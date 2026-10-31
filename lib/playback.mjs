import { randomBytes, randomUUID } from 'node:crypto';

const ROOT = '/ugreen/v2/stream/transcode/';
const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'smi', 'ssa', 'sup'];
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const nativeIndex = value => typeof value === 'number' && Number.isInteger(value) ? value : -99;
const text = value => typeof value === 'string' ? value : '';
const language = value => text(value).slice(0, 80);
const basename = path => text(path).replaceAll('\\', '/').split('/').pop() || '';

function track(item, index, kind) {
  return {
    id: `${kind}:${Number.isInteger(item.id) ? item.id : index}`, index,
    nasId: Number.isInteger(item.id) ? item.id : index,
    label: text(item.title) || text(item.language) || `轨道 ${index + 1}`,
    language: language(item.raw_language || item.language), codec: text(item.name || item.codec),
    channels: Number(item.channels) || undefined,
  };
}

export function playbackOptions(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw failure('NAS 播放信息格式已变化', 502);
  const qualities = [{ id: 'original', label: '原画', resolution: text(info.resolution), original: true }];
  for (const item of Array.isArray(info.transcode) ? info.transcode : []) {
    if (!item || !/^[0-9]{2,5}x[0-9]{2,5}$/.test(item.resolution || '') || typeof item.name !== 'string') continue;
    const id = `${item.name}@${item.resolution}`;
    if (qualities.some(q => q.id === id)) continue;
    qualities.push({ id, label: [text(item.name), text(item.cname)].filter(Boolean).join(' · '), resolution: item.resolution, original: false, frameRate: Number(item.framerate) || undefined });
  }
  return {
    qualities,
    audio: (Array.isArray(info.audios) ? info.audios : []).map((item, index) => track(item, index, 'audio')),
    subtitles: (Array.isArray(info.subtitle) ? info.subtitle : []).map((item, index) => ({ ...track(item, index, 'embedded'), kind: 'embedded', text: /^(subrip|srt|ass|ssa|webvtt|text|mov_text)$/i.test(item.name || '') })),
    source: { resolution: text(info.resolution), frameRate: Number(info.framerate) || 0, durationUs: Number(info.duration) || 0, hdr: Boolean(info.hdr), dolby: Number(info.dolby) || 0 },
  };
}

