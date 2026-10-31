import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Photos } from '../lib/photos.mjs';
import { createPhotoUhdHttpHandler, validatePhotoUhdMp4 } from '../lib/photo-uhd.mjs';
import '../app/photo-uhd-pipeline.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), owner = value => createHash('sha256').update(value).digest('hex');
const avcC = Buffer.from('0142c033ffe100136742c0338c6803c0043e9a83030303c2211a8001000468ce3c80', 'hex');
const fhd = Buffer.from('0142c033ffe1001a6742c033d900780227e5c044000003000400000300083c60c92001000568cb83cb20', 'hex');
const mp4 = config => Buffer.from(PhotoUhdPipeline.muxAvcStill({ data: Uint8Array.from([0, 0, 0, 2, 101, 136]), avcC: config || avcC, width: 3840, height: 2160, durationMs: 15000 }));
const blocked = new Set([1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
const wait = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(condition) { const end = Date.now() + 2000; while (!condition()) { if (Date.now() > end) throw new Error('test condition timeout'); await wait(); } }
class Clock {
  now = 0; jobs = new Map(); next = 0;
  set = (callback, ms) => { const timer = { id: ++this.next, unref() {} }; this.jobs.set(timer.id, { callback, at: this.now + ms }); return timer; };
  clear = timer => this.jobs.delete(timer?.id);
  advance(ms) { this.now += ms; for (const [id, job] of [...this.jobs]) if (job.at <= this.now && this.jobs.delete(id)) job.callback(); }
}
async function fixture(t, options = {}) {
  const photos = new Photos({ config: { server: 'https://nas.invalid', token: 'fake-NAS-private-A' } }), image = photos.present({ picture_id: 8, file_name: 'synthetic.jpg', real_ext_name: 'jpg', width: 3840, height: 2160 }, owner(A));
  const asset = image.original.split('/').pop(), view = image.view.split('/').pop(), handler = createPhotoUhdHttpHandler({ photos, ...options });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), client = req.headers.authorization?.replace(/^Bearer /i, '') || url.searchParams.get('client');
    if (!await handler(req, res, { url, owner: [A, B].includes(client) ? owner(client) : undefined, urlContext: { client }, ...(options.signal ? { signal: options.signal } : {}) })) { res.writeHead(404); res.end(); }
  });
  do { server.listen(0, '127.0.0.1'); await once(server, 'listening'); if (!blocked.has(server.address().port)) break; await new Promise(resolve => server.close(resolve)); } while (true);
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await handler.dispose(); await photos.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const upload = async ({ bytes = mp4(), token = A, source = asset, contentType = 'video/mp4' } = {}) => { const res = await fetch(base + '/api/photos/uhd?asset=' + source, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType }, body: bytes }); return { status: res.status, body: await res.json() }; };
  const close = async (id, token = A) => { const res = await fetch(base + '/api/photos/uhd/close', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); return res.status; };
  return { photos, asset, view, handler, server, base, upload, close };
}

