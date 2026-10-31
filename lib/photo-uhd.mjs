import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const MiB = 1024 * 1024, ID = /^[a-f0-9]{40}$/;
const ownedError = Symbol('photo UHD error');
const failure = (status, code) => Object.assign(new Error(code), { status, code, [ownedError]: true });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tokenValid = value => typeof value === 'string' && /^[\x21-\x7e]{16,512}$/.test(value);
const aborted = () => failure(410, 'CANCELLED');
const errors = { 400: '无效的照片视频', 401: '请先配对电视', 404: '照片视频链接已过期', 405: 'Method not allowed', 410: '照片视频请求已取消', 413: '照片视频超过内存限制', 415: '只接受 MP4 视频', 416: '无效读取范围', 429: '照片视频缓存已满，请先关闭上一张', 502: '无法准备照片视频' };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function spsDimensions(nal) {
  if (nal.length < 4 || (nal[0] & 31) !== 7) throw failure(400, 'INVALID_SPS');
  const bytes = []; for (let i = 1; i < nal.length; i++) { if (i > 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; bytes.push(nal[i]); }
  let at = 0;
  const bits = count => { if (count > 32 || at + count > bytes.length * 8) throw failure(400, 'INVALID_SPS'); let n = 0; while (count--) { n = n * 2 + ((bytes[at >> 3] >> (7 - (at & 7))) & 1); at++; } return n; };
  const ue = () => { let zeros = 0; while (!bits(1)) if (++zeros > 24) throw failure(400, 'INVALID_SPS'); return 2 ** zeros - 1 + (zeros ? bits(zeros) : 0); };
  const se = () => { const value = ue(); return value & 1 ? (value + 1) / 2 : -value / 2; };
  const profile = bits(8), compatibility = bits(8), level = bits(8); ue(); let chroma = 1, separate = 0;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue(); if (chroma > 3) throw failure(400, 'INVALID_SPS'); if (chroma === 3) separate = bits(1);
    if (ue() > 6 || ue() > 6) throw failure(400, 'INVALID_SPS'); bits(1);
    if (bits(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (bits(1)) { let last = 8, next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; } }
  }
  ue(); const order = ue();
  if (order === 0) ue();
  else if (order === 1) { bits(1); se(); se(); const cycles = ue(); if (cycles > 256) throw failure(400, 'INVALID_SPS'); for (let i = 0; i < cycles; i++) se(); }
  else if (order !== 2) throw failure(400, 'INVALID_SPS');
  ue(); bits(1); const codedWidth = (ue() + 1) * 16, mapHeight = ue() + 1, frameOnly = bits(1); if (!frameOnly) bits(1); bits(1);
  let left = 0, right = 0, top = 0, bottom = 0; if (bits(1)) { left = ue(); right = ue(); top = ue(); bottom = ue(); }
  const type = separate ? 0 : chroma, cropX = type === 1 || type === 2 ? 2 : 1, cropY = (type === 1 ? 2 : 1) * (2 - frameOnly), codedHeight = mapHeight * 16 * (2 - frameOnly);
  return { width: codedWidth - (left + right) * cropX, height: codedHeight - (top + bottom) * cropY, codedWidth, codedHeight, codec: 'avc1.' + [profile, compatibility, level].map(n => n.toString(16).padStart(2, '0')).join('') };
}

/** Narrow, bounded validator for the ordinary AVC MP4 produced by this app.
 * Reads SPS coded dimensions; a forged 4K sample-entry label is insufficient. */
export function validatePhotoUhdMp4(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 128 || bytes.length > 16 * MiB) throw failure(400, 'INVALID_MP4');
  let boxCount = 0;
  const u32 = at => { if (at < 0 || at + 4 > bytes.length) throw failure(400, 'INVALID_MP4'); return bytes.readUInt32BE(at); };
  const list = (start, end) => {
    const result = [];
    for (let at = start; at < end;) {
      if (++boxCount > 4096 || at + 8 > end) throw failure(400, 'INVALID_MP4');
      let size = u32(at), header = 8; const type = bytes.toString('ascii', at + 4, at + 8);
      if (size === 1) { if (at + 16 > end) throw failure(400, 'INVALID_MP4'); const big = bytes.readBigUInt64BE(at + 8); if (big > BigInt(bytes.length)) throw failure(400, 'INVALID_MP4'); size = Number(big); header = 16; }
      if (size === 0) size = end - at;
      if (size < header || at + size > end) throw failure(400, 'INVALID_MP4'); result.push({ type, start: at, data: at + header, end: at + size }); at += size;
    }
    return result;
  };
  const one = (items, type) => { const found = items.filter(item => item.type === type); if (found.length !== 1) throw failure(400, 'INVALID_MP4'); return found[0]; };
  const children = box => list(box.data, box.end), top = list(0, bytes.length), moov = one(top, 'moov'), mdat = one(top, 'mdat'); one(top, 'ftyp');
  if (top.some(box => ['moof', 'sidx'].includes(box.type))) throw failure(400, 'FRAGMENTED_MP4_NOT_SUPPORTED');
  const track = one(children(moov), 'trak'), mdia = one(children(track), 'mdia'), media = children(mdia), handler = one(media, 'hdlr');
  if (bytes.toString('ascii', handler.data + 8, handler.data + 12) !== 'vide') throw failure(400, 'VIDEO_ONLY_REQUIRED');
  const mdhd = one(media, 'mdhd'); if (bytes[mdhd.data] !== 0 || mdhd.data + 20 > mdhd.end) throw failure(400, 'INVALID_MP4');
  const timescale = u32(mdhd.data + 12), ticks = u32(mdhd.data + 16), durationMs = ticks * 1000 / timescale;
  if (!timescale || !Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 60000) throw failure(400, 'INVALID_MP4_DURATION');
  const minf = children(one(media, 'minf')), dinf = one(minf, 'dinf'), dref = one(children(dinf), 'dref');
  if (u32(dref.data + 4) !== 1) throw failure(400, 'EXTERNAL_REFERENCE_REJECTED');
  const localReference = one(list(dref.data + 8, dref.end), 'url '); if (u32(localReference.data) !== 1 || localReference.end - localReference.data !== 4) throw failure(400, 'EXTERNAL_REFERENCE_REJECTED');
  const table = children(one(minf, 'stbl')), stsd = one(table, 'stsd'); if (u32(stsd.data + 4) !== 1) throw failure(400, 'AVC_REQUIRED');
  const entry = one(list(stsd.data + 8, stsd.end), 'avc1'); if (entry.data + 78 > entry.end || bytes.readUInt16BE(entry.data + 6) !== 1 || bytes.readUInt16BE(entry.data + 24) !== 3840 || bytes.readUInt16BE(entry.data + 26) !== 2160) throw failure(400, 'UHD_DIMENSIONS_REQUIRED');
  const avcC = one(list(entry.data + 78, entry.end), 'avcC');
  if (avcC.end - avcC.data < 7 || bytes[avcC.data] !== 1 || ![1, 2, 4].includes((bytes[avcC.data + 4] & 3) + 1)) throw failure(400, 'INVALID_AVCC');
  const count = bytes[avcC.data + 5] & 31; if (!count || count > 8) throw failure(400, 'INVALID_AVCC'); let at = avcC.data + 6, coded;
  for (let i = 0; i < count; i++) {
    if (at + 2 > avcC.end) throw failure(400, 'INVALID_AVCC'); const length = bytes.readUInt16BE(at); at += 2;
    if (length < 4 || at + length > avcC.end) throw failure(400, 'INVALID_AVCC'); const dimensions = spsDimensions(bytes.subarray(at, at + length)); at += length;
    if (dimensions.codedWidth !== 3840 || dimensions.codedHeight !== 2160 || dimensions.width !== 3840 || dimensions.height !== 2160) throw failure(400, 'UHD_CODED_DIMENSIONS_REQUIRED');
    if (coded && coded.codec !== dimensions.codec || !dimensions.codec.endsWith(bytes.subarray(avcC.data + 1, avcC.data + 4).toString('hex'))) throw failure(400, 'INVALID_AVCC'); coded = dimensions;
  }
  if (at >= avcC.end) throw failure(400, 'INVALID_AVCC'); const ppsCount = bytes[at++]; if (!ppsCount || ppsCount > 32) throw failure(400, 'INVALID_AVCC');
  for (let i = 0; i < ppsCount; i++) { if (at + 2 > avcC.end) throw failure(400, 'INVALID_AVCC'); const length = bytes.readUInt16BE(at); at += 2; if (!length || at + length > avcC.end || (bytes[at] & 31) !== 8) throw failure(400, 'INVALID_AVCC'); at += length; }
  const stsz = one(table, 'stsz'), fixed = u32(stsz.data + 4), samples = u32(stsz.data + 8); if (!samples || samples > 1800 || stsz.data + 12 + (fixed ? 0 : samples * 4) !== stsz.end) throw failure(400, 'INVALID_SAMPLE_TABLE');
  const sizes = Array.from({ length: samples }, (_, i) => fixed || u32(stsz.data + 12 + i * 4)); if (sizes.some(n => !n)) throw failure(400, 'INVALID_SAMPLE_TABLE');
  const stts = one(table, 'stts'), timingCount = u32(stts.data + 4); if (!timingCount || timingCount > samples || stts.data + 8 + timingCount * 8 !== stts.end) throw failure(400, 'INVALID_SAMPLE_TABLE');
  let sampleTotal = 0, tickTotal = 0; for (let i = 0; i < timingCount; i++) { const n = u32(stts.data + 8 + i * 8), delta = u32(stts.data + 12 + i * 8); if (!n || !delta) throw failure(400, 'INVALID_SAMPLE_TABLE'); sampleTotal += n; tickTotal += n * delta; }
  if (sampleTotal !== samples || tickTotal !== ticks) throw failure(400, 'INVALID_SAMPLE_TABLE');
  const stco = one(table, 'stco'), chunks = u32(stco.data + 4), stsc = one(table, 'stsc'), mappings = u32(stsc.data + 4);
  if (!chunks || chunks > samples || stco.data + 8 + chunks * 4 !== stco.end || mappings !== 1 || stsc.data + 20 !== stsc.end || u32(stsc.data + 8) !== 1 || u32(stsc.data + 16) !== 1) throw failure(400, 'INVALID_SAMPLE_TABLE');
  const perChunk = u32(stsc.data + 12); if (!perChunk || perChunk * chunks !== samples) throw failure(400, 'INVALID_SAMPLE_TABLE');
  let index = 0, lastEnd = mdat.data, nalCount = 0, sawPicture = false; const lengthBytes = (bytes[avcC.data + 4] & 3) + 1;
  for (let i = 0; i < chunks; i++) {
    let offset = u32(stco.data + 8 + i * 4); if (offset < lastEnd) throw failure(400, 'INVALID_SAMPLE_TABLE');
    for (let j = 0; j < perChunk; j++) {
      const end = offset + sizes[index++]; if (end > mdat.end) throw failure(400, 'INVALID_SAMPLE_TABLE');
      while (offset < end) {
        if (++nalCount > 4096 || offset + lengthBytes > end) throw failure(400, 'INVALID_AVC_SAMPLE');
        const length = bytes.readUIntBE(offset, lengthBytes); offset += lengthBytes;
        if (!length || offset + length > end) throw failure(400, 'INVALID_AVC_SAMPLE'); const type = bytes[offset] & 31;
        if (type === 7) { const inband = spsDimensions(bytes.subarray(offset, offset + length)); if (inband.width !== 3840 || inband.height !== 2160 || inband.codedWidth !== 3840 || inband.codedHeight !== 2160) throw failure(400, 'UHD_CODED_DIMENSIONS_REQUIRED'); }
        if (type >= 1 && type <= 5) sawPicture = true; offset += length;
      }
    }
    lastEnd = offset;
  }
  if (!sawPicture) throw failure(400, 'AVC_PICTURE_REQUIRED');
  return { ...coded, durationMs, samples, bytes: bytes.length, nativeUhdConfirmed: false };
}

