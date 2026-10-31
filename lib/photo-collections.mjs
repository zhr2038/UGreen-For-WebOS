import { createHash, randomBytes } from 'node:crypto';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const expired = message => Object.assign(new Error(message), { status: 404 });
const label = value => String(value ?? '').slice(0, 512);
const FOLDER_SORT = Object.freeze({ name: 2, size: 3, date: 0, type: 6 });
const MAX_PLAYLIST = 1000;

// Read-only folder, recommended-memory and soundtrack access. Physical NAS
// paths and native descriptors stay in owner-bound maps, never in client URLs.
export class PhotoCollections {
  constructor({ nas, present, capability, photoSource, epoch = '', assert = () => {} }) { Object.defineProperty(this, 'nas', { value: nas }); this.present = present; this.capability = capability; this.photoSource = photoSource; this.handles = new Map(); this.epoch = epoch; this.assert = assert; this.generation = 0; this.nonce = randomBytes(20).toString('hex'); this.abort = new AbortController(); }
  clear() { this.generation++; this.abort.abort(expired('浏览连接已关闭')); this.abort = new AbortController(); this.nonce = randomBytes(20).toString('hex'); this.handles.clear(); }
  async request(path, options = {}) {
    this.assert(); const generation = this.generation, signal = options.signal ? AbortSignal.any([this.abort.signal, options.signal]) : this.abort.signal;
    const data = await this.nas.request(path, { ...options, signal }); this.assert(); if (generation !== this.generation || signal.aborted) throw expired('浏览连接已关闭'); return data;
  }
  handle(owner, kind, source, extra = {}) {
    this.assert(); const id = createHash('sha256').update(JSON.stringify([this.epoch, this.nonce, owner, kind, source])).digest('hex').slice(0, 40);
    const previous = this.handles.get(id);
    this.handles.delete(id); this.handles.set(id, { ...previous, ...extra, owner, kind, source, expires: Date.now() + 2 * 3600000 });
    while (this.handles.size > 512) this.handles.delete(this.handles.keys().next().value);
    return id;
  }
  get(id, owner, kind) {
    this.assert();
    const item = this.handles.get(id);
    if (!item || item.owner !== owner || item.kind !== kind || item.expires < Date.now()) throw expired('浏览链接已过期，请返回列表刷新');
    item.expires = Date.now() + 2 * 3600000;
    this.handles.delete(id); this.handles.set(id, item); return item;
  }
  async folders(params, owner, paging) {
    const id = params.get('folder'), current = id ? this.get(id, owner, 'folder') : { source: { path: '', storageType: 3 }, breadcrumbs: [] };
    const sort = params.get('folderSort') || 'name', order = params.get('folderOrder') || 'asc';
    if (!Object.hasOwn(FOLDER_SORT, sort) || !['asc', 'desc'].includes(order)) throw invalid('无效文件夹排序');
    const data = await this.request('v5/photo/picture/folder/list', { method: 'POST', body: { path: current.source.path, storage_type: current.source.storageType, hide_file: 0, hide_folder: 0, offset: paging.offset, limit: paging.limit, sort_by: FOLDER_SORT[sort], sort_order: order === 'asc' ? 1 : 0, type_option: paging.type_option } });
    if (!Array.isArray(data?.files) || !Array.isArray(data?.folders)) throw new Error('NAS 文件夹列表格式已变化');
    const folders = data.folders.map(folder => {
      if (typeof folder.path !== 'string' || !folder.path || folder.path.length > 4096) throw new Error('NAS 返回了无效文件夹');
      const source = { path: folder.path, storageType: Number(folder.storage_type ?? current.source.storageType) };
      const name = label(folder.folder_name || '文件夹'), folderId = this.handle(owner, 'folder', source);
      const breadcrumbs = [...current.breadcrumbs, { id: folderId, name }].slice(-32);
      this.handles.get(folderId).breadcrumbs = breadcrumbs;
      const cover = folder.covers?.[0];
      return { id: folderId, name, total: Number(folder.item_count) || 0, hasSubfolders: Boolean(folder.has_subdir), cover: cover ? this.capability(this.photoSource(cover), owner, 'photoTile') : '' };
    });
    const context = data.current_folder?.folder_id ? { source_folder_id: data.current_folder.folder_id } : {};
    const items = data.files.map(photo => this.present({ ...context, ...photo }, owner));
    const count = folders.length + items.length;
    return { items, folders, title: current.breadcrumbs.at(-1)?.name || '文件夹', breadcrumbs: current.breadcrumbs, total: paging.offset + count, totalKnown: false, offset: paging.offset, limit: paging.limit, last: count < paging.limit };
  }
  async memories(params, owner, paging) {
    this.assert();
    if (paging.offset !== 0) return { items: [], total: 0, totalKnown: true, offset: paging.offset, limit: paging.limit, last: true };
    const data = await this.request('v5/photo/album/recommend', { query: { limit: paging.limit, query_type: 0, total: 1, return_folder_album: 1 } });
    if (!Array.isArray(data?.list)) throw new Error('NAS 精选回忆格式已变化');
    const items = data.list.map(memory => {
      const type = label(memory.recommend_type);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(type)) throw new Error('NAS 返回了无效回忆类型');
      const source = { recommend_type: type, ...(memory.album_uuid ? { album_uuid: label(memory.album_uuid) } : {}), ...(memory.album_type == null ? {} : { album_type: Number(memory.album_type) }), ...(memory.event_uuid ? { event_uuid: label(memory.event_uuid) } : {}), ...(memory.latest_upload_time == null ? {} : { latest_upload_time: Number(memory.latest_upload_time) }) };
      return { id: this.handle(owner, 'memory', source), name: label(memory.name || '精选回忆'), total: Math.max(0, Number(memory.total) || 0), totalKnown: memory.total != null && Number.isFinite(Number(memory.total)), cover: memory.cover ? this.capability(this.photoSource(memory.cover), owner, 'photoTile') : '' };
    });
    return { items, total: items.length, totalKnown: true, offset: 0, limit: paging.limit, last: true };
  }
  async memoryPictures(params, owner, paging) {
    const memory = this.get(params.get('memory'), owner, 'memory');
    if (!memory.playlist) {
      const data = await this.request('v5/photo/album/recommend/playlist', { query: { ...memory.source, limit: MAX_PLAYLIST } });
      if (!Array.isArray(data?.list) || data.list.length > MAX_PLAYLIST) throw new Error('NAS 回忆播放列表格式已变化');
      memory.playlist = data.list;
      // Keep a small number of metadata playlists, not decoded images.
      const cached = [...this.handles.values()].filter(value => value.kind === 'memory' && value.playlist);
      for (const item of cached.slice(0, Math.max(0, cached.length - 4))) if (item !== memory) delete item.playlist;
    }
    const album = memory.source.album_uuid ? { id: memory.source.album_uuid, type: memory.source.album_type } : undefined;
    const items = memory.playlist.slice(paging.offset, paging.offset + paging.limit).map(photo => this.present({ ...photo, ...(memory.source.recommend_type === 'livephoto' ? { livephoto_type: 1 } : {}) }, owner, album));
    return { items, total: memory.playlist.length, totalKnown: true, playlistLimit: MAX_PLAYLIST, offset: paging.offset, limit: paging.limit, last: paging.offset + items.length >= memory.playlist.length };
  }
  async music(owner) {
    const data = await this.request('v5/photo/picture/slideshow/music/check', { method: 'POST', body: { custom_music: [] } });
    if (!Array.isArray(data?.builtin_music) || !Array.isArray(data?.custom_music)) throw new Error('NAS 幻灯片音乐格式已变化');
    const items = [...data.builtin_music.map(track => ({ ...track, builtin: true })), ...data.custom_music.map(track => ({ ...track, builtin: false }))].filter(track => track.available === true || track.available === 1).map(track => {
      const musicId = String(track.music_id || ''), mime = String(track.mime_type || 'audio/mpeg');
      if (!/^[\w-]{1,128}$/.test(musicId) || !/^audio\/[a-z0-9.+-]+$/i.test(mime)) throw new Error('NAS 返回了无效音乐资源');
      let ticket = track.resource_ticket;
      // Only recognised query values are retained. Arbitrary stream_url hosts
      // and paths are never fetched or forwarded by this module.
      if (!ticket && track.stream_url) { try { ticket = new URL(track.stream_url, 'http://localhost').searchParams.get('resource_ticket') || undefined; } catch {} }
      const url = this.capability({ music_id: musicId, ...(ticket ? { resource_ticket: String(ticket) } : {}) }, owner, 'music');
      return { id: url.slice(url.lastIndexOf('/') + 1), name: label(track.name || '背景音乐'), stream: url, mime, size: Math.max(0, Number(track.size) || 0), builtin: track.builtin };
    });
    return { items };
  }
}