test('ordinary MP4 validator verifies actual SPS coded dimensions and rejects forged 4K labels', () => {
  const value = validatePhotoUhdMp4(mp4()); assert.equal(value.width, 3840); assert.equal(value.height, 2160); assert.equal(value.codedWidth, 3840); assert.equal(value.codec, 'avc1.42c033'); assert.equal(value.samples, 2); assert.equal(value.durationMs, 15000); assert.equal(value.nativeUhdConfirmed, false);
  assert.throws(() => validatePhotoUhdMp4(mp4(fhd)), { code: 'UHD_CODED_DIMENSIONS_REQUIRED' });
  for (const bytes of [Buffer.from('not MP4'), mp4().subarray(0, 200)]) assert.throws(() => validatePhotoUhdMp4(bytes));
  const offset = mp4(), at = offset.indexOf(Buffer.from('stco')); offset.writeUInt32BE(1, at + 12); assert.throws(() => validatePhotoUhdMp4(offset), { code: 'INVALID_SAMPLE_TABLE' });
  const nal = fhd.subarray(8, 8 + fhd.readUInt16BE(6)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(nal.length);
  const switched = Buffer.from(PhotoUhdPipeline.muxAvcStill({ data: Buffer.concat([prefix, nal, Buffer.from([0, 0, 0, 2, 101, 136])]), avcC, width: 3840, height: 2160, durationMs: 15000 }));
  assert.throws(() => validatePhotoUhdMp4(switched), { code: 'UHD_CODED_DIMENSIONS_REQUIRED' }, 'In-band FHD SPS cannot override a 4K avcC label');
});

test('owner original -> raw upload -> opaque HTTP MP4 supports GET/HEAD/Range without files or NAS credentials', async t => {
  const f = await fixture(t), bytes = mp4(), uploaded = await f.upload(); assert.equal(uploaded.status, 200); assert.match(uploaded.body.id, /^[a-f0-9]{40}$/); assert.equal(uploaded.body.nativeUhdConfirmed, false); assert.equal(new URL(uploaded.body.url, f.base).searchParams.get('client'), A);
  assert.equal(JSON.stringify(uploaded.body).includes('fake-NAS-private-A'), false);
  const whole = await fetch(f.base + uploaded.body.url); assert.equal(whole.status, 200); assert.equal(whole.headers.get('content-type'), 'video/mp4'); assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
  const partial = await fetch(f.base + uploaded.body.url, { headers: { Range: 'bytes=5-12' } }); assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), `bytes 5-12/${bytes.length}`); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(5, 13));
  const head = await fetch(f.base + uploaded.body.url, { method: 'HEAD', headers: { Range: 'bytes=-10' } }); assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '10'); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const invalid = await fetch(f.base + uploaded.body.url, { headers: { Range: 'bytes=999999-' } }); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`); assert.equal(await invalid.text(), '');
  assert.equal(await f.close(uploaded.body.id), 200); assert.deepEqual(f.handler.snapshot(), { entries: 0, slots: 0, bytes: 0, disposed: false }); assert.equal((await fetch(f.base + uploaded.body.url)).status, 404);
});

test('cross-owner read/close and preview capabilities cannot access or authorize the original upload', async t => {
  const f = await fixture(t), first = await f.upload(); assert.equal((await f.upload({ source: f.view })).status, 404); assert.equal((await f.upload({ token: B })).status, 404);
  const other = new URL(first.body.url, f.base); other.searchParams.set('client', B); assert.equal((await fetch(other)).status, 404); assert.equal(await f.close(first.body.id, B), 404); assert.equal(f.handler.snapshot().entries, 1);
  assert.equal((await f.upload({ contentType: 'image/jpeg' })).status, 415); assert.equal((await f.upload({ bytes: mp4(fhd) })).status, 400); assert.equal(f.handler.snapshot().entries, 1);
});

test('payload RAM and entry count are reserved before upload and released on owner close', async t => {
  const n = mp4().length, f = await fixture(t, { maxFileBytes: 1024, maxBytes: n * 2, maxEntries: 2 });
  const a = await f.upload(), b = await f.upload(); assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(f.handler.snapshot().bytes, n * 2); assert.equal((await f.upload()).status, 429);
  assert.equal(await f.close(a.body.id), 200); assert.equal((await f.upload()).status, 200); assert.equal(f.handler.snapshot().bytes, n * 2);
  const tooLarge = await f.upload({ bytes: Buffer.alloc(1025) }); assert.equal(tooLarge.status, 413); assert.equal(f.handler.snapshot().bytes, n * 2);
});

test('absolute TTL expires without a read and successful GET does not renew it', async t => {
  const clock = new Clock(), f = await fixture(t, { ttlMs: 100, now: () => clock.now, setTimer: clock.set, clearTimer: clock.clear });
  const first = await f.upload(); clock.advance(80); assert.equal((await fetch(f.base + first.body.url)).status, 200); clock.advance(21);
  assert.equal(f.handler.snapshot().entries, 0); assert.equal(f.handler.snapshot().bytes, 0); assert.equal((await fetch(f.base + first.body.url)).status, 404); assert.equal(clock.jobs.size, 0);
});

test('reset aborts unfinished uploads and clears all RAM; NAS/account identity changes invalidate old cached data', async t => {
  const f = await fixture(t), first = await f.upload(); f.photos.nas.config.token = 'fake-NAS-private-B'; assert.equal((await fetch(f.base + first.body.url)).status, 404); assert.equal(f.handler.snapshot().bytes, 0);
  assert.equal((await f.upload()).status, 404, 'The old original capability cannot authorize another account');
  const fresh = f.photos.present({ picture_id: 8, file_name: 'synthetic.jpg', real_ext_name: 'jpg', width: 3840, height: 2160 }, owner(A)).original.split('/').pop();
  const request = http.request(f.base + '/api/photos/uhd?asset=' + fresh, { method: 'POST', headers: { Authorization: 'Bearer ' + A, 'Content-Type': 'video/mp4', 'Content-Length': mp4().length } }); request.on('error', () => {}); request.write(mp4().subarray(0, 50));
  await until(() => f.handler.snapshot().slots === 1); await f.handler.reset(); await until(() => f.handler.snapshot().bytes === 0); request.destroy(); assert.equal(f.handler.snapshot().entries, 0);
  const second = await f.upload({ source: fresh }); assert.equal(second.status, 200); await f.handler.reset(); assert.equal((await fetch(f.base + second.body.url)).status, 404);
});

test('external signal remains bound to a backpressured RAM response after the route has returned', async t => {
  const controller = new AbortController(), f = await fixture(t, { signal: controller.signal });
  const uploaded = await f.upload(); assert.equal(uploaded.status, 200);
  // Deterministic pending transport: a loopback TCP send may finish entirely
  // into the OS buffer before the receiving test can pause it.
  const req = new EventEmitter(); Object.assign(req, { method: 'GET', headers: {}, complete: true, aborted: false });
  const res = new EventEmitter(); Object.assign(res, { destroyed: false, writableEnded: false, writeHead() { this.headersSent = true; }, end(bytes) { this.pendingBytes = bytes; this.writableEnded = true; }, destroy() { this.destroyed = true; this.pendingBytes = null; this.emit('close'); } });
  assert.equal(await f.handler(req, res, { url: new URL(uploaded.body.url, f.base), owner: owner(A), urlContext: { client: A }, signal: controller.signal }), true);
  assert.ok(res.pendingBytes); controller.abort(); assert.equal(res.destroyed, true); assert.equal(res.pendingBytes, null); assert.equal(f.handler.snapshot().entries, 1, 'A cancelled read must not retire the owner cache');
});
