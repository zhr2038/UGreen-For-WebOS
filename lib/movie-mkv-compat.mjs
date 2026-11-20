import { Readable } from 'node:stream';
import { transcodeMkvGopToTs } from './audio-compat-wasm.mjs';
import { linkSignals } from './linked-signal.mjs';

const RAW_VIDEO = '/ugreen/v1/stream/transcode/raw/get';
const EBML_ID = 0x1A45DFA3;
const SEGMENT_ID = 0x18538067;
const SEEK_HEAD_ID = 0x114D9B74;
const SEEK_ID = 0x4DBB;
const SEEK_ELEMENT_ID = 0x53AB;
const SEEK_POS_ID = 0x53AC;
const INFO_ID = 0x1549A966;
const TIMECODE_SCALE_ID = 0x2AD7B1;
const DURATION_ID = 0x4489;
const TRACKS_ID = 0x1654AE6B;
const TRACK_ENTRY_ID = 0xAE;
const TRACK_NUMBER_ID = 0xD7;
const TRACK_TYPE_ID = 0x83;
const CODEC_ID = 0x86;
const LANGUAGE_ID = 0x22B59C;
const LANGUAGE_BCP47_ID = 0x22B59D;
const AUDIO_ID = 0xE1;
const CHANNELS_ID = 0x9F;
const SAMPLE_RATE_ID = 0xB5;
const CUES_ID = 0x1C53BB6B;
const CUE_POINT_ID = 0xBB;
const CUE_TIME_ID = 0xB3;
const CUE_TRACK_POSITIONS_ID = 0xB7;
const CUE_TRACK_ID = 0xF7;
const CUE_CLUSTER_POS_ID = 0xF1;
const CLUSTER_ID = 0x1F43B675;

const MAX_HEADER_SCAN = 4 * 1024 * 1024;
const MAX_CUES_BYTES = 8 * 1024 * 1024;
const MAX_GOP_BYTES = 48 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 512 * 1024;

export const isUnsupportedMkvAudioCodec = codec => /^(?:a_)?(?:dts(?:[ _/.-].*)?|truehd|mlp|av3a|flac|alac|pcm.*|none)$/i.test(String(codec || '').trim());
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

function readVintId(buf, offset, limit = buf.length) {
  if (offset >= limit) return null;
  const first = buf[offset];
  if (!first) return null;
  let mask = 0x80, length = 1;
  while (length <= 4 && !(first & mask)) { length++; mask >>= 1; }
  if (length > 4 || offset + length > limit) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + buf[offset + i];
  return { value, length };
}

function readVintSize(buf, offset, limit = buf.length) {
  if (offset >= limit) return null;
  const first = buf[offset];
  if (!first) return null;
  let mask = 0x80, length = 1;
  while (length <= 8 && !(first & mask)) { length++; mask >>= 1; }
  if (length > 8 || offset + length > limit) return null;
  let allOnes = (first & (mask - 1)) === (mask - 1);
  let value = BigInt(first & (mask - 1));
  for (let i = 1; i < length; i++) {
    const byte = buf[offset + i];
    if (byte !== 0xff) allOnes = false;
    value = (value << 8n) | BigInt(byte);
  }
  return { value: allOnes ? null : Number(value), length };
}

function readElementHeader(buf, offset, limit = buf.length) {
  const id = readVintId(buf, offset, limit);
  if (!id) return null;
  const size = readVintSize(buf, offset + id.length, limit);
  if (!size) return null;
  const dataStart = offset + id.length + size.length;
  const end = size.value === null ? limit : dataStart + size.value;
  if (!Number.isSafeInteger(end) || dataStart > limit) return null;
  return { id: id.value, headerStart: offset, dataStart, size: size.value, end };
}

function* iterElements(buf, start, end) {
  let at = start;
  while (at < end) {
    const el = readElementHeader(buf, at, end);
    if (!el || el.end > end || el.end <= at) break;
    yield el;
    at = el.end;
  }
}

function readUint(buf, start, end) {
  if (end <= start || end - start > 8) return 0;
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + buf[i];
  return value;
}

