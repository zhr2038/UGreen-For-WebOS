import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem, playbackFiles, libraryQuery, progressBody } from '../lib/ugos.mjs';

test('UGOS history records retain resume position and the episode cover', () => {
  const got = normalizeItem({ video_info: { ug_video_info_id: 12, name: '示例电影', type: 2, duration: 3000, file_path: ['/show.mkv'], poster_path: 'poster' }, play_status: { current_play_time: 420, progress: .14, episode: 3, cover_path: 'episode-still' } });
  assert.equal(got.position, 420); assert.equal(got.coverPath, 'episode-still'); assert.equal(got.episode, 3); assert.equal(got.type, 2);
});
test('multiple TV episode file versions remain distinct and ordered', () => {
  const got = playbackFiles({ tv_info: [{ episode: 1, ug_television_episode_id: 40, ep_name: '第一集', file_info: [{ path: '/s1-hd.mkv' }, { path: '/s1-4k.mkv' }] }, { episode: 2, ug_television_episode_id: 41, file_info: { path: '/s2.mkv' } }] });
  assert.deepEqual(got.map(f => [f.path, f.episode, f.episodeId]), [['/s1-hd.mkv', 1, 40], ['/s1-4k.mkv', 1, 40], ['/s2.mkv', 2, 41]]);
});
test('library requests include UGOS sentinel filters and the selected library', () => {
  const q = libraryQuery({ page: 2, libraryId: 7 });
  assert.equal(q.release_date_begin, -9999999999); assert.equal(q.watch_status, -1); assert.equal(q.video_type, -1); assert.equal(q.classification, 7); assert.equal(q.page, 2);
  assert.equal(libraryQuery({ classification: -102 }).classification, -102);
});
test('progress sync associates the selected episode and clamps completion', () => {
  const play = { item: { id: 10, categoryId: 'movie', libraryId: 2, type: 2, duration: 3600 }, file: { path: '/episode.mkv', episode: 2, episodeId: 33 } };
  const body = progressBody(play, 1200.9, 2400), p = body.recently_played;
  assert.equal(body.app_name, 'LG_webOS');
  assert.equal(p.progress, .5); assert.equal(p.current_play_time, 1200); assert.equal(p.ug_television_episode_id, 33);
  assert.equal(progressBody(play, 5000, 2400).recently_played.progress, 1);
});
