import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../app/movie-media.js', import.meta.url), 'utf8');
function harness(options = {}) {
  class Video extends EventTarget {
    constructor() { super(); this.src = this.currentSrc = '/old'; this.currentTime = 321; this.duration = 1000; this.paused = true; this.playbackRate = 1.5; this.preload = 'metadata'; this.readyState = 4; this.seeking = false; this.loads = []; }
    load() {
      this.readyState = 0; this.currentTime = 0; this.currentSrc = this.src; this.loads.push(this.src);
      if (options.hold && this.src === '/new' || options.holdOld && this.src === '/old') return;
      queueMicrotask(() => {
        if (options.fail && this.src === '/new') return this.dispatchEvent(new Event('error'));
        this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); this.readyState = 4; this.dispatchEvent(new Event('loadeddata'));
      });
    }
    play() { this.paused = false; return Promise.resolve(); }
  }
  const video = new Video(), calls = [], warnings = [], candidate = { id: 'play', candidateId: 'candidate', sourceId: 'candidate', stream: '/new' };
  const p = { id: 'play', connection: { token: 'opaque' }, stream: '/old' }; let playback = p, valid = true;
  const abort = new AbortController(), active = { id: 'play', sourceId: 'candidate', stream: '/new', kind: 'hls', quality: { id: '720p', label: '720P' } };
  const context = { id: p.id, playback: p, sourceUrl: '/new', signal: abort.signal, isCurrent: () => valid };
  const window = {};
  vm.runInNewContext(source, { window, DOMException, setTimeout, clearTimeout, AbortController });
  const media = window.createMovieMedia({ video, getPlayback: () => playback, asset: x => x, timeoutMs: 20, onWarning: s => warnings.push(s),
    api: async (path, body, _signal, connection) => {
      calls.push({ path, body, connection, decoded: video.readyState >= 2, position: video.currentTime });
      if (body?.action === 'commit') { if (options.commit) return options.commit(); if (options.lost) throw new Error('Lost response'); return active; }
      if (path.startsWith('/api/play/active')) { if (options.unknown) throw new Error('Offline'); return active; }
      return {};
    },
  });
  return { media, video, calls, warnings, candidate, context, p, active, abort, replace(p) { playback = p; }, invalidate() { valid = false; } };
}
test('quality commits only after decoded data, preserving position, pause and rate', async () => {
  const h = harness(); await h.media.switchSource(h.candidate, h.context);
  const commit = h.calls.find(x => x.body?.action === 'commit'); assert.equal(commit.decoded, true); assert.equal(commit.position, 321);
  assert.equal(h.video.currentTime, 321); assert.equal(h.video.paused, true); assert.equal(h.video.playbackRate, 1.5); assert.equal(h.p.sourceId, 'candidate'); assert.equal(h.video.preload, 'metadata'); assert.equal(h.media.switching(), false);
});
test('decoder rejection restores old source and discards the candidate without commit', async () => {
  const h = harness({ fail: true }); await assert.rejects(h.media.switchSource(h.candidate, h.context), /解码/);
  assert.deepEqual(h.video.loads, ['/new', '/old']); assert.equal(h.video.currentTime, 321); assert.ok(h.calls.some(x => x.body?.action === 'discard')); assert.ok(!h.calls.some(x => x.body?.action === 'commit'));
});
test('settings cancellation restores old source and closes a pending candidate', async () => {
  const h = harness({ hold: true }), job = h.media.switchSource(h.candidate, h.context); h.abort.abort();
  await assert.rejects(job, { name: 'AbortError' }); assert.equal(h.video.src, '/old'); assert.ok(h.calls.some(x => x.body?.action === 'discard'));
});
test('late cancellation cannot reload the old film over a newly selected film', async () => {
  const h = harness({ hold: true }), job = h.media.switchSource(h.candidate, h.context); h.replace({ id: 'next' }); h.video.src = '/next'; h.media.cancel();
  await assert.rejects(job, { name: 'AbortError' }); assert.equal(h.video.src, '/next'); assert.equal(h.media.switching(), false); assert.ok(!h.video.loads.includes('/old'));
});
test('a lost commit response is reconciled using authoritative active source', async () => {
  const h = harness({ lost: true }); await h.media.switchSource(h.candidate, h.context);
  assert.equal(h.p.sourceId, 'candidate'); assert.deepEqual(h.video.loads, ['/new']); assert.ok(h.calls.some(x => x.path.startsWith('/api/play/active'))); assert.ok(!h.calls.some(x => x.body?.action === 'discard'));
});
test('unknown commit outcome never rolls back to a possibly closed old task', async () => {
  const h = harness({ lost: true, unknown: true }); await assert.rejects(h.media.switchSource(h.candidate, h.context), /Lost response/);
  assert.deepEqual(h.video.loads, ['/new']); assert.equal(h.warnings.length, 1); assert.ok(!h.calls.some(x => x.body?.action === 'discard'));
});
test('closing settings during commit does not undo a confirmed source promotion', async () => {
  let resolve; const gate = new Promise(r => resolve = r); const h = harness({ commit: () => gate });
  const job = h.media.switchSource(h.candidate, h.context); await new Promise(r => setTimeout(r, 0)); h.invalidate(); h.abort.abort(); resolve(h.active); await job;
  assert.equal(h.p.sourceId, 'candidate'); assert.deepEqual(h.video.loads, ['/new']);
});
test('a source that never decodes times out and leaves no active operation', async () => {
  const h = harness({ hold: true }); await assert.rejects(h.media.switchSource(h.candidate, h.context), /超时/);
  assert.equal(h.video.src, '/old'); assert.equal(h.media.switching(), false);
});
test('a pending quality operation exposes the last valid position instead of reload zero', async () => {
  const h = harness({ hold: true }), job = h.media.switchSource(h.candidate, h.context);
  assert.equal(h.video.currentTime, 0); assert.equal(h.media.snapshot().position, 321); assert.equal(h.media.snapshot().duration, 1000);
  h.abort.abort(); await assert.rejects(job, { name: 'AbortError' });
});
test('a slow rollback cannot seek a newly opened film to the previous film position', async () => {
  const h = harness({ fail: true, holdOld: true }), job = h.media.switchSource(h.candidate, h.context);
  await new Promise(r => setTimeout(r, 0)); assert.equal(h.video.src, '/old');
  h.replace({ id: 'next' }); h.media.cancel(); h.video.src = '/next'; h.video.load();
  await assert.rejects(job, /解码/); await new Promise(r => setTimeout(r, 0));
  assert.equal(h.video.currentTime, 0); assert.equal(h.video.src, '/next'); assert.equal(h.media.switching(), false);
});
test('a decoded candidate waiting for commit exposes its current valid progress', async () => {
  let resolve; const gate = new Promise(r => resolve = r), h = harness({ commit: () => gate });
  const job = h.media.switchSource(h.candidate, h.context); await new Promise(r => setTimeout(r, 0)); h.video.currentTime = 654;
  assert.equal(h.media.snapshot().position, 654); resolve(h.active); await job;
});
