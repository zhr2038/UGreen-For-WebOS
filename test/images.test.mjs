import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Thumbnails } from '../lib/images.mjs';

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
