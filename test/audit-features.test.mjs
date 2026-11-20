import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { linkSignals } from '../lib/linked-signal.mjs';
import { PlaybackSession, decodeSubtitle } from '../lib/playback.mjs';
import { MediaTrackController } from '../lib/playback-tracks.mjs';
import { rankLanAddresses } from '../lib/transport/trusted-lan.mjs';
import { createBridge } from '../lib/bridge.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('linkSignals detaches all parent abort listeners on dispose without leaking', () => {
  const parentA = new AbortController();
  const parentB = new AbortController();
  for (let i = 0; i < 20; i++) {
    const linked = linkSignals([parentA.signal, parentB.signal]);
    assert.equal(linked.signal.aborted, false);
    linked.dispose();
  }
  assert.equal(getEventListeners(parentA.signal, 'abort').length, 0);
  assert.equal(getEventListeners(parentB.signal, 'abort').length, 0);

  const linked = linkSignals([parentA.signal, parentB.signal]);
  parentA.abort(new Error('boom'));
  assert.equal(linked.signal.aborted, true);
  assert.equal(getEventListeners(parentA.signal, 'abort').length, 0);
  assert.equal(getEventListeners(parentB.signal, 'abort').length, 0);
});

test('decodeSubtitle returns 415 status when explicit encoding fails fatal decode', () => {
  const invalidUtf8 = Buffer.from([0x80, 0x81, 0xff]);
  assert.throws(() => decodeSubtitle(invalidUtf8, 'utf-8'), err => err.status === 415);
  assert.throws(() => decodeSubtitle(invalidUtf8, 'auto'), err => err.status === 415);
});