/** One caller-owned movie/episode, one NAS task. Never accepts a browser file path. */
export class PlaybackSession {
  constructor(nas, play, { now = Date.now, taskId = randomUUID(), maxManifestBytes = 2 * 1024 * 1024 } = {}) {
    if (!play?.file?.path || typeof play.file.path !== 'string') throw failure('影片文件不存在');
    this.nas = nas; this.play = play; this.now = now; this.taskId = taskId; this.maxManifestBytes = maxManifestBytes;
    this.created = false; this.touched = false; this.closed = false; this.resources = new Map(); this.resourceIds = new Map(); this.external = new Map(); this.online = new Map();
    this.abort = new AbortController(); this.tail = Promise.resolve(); this.info = null; this.options = null; this.profile = null;
  }
  context() { return { task_id: this.taskId, timestamp: String(this.now()), src_type: 2, v2Enable: true }; }
  body() { return { ...this.context(), video_path: this.play.file.path }; }
  assertOpen() { if (this.closed) throw failure('播放会话已结束', 410); }
  async describe({ external = true, signal } = {}) {
    this.assertOpen();
    this.touched = true;
    const info = await this.nas.request('v2/stream/transcode/pre_info', { method: 'POST', body: this.body(), signal: signal || this.abort.signal });
    this.assertOpen(); this.info = info; this.options = playbackOptions(info);
    const warnings = [];
    if (external) {
      try {
        const result = await this.nas.request('v2/stream/transcode/subtitle/list', { method: 'POST', body: { ...this.context(), videoPath: this.play.file.path, supports: SUBTITLE_EXTENSIONS, ignore_filter: true }, signal: signal || this.abort.signal });
        this.assertOpen(); this.external.clear();
        for (const path of Array.isArray(result?.result) ? result.result : []) if (typeof path === 'string' && path && path.length < 8192) {
          const id = randomBytes(14).toString('hex'); this.external.set(id, path);
          this.options.subtitles.push({ id: `external:${id}`, kind: 'external', label: basename(path), codec: path.split('.').pop().toLowerCase(), text: /\.(srt|ass|ssa|vtt)$/i.test(path) });
        }
      } catch (error) { if (this.closed || error.name === 'AbortError') throw error; warnings.push({ feature: 'externalSubtitles', message: error.message }); }
    }
    return { ...this.options, selected: this.profile?.id || 'original', warnings };
  }
  selectQuality(id, { preferH264 = true } = {}) {
    const work = this.tail.catch(() => {}).then(async () => {
      this.assertOpen();
      if (!this.options) await this.describe({ external: false });
      const quality = this.options.qualities.find(item => item.id === id);
      if (!quality) throw failure('此影片没有这个画质选项');
      if (quality.original) { await this.closeTask(); this.profile = null; this.resources.clear(); this.resourceIds.clear(); return { kind: 'original', quality }; }
      const createdHere = !this.created;
      try {
        if (createdHere) {
          // Mark before sending: a timed-out create may already be running on NAS.
          this.created = true;
          await this.nas.request('v2/stream/transcode/create', { method: 'POST', body: this.body(), signal: this.abort.signal });
        }
        const info = await this.nas.request('v2/stream/transcode/info', { method: 'POST', body: this.body(), signal: this.abort.signal });
        this.assertOpen();
        const stillAvailable = playbackOptions(info).qualities.some(item => item.id === id);
        if (!stillAvailable) throw failure('NAS 当前无法提供这个画质', 409);
        const url = new URL(info.redir_link, this.nas.config.server);
        // Only consume the NAS's opaque video_name; never follow this URL. A
        // transport adapter can legitimately change the network origin.
        if (url.pathname !== ROOT + 'play') throw failure('NAS 返回了无效的转码地址', 502);
        const videoName = url.searchParams.get('video_name');
        if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(videoName || '') || videoName.includes('..')) throw failure('NAS 没有返回转码影片标识', 502);
        const m3u8File = `${videoName}_${quality.resolution}.m3u8`;
        await this.nas.request('v2/stream/transcode/play', { query: { ...this.context(), m3u8_file: m3u8File, regen: 0, prefer_h264: Boolean(preferH264) }, signal: this.abort.signal });
        this.assertOpen(); this.profile = { ...quality, m3u8File };
        return { kind: 'hls', quality, preferH264: Boolean(preferH264) };
      } catch (error) { if (createdHere) await this.closeTask().catch(() => {}); throw error; }
    });
    this.tail = work; return work;
  }
  resource(id) {
    this.assertOpen(); const resource = this.resources.get(id);
    if (!resource) throw failure('播放分段已过期', 404);
    return { path: resource.path, query: { ...resource.query, ...this.context() }, manifest: resource.manifest };
  }
  registerResource(uri, source) {
    const origin = new URL(this.nas.config.server).origin;
    const url = new URL(uri, new URL(source, origin));
    if (url.origin !== origin || !url.pathname.startsWith(ROOT) || url.username || url.password || url.hash) throw failure('NAS 播放列表包含不受支持的分段地址', 502);
    if (url.searchParams.has('task_id') && url.searchParams.get('task_id') !== this.taskId) throw failure('NAS 播放列表的会话归属不匹配', 502);
    for (const key of ['token', 'ugk', 'client']) url.searchParams.delete(key);
    const query = Object.fromEntries(url.searchParams);
    const canonicalQuery = new URLSearchParams(query);
    for (const key of ['task_id', 'timestamp', 'src_type', 'v2Enable']) canonicalQuery.delete(key);
    canonicalQuery.sort(); const canonical = url.pathname + '?' + canonicalQuery;
    if (this.resourceIds.has(canonical)) return this.resourceIds.get(canonical);
    const id = randomBytes(16).toString('hex');
    if (this.resources.size >= 24000) throw failure('播放列表分段数量超过限制', 502);
    this.resources.set(id, { path: url.pathname, query, manifest: /\.m3u8$/i.test(url.pathname) || url.pathname.endsWith('/m3u8') });
    this.resourceIds.set(canonical, id);
    return id;
  }
  async manifest(makeUrl, resourceId, signal) {
    this.assertOpen(); if (!this.profile) throw failure('尚未选择转码画质', 409);
    if (typeof makeUrl !== 'function') throw new TypeError('A local resource URL mapper is required');
    const source = resourceId ? this.resource(resourceId) : { path: ROOT + 'm3u8', query: { ...this.context(), m3u8_file: this.profile.m3u8File } };
    const res = await this.nas.open(source.path, { query: source.query, signal: signal || this.abort.signal });
    const bytes = await readBounded(res, this.maxManifestBytes);
    if (res.statusCode !== 200 || !bytes.toString('utf8').trimStart().startsWith('#EXTM3U')) throw failure('NAS 尚未提供有效播放列表', 502);
    this.assertOpen();
    const sourceUrl = source.path + '?' + new URLSearchParams(source.query);
    const body = rewriteHls(bytes.toString('utf8'), uri => makeUrl(this.registerResource(uri, sourceUrl)));
    return { body, contentType: 'application/vnd.apple.mpegurl; charset=utf-8' };
  }
  async subtitle(id, { format = 'vtt', encoding = 'auto', offset = 0, signal } = {}) {
    this.assertOpen();
    const path = this.external.get(String(id).replace(/^external:/, ''));
    if (!path) throw failure('字幕不存在或不属于此播放会话', 404);
    const response = await this.nas.open(ROOT + 'subtitle', { query: { ...this.context(), subtitle_path: path }, signal: signal || this.abort.signal });
    const bytes = await readBounded(response, 8 * 1024 * 1024);
    if (response.statusCode !== 200) throw failure('NAS 字幕读取失败', 502);
    if (format === 'original') return { body: bytes, contentType: /\.(ass|ssa)$/i.test(path) ? 'text/x-ass' : 'application/octet-stream' };
    if (format !== 'vtt') throw failure('不支持的字幕输出格式');
    return { body: subtitleToVtt(decodeSubtitle(bytes, encoding), { extension: path.split('.').pop(), offset }), contentType: 'text/vtt; charset=utf-8' };
  }
  async trackPreferences() {
    this.assertOpen();
    const result = await this.nas.request('v1/video/details/media_tracks', { query: { file_path: this.play.file.path }, signal: this.abort.signal });
    return {
      audio: { index: nativeIndex(result?.audio_tracks?.index), language: language(result?.audio_tracks?.language) },
      subtitle: { type: Number(result?.subtitle_tracks?.type) || 0, index: nativeIndex(result?.subtitle_tracks?.index), language: language(result?.subtitle_tracks?.language) },
    };
  }
  async skips({ duration = Number(this.play.file.duration || this.play.item?.duration) || Number(this.info?.duration) / 1000000 } = {}) {
    this.assertOpen();
    if (!this.play.item?.categoryId) return { enabled: false, ranges: [] };
    const result = await this.nas.request('v1/video/skipper', { query: { category_id: this.play.item.categoryId, path: this.play.file.path }, signal: this.abort.signal });
    const ranges = [];
    for (const range of Array.isArray(result?.skipper_params) ? result.skipper_params : []) {
      if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end < 0) continue;
      let start = range.start, end = range.end;
      // The official player measures `ed` backwards from the duration; these
      // are not already absolute positions like the `op` range.
      if (range.type === 'ed') { if (!Number.isFinite(duration) || duration <= 0) continue; start = duration - range.start; end = duration - range.end; }
      else if (range.type !== 'op') continue;
      if (start >= 0 && end > start) ranges.push({ start, end, type: range.type });
    }
    return { enabled: result?.switch_type === 1, ranges };
  }
  async setSkipEnabled(enabled) {
    this.assertOpen(); if (typeof enabled !== 'boolean') throw failure('无效的跳片头片尾设置');
    await this.nas.request('v1/video/skipper/switch', { method: 'POST', body: { switch_type: enabled ? 1 : 0 }, signal: this.abort.signal });
    return { enabled };
  }
  async searchSubtitles({ query = this.play.item?.name || '', language: lang = 'zh-cn', page = 1 } = {}) {
    this.assertOpen();
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,4})?$/.test(lang) || !Number.isInteger(page) || page < 1 || page > 100) throw failure('无效的字幕搜索条件');
    const result = await this.nas.request('v2/stream/transcode/subtitles/search', { method: 'POST', body: { query: query.trim(), language: lang, video_path: this.play.file.path, page, size: 20 }, signal: this.abort.signal });
    this.assertOpen();
    const items = [];
    for (const item of Array.isArray(result?.data) ? result.data : []) {
      const fileId = Number(item.file_id ?? item.fileId); if (!Number.isInteger(fileId) || fileId < 0) continue;
      const id = randomBytes(14).toString('hex');
      this.online.set(id, { fileId, featureId: item.feature_id ?? item.featureId, language: language(item.language) || lang });
      items.push({ id, label: basename(item.file_name ?? item.fileName) || `字幕 ${items.length + 1}`, language: language(item.language) || lang, downloads: Number(item.download_count ?? item.downloadCount) || 0, status: Number(item.status) || 0 });
    }
    while (this.online.size > 200) this.online.delete(this.online.keys().next().value);
    return { items, page: Number(result?.page) || page, pages: Number(result?.total_pages ?? result?.totalPages) || 0, total: Number(result?.total_count ?? result?.totalCount) || 0 };
  }
  /** Explicit user action: NAS may create/download a subtitle beside this movie. */
  async downloadSubtitle(id) {
    this.assertOpen(); const selected = this.online.get(id);
    if (!selected) throw failure('字幕搜索结果已过期', 404);
    const body = { file_id: selected.fileId, language: selected.language, video_path: this.play.file.path };
    if (Number.isInteger(selected.featureId)) body.feature_id = selected.featureId;
    const result = await this.nas.request('v2/stream/transcode/subtitles/download/status', { method: 'POST', body, signal: this.abort.signal });
    this.assertOpen(); const path = text(result?.file_path ?? result?.filePath); let subtitle;
    if (path && path.length < 8192) { const key = randomBytes(14).toString('hex'); this.external.set(key, path); subtitle = { id: `external:${key}`, label: basename(path), codec: path.split('.').pop().toLowerCase(), kind: 'external' }; }
    // Report the provider's status; a path alone is not proof that bytes exist.
    return { status: Number(result?.status), subtitle };
  }
  /** Explicit destructive action only; paths cannot be supplied by the browser. */
  async deleteSubtitle(id) {
    this.assertOpen(); const key = String(id).replace(/^external:/, ''), path = this.external.get(key);
    if (!path) throw failure('字幕不存在或不属于此播放会话', 404);
    await this.nas.request('v2/stream/transcode/subtitles/delete', { method: 'DELETE', query: { file_path: path }, signal: this.abort.signal });
    this.external.delete(key); return { ok: true };
  }
  async closeTask() {
    if (!this.created && !this.touched) return;
    await this.nas.request('v2/stream/transcode/close', { query: this.context() });
    this.created = false; this.touched = false;
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true; this.abort.abort();
    this.closing = this.tail.catch(() => {}).then(() => this.closeTask()).finally(() => { this.resources.clear(); this.resourceIds.clear(); this.external.clear(); this.online.clear(); });
    return this.closing;
  }
}

