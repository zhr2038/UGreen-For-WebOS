import { createHash } from 'node:crypto';

const RAW_VIDEO = '/ugreen/v1/stream/transcode/raw/get';
const HEADER_BYTES = 64 * 1024;
const MAX_MOOV_BYTES = 48 * 1024 * 1024;
const MAX_OVERLAY_BYTES = 20 * 1024 * 1024;

const invalid = () => new Error('Unsupported MP4 layout');
const unsupportedAudio = codec => /^(?:a_)?(?:dts(?:[ _-].*)?|truehd|av3a|none)$/i.test(codec || '');

export function movieAudioCompatibility(file, technical) {
  if (technical?.path !== file.path || !Array.isArray(technical.audio_info)) return null;
  const audio = technical.audio_info;
  if (!audio.some(track => unsupportedAudio(track?.codec))) return null;
  if (/\.mp4$/i.test(file.path) && audio.some(track => /^(?:a_)?eac3$/i.test(track?.codec))) return 'mp4';
  if (audio.length && audio.every(track => unsupportedAudio(track?.codec))) return 'transcode';
  return null;
}

function atom(bytes, start, limit) {
  if (start + 8 > bytes.length) throw invalid();
  let size = bytes.readUInt32BE(start), header = 8;
  if (size === 1) {
    if (start + 16 > bytes.length) throw invalid();
    size = Number(bytes.readBigUInt64BE(start + 8));
    header = 16;
  } else if (size === 0) {
    size = limit - start;
  }
  if (!Number.isSafeInteger(size) || size < header || start + size > limit) throw invalid();
  return { start, data: start + header, end: start + size, type: bytes.toString('ascii', start + 4, start + 8) };
}

function atoms(bytes, start, end) {
  const list = [];
  while (start < end) {
    if (list.length >= 128) throw invalid();
    const next = atom(bytes, start, end);
    list.push(next);
    start = next.end;
  }
  return list;
}

function one(list, type) {
  const matches = list.filter(box => box.type === type);
  if (matches.length !== 1) throw invalid();
  return matches[0];
}

function track(bytes, box) {
  const children = atoms(bytes, box.data, box.end);
  const media = one(children, 'mdia');
  const mediaChildren = atoms(bytes, media.data, media.end);
  const handler = one(mediaChildren, 'hdlr');
  if (handler.data + 12 > handler.end) throw invalid();
  const type = bytes.toString('ascii', handler.data + 8, handler.data + 12);
  if (!['vide', 'soun'].includes(type)) return { type };
  const minf = one(mediaChildren, 'minf');
  const stbl = one(atoms(bytes, minf.data, minf.end), 'stbl');
  const description = one(atoms(bytes, stbl.data, stbl.end), 'stsd');
  if (description.data + 8 > description.end || bytes.readUInt32BE(description.data + 4) !== 1) throw invalid();
  const sample = atom(bytes, description.data + 8, description.end);
  const header = one(children, 'tkhd');
  if (header.data + 4 > header.end) throw invalid();
  return { box, type, codec: sample.type, flags: header.data + 3 };
}

export function compactDolbyMp4(moov) {
  const root = atom(moov, 0, moov.length);
  if (root.type !== 'moov' || root.end !== moov.length) throw invalid();
  const children = atoms(moov, root.data, root.end);
  if (children.some(box => box.type === 'mvex')) throw invalid();
  const header = one(children, 'mvhd');
  const tracks = children.filter(box => box.type === 'trak').map(box => track(moov, box));
  const video = tracks.filter(item => item.type === 'vide');
  const audio = tracks.find(item => item.type === 'soun' && item.codec === 'ec-3');
  if (video.length !== 1 || !['dvhe', 'dvh1'].includes(video[0].codec) || !audio) throw invalid();
  const soundTracks = tracks.filter(item => item.type === 'soun');
  if (!soundTracks.some(item => !['ec-3', 'ac-3', 'mp4a'].includes(item.codec))) throw invalid();
  const retained = [header, video[0].box, audio.box];
  const newSize = retained.reduce((size, box) => size + box.end - box.start, 8);
  const freeSize = moov.length - newSize;
  if (freeSize < 8 || newSize + 8 > MAX_OVERLAY_BYTES) throw invalid();
  const output = Buffer.alloc(newSize + 8);
  output.writeUInt32BE(newSize);
  output.write('moov', 4);
  let start = 8;
  for (const box of retained) {
    moov.copy(output, start, box.start, box.end);
    if (box === audio.box) output[start + audio.flags - box.start] |= 3;
    start += box.end - box.start;
  }
  // The top-level free box covers the old unused metadata without changing
  // the absolute offsets of any of the original video and audio samples.
  output.writeUInt32BE(freeSize, start);
  output.write('free', start + 4);
  return output;
}

