import test from 'node:test';
import assert from 'node:assert/strict';
import { Photos } from '../lib/photos.mjs';

test('photo folder navigation only follows NAS-issued owner-bound paths and uses native storage/sort values', async () => {
  const calls = [];
  const photos = new Photos({ request: async (path, options) => {
    calls.push({ path, ...options });
    return options.body.path === '' ? { folders: [{ path: '/private/photos', storage_type: 1, folder_name: '照片', item_count: 3, covers: [{ picture_id: 3 }] }], files: [], current_folder: {} } : { folders: [], files: [{ picture_id: 3, file_name: 'example.jpg' }], current_folder: { folder_id: 17 } };
  } });
  const root = await photos.folders(new URLSearchParams(), 'owner'); assert.equal(calls[0].body.storage_type, 3); assert.equal(calls[0].body.sort_by, 2); assert.equal(calls[0].body.sort_order, 1);
  assert.equal(JSON.stringify(root).includes('/private'), false); assert.equal(root.totalKnown, false);
  const id = root.folders[0].id;
  const child = await photos.folders(new URLSearchParams({ folder: id, folderSort: 'size', folderOrder: 'desc' }), 'owner');
  assert.equal(calls[1].body.path, '/private/photos'); assert.equal(calls[1].body.storage_type, 1); assert.equal(calls[1].body.sort_by, 3); assert.equal(calls[1].body.sort_order, 0);
  assert.equal(child.breadcrumbs[0].id, id); assert.equal(child.items.length, 1);
  assert.equal(photos.get(child.items[0].view.split('/').pop(), 'owner').source.folder_id, 17);
  await assert.rejects(photos.folders(new URLSearchParams({ folder: id }), 'other'), { status: 404 });
  await assert.rejects(photos.folders(new URLSearchParams('folderSort=invalid'), 'owner'), { status: 400 });
});

test('recommended memory descriptors remain private and native playlists are fetched once then paged', async () => {
  const calls = []; const photos = new Photos({ request: async (path, options) => {
    calls.push({ path, ...options });
    if (path.endsWith('/recommend')) return { list: [{ recommend_type: 'album_event', name: '示例回忆', album_uuid: 'private-album', album_type: 2, event_uuid: 'private-event', cover: { picture_id: 1 } }] };
    return { list: Array.from({ length: 60 }, (_, index) => ({ picture_id: index + 1, file_name: 'example.jpg' })) };
  } });
  const memories = await photos.memories(new URLSearchParams(), 'owner'); assert.equal(JSON.stringify(memories).includes('private-event'), false);
  const id = memories.items[0].id;
  const first = await photos.list(new URLSearchParams({ memory: id }), 'owner'); const second = await photos.list(new URLSearchParams({ memory: id, offset: '48' }), 'owner');
  assert.equal(first.items.length, 48); assert.equal(second.items.length, 12); assert.equal(second.last, true); assert.equal(calls.length, 2);
  assert.equal(calls[1].query.event_uuid, 'private-event'); assert.equal(calls[1].query.limit, 1000);
  assert.equal(photos.get(first.items[0].view.split('/').pop(), 'owner').source.source_album_uuid, 'private-album');
  await assert.rejects(photos.list(new URLSearchParams({ memory: id }), 'other'), { status: 404 });
  photos.clear(); await assert.rejects(photos.list(new URLSearchParams({ memory: id }), 'owner'), { status: 404 });
});

test('NAS music tickets stay behind image-owner capabilities and never follow arbitrary stream URLs', async () => {
  const calls = []; const photos = new Photos({ request: async (path, options) => {
    calls.push({ path, ...options }); return { builtin_music: [{ music_id: 'builtin_1', name: '示例音乐', available: true, mime_type: 'audio/mpeg', stream_url: 'https://untrusted.example/not-used?resource_ticket=private-ticket' }, { music_id: 'not-available', available: false }], custom_music: [] };
  } });
  const music = await photos.music(new URLSearchParams(), 'owner'); assert.equal(music.items.length, 1); assert.equal(JSON.stringify(music).includes('private-ticket'), false); assert.equal(JSON.stringify(music).includes('untrusted'), false);
  const key = music.items[0].stream.split('/').pop(); const asset = photos.get(key, 'owner'); const target = photos.stream(asset);
  assert.equal(target.path, '/ugreen/v5/photo/picture/slideshow/music/stream'); assert.deepEqual(target.query, { music_id: 'builtin_1', resource_ticket: 'private-ticket' });
  assert.deepEqual(calls[0].body, { custom_music: [] });
  assert.throws(() => photos.get(key, 'other'), { status: 404 }); await assert.rejects(photos.image(asset), { status: 400 });
});
