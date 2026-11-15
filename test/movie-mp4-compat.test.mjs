import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { applyMp4Overlay, movieAudioCompatibility, prepareDolbyMp4 } from '../lib/movie-mp4-compat.mjs';

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, payload]);
}

function track(handler, codec) {
  const count = Buffer.alloc(8);
  count.writeUInt32BE(1, 4);
  return box('trak', box('tkhd', Buffer.alloc(4)),
    box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(handler)),
      box('minf', box('stbl', box('stsd', count, box(codec, Buffer.from('track data')))))));
}

test('the original MP4 stream keeps its length and media data when compatible tracks are applied across byte ranges', async () => {
  const video = track('vide', 'dvhe');
  const audio = track('soun', 'ec-3');
  const original = Buffer.concat([
    box('ftyp', Buffer.from('mp42')),
    box('moov', box('mvhd', Buffer.alloc(8)), video, track('soun', 'av3a'), audio, box('udta', Buffer.alloc(128))),
    box('mdat', Buffer.alloc(70000, 0xa5)),
  ]);
  const opens = [];
  const nas = {
    async open(path, options) {
      assert.match(path, /raw\/get$/);
      assert.equal(options.query.video_path, '/Films/example.mp4');
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range).map(Number);
      opens.push([start, end]);
      const result = Readable.from([original.subarray(start, end + 1)]);
      result.statusCode = 206;
      result.headers = { 'content-range': `bytes ${start}-${end}/${original.length}` };
      return result;
    },
  };
  const overlay = await prepareDolbyMp4(nas, '/Films/example.mp4', AbortSignal.timeout(1000));
  const split = overlay.start + 7;
  const rendered = Buffer.concat([
    applyMp4Overlay(original.subarray(0, split), 0, overlay),
    applyMp4Overlay(original.subarray(split), split, overlay),
  ]);
  assert.equal(rendered.length, original.length);
  assert.equal(opens.length, 1);
  assert.equal(rendered.readUInt32BE(overlay.start) + rendered.readUInt32BE(overlay.start + rendered.readUInt32BE(overlay.start)),
    original.readUInt32BE(overlay.start));
  const mdat = original.indexOf('mdat');
  assert.deepEqual(rendered.subarray(mdat), original.subarray(mdat));
  const retainedHeader = rendered.subarray(overlay.start, overlay.start + rendered.readUInt32BE(overlay.start));
  assert.ok(retainedHeader.includes(video));
  assert.ok(retainedHeader.includes('ec-3'));
  assert.ok(!retainedHeader.includes('av3a'));
  assert.equal(retainedHeader[retainedHeader.lastIndexOf('tkhd') + 7] & 3, 3);
  assert.ok(original.includes('av3a'));
});

test('format handling is tied to metadata for the exact selected file', () => {
  const file = { path: '/movie.mp4' };
  assert.equal(movieAudioCompatibility(file, { path: '/other.mp4', audio_info: [{ codec: 'dts' }] }), null);
  assert.equal(movieAudioCompatibility(file, { path: file.path, audio_info: [{ codec: 'dts' }, { codec: 'eac3' }] }), 'mp4');
  assert.equal(movieAudioCompatibility(file, { path: file.path, audio_info: [{ codec: 'A_DTS' }] }), 'transcode');
});
