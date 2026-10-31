import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Thumbnails } from '../lib/images.mjs';
import { NativeThumbnails } from '../lib/native-images.mjs';

test('duplicate requests decode a full-size poster only once', async () => {
  const input = await sharp({ create: { width: 2000, height: 3000, channels: 3, background: '#334455' } }).png().toBuffer();
  const cache = new Thumbnails(); let loads = 0;
  const load = async () => { loads++; await new Promise(r => setTimeout(r, 15)); return input; };
  const results = await Promise.all(Array.from({ length: 5 }, () => cache.make('poster', 'poster', load)));
  assert.equal(loads, 1); assert.ok(results.every(b => b === results[0]));
  const metadata = await sharp(results[0]).metadata(); assert.equal(metadata.width, 480); assert.equal(metadata.height, 720);
});

test('unrelated images use at most two concurrent NAS fetches', async () => {
  const input = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#334455' } }).png().toBuffer();
  const cache = new Thumbnails(); let active = 0, peak = 0;
  const load = async () => { active++; peak = Math.max(active, peak); await new Promise(r => setTimeout(r, 15)); active--; return input; };
  await Promise.all(Array.from({ length: 8 }, (_, n) => cache.make(String(n), 'poster', load)));
  assert.equal(peak, 2);
});
for (const Cache of [Thumbnails, NativeThumbnails]) {
  test(Cache.name + ' reset rejects a late old-account image and preserves the new request for the same key', async () => {
    const input = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#334455' } }).png().toBuffer();
    const cache = new Cache(); let resolveOld, resolveNew, oldLoads = 0, newLoads = 0;
    const oldGate = new Promise(r => resolveOld = r), newGate = new Promise(r => resolveNew = r);
    const old = cache.make('same', 'poster', async () => { oldLoads++; await oldGate; return input; });
    const rejected = assert.rejects(old, /连接已切换/); cache.clear();
    const next = cache.make('same', 'poster', async () => { newLoads++; await newGate; return input; });
    resolveOld(); await rejected;
    const duplicate = cache.make('same', 'poster', async () => { throw new Error('New pending entry was deleted by the old job'); });
    resolveNew(); const [a,b] = await Promise.all([next,duplicate]);
    assert.equal(a,b); assert.equal(oldLoads,1); assert.equal(newLoads,1); assert.equal(cache.cache.size,1); assert.equal(cache.bytes,a.length);
  });
}
