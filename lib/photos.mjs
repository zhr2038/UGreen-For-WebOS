import { createHash, randomBytes } from 'node:crypto';
import https from 'node:https';
import { Transform } from 'node:stream';
import { photoOutputInfo } from './photo-output.mjs';
import { PhotoCollections } from './photo-collections.mjs';
import { PhotoVideoSessions } from './photo-video.mjs';
import { UgOS } from './ugos.mjs';

// Contracts from the installed UGOS Android TV 1.21.0 album client (x4/b).
export const PHOTO_PAGE_SIZE = 48;
const typeOption = { all: 1, gif: 0, image: 0, live: 0, video: 0, raw: 0 };
const invalid = message => Object.assign(new Error(message), { status: 400 });
const personalRange = () => ({ personal: 1, share: 1, share_manage: 0, share_download: 0, share_view_only: 0 });
const categoryTypes = Object.freeze({ figure: 100, pet: 102, object: 103, custom: 104, city: 105 });
const categoryLabels = Object.freeze({ figure: '人物', pet: '宠物', object: '事物', custom: '自定义分类', city: '地点' });
const text = value => String(value ?? '').slice(0, 512);
const accountKeys = ['server', 'alias', 'username', 'uid', 'token', 'staticToken', 'authMode', 'clientId', 'tlsFingerprint', 'nasPublicRsa', 'password'];
const accountIdentity = nas => createHash('sha256').update(JSON.stringify(accountKeys.map(key => nas?.config?.[key] ?? null))).digest('hex');
const changed = () => Object.assign(new Error('NAS 账号或相册连接已切换，请重新打开相册'), { status: 410 });
const assetExpired = () => Object.assign(new Error('照片链接已过期，请重新打开相册'), { status: 404 });
const assetAccount = new WeakMap(), assetKey = Symbol('private photo capability key');
function privateConfig(value) {
  const config = { ...value };
  for (const key of accountKeys) if (key in config) Object.defineProperty(config, key, { value: config[key], enumerable: true, writable: false, configurable: false });
  return config;
}
// Production clients must own their configuration and Agent. The plain-object
// branch preserves callable offline fakes without ever borrowing their Agent.
function snapshotNas(nas) {
  let snapshot;
  if (typeof nas?.snapshot === 'function') snapshot = nas.snapshot();
  else if (nas instanceof UgOS) snapshot = new UgOS(privateConfig(nas.config));
  else if (nas && Object.getPrototypeOf(nas) === Object.prototype) snapshot = { ...nas, config: privateConfig(nas.config), httpsAgent: new https.Agent({ keepAlive: true, maxCachedSessions: 0 }) };
  else throw Object.assign(new Error('NAS 未提供独立的相册连接'), { status: 503 });
  if (!snapshot || snapshot === nas || typeof snapshot.then === 'function' || snapshot.httpsAgent && snapshot.httpsAgent === nas.httpsAgent) throw Object.assign(new Error('NAS 未提供独立的相册连接'), { status: 503 });
  Object.defineProperty(snapshot, 'config', { value: privateConfig(snapshot.config), enumerable: true, writable: false, configurable: false });
  return snapshot;
}
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback, value) => { if (done) return; done = true; signal.removeEventListener('abort', abort); callback(value); };
    const abort = () => finish(reject, signal.reason || new DOMException('Photo request aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
export function photoQuery(params) {
  const offset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) throw invalid('无效照片页码');
  const sort = params.get('sort') || 'date';
  if (!['date', 'upload', 'oldest'].includes(sort)) throw invalid('无效照片排序');
  const filter = params.get('filter') || 'all';
  if (!['all', 'image', 'video', 'live', 'raw', 'gif'].includes(filter)) throw invalid('无效照片类型');
  return {
    offset, limit: PHOTO_PAGE_SIZE, sort_by: sort === 'upload' ? 1 : 0, sort_order: sort === 'oldest' ? 1 : 0, total: 1,
    type_option: filter === 'all' ? { ...typeOption } : { ...typeOption, all: 0, ...(filter === 'image' ? { image: 1, gif: 1, live: 1, raw: 1 } : { [filter]: 1 }) },
  };
}
export function photoSource(photo, album) {
  return {
    id: String(photo.picture_id || ''), mtime: photo.upload_time || photo.mtime || 0,
    salt: photo.file_path ? createHash('md5').update(photo.file_path).digest('hex') : undefined,
    source_album_uuid: photo.source_album_uuid || album?.id || undefined,
    source_album_type: photo.source_album_type ?? album?.type,
    folder_id: photo.source_folder_id || undefined,
    ...(Number(photo.sensitivity) ? { isBlur: true } : {}),
  };
}
export function normalizePhoto(p) {
  const ext = String(p.real_ext_name || p.file_name?.split('.').pop() || '').replace(/^\./, '').toLowerCase();
  const duration = typeof p.duration === 'string' && p.duration.includes(':')
    ? p.duration.split(':').reduce((seconds, component) => seconds * 60 + (Number(component) || 0), 0)
    : Number(p.duration) || 0;
  return {
    id: String(p.picture_id), name: p.file_name || '未命名照片', width: p.width || 0, height: p.height || 0,
    date: Number(p.create_time_utc) || Number(p.upload_time) || 0,
    kind: Number(p.show_type) === 1 || /^(mp4|mov|m4v|mkv|avi|mts|m2ts|webm)$/.test(ext) ? 'video' : 'image',
    live: Number(p.show_type) === 2 || Boolean(Number(p.livephoto_type)) || Boolean(p.is_live_photo), duration,
    favorite: Boolean(p.collect), format: ext, size: Math.max(0, Number(p.size) || 0), sensitive: Boolean(Number(p.sensitivity)),
  };
}

class PhotoAccount {
  constructor(upstream, { current, retire }) {
    this.epoch = randomBytes(20).toString('hex'); this.current = current; this.retire = retire; this.closed = false; this.abort = new AbortController(); this.streams = new Set();
    const captured = snapshotNas(upstream); Object.defineProperty(this, 'captured', { value: captured });
    const nas = { request: (path, options) => this.call('request', path, options), open: (path, options) => this.call('open', path, options), snapshot: () => { this.assert(); return snapshotNas(captured); } };
    Object.defineProperty(nas, 'config', { get: () => captured.config });
    Object.defineProperty(nas, 'httpsAgent', { get: () => captured.httpsAgent });
    Object.defineProperty(this, 'nas', { value: nas });
    this.assets = new Map(); this.groups = new Map();
    this.collections = new PhotoCollections({ nas, epoch: this.epoch, assert: () => this.assert(), present: (...args) => this.present(...args), capability: (...args) => this.capability(...args), photoSource });
    this.videos = new PhotoVideoSessions(this);
    // HLS task children own further snapshots so retirement can still close an
    // old NAS task without borrowing global credentials or this account Agent.
    for (const method of ['start', 'quality', 'commit', 'discard', 'manifest', 'close']) {
      const run = this.videos[method].bind(this.videos);
      this.videos[method] = async (...args) => { this.assert(); try { const result = await run(...args); this.assert(); return result; } catch (error) { this.assert(); throw error; } };
    }
    for (const method of ['get', 'hls', 'resource', 'active']) { const run = this.videos[method].bind(this.videos); this.videos[method] = (...args) => { this.assert(); return run(...args); }; }
  }
  assert() { if (this.closed || !this.current()) { this.retire(this); throw changed(); } }
  call(method, path, options = {}) {
    this.assert(); const signal = options.signal ? AbortSignal.any([this.abort.signal, options.signal]) : this.abort.signal;
    const operation = Promise.resolve().then(async () => {
      this.assert(); if (signal.aborted) throw signal.reason;
      let result = await this.captured[method](path, { ...options, signal });
      try { this.assert(); if (signal.aborted) throw signal.reason; }
      catch (error) { if (method === 'open') result?.destroy(); throw error; }
      if (method === 'open') {
        const upstream = result, account = this;
        const guarded = new Transform({ transform(chunk, encoding, callback) { try { account.assert(); callback(null, chunk); } catch (error) { callback(error); } } });
        guarded.statusCode = upstream.statusCode; guarded.headers = upstream.headers;
        const failed = error => guarded.destroy(error);
        upstream.once('error', failed); guarded.once('close', () => { upstream.off('error', failed); upstream.destroy(); });
        upstream.pipe(guarded); result = guarded;
        this.streams.add(result);
        const stop = () => result.destroy(), cleanup = () => { signal.removeEventListener('abort', stop); this.streams.delete(result); result.off('end', cleanup); result.off('close', cleanup); result.off('error', cleanup); };
        result.once('end', cleanup); result.once('close', cleanup); result.once('error', cleanup); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      }
      return result;
    });
    return abortable(operation, signal);
  }
  clear() {
    if (this.closing) return this.closing;
    this.closed = true; this.abort.abort(changed()); for (const stream of this.streams) stream.destroy(); this.streams.clear();
    this.assets.clear(); this.groups.clear(); this.collections.clear();
    this.closing = Promise.resolve(this.videos.clear()).finally(() => this.captured.httpsAgent?.destroy()); return this.closing;
  }
  capability(source, owner, kind) {
    this.assert();
    if (kind === 'music' ? !/^[\w-]{1,128}$/.test(source.music_id || '') : !/^\d+$/.test(source.id) || source.id === '0') return '';
    const key = createHash('sha256').update(JSON.stringify([this.epoch, source, owner, kind])).digest('hex').slice(0, 40);
    this.assets.delete(key);
    const asset = { owner, kind, expires: Date.now() + 2 * 3600000 };
    Object.defineProperty(asset, 'source', { value: Object.freeze({ ...source }) }); Object.defineProperty(asset, assetKey, { value: key });
    assetAccount.set(asset, this); this.assets.set(key, asset);
    while (this.assets.size > 2048) this.assets.delete(this.assets.keys().next().value);
    return (kind === 'video' ? '/photo-video/' : kind === 'photoOriginal' ? '/photo-original/' : kind === 'live' ? '/photo-motion/' : kind === 'music' ? '/photo-music/' : '/photo-image/') + key;
  }
  get(key, owner) {
    this.assert();
    const asset = this.assets.get(key);
    if (!asset || asset.owner !== owner || asset.expires < Date.now()) throw assetExpired();
    asset.expires = Date.now() + 2 * 3600000;
    this.assets.delete(key); this.assets.set(key, asset);
    return asset;
  }
  present(p, owner, album, { reveal = false } = {}) {
    const photo = normalizePhoto(p), thumbSource = photoSource(p, album), source = { ...thumbSource };
    if (photo.sensitive && reveal) source.isBlur = false;
    const view = this.capability(source, owner, 'photoView');
    return {
      ...photo, revealed: photo.sensitive && reveal, thumb: this.capability(thumbSource, owner, 'photoTile'), view,
      stream: photo.kind === 'video' && (!photo.sensitive || reveal) ? this.capability(source, owner, 'video') : '',
      original: photo.kind === 'image' && (!photo.sensitive || reveal) ? this.capability(source, owner, 'photoOriginal') : '',
      motion: photo.live && (!photo.sensitive || reveal) ? this.capability(source, owner, 'live') : '',
      info: view ? '/api/photos/info?asset=' + view.slice(view.lastIndexOf('/') + 1) : '',
      output: photoOutputInfo(photo),
    };
  }
  async info(params, owner) {
    const asset = this.get(params.get('asset'), owner), source = asset.source;
    if (asset.kind === 'music' || !/^[1-9][0-9]*$/.test(source.id || '')) throw invalid('无效照片信息请求');
    const raw = await this.nas.request('v5/photo/picture/info', { query: { picture_id: source.id, source_album_uuid: source.source_album_uuid, source_album_type: source.source_album_type } });
    if (!raw || String(raw.picture_id) !== source.id) throw new Error('NAS 照片详情格式已变化');
    return {
      item: this.present(raw, owner, source.source_album_uuid ? { id: source.source_album_uuid, type: source.source_album_type } : undefined),
      metadata: {
        camera: text(raw.camera_model), lens: text(raw.lens_model), focalLength: text(raw.focal), exposure: text(raw.exposure), aperture: text(raw.aperture), iso: text(raw.iso),
        created: text(raw.create_time), modified: text(raw.modify_time),
        location: [raw.country, raw.province, raw.city_name, raw.addr_detail].filter(Boolean).map(text).join(' · '),
      },
    };
  }
  async previewVisibility({ asset: key, show }, owner) {
    if (typeof show !== 'boolean') throw invalid('请明确选择显示或隐藏图像');
    const asset = this.get(key, owner), source = asset.source;
    if (asset.kind === 'music' || !/^\d+$/.test(source.id || '')) throw invalid('无效照片预览');
    const raw = await this.nas.request('v5/photo/picture/info', { query: { picture_id: source.id, source_album_uuid: source.source_album_uuid, source_album_type: source.source_album_type } });
    if (!raw || String(raw.picture_id) !== source.id) throw new Error('NAS 照片详情格式已变化');
    // This changes only the returned preview capability. No sensitivity flag,
    // file, favourite or persistent album property is written on the NAS.
    return { item: this.present(raw, owner, source.source_album_uuid ? { id: source.source_album_uuid, type: source.source_album_type } : undefined, { reveal: show }) };
  }
  async categories(params, owner) {
    const { offset, limit } = photoQuery(params), kind = params.get('kind') || 'figure';
    if (!Object.hasOwn(categoryTypes, kind)) throw invalid('无效照片分类');
    const query = kind === 'city' ? { sort_by: 0, sort_order: 0, offset, limit, map_cover: 0 } : { order_by: 0, order_sort: 0, offset, limit, show_hidden: 0, show_name: 0 };
    const data = await this.nas.request(`v5/photo/ai/${kind}/list`, { query });
    if (!Array.isArray(data?.list)) throw new Error('NAS 照片分类格式已变化');
    const items = data.list.filter(p => !Number(p.hidden)).map(p => {
      const descriptor = kind === 'city' ? { album_type: categoryTypes[kind], country: text(p.country), province: text(p.province), city_name: text(p.city_name) } : { album_type: categoryTypes[kind], uuid: text(p.uuid), ...(p.common_album_type == null ? {} : { common_album_type: Number(p.common_album_type) }) };
      if (kind !== 'city' && !/^[\w-]{1,128}$/.test(descriptor.uuid)) throw new Error('NAS 返回了无效分类标识');
      const id = createHash('sha256').update(JSON.stringify([this.epoch, owner, descriptor])).digest('hex').slice(0, 40);
      this.groups.delete(id); this.groups.set(id, { owner, descriptor, expires: Date.now() + 2 * 3600000 });
      while (this.groups.size > 1024) this.groups.delete(this.groups.keys().next().value);
      const cover = typeof p.cover === 'object' ? p.cover : { picture_id: p.cover, upload_time: p.upload_time || p.update_time };
      return { id, kind, name: text(p.name_cn || p.name || p.city_name || (kind === 'figure' ? '未命名人物' : categoryLabels[kind])), total: Number(p.total ?? p.photo_count) || 0, cover: this.capability(photoSource(cover), owner, 'photoTile') };
    });
    const total = Number(data.actual_total ?? data.total) || items.length;
    return { items, kind, title: categoryLabels[kind], total, offset, limit, last: data.list.length < limit || offset + data.list.length >= total };
  }
  async albums(params, owner) {
    const { offset, limit } = photoQuery(params);
    const data = await this.nas.request('v5/photo/album/list', { method: 'POST', body: { sort_by: 4, sort_order: 0, album_type: [1, 2, 3, 4], share_select: [1, 2, 3], offset, limit } });
    if (!Array.isArray(data?.result)) throw new Error('NAS 相册列表格式已变化');
    return {
      items: data.result.map(a => ({ id: a.album_uuid, type: a.album_type, name: a.album_name || '未命名相册', total: Number(a.total) || 0, cover: this.capability(photoSource(a.cover || {}, { id: a.album_uuid, type: a.album_type }), owner, 'photoTile') })),
      total: Number(data.total) || 0, offset, limit, last: data.result.length < limit || offset + data.result.length >= data.total,
    };
  }
  folders(params, owner) { return this.collections.folders(params, owner, photoQuery(params)); }
  memories(params, owner) { return this.collections.memories(params, owner, photoQuery(params)); }
  music(params, owner) { return this.collections.music(owner); }
  async list(params, owner) {
    const body = photoQuery(params), albumId = params.get('album'), groupId = params.get('group'), search = params.get('search')?.trim();
    if (params.get('folder')) return this.collections.folders(params, owner, body);
    if (params.get('memory')) return this.collections.memoryPictures(params, owner, body);
    let path, album;
    if (groupId) {
      const group = this.groups.get(groupId);
      if (!group || group.owner !== owner || group.expires < Date.now()) throw Object.assign(new Error('分类链接已过期，请重新打开分类'), { status: 404 });
      group.expires = Date.now() + 2 * 3600000;
      Object.assign(body, { album_uuid: '', album_type: 0, album_option: { ...group.descriptor }, range_option: personalRange(), create_time_range: 1 });
      path = 'v5/photo/ai/picture/list';
    } else if (search) {
      if (search.length > 200) throw invalid('搜索内容过长');
      const category = Number(params.get('searchType') || 8);
      if (![5, 8].includes(category)) throw invalid('无效照片搜索类型');
      Object.assign(body, { category, name: search, range_option: personalRange() });
      path = 'v5/photo/search/cate';
    } else if (albumId) {
      const type = Number(params.get('type'));
      if (!/^[\w-]{1,128}$/.test(albumId) || ![1, 2, 3, 4].includes(type)) throw invalid('无效相册');
      album = { id: albumId, type };
      Object.assign(body, { album_uuid: albumId, album_type: type, provider_option: { provider_mine: 1, provider_other: 1 } });
      path = 'v5/photo/album/picture/list';
    } else {
      Object.assign(body, { range_option: personalRange() });
      path = params.get('favorites') === '1' ? 'v5/photo/picture/collect/list' : 'v5/photo/picture/timeline/list';
    }
    const data = await this.nas.request(path, { method: 'POST', body });
    if (!Array.isArray(data?.list)) throw new Error('NAS 照片列表格式已变化');
    return {
      items: data.list.map(p => this.present(p, owner, album)),
      total: Number(data.total) || 0, offset: body.offset, limit: body.limit,
      last: data.list.length < body.limit || (data.total != null && body.offset + data.list.length >= Number(data.total)),
    };
  }
  stream(asset) {
    this.assert();
    if (assetAccount.get(asset) !== this || this.assets.get(asset[assetKey]) !== asset || asset.expires < Date.now()) throw assetExpired();
    let path, query;
    if (asset.kind === 'music') { path = '/ugreen/v5/photo/picture/slideshow/music/stream'; query = { music_id: asset.source.music_id, resource_ticket: asset.source.resource_ticket }; }
    else {
    // Original and Live Photo motion are streamed directly. Never pass them
    // through the preview thumbnail decoder/cache or relabel HEIF as JPEG.
    const size_type = asset.kind === 'photoOriginal' || asset.kind === 'video' ? 0 : asset.kind === 'live' ? 5 : asset.kind === 'photoView' ? 3 : 1;
      path = '/ugreen/v5/photo/picture/stream'; query = { ...asset.source, size_type, ...(asset.kind === 'live' ? { get_thumb: 1 } : {}) };
    }
    const descriptor = { path };
    Object.defineProperty(descriptor, 'query', { value: Object.freeze(query) }); Object.defineProperty(descriptor, 'nas', { value: this.nas });
    return Object.freeze(descriptor);
  }
  async image(asset) {
    if (['photoOriginal', 'live', 'video', 'music'].includes(asset.kind)) throw invalid('原图和音视频必须使用流式读取');
    const stream = this.stream(asset);
    const upstream = await stream.nas.open(stream.path, { query: stream.query });
    if (upstream.statusCode !== 200) { upstream.destroy(); throw new Error('NAS 照片读取失败'); }
    const chunks = []; let size = 0;
    for await (const chunk of upstream) {
      this.assert();
      size += chunk.length;
      if (size > 12 * 1024 * 1024) { upstream.destroy(); throw new Error('NAS 照片预览过大'); }
      chunks.push(chunk);
    }
    this.assert(); return Buffer.concat(chunks);
  }
}

/** Current-account facade. An old result can never enter a later generation. */
export class Photos {
  #account; #closing = new Set();
  constructor(nas) { Object.defineProperty(this, 'nas', { value: nas, writable: true }); }
  #retire(account) {
    if (this.#account === account) this.#account = null;
    const closing = account.clear(); this.#closing.add(closing); closing.finally(() => this.#closing.delete(closing)).catch(() => {}); return closing;
  }
  #current() {
    const identity = accountIdentity(this.nas);
    if (this.#account && this.#account.identity !== identity) this.#retire(this.#account);
    if (!this.#account) {
      const account = new PhotoAccount(this.nas, { current: () => this.#account === account && identity === accountIdentity(this.nas), retire: old => this.#retire(old) });
      account.identity = identity; this.#account = account;
    }
    return this.#account;
  }
  get assets() { return this.#current().assets; }
  get groups() { return this.#current().groups; }
  get collections() { return this.#current().collections; }
  get videos() { return this.#current().videos; }
  clear() { if (this.#account) this.#retire(this.#account); return Promise.allSettled([...this.#closing]); }
  capability(...args) { return this.#current().capability(...args); }
  present(...args) { return this.#current().present(...args); }
  get(...args) { return this.#current().get(...args); }
  stream(asset) { const account = this.#current(); if (assetAccount.get(asset) !== account) throw assetExpired(); return account.stream(asset); }
  async image(asset) { const account = this.#current(); if (assetAccount.get(asset) !== account) throw assetExpired(); try { const result = await account.image(asset); account.assert(); return result; } catch (error) { account.assert(); throw error; } }
  async #read(method, args) { const account = this.#current(); try { const result = await account[method](...args); account.assert(); return result; } catch (error) { account.assert(); throw error; } }
  list(...args) { return this.#read('list', args); }
  albums(...args) { return this.#read('albums', args); }
  categories(...args) { return this.#read('categories', args); }
  info(...args) { return this.#read('info', args); }
  previewVisibility(...args) { return this.#read('previewVisibility', args); }
  folders(...args) { return this.#read('folders', args); }
  memories(...args) { return this.#read('memories', args); }
  music(...args) { return this.#read('music', args); }
}
