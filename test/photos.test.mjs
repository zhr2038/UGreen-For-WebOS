import test from 'node:test';
import assert from 'node:assert/strict';
import { Photos, photoQuery, normalizePhoto } from '../lib/photos.mjs';

test('photo queries bound page size and use the Android TV photo filters', () => {
  assert.equal(photoQuery(new URLSearchParams()).limit, 48);
  assert.equal(photoQuery(new URLSearchParams('offset=48&sort=oldest&filter=video')).sort_order, 1);
  assert.deepEqual(photoQuery(new URLSearchParams('filter=video')).type_option, { all: 0, gif: 0, image: 0, live: 0, video: 1, raw: 0 });
  for (const query of ['offset=-1', 'offset=NaN', 'offset=1.5', 'offset=10000001', 'sort=other', 'filter=other']) assert.throws(() => photoQuery(new URLSearchParams(query)), { status: 400 });
  assert.equal(normalizePhoto({ picture_id: 12, show_type: 2, real_ext_name: 'HEIC' }).kind, 'image');
  assert.equal(normalizePhoto({ picture_id: 12, show_type: 1 }).kind, 'video');
  assert.equal(normalizePhoto({ picture_id: 12, duration: '06:27' }).duration, 387);
  assert.deepEqual(photoQuery(new URLSearchParams('filter=live')).type_option, { all: 0, gif: 0, image: 0, live: 1, video: 0, raw: 0 });
  assert.deepEqual(photoQuery(new URLSearchParams('filter=raw')).type_option, { all: 0, gif: 0, image: 0, live: 0, video: 0, raw: 1 });
});

test('original and live sources are owner-scoped byte streams and cannot enter preview resizing', async () => {
  const photos = new Photos({ request: async () => ({ list: [{ picture_id: 9, file_name: 'sample.heic', real_ext_name: 'HEIC', file_path: '/private/sample.heic', width: 4032, height: 3024, size: 1234, livephoto_type: 1 }], total: 1 }) });
  const result = await photos.list(new URLSearchParams(), 'owner'); const p = result.items[0];
  assert.equal(p.output.nativeUhdConfirmed, false); assert.equal(p.output.browserOriginalCandidate, false); assert.equal(p.format, 'heic');
  const original = photos.get(p.original.split('/').pop(), 'owner');
  assert.equal(original.kind, 'photoOriginal'); assert.equal(photos.stream(original).query.size_type, 0);
  assert.equal(photos.stream(original).path, '/ugreen/v5/photo/picture/stream');
  await assert.rejects(photos.image(original), { status: 400 });
  assert.throws(() => photos.get(p.original.split('/').pop(), 'other'), { status: 404 });
  const motion = photos.get(p.motion.split('/').pop(), 'owner'); assert.deepEqual({ size: photos.stream(motion).query.size_type, thumb: photos.stream(motion).query.get_thumb }, { size: 5, thumb: 1 });
  assert.equal(JSON.stringify(result).includes('/private'), false);
});

test('AI category handles retain trusted NAS descriptors, exclude hidden people and bind listings to one client', async () => {
  const calls = []; const photos = new Photos({ request: async (path, options) => {
    calls.push({ path, ...options });
    if (path.endsWith('figure/list')) return { list: [{ uuid: 'person-1', name: '示例人物', cover: 20, total: 2, lock: 1 }, { uuid: 'hidden', hidden: 1, cover: 21 }], total: 2 };
    return { list: [{ picture_id: 20, file_name: 'sample.jpg' }], total: 2 };
  } });
  const groups = await photos.categories(new URLSearchParams('kind=figure'), 'owner'); assert.equal(groups.items.length, 1, 'Locked classification names are not the same as hidden/private albums');
  assert.equal(JSON.stringify(groups).includes('person-1'), false);
  const id = groups.items[0].id;
  const result = await photos.list(new URLSearchParams({ group: id }), 'owner'); assert.equal(result.items.length, 1);
  assert.equal(calls[1].path, 'v5/photo/ai/picture/list'); assert.deepEqual(calls[1].body.album_option, { album_type: 100, uuid: 'person-1' });
  await assert.rejects(photos.list(new URLSearchParams({ group: id }), 'other'), { status: 404 });
  photos.groups.get(id).expires = 0; await assert.rejects(photos.list(new URLSearchParams({ group: id }), 'owner'), { status: 404 });
  await assert.rejects(photos.categories(new URLSearchParams('kind=unknown'), 'owner'), { status: 400 });
});

