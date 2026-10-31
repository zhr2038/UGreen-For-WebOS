import { randomBytes } from 'node:crypto';
import { PlaybackSession, playbackOptions } from './playback.mjs';
import { UgOS } from './ugos.mjs';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const ROOT = '/ugreen/v2/stream/transcode/';
const SNAPSHOT = Symbol('private photo connection snapshot');

/** Album TV protocol. Source IDs come only from a Photos owner capability. */
export class PhotoVideoSession extends PlaybackSession {
  constructor(nas, source, options) {
    if (!/^[1-9][0-9]*$/.test(source?.id || '') || !Number.isSafeInteger(Number(source.id))) throw invalid('无效相册视频');
    // PlaybackSession requires a source marker; this is an authorized picture
    // ID, never a file path supplied by the browser. body() does not send it as
    // video_path, and describe() never calls movie-only subtitle APIs.
    super(nas, { file: { path: source.id } }, options);
    this.source = { ...source };
    const extra = {};
    if (source.source_album_uuid) extra.source_album_uuid = source.source_album_uuid;
    if (source.source_album_type != null) extra.source_album_type = source.source_album_type;
    this.custom = Object.keys(extra).length ? Buffer.from(JSON.stringify(extra)).toString('base64') : undefined;
  }
  context() { return { task_id: this.taskId, timestamp: String(this.now()), src_type: 5 }; }
  body() {
    return { ...this.context(), video_path_id: Number(this.source.id), path_type: 1, is_net_disk_direct: false, ...(this.custom ? { transcode_custom_query: this.custom } : {}) };
  }
  async describe({ signal } = {}) {
    this.assertOpen(); this.touched = true;
    const info = await this.nas.request('v2/stream/transcode/info', { method: 'POST', body: this.body(), query: { transcode_custom_query: this.custom }, signal: signal || this.abort.signal });
    this.assertOpen(); this.info = info; this.options = playbackOptions(info);
    return { ...this.options, selected: this.profile?.id || 'original', warnings: [] };
  }
  selectQuality(id) {
    const work = this.tail.catch(() => {}).then(async () => {
      this.assertOpen();
      if (!this.options) await this.describe();
      const quality = this.options.qualities.find(item => item.id === id);
      if (!quality) throw invalid('此相册视频没有这个画质选项');
      if (quality.original) {
        await this.closeTask(); this.profile = null; this.resources.clear(); this.resourceIds.clear();
        return { kind: 'original', quality };
      }
      // The album app's info call prepares the task; its interface has no
      // create method. Refresh after returning to original closed that task.
      if (!this.touched) await this.describe();
      this.assertOpen();
      if (!this.options.qualities.some(item => item.id === id)) throw invalid('NAS 当前无法提供这个画质', 409);
      const url = new URL(this.info.redir_link, this.nas.config.server);
      if (url.pathname !== ROOT + 'play') throw invalid('NAS 返回了无效的相册转码地址', 502);
      const videoName = url.searchParams.get('video_name');
      if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(videoName || '') || videoName.includes('..')) throw invalid('NAS 没有返回相册转码标识', 502);
      const m3u8File = `${videoName}_${quality.resolution}.m3u8`;
      await this.nas.request('v2/stream/transcode/play', { query: { ...this.context(), m3u8_file: m3u8File, regen: 0 }, signal: this.abort.signal });
      this.assertOpen(); this.profile = { ...quality, m3u8File };
      return { kind: 'hls', quality };
    });
    this.tail = work; return work;
  }
}

