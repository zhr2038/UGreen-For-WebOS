import test from 'node:test';
import assert from 'node:assert/strict';
import '../app/photo-uhd-pipeline.js';
const { muxAvcStill, dimensions, originalUrl, fetchOriginal, encodeStill } = globalThis.PhotoUhdPipeline;
const data = Uint8Array.from([0, 0, 0, 2, 0x65, 0x88]), avcC = Uint8Array.from([1, 66, 0, 51, 255, 225, 0]);
const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
function boxes(bytes, from = 0, end = bytes.length) {
  const list = [];
  for (let at = from; at < end;) { const size = u32(bytes, at), type = String.fromCharCode(...bytes.slice(at + 4, at + 8)); assert.ok(size >= 8 && at + size <= end); list.push({ type, at, size }); at += size; }
  return list;
}
function find(bytes, name) {
  const queue = boxes(bytes);
  while (queue.length) { const item = queue.shift(); if (item.type === name) return item; if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(item.type)) queue.push(...boxes(bytes, item.at + 8, item.at + item.size)); }
}
test('still MP4 has exact durations and sample offsets, with one encoded image plus a clock tail anchor', () => {
  for (const durationMs of [2000, 3000, 5000, 10000, 15000]) {
    const bytes = muxAvcStill({ data, avcC, width: 3840, height: 2160, durationMs });
    assert.deepEqual(boxes(bytes).map(item => item.type), ['ftyp', 'moov', 'mdat']);
    const timing = find(bytes, 'stts'), sizes = find(bytes, 'stsz'), offsets = find(bytes, 'stco'), mdat = find(bytes, 'mdat');
    assert.equal(u32(bytes, timing.at + 12), 2); assert.equal(u32(bytes, timing.at + 20) + u32(bytes, timing.at + 28), durationMs);
    assert.equal(u32(bytes, sizes.at + 12), data.length); assert.equal(u32(bytes, sizes.at + 16), 2); assert.equal(u32(bytes, offsets.at + 16), mdat.at + 8);
    assert.deepEqual(bytes.slice(mdat.at + 8), Uint8Array.from([...data, ...data]));
    const mdhd = find(bytes, 'mdhd'); assert.equal(u32(bytes, mdhd.at + 20), 1000); assert.equal(u32(bytes, mdhd.at + 24), durationMs);
  }
  const one = muxAvcStill({ data, avcC, width: 3840, height: 2160, durationMs: 15000, tailAnchor: false }); assert.equal(u32(one, find(one, 'stsz').at + 16), 1);
});
test('still muxing fails closed on incomplete AVC, missing configuration, invalid output size or timing', () => {
  const input = { data, avcC, width: 3840, height: 2160, durationMs: 15000 };
  for (const change of [{ data: new Uint8Array([0, 0, 0, 20, 101]) }, { data: new Uint8Array([0, 0, 1, 101, 0]) }, { avcC: new Uint8Array(7) }, { width: 3839 }, { durationMs: 0 }, { durationMs: 60001 }]) assert.throws(() => muxAvcStill({ ...input, ...change }), { name: 'PhotoUhdError' });
});
test('original URLs are constrained to authorized loopback originals and never accept preview or remote media', async () => {
  const cap = 'a'.repeat(40); assert.equal(originalUrl(`http://127.0.0.1:19770/photo-original/${cap}?client=local`), `http://127.0.0.1:19770/photo-original/${cap}?client=local`);
  for (const url of [`http://127.0.0.1/photo-image/${cap}`, `http://nas.invalid/photo-original/${cap}`, `file:///photo-original/${cap}`, `http://user:pass@127.0.0.1/photo-original/${cap}`, `http://127.0.0.1/photo-original/${cap}#fragment`]) assert.throws(() => originalUrl(url), { code: 'ORIGINAL_REQUIRED' });
  await assert.rejects(fetchOriginal('http://127.0.0.1', { maxBytes: Infinity }), { code: 'INVALID_OPTIONS' });
});
test('source headers are read before raster allocation and encoder absence never substitutes a thumbnail', async () => {
  const png = new Uint8Array(24); png.set([137, 80, 78, 71]); const view = new DataView(png.buffer); view.setUint32(16, 4032); view.setUint32(20, 3024); assert.deepEqual(dimensions(png), { width: 4032, height: 3024, mime: 'image/png' });
  const jpg = Uint8Array.from([255, 216, 255, 192, 0, 7, 8, 11, 208, 15, 192]); assert.deepEqual(dimensions(jpg), { width: 4032, height: 3024, mime: 'image/jpeg' }); assert.equal(dimensions(new Uint8Array(5)), null);
  await assert.rejects(encodeStill(new Blob([png], { type: 'image/png' }), { expectedWidth: 4032, expectedHeight: 3024 }), { code: 'ENCODER_UNAVAILABLE' });
  await assert.rejects(encodeStill(new Blob([png], { type: 'image/png' })), { code: 'SOURCE_TOO_LARGE' });
});

test('original fetch rejects redirects, partial bodies and chunked size overruns without leaving readers active', async () => {
  const originalFetch = globalThis.fetch, url = 'http://127.0.0.1/photo-original/' + 'a'.repeat(40); let cancelled = 0, options;
  try {
    globalThis.fetch = async (_, value) => { options = value; return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 206 }); };
    await assert.rejects(fetchOriginal(url), { code: 'ORIGINAL_READ_FAILED' }); assert.equal(cancelled, 1); assert.equal(options.redirect, 'error'); assert.equal(options.signal.aborted, true);
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); }, cancel() { cancelled++; } }), { status: 200 });
    await assert.rejects(fetchOriginal(url, { maxBytes: 5 }), { code: 'SOURCE_TOO_LARGE' }); assert.equal(cancelled, 2);
  } finally { globalThis.fetch = originalFetch; }
});
