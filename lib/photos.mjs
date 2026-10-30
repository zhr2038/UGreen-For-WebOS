import { createHash } from 'node:crypto';

// Contracts from the installed UGOS Android TV 1.21.0 album client (x4/b).
export const PHOTO_PAGE_SIZE = 48;
const typeOption = { all: 1, gif: 0, image: 0, live: 0, video: 0, raw: 0 };
const invalid = message => Object.assign(new Error(message), { status: 400 });
export function photoQuery(params) {
  const offset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) throw invalid('无效照片页码');
  const sort = params.get('sort') || 'date';
  if (!['date', 'upload', 'oldest'].includes(sort)) throw invalid('无效照片排序');
  const filter = params.get('filter') || 'all';
  if (!['all', 'image', 'video'].includes(filter)) throw invalid('无效照片类型');
  return {
    offset, limit: PHOTO_PAGE_SIZE, sort_by: sort === 'upload' ? 1 : 0, sort_order: sort === 'oldest' ? 1 : 0, total: 1,
    type_option: filter === 'all' ? { ...typeOption } : { ...typeOption, all: 0, ...(filter === 'video' ? { video: 1 } : { image: 1, gif: 1, live: 1, raw: 1 }) },
  };
}
export function photoSource(photo, album) {
  return {
    id: String(photo.picture_id || ''), mtime: photo.upload_time || photo.mtime || 0,
    salt: photo.file_path ? createHash('md5').update(photo.file_path).digest('hex') : undefined,
    source_album_uuid: photo.source_album_uuid || album?.id || undefined,
    source_album_type: photo.source_album_type ?? album?.type,
    folder_id: photo.source_folder_id || undefined,
  };
}
export function normalizePhoto(p) {
  const ext = String(p.real_ext_name || p.file_name?.split('.').pop() || '').toLowerCase();
  const duration = typeof p.duration === 'string' && p.duration.includes(':')
    ? p.duration.split(':').reduce((seconds, component) => seconds * 60 + (Number(component) || 0), 0)
    : Number(p.duration) || 0;
  return {
    id: String(p.picture_id), name: p.file_name || '未命名照片', width: p.width || 0, height: p.height || 0,
    date: Number(p.create_time_utc) || Number(p.upload_time) || 0,
    kind: Number(p.show_type) === 1 || /^(mp4|mov|m4v|mkv|avi|mts|m2ts|webm)$/.test(ext) ? 'video' : 'image',
    live: Number(p.show_type) === 2 || Boolean(Number(p.livephoto_type)), duration,
    favorite: Boolean(p.collect),
  };
}

export class Photos {
  constructor(nas) { this.nas = nas; this.assets = new Map(); }
  capability(source, owner, kind) {
    if (!/^\d+$/.test(source.id) || source.id === '0') return '';
    const key = createHash('sha256').update(JSON.stringify([source, owner, kind])).digest('hex').slice(0, 40);
    this.assets.delete(key);
    this.assets.set(key, { source, owner, kind, expires: Date.now() + 2 * 3600000 });
    while (this.assets.size > 2048) this.assets.delete(this.assets.keys().next().value);
    return (kind === 'video' ? '/photo-video/' : '/photo-image/') + key;
  }
  get(key, owner) {
    const asset = this.assets.get(key);
    if (!asset || asset.owner !== owner || asset.expires < Date.now()) throw Object.assign(new Error('照片链接已过期，请重新打开相册'), { status: 404 });
    asset.expires = Date.now() + 2 * 3600000;
    this.assets.delete(key); this.assets.set(key, asset);
    return asset;
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
  async list(params, owner) {
    const body = photoQuery(params), albumId = params.get('album');
    let path, album;
    if (albumId) {
      const type = Number(params.get('type'));
      if (!/^[\w-]{1,128}$/.test(albumId) || ![1, 2, 3, 4].includes(type)) throw invalid('无效相册');
      album = { id: albumId, type };
      Object.assign(body, { album_uuid: albumId, album_type: type, provider_option: { provider_mine: 1, provider_other: 1 } });
      path = 'v5/photo/album/picture/list';
    } else {
      Object.assign(body, { range_option: { personal: 1, share: 1, share_manage: 0, share_download: 0, share_view_only: 0 } });
      path = params.get('favorites') === '1' ? 'v5/photo/picture/collect/list' : 'v5/photo/picture/timeline/list';
    }
    const data = await this.nas.request(path, { method: 'POST', body });
    if (!Array.isArray(data?.list)) throw new Error('NAS 照片列表格式已变化');
    return {
      items: data.list.map(p => {
        const photo = normalizePhoto(p), source = photoSource(p, album);
        return { ...photo, thumb: this.capability(source, owner, 'photoTile'), view: this.capability(source, owner, 'photoView'), stream: photo.kind === 'video' ? this.capability(source, owner, 'video') : '' };
      }),
      total: Number(data.total) || 0, offset: body.offset, limit: body.limit,
      last: data.list.length < body.limit || (data.total != null && body.offset + data.list.length >= Number(data.total)),
    };
  }
  async image(asset) {
    const upstream = await this.nas.open('/ugreen/v5/photo/picture/stream', { query: { ...asset.source, size_type: asset.kind === 'photoView' ? 3 : 1 } });
    if (upstream.statusCode !== 200) { upstream.destroy(); throw new Error('NAS 照片读取失败'); }
    const chunks = []; let size = 0;
    for await (const chunk of upstream) {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) { upstream.destroy(); throw new Error('NAS 照片预览过大'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