async function readBounded(response, maximum) {
  const chunks = []; let length = 0;
  for await (const chunk of response) { length += chunk.length; if (length > maximum) { response.destroy(); throw failure('NAS 返回的数据超过读取限制', 502); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function rewriteHls(input, map) {
  return input.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (!line.startsWith('#')) return map(line.trim());
    return line.replace(/\bURI="([^"\r\n]+)"/g, (_, uri) => `URI="${map(uri)}"`);
  }).join('\n');
}

export function decodeSubtitle(bytes, encoding = 'auto') {
  const allowed = new Set(['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'big5', 'shift_jis', 'windows-1252']);
  if (!allowed.has(encoding)) throw failure('不支持的字幕编码');
  if (encoding !== 'auto') return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); } catch { throw failure('字幕编码无法识别，请手动选择编码'); } }
}

const cueText = value => value.replace(/<\/?(?:script|style)\b[^>]*>/gi, '').replace(/<(?!\/?(?:b|i|u|c|ruby|rt|v|lang)(?:[\s>.]|$))[^>]*>/gi, '');
function seconds(value) { const p = value.trim().replace(',', '.').split(':').map(Number); if (p.some(v => !Number.isFinite(v))) return NaN; return p.reduce((sum, v) => sum * 60 + v, 0); }
function timestamp(value) { const ms = Math.max(0, Math.round(value * 1000)); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; }
export function subtitleToVtt(input, { extension = 'srt', offset = 0 } = {}) {
  if (!Number.isFinite(offset) || Math.abs(offset) > 600) throw failure('字幕延迟超出范围');
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); const cues = [];
  if (/^(ass|ssa)$/i.test(extension) || /^\[Script Info\]/im.test(source)) {
    let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    let inEvents = false;
    for (const line of source.split('\n')) {
      if (/^\[/.test(line)) inEvents = /^\[Events\]/i.test(line.trim());
      if (!inEvents) continue;
      if (/^Format:/i.test(line)) { fields = line.slice(line.indexOf(':') + 1).split(',').map(s => s.trim().toLowerCase()); continue; }
      if (!/^Dialogue:/i.test(line)) continue;
      const pieces = line.slice(line.indexOf(':') + 1).trim().split(',');
      if (pieces.length < fields.length || fields.indexOf('text') !== fields.length - 1) continue;
      const textIndex = fields.indexOf('text'), start = seconds(pieces[fields.indexOf('start')]), end = seconds(pieces[fields.indexOf('end')]);
      const content = pieces.slice(textIndex).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
      if (Number.isFinite(start) && end > start) cues.push({ start, end, content });
    }
  } else {
    for (const block of source.replace(/^WEBVTT[^\n]*\n/, '').split(/\n\s*\n/)) {
      const lines = block.split('\n'); const index = lines.findIndex(line => /-->/.test(line));
      if (index < 0) continue;
      const match = lines[index].match(/^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{2,3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{2,3})(?:\s+.*)?$/);
      if (!match) continue;
      const start = seconds(match[1]), end = seconds(match[2]);
      if (Number.isFinite(start) && end > start) cues.push({ start, end, content: lines.slice(index + 1).join('\n') });
    }
  }
  if (!cues.length && source.trim()) throw failure('字幕格式无法转换为文本字幕');
  return 'WEBVTT\n\n' + cues.filter(c => c.end + offset > 0).map(c => `${timestamp(c.start + offset)} --> ${timestamp(c.end + offset)}\n${cueText(c.content)}`).join('\n\n') + '\n';
}