function identity(photos) { return createHash('sha256').update(JSON.stringify(['server', 'alias', 'username', 'token', 'staticToken', 'authMode'].map(key => photos.nas?.config?.[key]))).digest('hex'); }
function credentials(req, url, context, clientToken, authorized) {
  const header = req.headers.authorization; if (header != null && (typeof header !== 'string' || !/^Bearer [\x21-\x7e]{16,512}$/i.test(header))) throw failure(401, 'UNAUTHORIZED');
  const query = url.searchParams.getAll('client'), bearer = header?.replace(/^Bearer /i, ''); if (query.length > 1 || bearer && query[0] && !same(bearer, query[0])) throw failure(401, 'UNAUTHORIZED');
  const raw = bearer || query[0], client = authorized?.client ?? context.urlContext?.client ?? raw;
  let owner = authorized?.owner ?? context.owner;
  if (clientToken != null) { if (!same(raw || client, clientToken)) throw failure(401, 'UNAUTHORIZED'); owner ??= createHash('sha256').update(clientToken).digest('hex'); }
  if (!owner || typeof owner !== 'string' || owner.length > 512 || !tokenValid(client) || raw && !same(raw, client) || authorized?.owner && context.owner && authorized.owner !== context.owner) throw failure(401, 'UNAUTHORIZED');
  return { owner, client };
}
function response(req, res, status, object) { if (res.destroyed || res.writableEnded) return false; const body = Buffer.from(JSON.stringify(object)); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(req.method === 'HEAD' ? undefined : body); return true; }

