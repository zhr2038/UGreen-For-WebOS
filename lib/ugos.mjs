import http from 'node:http';
import https from 'node:https';
import { createHash, publicEncrypt, constants } from 'node:crypto';

export class UgOS {
  constructor(config) {
    this.config = config;
    // A resumed TLS handshake can omit the certificate. Require a full handshake
    // for new pinned connections while retaining verified keep-alive sockets.
    this.httpsAgent = new https.Agent({ keepAlive: true, maxCachedSessions: 0 });
  }

  open(path, { method = 'GET', query = {}, body, headers = {}, timeout = 20000, signal, auth = true } = {}) {
    const url = new URL(path, this.config.server);
    if (url.origin !== new URL(this.config.server).origin) throw new Error('NAS origin mismatch');
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    if (auth) {
      // Modern UGOS TV scan authorization issues a persistent key (ugk).
      // The Android client selects it instead of its short-lived token.
      if (this.config.authMode === 'ugk' && this.config.staticToken) url.searchParams.set('ugk', this.config.staticToken);
      else url.searchParams.set('token', this.config.token);
    }
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(url, {
        method, signal,
        agent: url.protocol === 'https:' ? this.httpsAgent : undefined,
        rejectUnauthorized: !this.config.tlsFingerprint,
        headers: { 'UG-Client-Id': this.config.clientId, ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {}), ...headers },
      }, resolve);
      if (url.protocol === 'https:' && this.config.tlsFingerprint) {
        req.on('socket', socket => socket.once('secureConnect', () => {
          const raw = socket.getPeerCertificate().raw;
          const actual = raw && createHash('sha256').update(raw).digest('hex');
          if (actual !== this.config.tlsFingerprint.toLowerCase().replaceAll(':', '')) req.destroy(new Error('NAS TLS certificate changed; recheck its fingerprint'));
        }));
      }
      req.setTimeout(timeout, () => req.destroy(new Error('NAS request timed out')));
      req.once('error', reject);
      req.end(encoded);
    });
  }

  async request(path, options) {
    const res = await this.open('/ugreen/' + path.replace(/^\/+/, ''), options);
    let bytes = 0; const chunks = [];
    for await (const chunk of res) {
      bytes += chunk.length;
      if (bytes > 12 * 1024 * 1024) throw new Error('NAS response exceeds limit');
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('NAS did not return JSON'); }
    if (res.statusCode !== 200 || data.code !== 200) {
      const err = new Error(data.msg || `NAS returned ${res.statusCode}`);
      err.code = data.code; throw err;
    }
    return data.data;
  }

  async login(username, password) {
    const res = await this.open('/ugreen/v1/verify/check', { method: 'POST', body: { username }, auth: false });
    res.resume();
    const header = res.headers['x-rsa-token'];
    if (!header) throw new Error('NAS RSA login handshake failed');
    const text = Buffer.from(header, 'base64').toString('utf8');
    const der = Buffer.from(text.split(/\r?\n/).filter(x => !x.startsWith('---')).join(''), 'base64');
    let passwordEncrypted;
    for (const type of ['pkcs1', 'spki']) {
      try { passwordEncrypted = publicEncrypt({ key: der, format: 'der', type, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password)).toString('base64'); break; }
      catch { /* UGOS public key wrappers vary across releases. */ }
    }
    if (!passwordEncrypted) throw new Error('NAS returned an unsupported RSA public key');
    const data = await this.request('v1/verify/login', { method: 'POST', auth: false, body: { username, password: passwordEncrypted, keepalive: true, otp: true, is_simple: false } });
    if (!data.token) throw new Error(data.enable_otp ? '此账号需要二次验证，请在电脑端完成登录。' : 'NAS login did not return a session');
    this.config.token = data.token;
    this.config.staticToken = data.static_token;
    this.config.name = data.nas_name;
    return { name: data.nas_name, model: data.model };
  }
}

export function libraryQuery({ page = 1, libraryId, classification = -101, sort = 2, order = 2 } = {}) {
  return {
    page, page_size: 60, sort_type: sort, order_type: order,
    release_date_begin: -9999999999, release_date_end: -9999999999,
    identify_status: 0, watch_status: -1, ug_style_id: 0, ug_country_id: 0, clarity: -1,
    language: 'zh-CN', classification: libraryId || classification,
    ...(libraryId ? { media_lib_set_id: libraryId, video_type: -1 } : {}),
  };
}

export function normalizeItem(input, playStatus) {
  const v = input.video_info || input;
  const p = playStatus || input.play_status || v;
  return {
    id: v.ug_video_info_id, libraryId: v.media_lib_set_id, categoryId: v.category_id,
    type: v.type, name: v.name || '未命名影片', year: v.year, score: v.score,
    overview: v.introduction || '', duration: v.duration || 0, episode: p.episode || 0,
    posterPath: v.poster_path, backdropPath: v.backdrop_path, logoPath: v.logo_path,
    coverPath: p.cover_path || v.cover_path || v.backdrop_path,
    clarity: v.clarity_show || (v.clarity === 2 ? '4K' : ''),
    imageQuality: v.image_quality || '', audioQuality: v.audio_quality || '',
    genres: v.style_list || [], countries: v.country_list || [],
    progress: Math.min(1, Math.max(0, Number(p.progress) || 0)),
    position: Number(p.current_play_time) || 0, filePaths: v.file_path || [],
    favorite: Boolean(input.is_favorite ?? v.is_favorites),
  };
}

export function playbackFiles(detail) {
  const files = [];
  for (const ep of detail.tv_info || []) {
    const sources = Array.isArray(ep.file_info) ? ep.file_info : ep.file_info ? [ep.file_info] : [];
    for (const f of sources) {
      const path = f.path || f.file_path;
      if (path) files.push({ ...f, path, episode: ep.episode, episodeId: ep.ug_television_episode_id, title: ep.ep_name || `第 ${ep.episode} 集`, cover: ep.cover_path });
    }
  }
  if (!files.length) for (const f of detail.file_information || []) if (f.path) files.push(f);
  if (!files.length) for (const path of detail.video_info?.file_path || []) files.push({ path });
  return files;
}

export function progressBody(play, position, duration) {
  const time = Math.max(0, Math.floor(position));
  const length = Math.max(1, duration || play.file.duration || play.item.duration || 1);
  const recentlyPlayed = {
    category_id: play.item.categoryId, ug_video_info_id: play.item.id,
    media_lib_set_id: play.item.libraryId, ug_television_episode_id: play.file.episodeId || 0,
    video_type: play.item.type, episode: play.file.episode || 0,
    current_play_time: time, progress: Math.min(1, time / length),
    recently_played_file_path: play.file.path, iso_ts: '',
  };
  return { recently_played: recentlyPlayed, app_name: 'LG_webOS' };
}