function readFloat(buf, start, end) {
  if (end - start === 4) return buf.readFloatBE(start);
  if (end - start === 8) return buf.readDoubleBE(start);
  return 0;
}

async function readNasRange(nas, filePath, start, endInclusive, signal, maxBytes = MAX_GOP_BYTES) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start) throw fail('无效的媒体字节范围');
  if (endInclusive - start + 1 > maxBytes) throw fail('兼容音轨分片超出读取上限');
  const res = await nas.open(RAW_VIDEO, {
    method: 'GET',
    query: { video_path: filePath },
    headers: { Range: `bytes=${start}-${endInclusive}` },
    timeout: 30000,
    signal,
  });
  try {
    if (![200, 206].includes(res.statusCode)) throw fail('读取 NAS 视频分片失败');
    let fileSize = null;
    if (res.statusCode === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(res.headers?.['content-range'] || ''));
      if (m && m[3] !== '*') fileSize = Number(m[3]);
    } else if (/^\d+$/.test(String(res.headers?.['content-length'] || ''))) {
      fileSize = Number(res.headers['content-length']);
    }
    const chunks = []; let total = 0;
    for await (const chunk of res) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > maxBytes) { res.destroy(); throw fail('兼容音轨分片超出读取上限'); }
      chunks.push(b);
    }
    const buffer = Buffer.concat(chunks, total);
    if (res.statusCode === 200 && start > 0) {
      return { buffer: buffer.subarray(start, endInclusive + 1), fileSize: fileSize ?? buffer.length };
    }
    return { buffer, fileSize };
  } finally {
    res.destroy?.();
  }
}

async function readElementAt(nas, filePath, absOffset, signal, initialBytes = 262144, maxBytes = MAX_CUES_BYTES) {
  const firstEnd = absOffset + initialBytes - 1;
  const first = await readNasRange(nas, filePath, absOffset, firstEnd, signal, maxBytes);
  const hdr = readElementHeader(first.buffer, 0, first.buffer.length);
  if (!hdr || hdr.size === null) throw fail('Matroska 索引结构无效');
  const fullLen = (hdr.dataStart - hdr.headerStart) + hdr.size;
  if (fullLen > maxBytes) throw fail('Matroska 索引超出大小限制');
  if (first.buffer.length >= fullLen) return first.buffer.subarray(0, fullLen);
  const rest = await readNasRange(nas, filePath, absOffset + first.buffer.length, absOffset + fullLen - 1, signal, maxBytes);
  return Buffer.concat([first.buffer, rest.buffer], first.buffer.length + rest.buffer.length);
}

function parseSeekHeadEntries(buf, start, end) {
  const entries = new Map();
  for (const el of iterElements(buf, start, end)) {
    if (el.id !== SEEK_ID) continue;
    let id = null, pos = null;
    for (const child of iterElements(buf, el.dataStart, el.end)) {
      if (child.id === SEEK_ELEMENT_ID) id = readUint(buf, child.dataStart, child.end);
      else if (child.id === SEEK_POS_ID) pos = readUint(buf, child.dataStart, child.end);
    }
    if (id !== null && pos !== null && !entries.has(id)) entries.set(id, pos);
  }
  return entries;
}

function parseInfoElement(buf, start, end) {
  let timecodeScale = 1_000_000, rawDuration = 0;
  for (const el of iterElements(buf, start, end)) {
    if (el.id === TIMECODE_SCALE_ID) timecodeScale = readUint(buf, el.dataStart, el.end) || 1_000_000;
    else if (el.id === DURATION_ID) rawDuration = readFloat(buf, el.dataStart, el.end);
  }
  return { timecodeScale, durationMs: Math.round(rawDuration * timecodeScale / 1_000_000) };
}