test('photo details and OCR/name searches use explicit read-only native API contracts', async () => {
  const calls = [], photo = { picture_id: 8, file_name: 'sample.jpg', file_path: '/private/sample.jpg', width: 4000, height: 3000, camera_model: 'Camera', latitude: '1.2' };
  const photos = new Photos({ request: async (path, options) => { calls.push({ path, ...options }); return path.endsWith('picture/info') ? photo : { list: [photo], total: 1 }; } });
  const list = await photos.list(new URLSearchParams('search=receipt&searchType=5'), 'owner'); assert.equal(calls[0].path, 'v5/photo/search/cate'); assert.equal(calls[0].body.category, 5); assert.equal(calls[0].body.name, 'receipt');
  const info = await photos.info(new URLSearchParams({ asset: list.items[0].view.split('/').pop() }), 'owner');
  assert.equal(calls[1].path, 'v5/photo/picture/info'); assert.equal(calls[1].query.picture_id, '8'); assert.equal(info.metadata.camera, 'Camera');
  assert.equal(JSON.stringify(info).includes('/private'), false); assert.equal(JSON.stringify(info).includes('latitude'), false);
  const music = photos.capability({ music_id: 'track' }, 'owner', 'music'); const before = calls.length;
  await assert.rejects(photos.info(new URLSearchParams({ asset: music.split('/').pop() }), 'owner'), { status: 400 }); assert.equal(calls.length, before);
  await assert.rejects(photos.list(new URLSearchParams('search=test&searchType=999'), 'owner'), { status: 400 });
});

test('sensitive-image show/hide only changes this preview capability and keeps grid thumbnails blurred', async () => {
  const calls = [], image = { picture_id: 11, file_name: 'sensitive.jpg', real_ext_name: 'jpg', sensitivity: 1 }, video = { picture_id: 12, file_name: 'sensitive.mp4', real_ext_name: 'mp4', sensitivity: 1, show_type: 1 };
  const photos = new Photos({ request: async (path, options) => { calls.push({ path, ...options }); return path.endsWith('/info') ? String(options.query.picture_id) === '12' ? video : image : { list: [image, video], total: 2 }; } });
  const list = await photos.list(new URLSearchParams(), 'owner'); assert.equal(list.items[0].original, ''); assert.equal(list.items[1].stream, '');
  const key = list.items[0].view.split('/').pop(); assert.equal(photos.get(key, 'owner').source.isBlur, true);
  const shown = await photos.previewVisibility({ asset: key, show: true }, 'owner'); assert.equal(shown.item.sensitive, true); assert.equal(shown.item.revealed, true);
  assert.equal(photos.get(shown.item.view.split('/').pop(), 'owner').source.isBlur, false); assert.equal(photos.get(shown.item.thumb.split('/').pop(), 'owner').source.isBlur, true); assert.ok(shown.item.original);
  const hidden = await photos.previewVisibility({ asset: shown.item.view.split('/').pop(), show: false }, 'owner'); assert.equal(hidden.item.revealed, false); assert.equal(hidden.item.original, '');
  assert.equal(calls.filter(call => call.path.endsWith('/info')).every(call => !call.method || call.method === 'GET'), true); assert.equal(calls.some(call => /delete|collect\/|edit|hide/.test(call.path)), false);
  await assert.rejects(photos.previewVisibility({ asset: key, show: true }, 'other'), { status: 404 }); await assert.rejects(photos.previewVisibility({ asset: key, show: 'true' }, 'owner'), { status: 400 });
});

test('album capabilities hide NAS paths, retain shared album context and are scoped and bounded', async () => {
  const calls = [], photo = { picture_id: 23, file_name: 'clip.mov', file_path: '/private/clip.mov', upload_time: 100, show_type: 1 };
  const nas = { request: async (path, options) => {
    calls.push({ path, ...options });
    if (path.endsWith('album/list')) return { result: [{ album_uuid: 'album-1', album_type: 2, album_name: '示例相册', total: 49, cover: { picture_id: 23, upload_time: 100 } }], total: 1 };
    return { list: [photo], total: 49 };
  } };
  const photos = new Photos(nas);
  const albums = await photos.albums(new URLSearchParams(), 'owner');
  assert.equal(albums.items[0].total, 49); assert.equal(albums.last, true);
  const data = await photos.list(new URLSearchParams('album=album-1&type=2&offset=48'), 'owner');
  assert.equal(data.last, true); assert.equal(data.items[0].kind, 'video');
  assert.ok(!JSON.stringify(data).includes('/private/')); assert.ok(!JSON.stringify(data).includes('salt'));
  assert.equal(calls[1].path, 'v5/photo/album/picture/list'); assert.equal(calls[1].body.offset, 48);
  const key = data.items[0].view.split('/').pop();
  assert.equal(photos.get(key, 'owner').source.source_album_uuid, 'album-1');
  assert.throws(() => photos.get(key, 'other'), { status: 404 });
  const clip = photos.get(data.items[0].stream.split('/').pop(), 'owner'); assert.equal(clip.source.id, '23');
  photos.assets.get(key).expires = 0; assert.throws(() => photos.get(key, 'owner'), { status: 404 });
  await assert.rejects(photos.list(new URLSearchParams('album=../secret&type=2'), 'owner'), { status: 400 });
  await photos.list(new URLSearchParams('favorites=1'), 'owner');
  assert.equal(calls.at(-1).path, 'v5/photo/picture/collect/list');
  for (let i = 1; i < 2200; i++) photos.capability({ id: String(i) }, 'owner', 'photoTile');
  assert.equal(photos.assets.size, 2048);
});
