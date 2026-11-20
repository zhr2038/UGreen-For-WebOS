import http from 'node:http';
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { extname, join, posix } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { UgOS, normalizeItem, libraryQuery, playbackFiles, progressBody } from './ugos.mjs';
import { Photos } from './photos.mjs';
import { createMoviePlaybackService } from './movie-playback-service.mjs';
import { createMovieHttpHandler, movieSourceUrl } from './movie-http.mjs';
import { movieAudioCompatibility, movieHeaderHash, prepareDolbyMp4 } from './movie-mp4-compat.mjs';
import { audioHelperSession } from './movie-audio-helper.mjs';
import { mkvAudioCompatSession, isUnsupportedMkvAudioCodec } from './movie-mkv-compat.mjs';
import { isAudioCompatAvailable } from './audio-compat-wasm.mjs';
import { createPhotoHttpHandler } from './photo-http.mjs';
import { createPhotoUhdHttpHandler } from './photo-uhd.mjs';
import { listenBrowser } from './browser-listen.mjs';
import { linkSignals } from './linked-signal.mjs';

const APP_VERSION = '0.5.6';
const YEAR_RANGES = {
  '2026': [1767225600, 1798761599],
  '2025': [1735689600, 1767225599],
  '2024': [1704067200, 1735689599],
  '2020-2023': [1577836800, 1704067199],
  '2010s': [1262304000, 1577836799],
  'earlier': [-9999999999, 1262303999],
};
const FALLBACK_STYLES = [
  [1, '动作'], [2, '喜剧'], [3, '科幻'], [4, '悬疑'], [5, '惊悚'], [6, '爱情'],
  [7, '剧情'], [8, '动画'], [9, '奇幻'], [10, '冒险'], [11, '犯罪'], [12, '恐怖'], [13, '战争'], [14, '纪录片'],
];
const FALLBACK_COUNTRIES = [
  [1, '中国大陆'], [2, '美国'], [3, '日本'], [4, '韩国'], [5, '英国'], [6, '中国香港'], [7, '中国台湾'], [8, '法国'], [9, '德国'],
];