async function readSlice(nas, path, start, length, signal, total) {
  const end = start + length - 1;
  const response = await nas.open(RAW_VIDEO, {
    query: { video_path: path }, headers: { Range: `bytes=${start}-${end}` }, signal, timeout: 12000,
  });
  const abort = () => response.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
    const fileSize = Number(range?.[3]);
    if (response.statusCode !== 206 || !range || Number(range[1]) !== start || Number(range[2]) !== end
        || !Number.isSafeInteger(fileSize) || fileSize <= end || (total && fileSize !== total)) throw invalid();
    const buffer = Buffer.allocUnsafe(length);
    let written = 0;
    for await (const chunk of response) {
      if (written + chunk.length > length) throw invalid();
      chunk.copy(buffer, written);
      written += chunk.length;
    }
    if (signal.aborted) throw signal.reason;
    if (written !== length) throw invalid();
    return { buffer, fileSize };
  } finally {
    signal.removeEventListener('abort', abort);
    response.destroy();
  }
}

export async function prepareDolbyMp4(nas, path, signal) {
  const { buffer, fileSize } = await readSlice(nas, path, 0, HEADER_BYTES, signal);
  const ftyp = atom(buffer, 0, fileSize);
  if (ftyp.type !== 'ftyp') throw invalid();
  let offset = ftyp.end, moov = null;
  for (let i = 0; i < 8 && offset + 8 <= fileSize; i++) {
    let headerBuf = buffer;
    let rel = offset;
    if (offset + 16 > buffer.length) {
      const sliceLen = Math.min(16, fileSize - offset);
      headerBuf = (await readSlice(nas, path, offset, sliceLen, signal, fileSize)).buffer;
      rel = 0;
    }
    const box = atom(headerBuf, rel, fileSize);
    const boxStart = offset;
    const boxEnd = offset + (box.end - box.start);
    if (box.type === 'moov') {
      moov = { start: boxStart, end: boxEnd };
      break;
    }
    if (!['free', 'skip', 'wide', 'pdin'].includes(box.type)) break;
    offset = boxEnd;
  }
  if (!moov || moov.end > fileSize || moov.end - moov.start > MAX_MOOV_BYTES) throw invalid();
  const header = moov.end <= buffer.length ? buffer.subarray(moov.start, moov.end)
    : (await readSlice(nas, path, moov.start, moov.end - moov.start, signal, fileSize)).buffer;
  return { start: moov.start, fileSize, bytes: compactDolbyMp4(header) };
}

export async function movieHeaderHash(nas, path, signal) {
  const { buffer } = await readSlice(nas, path, 0, HEADER_BYTES, signal);
  return createHash('sha256').update(buffer).digest('hex');
}

export function applyMp4Overlay(chunk, offset, overlay) {
  if (!overlay) return chunk;
  const from = Math.max(overlay.start, offset);
  const to = Math.min(overlay.start + overlay.bytes.length, offset + chunk.length);
  if (to <= from) return chunk;
  const out = Buffer.from(chunk);
  overlay.bytes.copy(out, from - offset, from - overlay.start, to - overlay.start);
  return out;
}
