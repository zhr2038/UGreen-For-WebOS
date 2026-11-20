import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkvAudioCompatSession, probeMkvAudioTracks, isUnsupportedMkvAudioCodec } from '../lib/movie-mkv-compat.mjs';
import { isAudioCompatAvailable } from '../lib/audio-compat-wasm.mjs';
import { createBridge } from '../lib/bridge.mjs';

function vintSize(n) {
  if (n < 0x7f) return Buffer.from([0x80 | n]);
  if (n < 0x3fff) { const b = Buffer.alloc(2); b.writeUInt16BE(0x4000 | n); return b; }
  const b = Buffer.alloc(4);
  b.writeUInt32BE(0x10000000 | n);
  return b;
}

function el(idBytes, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
  return Buffer.concat([Buffer.from(idBytes), vintSize(buf.length), buf]);
}

function uintBytes(n) {
  if (n === 0) return Buffer.from([0]);
  const bytes = [];
  let v = BigInt(n);
  while (v > 0n) { bytes.unshift(Number(v & 0xffn)); v >>= 8n; }
  return Buffer.from(bytes);
}

function f64(n) {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b;
}

function simpleBlock(trackNum, relMs, keyframe, data) {
  const hdr = Buffer.alloc(4);
  hdr[0] = 0x80 | trackNum;
  hdr.writeInt16BE(relMs, 1);
  hdr[3] = keyframe ? 0x80 : 0x00;
  return el([0xA3], Buffer.concat([hdr, data]));
}

/** Builds a valid Matroska stream with H.264 video + 5.1 48kHz PCM audio across two 5.2s GOP clusters. */
function buildSyntheticMkv({ audioCodecId = 'A_PCM/INT/LIT', channels = 6 } = {}) {
  const ebml = el([0x1A, 0x45, 0xDF, 0xA3], [
    el([0x42, 0x86], Buffer.from([1])),
    el([0x42, 0xF7], Buffer.from([1])),
    el([0x42, 0xF2], Buffer.from([4])),
    el([0x42, 0xF3], Buffer.from([8])),
    el([0x42, 0x82], Buffer.from('matroska')),
    el([0x42, 0x87], Buffer.from([4])),
    el([0x42, 0x85], Buffer.from([2])),
  ]);

  const info = el([0x15, 0x49, 0xA9, 0x66], [
    el([0x2A, 0xD7, 0xB1], uintBytes(1_000_000)),
    el([0x44, 0x89], f64(10400)),
  ]);

  // Valid Baseline 64x64 SPS + PPS inside avcC + 4-byte length prefixed IDR slice
  const sps = Buffer.from([0x67, 0x42, 0xC0, 0x1E, 0xD9, 0x00, 0xA0, 0x47, 0xFE, 0xC8]);
  const pps = Buffer.from([0x68, 0xCE, 0x38, 0x80]);
  const avcC = Buffer.concat([
    Buffer.from([0x01, sps[1], sps[2], sps[3], 0xff, 0xe1, 0x00, sps.length]), sps,
    Buffer.from([0x01, 0x00, pps.length]), pps,
  ]);
  const idrNal = Buffer.from([0x65, 0x88, 0x84, 0x21, 0xa0, 0x00]);
  const idrSample = Buffer.concat([Buffer.from([0, 0, 0, idrNal.length]), idrNal]);

  const audioPcmChunk = Buffer.alloc(960 * channels * 2); // 20ms @ 48kHz

  const tracks = el([0x16, 0x54, 0xAE, 0x6B], [
    el([0xAE], [
      el([0xD7], Buffer.from([1])),
      el([0x73, 0xC5], Buffer.from([1])),
      el([0x83], Buffer.from([1])),
      el([0x86], Buffer.from('V_MPEG4/ISO/AVC')),
      el([0x63, 0xA2], avcC),
      el([0xE0], [el([0xB0], Buffer.from([64])), el([0xBA], Buffer.from([64]))]),
    ]),
    el([0xAE], [
      el([0xD7], Buffer.from([2])),
      el([0x73, 0xC5], Buffer.from([2])),
      el([0x83], Buffer.from([2])),
      el([0x86], Buffer.from(audioCodecId)),
      el([0xE1], [
        el([0xB5], f64(48000)),
        el([0x9F], Buffer.from([channels])),
        el([0x62, 0x64], Buffer.from([16])),
      ]),
    ]),
  ]);

  const makeCluster = (baseMs, countMs) => {
    const blocks = [el([0xE7], uintBytes(baseMs)), simpleBlock(1, 0, true, idrSample)];
    for (let t = 0; t < countMs; t += 20) blocks.push(simpleBlock(2, t, true, audioPcmChunk));
    return el([0x1F, 0x43, 0xB6, 0x75], blocks);
  };

  const cluster1 = makeCluster(0, 5200);
  const cluster2 = makeCluster(5200, 5200);

  // Compute SeekHead and Cues using known fixed 4-byte offsets after placeholders.
  const makeSeekEntry = (idBytes, pos) => el([0x4D, 0xBB], [
    el([0x53, 0xAB], Buffer.from(idBytes)),
    el([0x53, 0xAC], (() => { const b = Buffer.alloc(4); b.writeUInt32BE(pos); return b; })()),
  ]);
  const placeholderSeek = el([0x11, 0x4D, 0x9B, 0x74], [
    makeSeekEntry([0x15, 0x49, 0xA9, 0x66], 0),
    makeSeekEntry([0x16, 0x54, 0xAE, 0x6B], 0),
    makeSeekEntry([0x1C, 0x53, 0xBB, 0x6B], 0),
  ]);
  const infoPos = placeholderSeek.length;
  const tracksPos = infoPos + info.length;
  const cluster1Pos = tracksPos + tracks.length;
  const cluster2Pos = cluster1Pos + cluster1.length;
  const cuesPos = cluster2Pos + cluster2.length;

  const seekHead = el([0x11, 0x4D, 0x9B, 0x74], [
    makeSeekEntry([0x15, 0x49, 0xA9, 0x66], infoPos),
    makeSeekEntry([0x16, 0x54, 0xAE, 0x6B], tracksPos),
    makeSeekEntry([0x1C, 0x53, 0xBB, 0x6B], cuesPos),
  ]);
  assert.equal(seekHead.length, placeholderSeek.length);

  const cues = el([0x1C, 0x53, 0xBB, 0x6B], [
    el([0xBB], [el([0xB3], uintBytes(0)), el([0xB7], [el([0xF7], Buffer.from([1])), el([0xF1], uintBytes(cluster1Pos))])]),
    el([0xBB], [el([0xB3], uintBytes(5200)), el([0xB7], [el([0xF7], Buffer.from([1])), el([0xF1], uintBytes(cluster2Pos))])]),
  ]);

  const segPayload = Buffer.concat([seekHead, info, tracks, cluster1, cluster2, cues]);
  const segSize = Buffer.alloc(8);
  segSize.writeBigUInt64BE(0x0100000000000000n | BigInt(segPayload.length));
  const segment = Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67]), segSize, segPayload]);
  return Buffer.concat([ebml, segment]);
}