export async function createBridge({ dir, config, thumbnails, host = '0.0.0.0', port = 8780, clientToken, control, staticDir, nasClient, getAudioHelper }) {
const nas = nasClient || new UgOS(config);
let clients = {};
try { clients = JSON.parse(await readFile(join(dir, 'clients.json'), 'utf8')); } catch {}
const images = new Map(), plays = new Map(), attempts = new Map();
const photos = new Photos(nas);
let generation = 0;
let preparingMp4 = false;
let filterCache = null;
let pairFailures = { code: '', count: 0 };
let writeQueue = Promise.resolve();
const atomicWrite = (path, content) => {
  const work = writeQueue.catch(() => {}).then(async () => {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  });
  writeQueue = work;
  return work;
};
const movies = createMoviePlaybackService({ dir, makeUrl: movieSourceUrl });
const movieHttp = createMovieHttpHandler({ movies, validatePlay(id, owner) { const p = plays.get(id); if (!p || p.owner !== owner || Date.now() - p.created > 24 * 3600000) throw Object.assign(new Error('播放链接已过期'), { status: 404 }); } });
const photoHttp = createPhotoHttpHandler({ photos, proxy, onReset: () => photos.clear() });
const photoUhdHttp = createPhotoUhdHttpHandler({ photos });
const digest = value => createHash('sha256').update(value).digest('hex');
const accountScope = (value = config) => digest(JSON.stringify([value.alias || value.server, value.username || value.uid || digest(value.token || value.staticToken || '')]));
function readGuard() {
  const epoch = generation, identity = () => digest(JSON.stringify(['server','alias','username','uid','token','staticToken','authMode','clientId','tlsFingerprint','nasPublicRsa'].map(key => config[key]))), captured = identity();
  return () => { if (epoch !== generation || captured !== identity()) throw Object.assign(new Error('连接已切换，请刷新页面'), { status: 410 }); };
}
if (clientToken) clients[digest(clientToken)] = { name: 'This TV', expires: Number.MAX_SAFE_INTEGER };
const persistClients = () => atomicWrite(join(dir, 'clients.json'), JSON.stringify(clients));
const saveNas = () => control ? control.save() : atomicWrite(join(dir, 'nas.json'), JSON.stringify(config));

function json(res, status, value) {
  if (res.destroyed) return;
  if (value?.hero && value?.libraries) { value.connectionScope=nas.visibilityScope?.();value.connection = config.linkMode === 'native-p2p' ? '原生P2P直连' : config.linkMode === 'lan-https' ? '局域网直连' : control ? 'UGREENlink 中继' : '兼容服务'; value.accountScope = accountScope(); }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readRequest(req, res, operation) {
  const controller = new AbortController(), abort = () => controller.abort();
  const closed = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort); res.once('close', closed); if (req.aborted || res.destroyed) abort();
  let completed = false;
  try { const value = await operation(controller.signal); if (controller.signal.aborted) throw Object.assign(new Error('读取已取消'), { name: 'AbortError', status: 410 }); completed = true; return value; }
  finally { if (!completed) abort(); req.off('aborted', abort); res.off('close', closed); }
}
const imageRequest = (req, res, key, kind, load) => readRequest(req, res, signal => thumbnails.make(key, kind, load, { signal }));
async function body(req) {
  const chunks = []; let size = 0;
  for await (const b of req) { size += b.length; if (size > 16384) throw Object.assign(new Error('请求过大'), { status: 413 }); chunks.push(b); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('无效请求'), { status: 400 }); }
}
function clientId(req, url) {
  const auth = req.headers.authorization;
  const value = typeof auth === 'string' && /^Bearer /i.test(auth)
    ? auth.replace(/^Bearer /i, '')
    : (url.searchParams.get('client') || '');
  if (!value || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw Object.assign(new Error('请先配对电视'), { status: 401 });
  const id = digest(value);
  if (!clients[id] || clients[id].expires < Date.now()) throw Object.assign(new Error('请先配对电视'), { status: 401 });
  return id;
}
function imageUrl(path, id, kind = 'poster') {
  if (!path) return '';
  const key = digest(String(path) + ':' + id + ':' + kind).slice(0, 32);
  images.delete(key);
  images.set(key, { path, id, kind });
  while (images.size > 4096) images.delete(images.keys().next().value);
  return '/image/' + key;
}
function item(input, status) {
  const i = normalizeItem(input, status);
  return { ...i, poster: imageUrl(i.posterPath, i.id, 'poster'), backdrop: imageUrl(i.backdropPath, i.id, 'backdrop'), cover: imageUrl(i.coverPath, i.id, 'cover'), logo: imageUrl(i.logoPath, i.id, 'logo') };
}
async function detail(id, type, libraryId, client = nas, publishArtwork = true, assertCurrent = () => {}, signal) {
  if (!/^\d+$/.test(String(id))) throw Object.assign(new Error('无效影片'), { status: 400 });
  let data;
  try { data = await client.request(type === 2 ? 'v2/video/details/getTV' : 'v1/video/details/getMovie', { query: type === 2 ? { ug_video_info_id: id } : { id, media_lib_set_id: libraryId, language: 'zh-CN' }, signal }); }
  catch (error) { throw Object.assign(new Error('NAS 影片信息读取失败'), Number.isInteger(error.code) ? { code: error.code } : {}); }
  assertCurrent();
  if (signal?.aborted) throw Object.assign(new Error('读取已取消'), { name: 'AbortError', status: 410 });
  const raw = { ...data.video_info, is_favorites: data.is_favorite };
  const v = publishArtwork ? item(raw, data.play_status) : normalizeItem(raw, data.play_status);
  return { raw: data, item: v, files: playbackFiles(data) };
}
async function proxy(req, res, path, query, kind, client = nas) {
  const abort = new AbortController();
  const onClose = () => { if (!res.writableEnded) abort.abort(); };
  res.once('close', onClose);
  let upstream;
  try {
    // UGOS stream routes only implement GET; HEAD can otherwise return JSON with
    // HTTP 200. Read the GET headers and close immediately for a client HEAD.
    upstream = await client.open(path, { query, method: 'GET', headers: req.headers.range ? { Range: req.headers.range, ...(req.headers['if-range'] ? { 'If-Range': req.headers['if-range'] } : {}) } : {}, timeout: 60000, signal: abort.signal });
    const headers = { 'Cache-Control': kind === 'image' ? 'private, max-age=3600' : 'no-store' };
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-type']) if (upstream.headers[name]) headers[name] = upstream.headers[name];
    if (kind !== 'image' && String(headers['content-type'] || '').toLowerCase().includes('application/json')) {
      const chunks = []; let total = 0;
      for await (const chunk of upstream) { total += chunk.length; if (total > 65536) break; chunks.push(chunk); }
      let parsed; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const expired = [1010, 1011, 1012, 1019, 1024].includes(parsed?.code);
      return json(res, expired ? 401 : 502, { error: expired ? 'NAS 登录已过期，请在设置中重新登录' : 'NAS 媒体流读取失败' });
    }
    if (kind === 'image' && upstream.statusCode === 200 && !headers['content-type']?.startsWith('image/')) {
      // UGOS serves cached image bytes as application/octet-stream.
      const iterator = upstream[Symbol.asyncIterator]();
      const first = await iterator.next();
      const bytes = first.value ? (Buffer.isBuffer(first.value) ? first.value : Buffer.from(first.value)) : Buffer.alloc(0);
      const mime = imageMime(bytes, null);
      if (!mime) return json(res, 502, { error: 'NAS 返回了无效封面' });
      headers['content-type'] = mime;
      res.writeHead(upstream.statusCode, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      async function* rest() {
        yield bytes;
        for await (const chunk of iterator) yield chunk;
      }
      await pipeline(rest(), res, { signal: abort.signal });
      return;
    }
    res.writeHead(upstream.statusCode || 502, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(upstream, res, { signal: abort.signal });
  } finally {
    res.off('close', onClose);
    upstream?.destroy();
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const reqHost = String(req.headers.host || '').toLowerCase();
  const allowedOrigin = !origin
    ? '*'
    : (origin === 'null' || origin.startsWith('file://') || (!clientToken && (() => { try { const u = new URL(origin); return u.host.toLowerCase() === reqHost; } catch { return false; } })()))
      ? origin
      : '';
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Range');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range,Accept-Ranges');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(allowedOrigin ? 204 : 403); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, name: 'LG NAS Cinema', version: APP_VERSION });
    if (!clientToken && url.pathname === '/api/pair' && req.method === 'POST') {
      const ip = String(req.socket.remoteAddress || 'unknown');
      const now = Date.now();
      const last = attempts.get(ip) || { count: 0, at: now };
      if (now - last.at > 15 * 60000) { last.count = 0; last.at = now; }
      if (last.count >= 8) return json(res, 429, { error: '尝试次数过多，请稍后再试' });
      last.count++; attempts.delete(ip); attempts.set(ip, last);
      while (attempts.size > 1024) attempts.delete(attempts.keys().next().value);
      const data = await body(req);
      const code = String(data.code || '');
      let pairing;
      try { pairing = JSON.parse(await readFile(join(dir, 'pairing.json'), 'utf8')); }
      catch { return json(res, 401, { error: '配对码错误或已过期，请在 NAS 重新生成配对码' }); }
      if (pairFailures.code !== pairing.code) pairFailures = { code: String(pairing.code || ''), count: 0 };
      const valid = /^[0-9]{6}$/.test(code) && /^[0-9]{6}$/.test(pairing.code || '') && now <= pairing.expiresAt && timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code));
      if (!valid) {
        if (++pairFailures.count >= 8) await unlink(join(dir, 'pairing.json')).catch(() => {});
        return json(res, 401, { error: '配对码错误或已过期，请在 NAS 重新生成配对码' });
      }
      pairFailures = { code: '', count: 0 };
      const token = randomBytes(32).toString('hex');
      clients[digest(token)] = { name: String(data.name || 'LG webOS TV').slice(0, 80), expires: now + 365 * 86400000 };
      await persistClients();
      return json(res, 200, { token, name: config.name });
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/image/') || url.pathname.startsWith('/media/') || /^\/photo-(?:image|video|original|motion|music|hls|uhd)\//.test(url.pathname)) {
      const owner = clientId(req, url);
      if (['GET', 'HEAD'].includes(req.method)) nas.foreground?.(req.method);
      if (url.pathname === '/api/connection' && ['GET', 'HEAD'].includes(req.method)) {if(url.searchParams.has('owner')&&(url.searchParams.get('owner')!==nas.visibilityScope?.()||url.searchParams.get('accountScope')!==accountScope()))return json(res,409,{error:'连接已切换'});return json(res, 200, nas.summary ? {...nas.summary(),visibilityScope:nas.visibilityScope?.(),accountScope:accountScope()} : { mode: 'ugreenlink-relay', verified: false, p2p: false, reason: 'NOT_PROBED', probing: false, probeStage: 'IDLE', probeError: null, probeElapsedMs: 0, attempts: 0, retryAfterMs: 0, automaticRetry: false });}
      if(url.pathname==='/api/connection/visibility'){if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});const epoch=generation,data=await body(req);if(epoch!==generation||Object.keys(data).some(key=>!['visible','scope','accountScope'].includes(key))||data.accountScope!==accountScope()||data.scope!==nas.visibilityScope?.()||!nas.setVisibility?.(data))return json(res,409,{error:'连接已切换'});return json(res,200,{ok:true});}
      if (control && url.pathname.startsWith('/api/direct/')) {
        const result = await control.handle(url.pathname, req.method, req.method === 'POST' ? await body(req) : {}, nas);
        return json(res, 200, result);
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const data = await body(req);
        if (control) {
          const result = await control.handle('/api/direct/login', 'POST', { ...data, server: config.server }, nas);
          return json(res, 200, result);
        }
        const result = await nas.login(data.username, data.password);
        await saveNas();
        await reset();
        return json(res, 200, result);
      }
      if (!config.token) return json(res, 401, { error: '请先登录 NAS' });
      const urlContext = { client: req.headers.authorization?.replace(/^Bearer /i, '') || url.searchParams.get('client') || '' };
      if (url.pathname === '/api/play/close' && req.method === 'POST') {
        const p = await body(req), play = plays.get(p.id);
        if (play && play.owner !== owner) return json(res, 404, { error: '播放会话不存在' });
        const result = await movies.close(p.id, owner);
        if (play) play.closedAt = Date.now();
        return json(res, 200, result);
      }
      if (await movieHttp(req, res, { url, owner, urlContext })) return;
      if (await photoUhdHttp(req, res, { url, owner, urlContext })) return;
      if (await photoHttp(req, res, { url, owner, urlContext })) return;
      const photoReads = { '/api/photos/albums': 'albums', '/api/photos/list': 'list', '/api/photos/categories': 'categories', '/api/photos/info': 'info', '/api/photos/folders': 'folders', '/api/photos/memories': 'memories', '/api/photos/music': 'music' };
      if (photoReads[url.pathname]) {
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
        const epoch = generation, value = await readRequest(req, res, signal => photos[photoReads[url.pathname]](url.searchParams, owner, { signal }));
        return epoch === generation ? json(res, 200, value) : json(res, 410, { error: '相册连接已切换，请刷新列表' });
      }
      if (url.pathname === '/api/photos/preview-visibility') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
        const epoch = generation, value = await photos.previewVisibility(await body(req), owner);
        return epoch === generation ? json(res, 200, value) : json(res, 410, { error: '相册连接已切换，请刷新列表' });
      }
      if (/^\/photo-(?:image|video|original|motion|music)\//.test(url.pathname)) {
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
        const key = url.pathname.split('/')[2], asset = photos.get(key, owner);
        const expected = { 'photo-image': ['photoTile', 'photoView'], 'photo-video': ['video'], 'photo-original': ['photoOriginal'], 'photo-motion': ['live'], 'photo-music': ['music'] }[url.pathname.split('/')[1]];
        if (!expected?.includes(asset.kind)) return json(res, 404, { error: '照片链接无效' });
        if (['video', 'photoOriginal', 'live', 'music'].includes(asset.kind)) { const stream = photos.stream(asset); return await proxy(req, res, stream.path, stream.query, asset.kind, stream.nas); }
        const epoch = generation;
        const buffer = await imageRequest(req, res, 'photo:' + key, asset.kind, signal => photos.image(asset, { signal }));
        if (epoch !== generation) return json(res, 410, { error: '相册连接已切换，请刷新列表' });
        if (!res.destroyed) { res.writeHead(200, { 'Content-Type': imageMime(buffer), 'Content-Length': buffer.length, 'Cache-Control': 'private, max-age=3600' }); res.end(req.method === 'HEAD' ? undefined : buffer); }
        return;
      }
      if (url.pathname === '/api/status') return json(res, 200, { name: config.name, model: config.model });
      if (url.pathname === '/api/home') {
        const assertCurrent = readGuard();const [home, slider, libraries] = await readRequest(req, res, signal => Promise.all([
          nas.request('v2/video/homepage', { query: { language: 'zh-CN' }, signal }),
          nas.request('v1/video/homepage/slider', { query: { language: 'zh-CN', app_name: 'tv' }, signal }),
          nas.request('v1/video/homepage/media_list', { signal }),
        ]));
        assertCurrent();return json(res, 200, { name: config.name, hero: (slider.random_list || []).map(v => item(v)), recent: (home.recently_played_arr?.video_arr || []).map(v => item(v)), updates: (home.recently_update_arr?.video_arr || []).map(v => item(v)), favorites: (home.favorites_arr?.video_arr || []).map(v => item(v)), libraries: libraries.media_lib_info_list || [] });
      }
      if (url.pathname === '/api/filters') {
        const assertCurrent = readGuard();
        if (!filterCache) {
          let styles = [], countries = [];
          try {
            const raw = await readRequest(req, res, signal => nas.request('v1/video/media_lib/filter/options', { query: { type: 0, language: 'zh-CN' }, signal }));
            styles = (raw?.style_list || []).map(x => ({ id: Number(x.ID ?? x.id), name: String((x.Name ?? x.name) || '') })).filter(x => Number.isFinite(x.id) && x.name);
            countries = (raw?.country_list || []).map(x => ({ id: Number(x.ID ?? x.id), name: String((x.Name ?? x.name) || '') })).filter(x => Number.isFinite(x.id) && x.name);
          } catch {}
          assertCurrent();
          filterCache = {
            styles: styles.length ? styles : FALLBACK_STYLES.map(([id, name]) => ({ id, name })),
            countries: countries.length ? countries : FALLBACK_COUNTRIES.map(([id, name]) => ({ id, name })),
            years: [
              { id: '2026', label: '2026 年' },
              { id: '2025', label: '2025 年' },
              { id: '2024', label: '2024 年' },
              { id: '2020-2023', label: '2020–2023 年' },
              { id: '2010s', label: '2010 年代' },
              { id: 'earlier', label: '更早' },
            ],
            clarities: [{ id: '1', name: '4K' }, { id: '2', name: '蓝光 / 原盘' }],
          };
        }
        return json(res, 200, filterCache);
      }
      if (url.pathname === '/api/library') {
        const assertCurrent = readGuard();
        const lib = Number(url.searchParams.get('id')) || undefined;
        const kind = url.searchParams.get('kind') || 'all';
        const mediaType = url.searchParams.get('mediaType') || 'all';
        const page = Math.max(1, Math.min(1000, Number(url.searchParams.get('page')) || 1));
        const requestedSort = Number(url.searchParams.get('sort'));
        const sort = [1, 2, 3, 4].includes(requestedSort) ? requestedSort : 2;
        const requestedOrder = Number(url.searchParams.get('order'));
        const order = [1, 2].includes(requestedOrder) ? requestedOrder : (sort === 1 ? 1 : 2);
        const styleId = Math.max(0, Number(url.searchParams.get('style')) || 0);
        const countryId = Math.max(0, Number(url.searchParams.get('country')) || 0);
        const rawWatched = url.searchParams.get('watched');
        const watchStatus = [0, 2].includes(Number(rawWatched)) && rawWatched !== '' && rawWatched !== null ? Number(rawWatched) : -1;
        const rawClarity = url.searchParams.get('clarity');
        const clarity = [1, 2].includes(Number(rawClarity)) && rawClarity !== '' && rawClarity !== null ? Number(rawClarity) : -1;
        const [releaseBegin, releaseEnd] = YEAR_RANGES[url.searchParams.get('year')] || [-9999999999, -9999999999];
        const filterType = mediaType === 'movies' ? 1 : mediaType === 'tv' ? 2 : -1;
        const hasFilters = Boolean(styleId || countryId || watchStatus !== -1 || clarity !== -1 || releaseBegin !== -9999999999);
        let rawList = [], total = 0, explicitLast = false;
        if (kind === 'history') {
          const data = await readRequest(req, res, signal => nas.request('v1/video/recently_played/get', { query: { page, page_size: 60, language: 'zh-CN', create_time_order: false }, signal }));
          rawList = data.video_arr || data.video_info_list || [];
          total = Number(data.total_num) || rawList.length;
          explicitLast = Boolean(data.is_last_page);
        } else if (kind === 'recent' && !hasFilters && filterType === -1 && requestedSort === 0) {
          const data = await readRequest(req, res, signal => nas.request('v1/video/recently_update/get', { query: { page, page_size: 60, language: 'zh-CN', create_time_order: false }, signal }));
          rawList = data.video_arr || data.video_info_list || [];
          total = Number(data.total_num) || rawList.length;
          explicitLast = Boolean(data.is_last_page);
        } else if (kind === 'favorites') {
          if (filterType === -1) {
            const [moviesFav, tvFav] = await readRequest(req, res, signal => Promise.all([
              nas.request('v1/video/collect/get', { query: { page, page_size: 60, language: 'zh-CN', create_time_order: false, video_type: 1, sort_type: sort, order_type: order }, signal }),
              nas.request('v1/video/collect/get', { query: { page, page_size: 60, language: 'zh-CN', create_time_order: false, video_type: 2, sort_type: sort, order_type: order }, signal }),
            ]));
            const mArr = moviesFav.video_arr || moviesFav.video_info_list || [];
            const tArr = tvFav.video_arr || tvFav.video_info_list || [];
            rawList = [...mArr, ...tArr];
            total = (Number(moviesFav.total_num) || mArr.length) + (Number(tvFav.total_num) || tArr.length);
            explicitLast = Boolean(moviesFav.is_last_page ?? true) && Boolean(tvFav.is_last_page ?? true) || (mArr.length < 60 && tArr.length < 60);
          } else {
            const data = await readRequest(req, res, signal => nas.request('v1/video/collect/get', { query: { page, page_size: 60, language: 'zh-CN', create_time_order: false, video_type: filterType, sort_type: sort, order_type: order }, signal }));
            rawList = data.video_arr || data.video_info_list || [];
            total = Number(data.total_num) || rawList.length;
            explicitLast = Boolean(data.is_last_page);
          }
        } else {
          const effType = kind === 'tv' ? 2 : kind === 'movies' ? 1 : filterType;
          const classification = effType === 2 ? -103 : effType === 1 ? -102 : -101;
          const effectiveSort = kind === 'recent' && !requestedSort ? 2 : sort;
          const data = await readRequest(req, res, signal => nas.request(lib ? 'v2/video/mediaLibSet/poster-wall' : 'v1/video/all', {
            query: libraryQuery({
              page, libraryId: lib, classification, sort: effectiveSort, order,
              videoType: effType, styleId, countryId, watchStatus, clarity, releaseBegin, releaseEnd,
            }),
            signal,
          }));
          rawList = data.video_arr || data.video_info_list || [];
          total = Number(data.total_num) || 0;
          explicitLast = Boolean(data.is_last_page);
        }
        assertCurrent();
        const items = rawList.map(v => item(v));
        const last = explicitLast || items.length === 0 || (total > 0 && page * 60 >= total) || (kind !== 'favorites' && items.length < 60);
        return json(res, 200, { items, total: total || items.length, last });
      }
      if (url.pathname === '/api/detail') {
        const assertCurrent = readGuard(), d = await readRequest(req, res, signal => detail(url.searchParams.get('id'), Number(url.searchParams.get('type')), Number(url.searchParams.get('library')), nas, true, assertCurrent, signal));
        const people = Array.isArray(d.raw.ug_actor_arr) ? d.raw.ug_actor_arr : [];
        const mapPerson = a => ({
          name: a.name || a.actor_name || '',
          role: a.character || a.role || '',
          department: a.department || '',
          avatar: imageUrl(a.profile_path || a.head_portrait, d.item.id, 'poster'),
        });
        const directors = people.filter(a => a.department === 'Directing').map(mapPerson);
        const writers = people.filter(a => a.department === 'Writing').map(mapPerson);
        const actors = people.filter(a => !['Directing', 'Writing'].includes(a.department)).slice(0, 16).map(mapPerson);
        const resumePath = d.raw.play_status?.recently_played_file_path;
        const resumeIdx = resumePath ? d.files.findIndex(f => f.path === resumePath) : -1;
        const releaseDate = Number(d.raw.video_info?.release_date) || 0;
        const releaseDateText = releaseDate > 0 ? new Date(releaseDate * 1000).toISOString().slice(0, 10) : '';
        return json(res, 200, {
          item: d.item,
          resumeFileIndex: resumeIdx >= 0 ? resumeIdx : 0,
          releaseDateText,
          countries: d.raw.video_info?.country_list || d.item.countries || [],
          directors,
          writers,
          actors,
          files: d.files.map((f, index) => ({
            index,
            name: f.title || f.name || `版本 ${index + 1}`,
            fileName: posix.basename(String(f.path || '')),
            episode: f.episode,
            season: f.season || 1,
            multiVersion: Boolean(f.multiVersion),
            versionLabel: f.versionLabel || '',
            clarity: f.clarity_show || '',
            duration: f.duration,
            size: f.size,
          })),
          technical: d.raw.media_info || null,
        });
      }
      if (url.pathname === '/api/watched' && req.method === 'POST') {
        const epoch = generation, captured = nas.snapshot ? nas.snapshot() : new UgOS({ ...config });
        if (!captured || captured === nas || typeof captured.then === 'function') throw Object.assign(new Error('NAS 未提供独立的标记连接'), { status: 503 });
        const scope = accountScope(captured.config), current = () => epoch === generation && scope === accountScope();
        try {
          const p = await body(req);
          if (!current() || res.destroyed) return json(res, 410, { error: '连接已切换，请重新打开影片' });
          const d = await detail(p.id, Number(p.type), Number(p.library), captured, false), i = d.item;
          if (!current() || res.destroyed) return json(res, 410, { error: '连接已切换，请重新打开影片' });
          const reqBody = {
            video_type: i.type,
            media_lib_set_id: i.libraryId,
            category_id: i.categoryId,
            watch_status: p.watched ? 2 : 0,
            ...(i.type === 1 && d.files[0]?.file_id ? { file_id: d.files[0].file_id } : i.type !== 1 ? { folder_path: 'ALL' } : {}),
          };
          try { await captured.request('v1/video/recently_played/mark', { method: 'POST', body: reqBody }); }
          catch (error) { throw Object.assign(new Error('NAS 已看状态更新失败'), Number.isInteger(error.code) ? { code: error.code } : {}); }
          return current() ? json(res, 200, { ok: true, watched: Boolean(p.watched) }) : json(res, 410, { error: '连接已切换，请重新打开影片' });
        } finally { captured.httpsAgent?.destroy?.(); }
      }
      if (url.pathname === '/api/history/delete' && req.method === 'POST') {
        const epoch = generation, captured = nas.snapshot ? nas.snapshot() : new UgOS({ ...config });
        if (!captured || captured === nas || typeof captured.then === 'function') throw Object.assign(new Error('NAS 未提供独立的历史清理连接'), { status: 503 });
        const scope = accountScope(captured.config), current = () => epoch === generation && scope === accountScope();
        try {
          const p = await body(req);
          if (!current() || res.destroyed) return json(res, 410, { error: '连接已切换，请刷新页面' });
          let delType = (p.clearAll || p.all) ? 2 : 1;
          let ids = [];
          if (delType === 1) {
            const directRid = Number(p.recentlyPlayedId);
            if (Number.isInteger(directRid) && directRid > 0) ids = [directRid];
            else if (/^\d+$/.test(String(p.id || ''))) {
              const targetId = Number(p.id);
              const list = await captured.request('v1/video/recently_played/get', { query: { page: 1, page_size: 100, language: 'zh-CN', create_time_order: false } });
              const found = (list?.video_arr || list?.video_info_list || []).find(v => {
                const ridCandidate = Number(v.play_status?.recently_played_id ?? v.recently_played_id ?? v.play_status?.id);
                const vidCandidate = Number(v.video_info?.ug_video_info_id ?? v.ug_video_info_id);
                return vidCandidate === targetId || ridCandidate === targetId;
              });
              const rid = Number(found?.play_status?.recently_played_id ?? found?.recently_played_id ?? found?.play_status?.id);
              if (Number.isInteger(rid) && rid > 0) ids = [rid];
            }
            if (!ids.length) return json(res, 404, { error: '未找到对应的播放记录' });
          }
          if (!current() || res.destroyed) return json(res, 410, { error: '连接已切换，请刷新页面' });
          try { await captured.request('v1/video/recently_played/delete', { method: 'POST', body: { del_type: delType, recently_played_id_arr: ids } }); }
          catch (error) { throw Object.assign(new Error('NAS 播放记录删除失败'), Number.isInteger(error.code) ? { code: error.code } : {}); }
          return current() ? json(res, 200, { ok: true }) : json(res, 410, { error: '连接已切换，请刷新页面' });
        } finally { captured.httpsAgent?.destroy?.(); }
      }
      if (url.pathname === '/api/search') {
        const assertCurrent = readGuard();
        const keyword = (url.searchParams.get('q') || '').trim().slice(0, 200);
        if (!keyword) return json(res, 200, { items: [] });
        const data = await readRequest(req, res, signal => nas.request('v1/video/search', { query: { keyword, language: 'zh-CN', search_type: 1, offset: 0, limit: 100 }, signal }));
        assertCurrent();return json(res, 200, { items: [...(data.movies_list?.video_arr || []), ...(data.tv_list?.video_arr || [])].map(v => item(v)) });
      }
      if (url.pathname === '/api/favorite' && req.method === 'POST') {
        const epoch = generation, captured = nas.snapshot ? nas.snapshot() : new UgOS({ ...config });
        if (!captured || captured === nas || typeof captured.then === 'function') throw Object.assign(new Error('NAS 未提供独立的收藏连接'), { status: 503 });
        const scope = accountScope(captured.config), current = () => epoch === generation && scope === accountScope();
        try {
          const p = await body(req);
          if (!current() || res.destroyed) return json(res, 410, { error: '连接已切换，请重新打开影片' });
          // Metadata for a mutation must not mint artwork capabilities from a
          // response that can arrive after reset or an account switch.
          const d = await detail(p.id, Number(p.type), Number(p.library), captured, false), i = d.item;
          if (!current() || res.destroyed) return json(res, 410, { error: '连接已切换，请重新打开影片' });
          try { await captured.request(p.favorite ? 'v1/video/collect/create' : 'v1/video/collect/delete', { method: 'POST', body: p.favorite ? { ids: [{ category_id: i.categoryId, ug_video_info_id: i.id, type: i.type }], media_lib_set_id: i.libraryId } : { ids: [i.categoryId], media_lib_set_id: i.libraryId, type: i.type } }); }
          catch (error) { throw Object.assign(new Error('NAS 收藏更新失败'), Number.isInteger(error.code) ? { code: error.code } : {}); }
          return current() ? json(res, 200, { ok: true }) : json(res, 410, { error: '连接已切换，请重新打开影片' });
        } finally { captured.httpsAgent?.destroy(); }
      }
      if (url.pathname === '/api/play' && req.method === 'POST') {
        const p = await body(req), epoch = generation, assertCurrent = readGuard(), playNas = nas.snapshot ? nas.snapshot() : new UgOS({ ...config });
        let retained = false;
        try {
        const d = await detail(p.id, Number(p.type), Number(p.library), playNas, true, assertCurrent);
        if (res.destroyed) return;
        if (epoch !== generation) return json(res, 410, { error: '连接已切换，请重新打开影片' });
        const index = Number.isInteger(p.fileIndex) ? p.fileIndex : d.files.findIndex(f => f.path === d.raw.play_status?.recently_played_file_path);
        const file = d.files[Math.max(0, index)];
        if (!file?.path) return json(res, 404, { error: '影片文件不存在' });
        const technical = d.raw.media_info || null;
        const compatibility = movieAudioCompatibility(file, technical);
        const allowEpisodeMp4Probe = !compatibility && /\.mp4$/i.test(file.path) && technical?.path !== file.path;
        let overlay;
        if ((compatibility === 'mp4' || allowEpisodeMp4Probe) && !preparingMp4 && movies.overlayCount() < 2) {
          preparingMp4 = true;
          try {
            overlay = await readRequest(req, res, signal => {
              const linked = linkSignals([signal, AbortSignal.timeout(15000)]);
              return prepareDolbyMp4(playNas, file.path, linked.signal).finally(() => linked.dispose());
            });
          } catch { /* An unsupported MP4 layout still uses normal original playback. */ }
          finally { preparingMp4 = false; }
          if (res.destroyed) return;
          assertCurrent();
        }
        const id = randomBytes(20).toString('hex');
        const play = { owner, item: d.item, file, created: Date.now(), nas: playNas };
        const helper = (compatibility === 'transcode' || !compatibility && /\.mkv$/i.test(file.path) && technical?.path !== file.path) ? getAudioHelper?.() : undefined;
        let prepareAudio, resolvePrepareAudio, audioCompatibility = false;
        if (helper && (!file.size || helper.size === Number(file.size || technical?.size)) && posix.dirname(helper.path) === posix.dirname(file.path)) {
          const hash = await readRequest(req, res, signal => {
            const linked = linkSignals([signal, AbortSignal.timeout(5000)]);
            return movieHeaderHash(playNas, file.path, linked.signal).finally(() => linked.dispose());
          }).catch(() => '');
          if (hash === helper.headerHash) {
            prepareAudio = () => audioHelperSession(helper);
            audioCompatibility = true;
          }
          if (res.destroyed) return;
          assertCurrent();
        }
        if (!prepareAudio && /\.mkv$/i.test(file.path) && isAudioCompatAvailable()) {
          if (technical?.path === file.path && Array.isArray(technical.audio_info)) {
            const badIdx = technical.audio_info.findIndex(t => isUnsupportedMkvAudioCodec(t?.codec));
            if (badIdx >= 0) {
              prepareAudio = () => mkvAudioCompatSession(playNas, file.path, { audioTrackIndex: badIdx });
              audioCompatibility = technical.audio_info.every(t => isUnsupportedMkvAudioCodec(t?.codec));
            }
          } else {
            resolvePrepareAudio = trackIndex => mkvAudioCompatSession(playNas, file.path, { audioTrackIndex: trackIndex });
          }
        }
        const source = movies.register(id, owner, playNas, play, { urlContext, overlay, prepareAudio, resolvePrepareAudio });
        plays.set(id, play); retained = true;
        return json(res, 200, { ...source, accountScope: accountScope(playNas.config), fileIndex: Math.max(0, index), title: file.title ? d.item.name + ' · ' + file.title : d.item.name, position: p.restart ? 0 : (file.path === d.raw.play_status?.recently_played_file_path ? d.item.position : 0), duration: file.duration || d.item.duration, technical, ...(audioCompatibility ? { audioCompatibility: true } : {}) });
        } finally { if (!retained) playNas.httpsAgent?.destroy?.(); }
      }
      if (url.pathname === '/api/progress' && req.method === 'POST') {
        const p = await body(req); const play = plays.get(p.id);
        if (!play || play.owner !== owner) return json(res, 404, { error: '播放会话已结束' });
        if (!Number.isFinite(p.position) || !Number.isFinite(p.duration) || p.position < 0 || p.duration <= 0 || p.position > p.duration + 5) return json(res, 400, { error: '播放进度无效' });
        try { await play.nas.request('v1/video/recently_played/create', { method: 'POST', body: progressBody(play, p.position, p.duration) }); }
        catch (error) { throw Object.assign(new Error('播放记录未能同步到 NAS'), Number.isInteger(error.code) ? { code: error.code } : {}); }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        // Handled above before the !config.token guard so fresh bridge logins work.
      }
      if (url.pathname.startsWith('/image/')) {
        const key = url.pathname.slice(7), image = images.get(key);
        if (!image) return json(res, 404, { error: '封面已过期，请刷新' });
        const epoch = generation;
        const buffer = await imageRequest(req, res, key, image.kind, async signal => {
          if (signal?.aborted || epoch !== generation) throw new Error('封面连接已切换');
          const upstream = await nas.open('/ugreen/v2/video/getImaStream', { query: { name: image.path, id: image.id, size: clientToken ? 1 : 0, app_name: 'tv' }, signal });
          if (upstream.statusCode !== 200) { upstream.destroy(); throw new Error('NAS 封面读取失败'); }
          const pieces = []; let size = 0;
          for await (const chunk of upstream) {
            size += chunk.length;
            if (size > 12 * 1024 * 1024) { upstream.destroy(); throw new Error('NAS 封面过大'); }
            pieces.push(chunk);
          }
          return Buffer.concat(pieces);
        });
        if (epoch !== generation) return json(res, 410, { error: '封面连接已切换，请刷新列表' });
        if (!res.destroyed) { res.writeHead(200, { 'Content-Type': imageMime(buffer), 'Content-Length': buffer.length, 'Cache-Control': 'private, max-age=86400' }); res.end(req.method === 'HEAD' ? undefined : buffer); }
        return;
      }
      return json(res, 404, { error: '接口不存在' });
    }
    if (!staticDir) return json(res, 404, { error: '接口不存在' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
    const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/artwork.js': 'artwork.js', '/app.css': 'app.css', '/photos.js': 'photos.js', '/photos.css': 'photos.css', '/connection.js': 'connection.js', '/connection.css': 'connection.css', '/qr.js': 'qr.js', '/logo.png': 'logo.png', '/icon.png': 'icon.png', '/icon-cloudframe.png': 'icon-cloudframe.png', '/large-icon-cloudframe.png': 'large-icon-cloudframe.png', '/favicon.ico': 'icon.png' };
    Object.assign(files, { '/playback.js': 'playback.js', '/movie-media.js': 'movie-media.js', '/player-options.js': 'player-options.js', '/player-options.css': 'player-options.css', '/photo-uhd-pipeline.js': 'photo-uhd-pipeline.js', '/heif-assets-loader.js': 'heif-assets-loader.js', '/heif-client.js': 'heif-client.js', '/heif-assets.js': 'heif-assets.js', '/photo-music.js': 'photo-music.js' });
    const file = files[url.pathname];
    if (!file) return json(res, 404, { error: '页面不存在' });
    const bytes = await readFile(join(staticDir, file));
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' })[extname(file)], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    const expired = [1010, 1011, 1012, 1019, 1024].includes(err.code);
    const fsLeak = typeof err.path === 'string' || ['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(err.code);
    const safeMessage = expired ? 'NAS 登录已过期，请在设置中重新登录' : (fsLeak ? '服务内部资源暂不可用' : err.message);
    json(res, err.status || (expired ? 401 : 502), { error: safeMessage, ...(err.code === 'CERT_CONFIRM' ? { code: err.code, fingerprint: err.fingerprint, server: err.server } : {}) });
  }
});
server.requestTimeout = 0;
server.headersTimeout = 15000;
await listenBrowser(server, { port, host });
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, p] of plays) if (now - (p.closedAt || p.created) > (p.closedAt ? 60000 : 24 * 3600000)) { plays.delete(id); p.nas?.httpsAgent?.destroy?.(); movies.close(id, p.owner).catch(() => {}); }
}, 60000).unref();

async function reset() { generation++; filterCache = null; images.clear(); thumbnails.clear?.(); for (const p of plays.values()) p.nas?.httpsAgent?.destroy?.(); plays.clear(); return Promise.allSettled([movies.reset(), photoHttp.reset(), photoUhdHttp.reset()]); }
server.once('close', () => { clearInterval(cleanup); reset().finally(() => nas.httpsAgent?.destroy?.()); });
return { server, nas, reset };
}

function imageMime(bytes, fallback = 'image/webp') {
  if (!bytes || bytes.length < 4) return fallback;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return fallback;
}