function parseTracksElement(buf, start, end) {
  const tracks = [];
  for (const entry of iterElements(buf, start, end)) {
    if (entry.id !== TRACK_ENTRY_ID) continue;
    const item = { number: 0, type: 0, codec: '', language: '', channels: 0, sampleRate: 0 };
    for (const child of iterElements(buf, entry.dataStart, entry.end)) {
      if (child.id === TRACK_NUMBER_ID) item.number = readUint(buf, child.dataStart, child.end);
      else if (child.id === TRACK_TYPE_ID) item.type = readUint(buf, child.dataStart, child.end);
      else if (child.id === CODEC_ID) item.codec = buf.toString('utf8', child.dataStart, child.end).replace(/\0+$/, '');
      else if (child.id === LANGUAGE_ID || child.id === LANGUAGE_BCP47_ID) item.language ||= buf.toString('utf8', child.dataStart, child.end).replace(/\0+$/, '');
      else if (child.id === AUDIO_ID) {
        for (const audioChild of iterElements(buf, child.dataStart, child.end)) {
          if (audioChild.id === CHANNELS_ID) item.channels = readUint(buf, audioChild.dataStart, audioChild.end);
          else if (audioChild.id === SAMPLE_RATE_ID) item.sampleRate = readFloat(buf, audioChild.dataStart, audioChild.end);
        }
      }
    }
    tracks.push(item);
  }
  return tracks;
}

function parseCuesElement(buf, cuesDataStart, cuesEnd, videoTrackNumbers, segmentDataStart, timecodeScale, durationMs) {
  const keyframes = [];
  for (const point of iterElements(buf, cuesDataStart, cuesEnd)) {
    if (point.id !== CUE_POINT_ID) continue;
    let timeTicks = null, fallbackPos = null, matchedPos = null;
    for (const child of iterElements(buf, point.dataStart, point.end)) {
      if (child.id === CUE_TIME_ID) timeTicks = readUint(buf, child.dataStart, child.end);
      else if (child.id === CUE_TRACK_POSITIONS_ID) {
        let track = 0, clusterPos = null;
        for (const posChild of iterElements(buf, child.dataStart, child.end)) {
          if (posChild.id === CUE_TRACK_ID) track = readUint(buf, posChild.dataStart, posChild.end);
          else if (posChild.id === CUE_CLUSTER_POS_ID) clusterPos = readUint(buf, posChild.dataStart, posChild.end);
        }
        if (clusterPos !== null) {
          if (videoTrackNumbers.has(track) && matchedPos === null) matchedPos = clusterPos;
          else if (fallbackPos === null) fallbackPos = clusterPos;
        }
      }
    }
    const chosen = matchedPos ?? fallbackPos;
    if (timeTicks !== null && chosen !== null) {
      const timeMs = Math.round(timeTicks * timecodeScale / 1_000_000);
      if (timeMs >= 0 && (!durationMs || timeMs < durationMs)) {
        keyframes.push({ timeMs, absPos: segmentDataStart + chosen });
      }
    }
  }
  keyframes.sort((a, b) => a.timeMs - b.timeMs || a.absPos - b.absPos);
  const deduped = [];
  for (const kf of keyframes) {
    if (!deduped.length || kf.timeMs > deduped.at(-1).timeMs) deduped.push(kf);
  }
  return deduped;
}

function buildUnknownSegmentHeader() {
  // Segment Element ID (18 53 80 67) + 8-byte VINT unknown size (01 FF FF FF FF FF FF FF)
  return Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
}

