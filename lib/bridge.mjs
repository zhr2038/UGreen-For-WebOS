import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { UgOS, normalizeItem, libraryQuery, playbackFiles, progressBody } from './ugos.mjs';
import { Photos } from './photos.mjs';

export async function createBridge({ dir, config, thumbnails, host = '0.0.0.0', port = 8780, clientToken, control, staticDir, nasClient }) {
const nas = nasClient || new UgOS(config);
let clients = {};
try { clients = JSON.parse(await readFile(join(dir, 'clients.json'), 'utf8')); } catch {}
const images = new Map(), plays = new Map(), attempts = new Map();
const photos = new Photos(nas);
const digest = value => createHash('sha256').update(value).digest('hex');
if (clientToken) clients[digest(clientToken)] = { name: 'This TV', expires: Number.MAX_SAFE_INTEGER };
const persistClients = () => writeFile(join(dir, 'clients.json'), JSON.stringify(clients), { mode: 0o600 });
const saveNas = () => control ? control.save() : writeFile(join(dir, 'nas.json'), JSON.stringify(config), { mode: 0o600 });

function json(res, status, value) {
  if (res.destroyed) return;
  if (value?.hero && value?.libraries) value.connection = config.linkMode === 'lan-https' ? '局域网直连' : control ? 'UGREENlink 中继' : '兼容服务';
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const b of req) { size += b.length; if (size > 16384) throw Object.assign(new Error('请求过大'), { status: 413 }); chunks.push(b); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('无效请求'), { status: 400 }); }
}
function clientId(req, url) {
  const value = req.headers.authorization?.replace(/^Bearer /i, '') || url.searchParams.get('client') || '';
  const id = digest(value);
  if (!clients[id] || clients[id].expires < Date.now()) throw Object.assign(new Error('请先配对电视'), { status: 401 });
  return id;
}
function imageUrl(path, id, kind = 'poster') {
  if (!path) return '';
  const key = digest(String(path) + ':' + id + ':' + kind).slice(0, 32);
  images.set(key, { path, id, kind });
  return '/image/' + key;
}
function item(input, status) {
  const i = normalizeItem(input, status);
  return { ...i, poster: imageUrl(i.posterPath, i.id, 'poster'), backdrop: imageUrl(i.backdropPath, i.id, 'backdrop'), cover: imageUrl(i.coverPath, i.id, 'cover'), logo: imageUrl(i.logoPath, i.id, 'logo') };
}
async function detail(id, type, libraryId) {
  if (!/^\d+$/.test(String(id))) throw Object.assign(new Error('无效影片'), { status: 400 });
  const data = await nas.request(type === 2 ? 'v2/video/details/getTV' : 'v1/video/details/getMovie', { query: type === 2 ? { ug_video_info_id: id } : { id, media_lib_set_id: libraryId, language: 'zh-CN' } });
  const v = item({ ...data.video_info, is_favorites: data.is_favorite }, data.play_status);
  return { raw: data, item: v, files: playbackFiles(data) };
}
async function proxy(req, res, path, query, kind) {
  const abort = new AbortController();
  res.once('close', () => { if (!res.writableEnded) abort.abort(); });
  // UGOS stream routes only implement GET; HEAD can otherwise return JSON with
  // HTTP 200. Read the GET headers and close immediately for a client HEAD.
  const upstream = await nas.open(path, { query, method: 'GET', headers: req.headers.range ? { Range: req.headers.range, ...(req.headers['if-range'] ? { 'If-Range': req.headers['if-range'] } : {}) } : {}, timeout: 60000, signal: abort.signal });
  const headers = { 'Cache-Control': kind === 'image' ? 'private, max-age=3600' : 'no-store' };
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-type']) if (upstream.headers[name]) headers[name] = upstream.headers[name];
  if (kind === 'image' && upstream.statusCode === 200 && !headers['content-type']?.startsWith('image/')) {
    // UGOS serves cached image bytes as application/octet-stream.
    const iterator = upstream[Symbol.asyncIterator]();
    const first = await iterator.next();
    const bytes = first.value || Buffer.alloc(0);
    const mime = bytes.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : null;
    if (!mime) { upstream.destroy(); return json(res, 502, { error: 'NAS 返回了无效封面' }); }
    headers['content-type'] = mime;
    res.writeHead(upstream.statusCode, headers); res.write(bytes);
    for await (const chunk of iterator) if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
    res.end(); return;
  }
  res.writeHead(upstream.statusCode || 502, headers);
  if (req.method === 'HEAD') { upstream.destroy(); res.end(); return; }
  await pipeline(upstream, res, { signal: abort.signal });
}