test('MediaTrackController.selectExternal forwards requested character encoding', async () => {
  let seen = null;
  const listeners = new Map();
  const video = {
    style: {}, audioTracks: [], textTracks: [],
    addEventListener(n, fn) { listeners.set(n, fn); }, removeEventListener() {},
    addTextTrack() { return { mode: 'hidden', cues: [], addCue(c) { this.cues.push(c); }, removeCue() {}, addEventListener() {}, removeEventListener() {} }; },
  };
  globalThis.VTTCue = class { constructor(s, e, t) { this.startTime = s; this.endTime = e; this.text = t; } };
  const ctrl = new MediaTrackController(video, {
    async loadSubtitle(id, opts) { seen = { id, opts }; return 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好\n'; },
  });
  ctrl.setSource('account:test', { subtitles: [{ id: 'ext-1', kind: 'external', label: 'chs.srt', language: 'zh', codec: 'srt' }] });
  await ctrl.selectExternal('ext-1', { encoding: 'gb18030' });
  assert.equal(seen.id, 'ext-1');
  assert.equal(seen.opts.encoding, 'gb18030');
  assert.equal(ctrl.selected.encoding, 'gb18030');
});

test('PlaybackSession.skips retains op ranges when duration is zero and saves track preferences', async () => {
  const calls = [];
  const nas = {
    config: { server: 'https://nas.example.invalid' },
    async request(path, opts) {
      calls.push({ path, opts });
      if (path === 'v1/video/skipper') return { switch_type: 1, skipper_params: [{ type: 'op', start: 5, end: 85 }, { type: 'ed', start: 90, end: 10 }] };
      if (path === 'v1/video/details/media_tracks' && opts?.method === 'POST') return {};
      return {};
    },
  };
  const session = new PlaybackSession(nas, { file: { path: '/Show/e01.mkv', duration: 0 }, item: { id: 1, categoryId: 'cat-1', name: 'Show' } });
  const skips = await session.skips({ duration: 0 });
  assert.equal(skips.enabled, true);
  assert.deepEqual(skips.ranges, [{ start: 5, end: 85, type: 'op' }]);

  await session.saveTrackPreferences({ audio: { index: 1, language: 'jpn' }, subtitle: { type: 0, index: -99, language: '' } });
  const post = calls.find(c => c.path === 'v1/video/details/media_tracks');
  assert.deepEqual(post.opts.body, { file_path: '/Show/e01.mkv', audio_tracks: { index: 1, language: 'jpn' }, subtitle_tracks: { type: 0, index: -99, language: '', subtitle_path: '' } });
});

test('rankLanAddresses deprioritizes virtual bridge gateway .1 addresses in favor of LAN host IP', () => {
  const ranked = rankLanAddresses(
    [{ family: 4, address: '172.17.0.1' }, { family: 4, address: '192.168.1.88' }],
    { eth0: [{ family: 'IPv4', address: '192.168.1.10', internal: false }] },
  );
  assert.equal(ranked[0].address, '192.168.1.88');
});

test('bridge exposes /api/filters, /api/watched and /api/history/delete with UGOS payloads', async t => {
  const calls = [];
  const dir = await mkdtemp(join(tmpdir(), 'bridge-audit-features-'));
  const mkNas = () => ({
    config: { server: 'https://nas.example.invalid', alias: 'demo', token: 'TOKEN', username: 'u', clientId: 'c' },
    httpsAgent: { destroy() {} },
    snapshot() { return mkNas(); },
    async request(path, opts = {}) {
      calls.push({ path, opts });
      if (path === 'v1/video/media_lib/filter/options') return { style_list: [{ id: 1, name: '科幻' }], country_list: [{ id: 2, name: '日本' }] };
      if (path === 'v1/video/recently_played/get') return { video_arr: [{ video_info: { ug_video_info_id: 55 }, play_status: { recently_played_id: 88 } }] };
      if (path === 'v1/video/all') return { total: 0, video_info_arr: [] };
      return {};
    },
  });
  const nas = mkNas();
  const bridge = await createBridge({ dir, config: nas.config, nasClient: nas, thumbnails: { make() {} }, host: '127.0.0.1', port: 0, clientToken: 'cap-audit' });
  t.after(async () => { await bridge.reset(); bridge.server.closeAllConnections(); await new Promise(r => bridge.server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + bridge.server.address().port;
  const headers = { Authorization: 'Bearer cap-audit', 'Content-Type': 'application/json' };

  const filters = await (await fetch(base + '/api/filters', { headers })).json();
  assert.equal(filters.styles[0].name, '科幻');
  assert.equal(filters.countries[0].name, '日本');
  assert.ok(filters.years.length > 0);
  assert.ok(filters.clarities.length > 0);

  assert.equal((await fetch(base + '/api/watched', { method: 'POST', headers, body: JSON.stringify({ id: 5, type: 2, library: 1, watched: true }) })).status, 200);
  const mark = calls.find(c => c.path === 'v1/video/recently_played/mark');
  assert.equal(mark.opts.body.watch_status, 2);
  assert.equal(mark.opts.body.folder_path, 'ALL');

  assert.equal((await fetch(base + '/api/history/delete', { method: 'POST', headers, body: JSON.stringify({ recentlyPlayedId: 42 }) })).status, 200);
  const delDirect = calls.find(c => c.path === 'v1/video/recently_played/delete' && c.opts.body.del_type === 1 && c.opts.body.recently_played_id_arr[0] === 42);
  assert.ok(delDirect);

  assert.equal((await fetch(base + '/api/history/delete', { method: 'POST', headers, body: JSON.stringify({ id: 55 }) })).status, 200);
  const delLookup = calls.find(c => c.path === 'v1/video/recently_played/delete' && c.opts.body.del_type === 1 && c.opts.body.recently_played_id_arr[0] === 88);
  assert.ok(delLookup);

  assert.equal((await fetch(base + '/api/history/delete', { method: 'POST', headers, body: JSON.stringify({ all: true }) })).status, 200);
  const delAll = calls.find(c => c.path === 'v1/video/recently_played/delete' && c.opts.body.del_type === 2);
  assert.deepEqual(delAll.opts.body.recently_played_id_arr, []);
});