async function loadMkvHeaders(nas, filePath, signal) {
  let { buffer: head, fileSize } = await readNasRange(nas, filePath, 0, 131071, signal, MAX_HEADER_SCAN);
  const ebml = readElementHeader(head, 0, head.length);
  if (!ebml || ebml.id !== EBML_ID || ebml.end > head.length) throw fail('无效的 Matroska 文件头');
  const ebmlRaw = Buffer.from(head.subarray(ebml.headerStart, ebml.end));
  const seg = readElementHeader(head, ebml.end, head.length);
  if (!seg || seg.id !== SEGMENT_ID) throw fail('未找到 Matroska Segment');

  const segmentDataStart = seg.dataStart;
  const segmentAbsEnd = seg.size !== null ? seg.dataStart + seg.size : (fileSize || Number.MAX_SAFE_INTEGER);

  const seekPositions = new Map();
  let infoRaw = null, tracksRaw = null, cuesPosInHead = null;

  // Scan initial top-level elements inside head (stopping at Cluster first, then
  // resuming across Clusters within `head` only if SeekHead lacked Cues).
  const scanTop = (buf, from, stopAtCluster = true) => {
    let at = from;
    while (at < buf.length) {
      const el = readElementHeader(buf, at, buf.length);
      if (!el) break;
      if (stopAtCluster && el.id === CLUSTER_ID) break;
      if (el.end > buf.length) return { incompleteAt: at };
      if (el.id === SEEK_HEAD_ID) {
        for (const [k, v] of parseSeekHeadEntries(buf, el.dataStart, el.end)) if (!seekPositions.has(k)) seekPositions.set(k, v);
      } else if (el.id === INFO_ID && !infoRaw) infoRaw = Buffer.from(buf.subarray(el.headerStart, el.end));
      else if (el.id === TRACKS_ID && !tracksRaw) tracksRaw = Buffer.from(buf.subarray(el.headerStart, el.end));
      else if (el.id === CUES_ID && cuesPosInHead === null) cuesPosInHead = at - segmentDataStart;
      at = el.end;
    }
    return { incompleteAt: null };
  };

  let state = scanTop(head, seg.dataStart, true);
  if (state.incompleteAt !== null && head.length < MAX_HEADER_SCAN && (!infoRaw || !tracksRaw)) {
    const extEnd = Math.min((fileSize ? fileSize - 1 : MAX_HEADER_SCAN - 1), MAX_HEADER_SCAN - 1);
    if (extEnd >= head.length) {
      const more = await readNasRange(nas, filePath, 0, extEnd, signal, MAX_HEADER_SCAN);
      head = more.buffer;
      if (more.fileSize) fileSize = more.fileSize;
      scanTop(head, seg.dataStart, true);
    }
  }
  if (cuesPosInHead === null && !seekPositions.has(CUES_ID) && fileSize && fileSize <= head.length) {
    scanTop(head, seg.dataStart, false);
  }

  // Follow SeekHead if Info or Tracks live later in the file.
  if (!infoRaw && seekPositions.has(INFO_ID)) {
    infoRaw = await readElementAt(nas, filePath, segmentDataStart + seekPositions.get(INFO_ID), signal);
  }
  if (!tracksRaw && seekPositions.has(TRACKS_ID)) {
    tracksRaw = await readElementAt(nas, filePath, segmentDataStart + seekPositions.get(TRACKS_ID), signal);
  }
  if (!infoRaw || !tracksRaw) throw fail('Matroska 缺少轨道或时长信息');

  const infoEl = readElementHeader(infoRaw, 0, infoRaw.length);
  const tracksEl = readElementHeader(tracksRaw, 0, tracksRaw.length);
  const info = parseInfoElement(infoRaw, infoEl.dataStart, infoEl.end);
  const tracks = parseTracksElement(tracksRaw, tracksEl.dataStart, tracksEl.end);

  return { ebmlRaw, infoRaw, tracksRaw, segmentDataStart, segmentAbsEnd, fileSize, seekPositions, cuesPosInHead, info, tracks };
}

/** Probe audio codecs in a Matroska file via a single bounded Range request. */
export async function probeMkvAudioTracks(nas, filePath, signal) {
  const { tracks } = await loadMkvHeaders(nas, filePath, signal);
  const audioTracks = tracks.filter(t => t.type === 2);
  const compatIndex = audioTracks.findIndex(t => isUnsupportedMkvAudioCodec(t.codec));
  return {
    tracks: audioTracks,
    needsCompat: compatIndex >= 0,
    allUnsupported: audioTracks.length > 0 && audioTracks.every(t => isUnsupportedMkvAudioCodec(t.codec)),
    targetAudioIndex: compatIndex >= 0 ? compatIndex : 0,
  };
}