const server = http.createServer(async (req, res) => {
  // Installed webOS web apps have a null/file origin. Bearer capabilities are required for data.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Range');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range,Accept-Ranges');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, name: 'LG NAS Cinema', version: '0.3.2' });
    if (!clientToken && url.pathname === '/api/pair' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      const last = attempts.get(ip) || { count: 0, at: Date.now() };
      if (Date.now() - last.at > 15 * 60000) { last.count = 0; last.at = Date.now(); }
      if (last.count >= 8) return json(res, 429, { error: '尝试次数过多，请稍后再试' });
      last.count++; attempts.set(ip, last);
      const data = await body(req);
      const code = String(data.code || '');
      const pairing = JSON.parse(await readFile(join(dir, 'pairing.json'), 'utf8'));
      if (!/^[0-9]{6}$/.test(code) || !/^[0-9]{6}$/.test(pairing.code) || Date.now() > pairing.expiresAt || !timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code))) return json(res, 401, { error: '配对码错误或已过期，请在 NAS 重新生成配对码' });
      const token = randomBytes(32).toString('hex');
      clients[digest(token)] = { name: String(data.name || 'LG webOS TV').slice(0, 80), expires: Date.now() + 365 * 86400000 };
      await persistClients();
      return json(res, 200, { token, name: config.name });
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/image/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/photo-image/') || url.pathname.startsWith('/photo-video/')) {
      const owner = clientId(req, url);
      if (control && url.pathname.startsWith('/api/direct/')) {
        const result = await control.handle(url.pathname, req.method, req.method === 'POST' ? await body(req) : {}, nas);
        return json(res, 200, result);
      }
      if (!config.token) return json(res, 401, { error: '请先登录 NAS' });
      if (url.pathname === '/api/photos/albums' || url.pathname === '/api/photos/list' || url.pathname.startsWith('/photo-image/') || url.pathname.startsWith('/photo-video/')) {
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
        if (url.pathname === '/api/photos/albums') return json(res, 200, await photos.albums(url.searchParams, owner));
        if (url.pathname === '/api/photos/list') return json(res, 200, await photos.list(url.searchParams, owner));
        const isVideo = url.pathname.startsWith('/photo-video/');
        const key = url.pathname.split('/')[2], asset = photos.get(key, owner);
        if (isVideo !== (asset.kind === 'video')) return json(res, 404, { error: '照片链接无效' });
        if (isVideo) return await proxy(req, res, '/ugreen/v5/photo/picture/stream', { ...asset.source, size_type: 0 }, 'video');
        const buffer = await thumbnails.make('photo:' + key, asset.kind, () => photos.image(asset));
        if (!res.destroyed) { res.writeHead(200, { 'Content-Type': imageMime(buffer), 'Content-Length': buffer.length, 'Cache-Control': 'private, max-age=3600' }); res.end(req.method === 'HEAD' ? undefined : buffer); }
        return;
      }
      if (url.pathname === '/api/status') return json(res, 200, { name: config.name, model: config.model });
      if (url.pathname === '/api/home') {
        const [home, slider, libraries] = await Promise.all([
          nas.request('v2/video/homepage', { query: { language: 'zh-CN' } }),
          nas.request('v1/video/homepage/slider', { query: { language: 'zh-CN', app_name: 'tv' } }),
          nas.request('v1/video/homepage/media_list'),
        ]);
        return json(res, 200, { name: config.name, hero: (slider.random_list || []).map(v => item(v)), recent: (home.recently_played_arr?.video_arr || []).map(v => item(v)), updates: (home.recently_update_arr?.video_arr || []).map(v => item(v)), favorites: (home.favorites_arr?.video_arr || []).map(v => item(v)), libraries: libraries.media_lib_info_list || [] });
      }
      if (url.pathname === '/api/library') {
        const lib = Number(url.searchParams.get('id')) || undefined;
        const kind = url.searchParams.get('kind');
        const page = Math.max(1, Math.min(1000, Number(url.searchParams.get('page')) || 1));
        let data;
        if (kind === 'history' || kind === 'recent' || kind === 'favorites') {
          data = await nas.request(kind === 'history' ? 'v1/video/recently_played/get' : kind === 'recent' ? 'v1/video/recently_update/get' : 'v1/video/collect/get', { query: { page, page_size: 60, language: 'zh-CN', create_time_order: false, ...(kind === 'favorites' ? { video_type: 1, sort_type: 1, order_type: 2 } : {}) } });
        } else {
          const classification = kind === 'tv' ? -103 : kind === 'movies' ? -102 : -101;
          data = await nas.request(lib ? 'v2/video/mediaLibSet/poster-wall' : 'v1/video/all', { query: libraryQuery({ page, libraryId: lib, classification, sort: Number(url.searchParams.get('sort')) || 2 }) });
        }
        return json(res, 200, { items: (data.video_arr || data.video_info_list || []).map(v => item(v)), total: data.total_num || 0, last: Boolean(data.is_last_page) });
      }
      if (url.pathname === '/api/detail') {
        const d = await detail(url.searchParams.get('id'), Number(url.searchParams.get('type')), Number(url.searchParams.get('library')));
        return json(res, 200, { item: d.item, files: d.files.map((f, index) => ({ index, name: f.title || f.name || `版本 ${index + 1}`, episode: f.episode, duration: f.duration, size: f.size })), actors: (d.raw.ug_actor_arr || []).slice(0, 16).map(a => ({ name: a.name || a.actor_name, role: a.character || a.role })), technical: d.raw.media_info || null });
      }
      if (url.pathname === '/api/search') {
        const keyword = (url.searchParams.get('q') || '').trim().slice(0, 200);
        if (!keyword) return json(res, 200, { items: [] });
        const data = await nas.request('v1/video/search', { query: { keyword, language: 'zh-CN', search_type: 1, offset: 0, limit: 100 } });
        return json(res, 200, { items: [...(data.movies_list?.video_arr || []), ...(data.tv_list?.video_arr || [])].map(v => item(v)) });
      }
      if (url.pathname === '/api/favorite' && req.method === 'POST') {
        const p = await body(req); const d = await detail(p.id, Number(p.type), Number(p.library));
        const i = d.item;
        await nas.request(p.favorite ? 'v1/video/collect/create' : 'v1/video/collect/delete', { method: 'POST', body: p.favorite ? { ids: [{ category_id: i.categoryId, ug_video_info_id: i.id, type: i.type }], media_lib_set_id: i.libraryId } : { ids: [i.categoryId], media_lib_set_id: i.libraryId, type: i.type } });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/play' && req.method === 'POST') {
        const p = await body(req); const d = await detail(p.id, Number(p.type), Number(p.library));
        const index = Number.isInteger(p.fileIndex) ? p.fileIndex : d.files.findIndex(f => f.path === d.raw.play_status?.recently_played_file_path);
        const file = d.files[Math.max(0, index)];
        if (!file?.path) return json(res, 404, { error: '影片文件不存在' });
        const id = randomBytes(20).toString('hex');
        plays.set(id, { owner, item: d.item, file, created: Date.now() });
        return json(res, 200, { id, stream: '/media/' + id, fileIndex: Math.max(0, index), title: file.title ? d.item.name + ' · ' + file.title : d.item.name, position: p.restart ? 0 : (file.path === d.raw.play_status?.recently_played_file_path ? d.item.position : 0), duration: file.duration || d.item.duration, technical: d.raw.media_info || null });
      }
      if (url.pathname === '/api/progress' && req.method === 'POST') {
        const p = await body(req); const play = plays.get(p.id);
        if (!play || play.owner !== owner) return json(res, 404, { error: '播放会话已结束' });
        if (!Number.isFinite(p.position) || !Number.isFinite(p.duration) || p.position < 0 || p.duration <= 0 || p.position > p.duration + 5) return json(res, 400, { error: '播放进度无效' });
        await nas.request('v1/video/recently_played/create', { method: 'POST', body: progressBody(play, p.position, p.duration) });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const data = await body(req); const result = control ? await control.handle('/api/direct/login', 'POST', { ...data, server: config.server }, nas) : await nas.login(data.username, data.password); await saveNas(); return json(res, 200, result);
      }
      if (url.pathname.startsWith('/image/')) {
        const key = url.pathname.slice(7), image = images.get(key);
        if (!image) return json(res, 404, { error: '封面已过期，请刷新' });
        const buffer = await thumbnails.make(key, image.kind, async () => {
          if (res.destroyed) throw new Error('Image request closed');
          const upstream = await nas.open('/ugreen/v2/video/getImaStream', { query: { name: image.path, id: image.id, size: clientToken ? 1 : 0, app_name: 'tv' } });
          if (upstream.statusCode !== 200) { upstream.destroy(); throw new Error('NAS 封面读取失败'); }
          const pieces = []; let size = 0;
          for await (const chunk of upstream) {
            size += chunk.length;
            if (size > 12 * 1024 * 1024) { upstream.destroy(); throw new Error('NAS 封面过大'); }
            pieces.push(chunk);
          }
          return Buffer.concat(pieces);
        });
        if (!res.destroyed) { res.writeHead(200, { 'Content-Type': imageMime(buffer), 'Content-Length': buffer.length, 'Cache-Control': 'private, max-age=86400' }); res.end(req.method === 'HEAD' ? undefined : buffer); }
        return;
      }
      if (url.pathname.startsWith('/media/')) {
        const play = plays.get(url.pathname.slice(7));
        if (!play || play.owner !== owner || Date.now() - play.created > 24 * 3600000) return json(res, 404, { error: '播放链接已过期' });
        return await proxy(req, res, '/ugreen/v1/stream/transcode/raw/get', { video_path: play.file.path }, 'video');
      }
      return json(res, 404, { error: '接口不存在' });
    }
    if (!staticDir) return json(res, 404, { error: '接口不存在' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
    const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/artwork.js': 'artwork.js', '/app.css': 'app.css', '/photos.js': 'photos.js', '/photos.css': 'photos.css', '/connection.js': 'connection.js', '/connection.css': 'connection.css', '/qr.js': 'qr.js', '/logo.png': 'logo.png', '/icon.png': 'icon.png', '/icon-cloudframe.png': 'icon-cloudframe.png', '/large-icon-cloudframe.png': 'large-icon-cloudframe.png', '/favicon.ico': 'icon.png' };
    const file = files[url.pathname];
    if (!file) return json(res, 404, { error: '页面不存在' });
    const bytes = await readFile(join(staticDir, file));
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' })[extname(file)], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    const expired = [1010, 1011, 1012, 1019, 1024].includes(err.code);
    json(res, err.status || (expired ? 401 : 502), { error: expired ? 'NAS 登录已过期，请在设置中重新登录' : err.message, ...(err.code === 'CERT_CONFIRM' ? { code: err.code, fingerprint: err.fingerprint, server: err.server } : {}) });
  }
});
server.requestTimeout = 0;
server.headersTimeout = 15000;
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, host, resolveListen); });
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, p] of plays) if (now - p.created > 24 * 3600000) plays.delete(id);
}, 3600000).unref();

server.once('close', () => { clearInterval(cleanup); nas.httpsAgent.destroy(); });
return { server, nas, reset() { images.clear(); plays.clear(); photos.assets.clear(); } };
}

function imageMime(bytes) { return bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x89 ? 'image/png' : bytes.subarray(0, 3).toString() === 'GIF' ? 'image/gif' : 'image/webp'; }