/** Bounded caller-owned album video tasks, with no browser path input. */
export class PhotoVideoSessions {
  constructor(photos, { now = Date.now, createSession = (nas, source) => new PhotoVideoSession(nas, source), ttlMs = 30 * 60_000, candidateTtlMs = 120_000, maximum = 16, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.photos = photos; this.now = now; this.createSession = createSession; this.ttlMs = ttlMs; this.candidateTtlMs = candidateTtlMs; this.maximum = maximum; this.sessions = new Map(); this.candidates = new Map(); this.setTimer = setTimer; this.clearTimer = clearTimer; this.generation = 0;
  }
  capture(source, upstream = this.photos.nas) {
    const snapshot = typeof upstream.snapshot === 'function' ? upstream.snapshot() : new UgOS({ ...upstream.config });
    if (!snapshot || snapshot === upstream || typeof snapshot.then === 'function') throw invalid('NAS 未提供独立的播放连接', 503);
    const destroy = () => snapshot.httpsAgent?.destroy();
    let session;
    try { session = this.createSession(snapshot, { ...source }); } catch (error) { destroy(); throw error; }
    const close = session.close.bind(session); let closing;
    session.close = () => closing ||= Promise.resolve().then(close).finally(destroy);
    session[SNAPSHOT] = snapshot;
    return session;
  }
  touch(id, record, candidate = false) {
    const collection = candidate ? this.candidates : this.sessions, ttl = candidate && record.state !== 'active' ? Math.max(1, record.deadline - this.now()) : this.ttlMs;
    this.clearTimer(record.timer); record.expires = this.now() + ttl; const epoch = record.timerEpoch = (record.timerEpoch || 0) + 1;
    record.timer = this.setTimer(() => {
      if (collection.get(id) !== record || record.timerEpoch !== epoch) return;
      (candidate ? this.drop(id) : this.closeRoot(id, record)).catch(() => {});
    }, ttl); record.timer?.unref?.();
  }
  async drop(id) {
    const record = this.candidates.get(id); if (!record) return;
    this.candidates.delete(id); this.clearTimer(record.timer);
    const root = this.sessions.get(record.rootId); if (root?.pending === id) root.pending = null; if (root?.active === id) root.active = null;
    await record.session?.close();
  }
  async closeRoot(id, record) {
    if (this.sessions.get(id) !== record) return;
    this.sessions.delete(id); this.clearTimer(record.timer);
    const results = await Promise.allSettled([record.initial?.close(), ...[...this.candidates].filter(([, candidate]) => candidate.rootId === id).map(([key]) => this.drop(key))]);
    return { cleanupConfirmed: results.every(result => result.status === 'fulfilled') };
  }
  async reap() {
    await Promise.allSettled([...this.sessions].filter(([, item]) => item.expires < this.now()).map(([id, item]) => this.closeRoot(id, item)));
    await Promise.allSettled([...this.candidates].filter(([, item]) => item.expires < this.now()).map(([id]) => this.drop(id)));
  }
  async start({ asset }, owner) {
    const source = this.photos.get(asset, owner), generation = this.generation;
    if (source.kind !== 'video' || source.source.isBlur === true) throw invalid('请先打开有权查看的相册视频');
    // Capture before any await: even clear-after-config-change must close the
    // original task with its original account and independently owned Agent.
    const initial = this.capture(source.source);
    try {
      await this.reap();
      if (generation !== this.generation) throw invalid('相册视频会话已关闭', 410);
      if (this.sessions.size >= this.maximum) throw invalid('相册视频会话过多，请先关闭其他视频', 429);
      const id = randomBytes(20).toString('hex'), record = { owner, initial, transport: initial[SNAPSHOT], source: { ...source.source }, original: '/photo-video/' + asset, active: null, pending: null };
      this.sessions.set(id, record); this.touch(id, record);
      try {
        const options = await initial.describe();
        if (this.sessions.get(id) !== record || generation !== this.generation) throw invalid('相册视频会话已关闭', 410);
        record.options = options; return { id, options, original: record.original };
      } catch (error) { await this.closeRoot(id, record); throw error; }
      finally { record.initial = null; }
    } finally { await initial.close().catch(() => {}); }
  }
  get(id, owner) {
    const record = this.sessions.get(id);
    if (!record || record.owner !== owner || record.expires < this.now()) throw invalid('相册视频会话已过期', 404);
    this.touch(id, record); return record;
  }
  async quality({ id, quality, request = randomBytes(12).toString('hex') }, owner) {
    const root = this.get(id, owner), selected = root.options?.qualities.find(item => item.id === quality);
    if (!selected || !/^[a-zA-Z0-9_-]{1,80}$/.test(request)) throw invalid('无效相册视频画质请求');
    // Snapshot is captured synchronously before cancellation/cleanup awaits.
    const session = selected.original ? null : this.capture(root.source, root.transport);
    const key = randomBytes(20).toString('hex'), candidate = { rootId: id, owner, request, quality: selected, session, state: 'loading', deadline: this.now() + this.candidateTtlMs };
    const previous = root.pending; root.pending = key; this.candidates.set(key, candidate); this.touch(key, candidate, true);
    try {
      if (previous) await this.drop(previous);
      if (this.sessions.get(id) !== root || this.candidates.get(key) !== candidate || root.pending !== key || candidate.deadline <= this.now()) throw invalid('画质切换已取消', 410);
      let result = { kind: 'original', quality: selected };
      if (session) {
        await session.describe();
        if (this.sessions.get(id) !== root || this.candidates.get(key) !== candidate || root.pending !== key || candidate.deadline <= this.now()) throw invalid('画质切换已取消', 410);
        result = await session.selectQuality(quality);
      }
      if (this.sessions.get(id) !== root || this.candidates.get(key) !== candidate || root.pending !== key || candidate.deadline <= this.now()) throw invalid('画质切换已取消', 410);
      candidate.state = 'ready';
      return { ...result, candidate: key, request, url: result.kind === 'original' ? root.original : `/photo-hls/${key}/master` };
    } catch (error) { await this.drop(key).catch(() => {}); throw error; }
  }
  async commit({ id, candidate: key }, owner) {
    const root = this.get(id, owner), candidate = this.candidates.get(key);
    if (!candidate || candidate.rootId !== id || candidate.owner !== owner || candidate.state !== 'ready' || root.pending !== key) throw invalid('画质候选已过期', 404);
    if (candidate.deadline <= this.now()) { await this.drop(key); throw invalid('画质候选已过期', 404); }
    const old = root.active; root.pending = null; root.active = candidate.session ? key : null; root.selected = candidate.quality.id;
    if (candidate.session) { candidate.state = 'active'; this.touch(key, candidate, true); } else await this.drop(key);
    let warning;
    if (old) { try { await this.drop(old); } catch { warning = '新画质已启用，之前的 NAS 转码任务关闭未确认'; } }
    // Once accepted, an old-task cleanup failure cannot truthfully turn this
    // into a failed selection and tell the UI to reload the retired source.
    return { ok: true, selected: root.selected, ...(warning ? { warning } : {}) };
  }
  async discard({ id, candidate: key, request }, owner) {
    const root = this.get(id, owner), pending = this.candidates.get(root.pending);
    if (pending && (key === root.pending || request === pending.request)) await this.drop(root.pending);
    return { ok: true };
  }
  hls(id, owner) {
    const record = this.candidates.get(id);
    if (!record || record.owner !== owner || record.expires < this.now() || !record.session || !['ready', 'active'].includes(record.state)) throw invalid('相册视频资源已过期', 404);
    this.get(record.rootId, owner); this.touch(id, record, true); return record.session;
  }
  async manifest(id, resource, owner, signal) {
    return this.hls(id, owner).manifest(key => `/photo-hls/${id}/${key}`, resource === 'master' ? undefined : resource, signal);
  }
  resource(id, resource, owner) { return this.hls(id, owner).resource(resource); }
  async close({ id }, owner) { const record = this.get(id, owner); const result = await this.closeRoot(id, record); return { ok: true, ...result }; }
  async clear() {
    ++this.generation;
    await Promise.allSettled([...this.sessions].map(([id, record]) => this.closeRoot(id, record)));
    await Promise.allSettled([...this.candidates.keys()].map(id => this.drop(id)));
  }
}
