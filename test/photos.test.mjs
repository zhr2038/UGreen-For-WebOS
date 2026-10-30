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