/** Build ~5s GOP segments from parsed Cues aligned on video keyframes. */
export function buildMkvTimeline(keyframes, durationMs, fileEndOffset) {
  if (!Array.isArray(keyframes) || !keyframes.length || durationMs <= 0) throw fail('Matroska 缺少视频关键帧索引');
  const segments = [];
  let startIndex = 0;
  for (let i = 1; i < keyframes.length; i++) {
    const kf = keyframes[i], cur = keyframes[startIndex];
    if (kf.timeMs - cur.timeMs >= 5000 && durationMs - kf.timeMs >= 750) {
      // Include one cluster after the boundary keyframe so audio/B-frames around
      // the boundary are complete inside this range read.
      const nextAfterBoundary = keyframes[i + 1]?.absPos ?? fileEndOffset;
      const byteEnd = Math.min(fileEndOffset - 1, nextAfterBoundary - 1, cur.absPos + MAX_GOP_BYTES - 1);
      segments.push({ startMs: cur.timeMs, endMs: kf.timeMs, byteStart: cur.absPos, byteEnd: Math.max(cur.absPos, byteEnd) });
      startIndex = i;
    }
  }
  const lastStart = keyframes[startIndex];
  const lastByteEnd = Math.min(fileEndOffset - 1, lastStart.absPos + MAX_GOP_BYTES - 1);
  segments.push({ startMs: lastStart.timeMs, endMs: durationMs, byteStart: lastStart.absPos, byteEnd: Math.max(lastStart.absPos, lastByteEnd) });

  const maxSegSec = Math.max(1, Math.ceil(Math.max(...segments.map(s => s.endMs - s.startMs)) / 1000));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-TARGETDURATION:${maxSegSec}`];
  for (let i = 0; i < segments.length; i++) {
    lines.push(`#EXTINF:${((segments[i].endMs - segments[i].startMs) / 1000).toFixed(3)},`, `${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  const playlistText = lines.join('\n');
  if (Buffer.byteLength(playlistText, 'utf8') > MAX_PLAYLIST_BYTES) throw fail('兼容播放列表过长');
  return { segments, playlistText };
}

function sendBufferResponse(data, mime, headers = {}) {
  const rangeHeader = headers.Range || headers.range;
  let status = 200, start = 0, end = data.length - 1;
  const respHeaders = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(rangeHeader));
    if (!m) {
      const r = Readable.from([]); r.statusCode = 416; r.headers = { ...respHeaders, 'content-range': `bytes */${data.length}` }; return r;
    }
    start = Number(m[1]);
    end = m[2] ? Math.min(data.length - 1, Number(m[2])) : data.length - 1;
    if (start >= data.length || end < start) {
      const r = Readable.from([]); r.statusCode = 416; r.headers = { ...respHeaders, 'content-range': `bytes */${data.length}` }; return r;
    }
    status = 206;
    respHeaders['content-range'] = `bytes ${start}-${end}/${data.length}`;
  }
  const slice = data.subarray(start, end + 1);
  respHeaders['content-length'] = String(slice.length);
  const stream = Readable.from([slice]);
  stream.statusCode = status;
  stream.headers = respHeaders;
  return stream;
}

/**
 * In-process MKV DTS/TrueHD compatibility session (no external NAS container needed).
 * Implements the exact MoviePlaybackService `prepareAudio()` contract.
 */