export function createPhotoUhdHttpHandler({ photos, clientToken, authorize, makeURL, maxFileBytes = 16 * MiB, maxBytes = 24 * MiB, maxEntries = 2, ttlMs = 120000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!photos?.get || clientToken != null && !tokenValid(clientToken) || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 128 || maxFileBytes > 16 * MiB || !Number.isSafeInteger(maxBytes) || maxBytes < maxFileBytes || maxBytes > 24 * MiB || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 2 || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 120000) throw new TypeError('Invalid bounded photo UHD cache configuration');
  const entries = new Map(), slots = new Set(), active = new Set(); let heldBytes = 0, generation = 0, disposed = false;
  function release(entry) { if (!entry.retired || entry.uploading || entry.readers.size) return; if (slots.delete(entry)) heldBytes -= entry.capacity; entry.buffer = null; }
  function retire(entry, stopReaders = false) {
    if (!entry) return; entry.retired = true; clearTimer(entry.timer); if (entry.id) entries.delete(entry.id); entry.abort?.();
    if (stopReaders) for (const reader of [...entry.readers]) { reader.res.destroy(); reader.finish(); }
    release(entry);
  }
  function outputURL(id, client, urlContext, url) {
    const path = '/photo-uhd/' + id, mapper = urlContext?.makeURL || makeURL;
    const value = mapper ? mapper(path, { ...urlContext, client }) : path + '?client=' + encodeURIComponent(client);
    if (typeof value !== 'string' || value.startsWith('//')) throw failure(502, 'INVALID_LOCAL_URL'); const parsed = new URL(value, url), origin = urlContext?.origin ? new URL(urlContext.origin).origin : null;
    if (!['http:', 'https:'].includes(parsed.protocol) || /^https?:/i.test(value) && parsed.origin !== origin || parsed.pathname !== path || parsed.hash || parsed.username || parsed.password || parsed.searchParams.getAll('client').length !== 1 || !same(parsed.searchParams.get('client'), client) || [...parsed.searchParams.keys()].some(key => key !== 'client')) throw failure(502, 'INVALID_LOCAL_URL');
    return /^https?:/i.test(value) ? parsed.href : parsed.pathname + parsed.search;
  }
  async function handler(req, res, context = {}) {
    const url = context.url instanceof URL ? context.url : new URL(context.url || req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/photos/uhd') && !url.pathname.startsWith('/photo-uhd/')) return false;
    const controller = new AbortController(), external = context.signal || context.requestSignal, epoch = generation;
    const abort = () => { controller.abort(); if (!req.complete) req.destroy(); }, close = () => { if (!res.writableEnded) abort(); };
    req.once('aborted', abort); res.once('close', close); external?.addEventListener('abort', abort, { once: true }); if (external?.aborted) abort(); active.add(abort);
    let upload;
    try {
      const authorized = authorize ? await authorize(req, url, context) : null; if (authorize && !plain(authorized)) throw failure(401, 'UNAUTHORIZED');
      const { owner, client } = credentials(req, url, context, clientToken, authorized);
      if (controller.signal.aborted || disposed) throw aborted();
      if (url.pathname === '/api/photos/uhd') {
        if (req.method !== 'POST') throw failure(405, 'METHOD');
        const assetId = url.searchParams.get('asset'); if (!ID.test(assetId || '')) throw failure(400, 'INVALID_ASSET');
        const asset = photos.get(assetId, owner); if (asset.kind !== 'photoOriginal') throw failure(404, 'ORIGINAL_REQUIRED');
        if (!/^video\/mp4(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, 'MP4_REQUIRED');
        const header = req.headers['content-length'], expected = header == null ? null : Number(header);
        if (expected != null && (!Number.isSafeInteger(expected) || expected < 1 || expected > maxFileBytes)) { req.resume(); throw failure(413, 'FILE_TOO_LARGE'); }
        const capacity = expected ?? maxFileBytes;
        if (slots.size >= maxEntries || heldBytes + capacity > maxBytes) { req.resume(); throw failure(429, 'CACHE_FULL'); }
        upload = { capacity, buffer: Buffer.allocUnsafe(capacity), size: 0, owner, assetId, identity: identity(photos), uploading: true, retired: false, readers: new Set(), expiresAt: now() + ttlMs, abort };
        slots.add(upload); heldBytes += capacity;
        const entry = upload; upload.timer = setTimer(() => retire(entry, true), ttlMs); upload.timer?.unref?.();
        const deadline = setTimer(abort, Math.min(30000, ttlMs)); deadline?.unref?.();
        try {
          for await (const chunk of req) { if (controller.signal.aborted || upload.retired) throw aborted(); if (upload.size + chunk.length > capacity) throw failure(413, 'FILE_TOO_LARGE'); chunk.copy(upload.buffer, upload.size); upload.size += chunk.length; }
        } finally { clearTimer(deadline); }
        if (controller.signal.aborted || epoch !== generation || upload.retired || expected != null && upload.size !== expected) throw aborted();
        const video = upload.buffer.subarray(0, upload.size), info = validatePhotoUhdMp4(video);
        photos.get(assetId, owner); if (upload.identity !== identity(photos) || now() >= upload.expiresAt) throw aborted();
        upload.id = randomBytes(20).toString('hex'); upload.uploading = false; upload.abort = null; entries.set(upload.id, upload);
        const result = { id: upload.id, url: outputURL(upload.id, client, context.urlContext, url), expiresAt: upload.expiresAt, video: info, colorPreservation: 'lossy-video', nativeUhdConfirmed: false };
        if (!response(req, res, 200, result)) throw aborted(); upload = null;
      } else if (url.pathname === '/api/photos/uhd/close') {
        if (req.method !== 'POST') throw failure(405, 'METHOD');
        const parts = []; let size = 0; for await (const part of req) { size += part.length; if (size > 1024) throw failure(413, 'BODY_TOO_LARGE'); parts.push(part); }
        let body; try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw failure(400, 'INVALID_JSON'); }
        if (!plain(body) || Object.keys(body).some(key => key !== 'id') || !ID.test(body.id || '')) throw failure(400, 'INVALID_ID');
        const entry = entries.get(body.id); if (!entry || entry.owner !== owner) throw failure(404, 'NOT_FOUND'); retire(entry, true); response(req, res, 200, { ok: true });
      } else if (/^\/photo-uhd\/[a-f0-9]{40}$/.test(url.pathname)) {
        if (!['GET', 'HEAD'].includes(req.method)) throw failure(405, 'METHOD');
        const entry = entries.get(url.pathname.split('/')[2]);
        if (!entry || entry.owner !== owner) throw failure(404, 'NOT_FOUND');
        if (now() >= entry.expiresAt || entry.identity !== identity(photos)) { retire(entry, true); throw failure(404, 'NOT_FOUND'); }
        try { if (photos.get(entry.assetId, owner).kind !== 'photoOriginal') throw new Error(); } catch { retire(entry, true); throw failure(404, 'NOT_FOUND'); }
        const etag = '"photo-uhd-' + entry.id + '"';
        let start = 0, end = entry.size - 1, status = 200; const range = req.headers['if-range'] && req.headers['if-range'] !== etag ? null : req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || !match[1] && !match[2]) status = 416;
          else { if (!match[1]) start = Math.max(0, entry.size - Number(match[2])); else start = Number(match[1]); end = match[1] && match[2] ? Math.min(entry.size - 1, Number(match[2])) : entry.size - 1; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= entry.size) status = 416; else status = 206; }
        }
        const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', ETag: etag, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Length': status === 416 ? 0 : end - start + 1, ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${entry.size}` } : status === 416 ? { 'Content-Range': `bytes */${entry.size}` } : {}) };
        res.writeHead(status, headers);
        if (req.method === 'HEAD' || status === 416) res.end();
        else {
          const stopRead = () => { res.destroy(); reader.finish(); };
          const reader = { res, finish() { res.off('finish', reader.finish); res.off('close', reader.finish); external?.removeEventListener('abort', stopRead); entry.readers.delete(reader); release(entry); } };
          entry.readers.add(reader); res.once('finish', reader.finish); res.once('close', reader.finish); external?.addEventListener('abort', stopRead, { once: true });
          if (external?.aborted) stopRead(); else res.end(entry.buffer.subarray(start, end + 1));
        }
      } else throw failure(404, 'NOT_FOUND');
    } catch (error) {
      const cancelled = controller.signal.aborted || epoch !== generation;
      if (upload) { upload.uploading = false; retire(upload, true); }
      const status = cancelled ? 410 : errors[error.status] ? error.status : 400;
      if (!res.destroyed && !res.writableEnded) { if (res.headersSent) res.destroy(); else response(req, res, status, { error: errors[status], code: error[ownedError] ? error.code : 'REQUEST_REJECTED' }); }
    } finally { active.delete(abort); req.off('aborted', abort); res.off('close', close); external?.removeEventListener('abort', abort); }
    return true;
  }
  handler.reset = async () => { ++generation; for (const abort of active) abort(); for (const entry of [...slots]) { entry.uploading = false; retire(entry, true); } };
  handler.dispose = async () => { disposed = true; await handler.reset(); };
  handler.snapshot = () => ({ entries: entries.size, slots: slots.size, bytes: heldBytes, disposed });
  return handler;
}