function nasForBuffer(mkvBuffer) {
  const rangeRequests = [];
  return {
    rangeRequests,
    async open(_path, options = {}) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(String(options.headers?.Range || ''));
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(mkvBuffer.length - 1, Number(m[2])) : mkvBuffer.length - 1;
      rangeRequests.push([start, end]);
      const slice = mkvBuffer.subarray(start, end + 1);
      const stream = Readable.from([slice]);
      stream.statusCode = 206;
      stream.headers = { 'content-type': 'video/x-matroska', 'content-range': `bytes ${start}-${end}/${mkvBuffer.length}`, 'content-length': String(slice.length), 'accept-ranges': 'bytes' };
      return stream;
    },
  };
}

test('built-in LGPL WASM engine transcodes an MKV GOP into valid MPEG-TS with EAC3 5.1 and cached Range support', async () => {
  assert.equal(isAudioCompatAvailable(), true);
  assert.equal(isUnsupportedMkvAudioCodec('A_DTS'), true);
  assert.equal(isUnsupportedMkvAudioCodec('A_TRUEHD'), true);
  assert.equal(isUnsupportedMkvAudioCodec('A_EAC3'), false);

  const mkv = buildSyntheticMkv();
  const nas = nasForBuffer(mkv);
  const compat = mkvAudioCompatSession(nas, '/Movies/example.mkv');
  await compat.session.prepare(AbortSignal.timeout(5000));

  const m3u8 = compat.session.manifest(id => `/seg/${id}.ts`).body;
  assert.match(m3u8, /^#EXTM3U/m);
  assert.match(m3u8, /^#EXT-X-INDEPENDENT-SEGMENTS$/m);
  assert.match(m3u8, /^\/seg\/0\.ts$/m);
  assert.match(m3u8, /^\/seg\/1\.ts$/m);

  const readsBeforeSeg0 = nas.rangeRequests.length;
  const tsRes = await compat.owned.nas.open('/0.ts', { method: 'GET', signal: AbortSignal.timeout(10000) });
  assert.equal(tsRes.statusCode, 200);
  const tsChunks = [];
  for await (const c of tsRes) tsChunks.push(c);
  const ts = Buffer.concat(tsChunks);
  assert.ok(ts.length >= 376 && ts.length % 188 === 0, 'valid MPEG-TS packet alignment');
  for (let i = 0; i < ts.length; i += 188) assert.equal(ts[i], 0x47, 'MPEG-TS sync byte at offset ' + i);
  // Check EAC3 syncword (0x0b 0x77) exists inside generated TS payload.
  assert.ok(ts.includes(Buffer.from([0x0b, 0x77])), 'EAC3 audio frames present inside MPEG-TS');

  // Repeat Range read on cached segment must not hit upstream NAS again.
  const readsAfterSeg0 = nas.rangeRequests.length;
  assert.ok(readsAfterSeg0 > readsBeforeSeg0);
  const rangeRes = await compat.owned.nas.open('/0.ts', { method: 'GET', headers: { Range: 'bytes=0-187' } });
  assert.equal(rangeRes.statusCode, 206);
  assert.equal(nas.rangeRequests.length, readsAfterSeg0);
  const rangeChunks = [];
  for await (const c of rangeRes) rangeChunks.push(c);
  assert.equal(Buffer.concat(rangeChunks).length, 188);

  compat.owned.dispose();
  await assert.rejects(() => compat.owned.nas.open('/1.ts', { method: 'GET' }));
});

test('probeMkvAudioTracks flags DTS and TrueHD MKV files while ignoring EAC3 tracks', async () => {
  const dtsNas = nasForBuffer(buildSyntheticMkv({ audioCodecId: 'A_DTS', channels: 6 }));
  const dtsProbe = await probeMkvAudioTracks(dtsNas, '/dts.mkv');
  assert.equal(dtsProbe.needsCompat, true);
  assert.equal(dtsProbe.allUnsupported, true);

  const eac3Nas = nasForBuffer(buildSyntheticMkv({ audioCodecId: 'A_EAC3', channels: 6 }));
  const eac3Probe = await probeMkvAudioTracks(eac3Nas, '/eac3.mkv');
  assert.equal(eac3Probe.needsCompat, false);
  assert.equal(eac3Probe.allUnsupported, false);
});

test('createBridge automatically exposes audio-compatible HLS without external NAS helper for DTS MKV episode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-mkv-compat-'));
  const mkv = buildSyntheticMkv();
  const baseNas = {
    config: { server: 'https://nas.example.invalid', alias: 'demo', token: 'FAKE_TOKEN', username: 'u', clientId: 'c' },
    httpsAgent: { destroy() {} },
    snapshot() { return { ...this, config: { ...this.config }, httpsAgent: { destroy() {} }, snapshot: this.snapshot }; },
    async request(path) {
      if (path.endsWith('/getTV') || path.endsWith('/getMovie')) {
        return {
          video_info: { ug_video_info_id: 9, media_lib_set_id: 1, category_id: 'cat-9', type: 2, name: 'Show', duration: 10 },
          tv_info: [{ episode: 1, ug_television_episode_id: 90, ep_name: 'E1', file_info: [{ path: '/Show/E01.mkv', duration: 10 }] }],
          play_status: { recently_played_file_path: '/Show/E01.mkv', current_play_time: 0 },
        };
      }
      if (path.endsWith('/pre_info')) {
        return { resolution: '1920x1080', transcode: [{ name: '720P', resolution: '1280x720' }], audios: [{ id: 0, name: 'dts', language: 'eng', channels: 6 }], subtitle: [] };
      }
      if (path.endsWith('/subtitle/list')) return { result: [] };
      return {};
    },
    async open(path, opts) { return nasForBuffer(mkv).open(path, opts); },
  };

  let configuredHelper;
  const bridge = await createBridge({ dir, config: baseNas.config, nasClient: baseNas, thumbnails: { make() {} }, host: '127.0.0.1', port: 0, clientToken: 'cap-mkv', getAudioHelper: () => configuredHelper });
  t.after(async () => { await bridge.reset(); bridge.server.closeAllConnections(); await new Promise(r => bridge.server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + bridge.server.address().port;
  const headers = { Authorization: 'Bearer cap-mkv', 'Content-Type': 'application/json' };

  const play = await (await fetch(base + '/api/play', { method: 'POST', headers, body: JSON.stringify({ id: 9, type: 2, library: 1, fileIndex: 0 }) })).json();
  const options = await (await fetch(base + '/api/play/options?id=' + play.id, { headers })).json();
  assert.equal(options.audioCompatibility, true);
  assert.equal(options.qualities[1].id, 'audio-compatible');

  const cand = await (await fetch(base + '/api/play/quality', { method: 'POST', headers, body: JSON.stringify({ id: play.id, qualityId: 'audio-compatible' }) })).json();
  assert.equal(cand.kind, 'hls');
  const m3u8 = await (await fetch(base + cand.stream)).text();
  assert.match(m3u8, /^#EXTM3U/m);
  const segUrl = m3u8.split('\n').find(l => l.startsWith('/api/'));
  const seg = await fetch(base + segUrl);
  assert.equal(seg.status, 200);
  const buf = Buffer.from(await seg.arrayBuffer());
  assert.equal(buf[0], 0x47);
  assert.ok(buf.includes(Buffer.from([0x0b, 0x77])));

  // A helper for a different episode in the same directory must leave the built-in option available.
  configuredHelper = { path: '/Show/E02.mkv', headerHash: '0'.repeat(64) };
  const other = await (await fetch(base + '/api/play', { method: 'POST', headers, body: JSON.stringify({ id: 9, type: 2, library: 1, fileIndex: 0 }) })).json();
  const otherOptions = await (await fetch(base + '/api/play/options?id=' + other.id, { headers })).json();
  assert.equal(otherOptions.audioCompatibility, true);
  assert.ok(otherOptions.qualities.some(quality => quality.id === 'audio-compatible'));
});