export function mkvAudioCompatSession(nas, filePath, { transcode = transcodeMkvGopToTs, audioTrackIndex } = {}) {
  const controller = new AbortController();
  let prepared = null, playlistLines = null;
  let cachedIndex = -1, cachedBuffer = null;

  async function prepare(signal) {
    const linked = linkSignals([signal, controller.signal]);
    try {
      const headers = await loadMkvHeaders(nas, filePath, linked.signal);
      const audioTracks = headers.tracks.filter(t => t.type === 2);
      if (!audioTracks.length) throw fail('该影片没有音轨');
      const selectedAudio = Number.isInteger(audioTrackIndex) && audioTrackIndex >= 0
        ? audioTrackIndex
        : Math.max(0, audioTracks.findIndex(t => isUnsupportedMkvAudioCodec(t.codec)));

      let cuesRel = headers.cuesPosInHead ?? headers.seekPositions.get(CUES_ID);
      if (cuesRel == null && headers.seekPositions.has(SEEK_HEAD_ID)) {
        const secondHead = await readElementAt(nas, filePath, headers.segmentDataStart + headers.seekPositions.get(SEEK_HEAD_ID), linked.signal);
        const secondEl = readElementHeader(secondHead, 0, secondHead.length);
        if (secondEl) {
          const map2 = parseSeekHeadEntries(secondHead, secondEl.dataStart, secondEl.end);
          cuesRel = map2.get(CUES_ID);
        }
      }
      if (cuesRel == null) throw fail('此 MKV 缺少关键帧索引，无法即时生成兼容音轨');

      const cuesBuf = await readElementAt(nas, filePath, headers.segmentDataStart + cuesRel, linked.signal);
      const cuesEl = readElementHeader(cuesBuf, 0, cuesBuf.length);
      if (!cuesEl || cuesEl.id !== CUES_ID) throw fail('Matroska 关键帧索引无效');

      const videoTracks = new Set(headers.tracks.filter(t => t.type === 1).map(t => t.number));
      const keyframes = parseCuesElement(cuesBuf, cuesEl.dataStart, cuesEl.end, videoTracks, headers.segmentDataStart, headers.info.timecodeScale, headers.info.durationMs);
      const fileEnd = Number.isSafeInteger(headers.fileSize) && headers.fileSize > 0
        ? Math.min(headers.fileSize, headers.segmentAbsEnd)
        : headers.segmentAbsEnd;
      const { segments, playlistText } = buildMkvTimeline(keyframes, headers.info.durationMs, fileEnd);
      const initSegment = Buffer.concat([headers.ebmlRaw, buildUnknownSegmentHeader(), headers.infoRaw, headers.tracksRaw]);

      prepared = { initSegment, segments, audioTrackIndex: selectedAudio, playlistBuffer: Buffer.from(playlistText, 'utf8') };
      playlistLines = playlistText.trim().split('\n');
    } finally { linked.dispose(); }
  }

  async function open(path, { method = 'GET', headers = {}, signal } = {}) {
    if (method !== 'GET' || !prepared) throw fail('播放列表未准备好', 404);
    if (path === '/playlist.m3u8') return sendBufferResponse(prepared.playlistBuffer, 'application/vnd.apple.mpegurl; charset=utf-8', headers);
    const m = /^\/([0-9]{1,5})\.ts$/.exec(path);
    if (!m) throw fail('分段不存在', 404);
    const index = Number(m[1]);
    if (index < 0 || index >= prepared.segments.length) throw fail('分段不存在', 404);

    if (cachedIndex === index && cachedBuffer) {
      return sendBufferResponse(cachedBuffer, 'video/mp2t', headers);
    }

    const seg = prepared.segments[index];
    const linked = linkSignals([signal, controller.signal]);
    try {
      const { buffer: clusterBytes } = await readNasRange(nas, filePath, seg.byteStart, seg.byteEnd, linked.signal, MAX_GOP_BYTES);
      const ts = await transcode({
        initSegment: prepared.initSegment,
        clusterBytes,
        startMs: seg.startMs,
        endMs: seg.endMs,
        audioTrackIndex: prepared.audioTrackIndex,
        signal: linked.signal,
      });
      if (controller.signal.aborted) throw Object.assign(new DOMException('Cancelled', 'AbortError'), { status: 410 });
      cachedIndex = index;
      cachedBuffer = ts;
      return sendBufferResponse(ts, 'video/mp2t', headers);
    } finally { linked.dispose(); }
  }

  function resource(id) {
    const segment = Number(id);
    if (!prepared || !/^[0-9]{1,5}$/.test(id) || segment >= prepared.segments.length) throw fail('分段不存在', 404);
    return { path: '/' + segment + '.ts', query: {}, manifest: false };
  }

  function manifest(map, resourceId) {
    if (!playlistLines || resourceId !== undefined) throw fail('清单不存在', 404);
    return { body: playlistLines.map(line => line.startsWith('#') ? line : map(line.slice(0, -3))).join('\n') + '\n' };
  }

  function close() {
    controller.abort();
    cachedBuffer = null;
    cachedIndex = -1;
    prepared = null;
  }

  return { owned: { nas: { open }, dispose: close }, session: { prepare, resource, manifest, close } };
}
