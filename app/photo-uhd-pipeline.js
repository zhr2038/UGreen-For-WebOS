/* Experimental original-photo -> UHD still-video pipeline. No media is played
 * automatically. A 4K file or videoWidth is not proof of physical UHD output. */
(() => {
  'use strict';
  class PhotoUhdError extends Error {
    constructor(code, message) { super(message); this.name = 'PhotoUhdError'; this.code = code; }
  }
  const fail = (code, message) => new PhotoUhdError(code, message);
  function bounded(operation, { milliseconds, signal, late = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      let done = false, timer;
      const finish = (callback, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value); };
      const abort = () => finish(reject, new DOMException('Operation aborted', 'AbortError'));
      timer = setTimeout(() => finish(reject, fail('PIPELINE_TIMEOUT', '原图处理超时')), Math.max(1, milliseconds));
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      Promise.resolve(operation).then(value => { if (done) late(value); else finish(resolve, value); }, error => finish(reject, error));
    });
  }
  const join = (...parts) => { const result = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0)); let at = 0; for (const part of parts) { result.set(part, at); at += part.byteLength; } return result; };
  const u16 = value => { const bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, value); return bytes; };
  const u32 = value => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes; };
  const ascii = value => Uint8Array.from(value, c => c.charCodeAt(0));
  const zero = length => new Uint8Array(length);
  const box = (name, ...parts) => { const payload = join(...parts); return join(u32(payload.byteLength + 8), ascii(name), payload); };
  const full = (name, flags, ...parts) => box(name, u32(flags), ...parts);
  const matrix = () => join(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

  /** One encoded AVC key image. A duplicate tail sample anchors media clocks
   * which prematurely end truly one-sample videos. No second encoding occurs. */
  function muxAvcStill({ data, avcC, width, height, durationMs, tailAnchor = true }) {
    if (!(data instanceof Uint8Array) || data.length < 5 || data.length > 24 * 1024 * 1024 || !(avcC instanceof Uint8Array) || avcC.length < 7 || avcC[0] !== 1) throw fail('INVALID_AVC', '编码器没有返回有效的 AVC 样本或 avcC');
    if (![width, height, durationMs].every(Number.isSafeInteger) || width < 2 || height < 2 || width > 8192 || height > 8192 || width % 2 || height % 2 || durationMs < 1000 || durationMs > 60000) throw fail('INVALID_TIMING', '静态视频尺寸或时长无效');
    const lengthBytes = (avcC[4] & 3) + 1;
    for (let at = 0; at < data.length;) {
      if (at + lengthBytes > data.length) throw fail('INVALID_AVC', 'AVC 样本长度不完整');
      let length = 0; for (let i = 0; i < lengthBytes; i++) length = length * 256 + data[at++];
      if (!length || at + length > data.length) throw fail('INVALID_AVC', 'AVC 样本不是完整的长度前缀数据');
      at += length;
    }
    const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2avc1mp41'));
    const sampleCount = tailAnchor ? 2 : 1, tailMs = Math.min(1000, Math.floor(durationMs / 2));
    const movie = chunkOffset => {
      const mvhd = full('mvhd', 0, u32(0), u32(0), u32(1000), u32(durationMs), u32(0x10000), u16(0x100), zero(10), matrix(), zero(24), u32(2));
      const tkhd = full('tkhd', 7, u32(0), u32(0), u32(1), u32(0), u32(durationMs), zero(8), zero(8), matrix(), u32(width * 65536), u32(height * 65536));
      const mdhd = full('mdhd', 0, u32(0), u32(0), u32(1000), u32(durationMs), u16(0x55c4), u16(0));
      const hdlr = full('hdlr', 0, u32(0), ascii('vide'), zero(12), ascii('Original photo video\0'));
      const entry = box('avc1', zero(6), u16(1), zero(16), u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0), u16(1), zero(32), u16(24), u16(0xffff), box('avcC', avcC));
      const timing = tailAnchor ? join(u32(2), u32(1), u32(durationMs - tailMs), u32(1), u32(tailMs)) : join(u32(1), u32(1), u32(durationMs));
      const sync = tailAnchor ? join(u32(2), u32(1), u32(2)) : join(u32(1), u32(1));
      const stbl = box('stbl', full('stsd', 0, u32(1), entry), full('stts', 0, timing), full('stsc', 0, u32(1), u32(1), u32(sampleCount), u32(1)), full('stsz', 0, u32(data.length), u32(sampleCount)), full('stco', 0, u32(1), u32(chunkOffset)), full('stss', 0, sync));
      const minf = box('minf', full('vmhd', 1, zero(8)), box('dinf', full('dref', 0, u32(1), full('url ', 1))), stbl);
      return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, minf)));
    };
    const moov = movie(ftyp.length + movie(0).length + 8);
    return join(ftyp, moov, box('mdat', tailAnchor ? join(data, data) : data));
  }

  function originalUrl(value) {
    const url = new URL(value, globalThis.location?.href);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash || !/^\/photo-original\/[0-9a-f]{40}$/.test(url.pathname)) throw fail('ORIGINAL_REQUIRED', 'UHD 编码只接受本机已授权原图链接');
    return url.href;
  }
  async function fetchOriginal(value, { signal, maxBytes = 32 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw fail('INVALID_OPTIONS', '原图读取上限无效');
    const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, 30000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    try {
      const response = await fetch(originalUrl(value), { signal: controller.signal, cache: 'no-store', redirect: 'error' });
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw fail('ORIGINAL_READ_FAILED', '原图读取失败'); }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw fail('SOURCE_TOO_LARGE', '原图超过本机编码的内存上限'); }
      const reader = response.body.getReader(), parts = []; let length = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > maxBytes) throw fail('SOURCE_TOO_LARGE', '原图超过本机编码的内存上限'); parts.push(next.value); } }
      catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      return new Blob(parts, { type: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' });
    } finally { controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function dimensions(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length >= 24 && bytes[0] === 137 && String.fromCharCode(...bytes.slice(1, 4)) === 'PNG') return { width: view.getUint32(16), height: view.getUint32(20), mime: 'image/png' };
    if (bytes[0] === 255 && bytes[1] === 216) {
      let at = 2;
      while (at + 3 < bytes.length) {
        if (bytes[at++] !== 255) break;
        while (bytes[at] === 255) at++;
        const marker = bytes[at++]; if (marker === 217 || marker === 218) break;
        if (marker === 1 || marker >= 208 && marker <= 215) continue;
        if (at + 2 > bytes.length) break;
        const length = view.getUint16(at); if (length < 2 || at + length > bytes.length) break;
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) return { width: view.getUint16(at + 5), height: view.getUint16(at + 3), mime: 'image/jpeg' };
        at += length;
      }
    }
    return null;
  }
  const checkPixels = (width, height) => { if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 50_000_000 || width > 20000 || height > 20000) throw fail('SOURCE_TOO_LARGE', '原始图片尺寸超过本机编码上限'); };
  const matches = (actual, width, height) => !width && !height || actual.width === width && actual.height === height || actual.width === height && actual.height === width;
  async function encoderConfig({ codec = 'avc1.420033', width = 3840, height = 2160, hardwareAcceleration = 'no-preference', bitrate = 40000000 } = {}, limits = {}) {
    if (!globalThis.VideoEncoder?.isConfigSupported || !globalThis.VideoFrame || !globalThis.OffscreenCanvas) throw fail('ENCODER_UNAVAILABLE', '电视浏览器没有提供原图视频编码能力');
    const config = { codec, width, height, bitrate, framerate: 1, hardwareAcceleration, latencyMode: 'quality', avc: { format: 'avc' } };
    if (!/^avc1\.[0-9a-f]{6}$/i.test(codec)) throw fail('CODEC_UNSUPPORTED', '此单帧封装器只接受 AVC');
    const supported = await bounded(VideoEncoder.isConfigSupported(config), { milliseconds: 3000, ...limits });
    if (!supported.supported) throw fail('ENCODER_UNSUPPORTED', '浏览器不支持请求的 UHD AVC 编码配置');
    return supported.config;
  }
  async function encodeStill(original, { expectedWidth, expectedHeight, width = 3840, height = 2160, durationMs = 15000, fit = 'contain', signal, timeoutMs = 30000, codec, hardwareAcceleration, bitrate } = {}) {
    if (!(original instanceof Blob) || !original.size || original.size > 32 * 1024 * 1024) throw fail('SOURCE_TOO_LARGE', '原图为空或超过 32MB 编码上限');
    if (!['contain', 'cover'].includes(fit) || width !== 3840 || height !== 2160 || !Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > 60000 || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw fail('INVALID_OPTIONS', 'UHD 静态视频参数无效');
    checkPixels(expectedWidth, expectedHeight);
    if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
    const pipelineStarted = performance.now(), remaining = () => Math.max(1, timeoutMs - (performance.now() - pipelineStarted));
    const config = await encoderConfig({ codec, width, height, hardwareAcceleration, bitrate }, { signal, milliseconds: Math.min(3000, remaining()) });
    let image, decoder, canvas, encoder, frame, timer, abortListener;
    const started = performance.now();
    try {
      const bytes = new Uint8Array(await bounded(original.arrayBuffer(), { milliseconds: remaining(), signal })), header = dimensions(bytes), mime = header?.mime || original.type.toLowerCase();
      if (header) { checkPixels(header.width, header.height); if (!matches(header, expectedWidth, expectedHeight)) throw fail('SOURCE_DIMENSIONS_MISMATCH', '读取到的文件尺寸与原图不符，不能用预览图代替'); }
      if (header && globalThis.createImageBitmap) image = await bounded(createImageBitmap(original, { imageOrientation: 'from-image' }), { milliseconds: remaining(), signal, late: image => image.close() });
      else {
        if (!globalThis.ImageDecoder?.isTypeSupported || !await bounded(ImageDecoder.isTypeSupported(mime), { milliseconds: remaining(), signal })) throw fail('IMAGE_DECODE_UNSUPPORTED', '浏览器不能解码这个原图格式，请保留系统查看器路径');
        decoder = new ImageDecoder({ data: bytes, type: mime, preferAnimation: false });
        image = (await bounded(decoder.decode({ frameIndex: 0, completeFramesOnly: true }), { milliseconds: remaining(), signal, late: result => result.image.close() })).image;
      }
      const sourceWidth = image.displayWidth || image.width, sourceHeight = image.displayHeight || image.height;
      checkPixels(sourceWidth, sourceHeight); if (!matches({ width: sourceWidth, height: sourceHeight }, expectedWidth, expectedHeight)) throw fail('SOURCE_DIMENSIONS_MISMATCH', '原图解码尺寸与 NAS 原图信息不符');
      if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
      canvas = new OffscreenCanvas(width, height); const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw fail('CANVAS_UNAVAILABLE', '电视没有提供离屏图片绘制能力');
      const scale = (fit === 'cover' ? Math.max : Math.min)(width / sourceWidth, height / sourceHeight), drawnWidth = sourceWidth * scale, drawnHeight = sourceHeight * scale;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
      image.close?.(); image = null; decoder?.close(); decoder = null;
      const chunks = []; let avcC, encodingError, encoderCodedWidth, encoderCodedHeight;
      let reportError; const failed = new Promise(resolve => { reportError = resolve; });
      encoder = new VideoEncoder({
        output(chunk, metadata) {
          try {
            if (chunk.type !== 'key' || chunks.length) throw fail('INVALID_AVC', '静态视频编码没有产生唯一关键帧');
            const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); chunks.push(data);
            if (metadata?.decoderConfig?.description) avcC = new Uint8Array(metadata.decoderConfig.description).slice();
            encoderCodedWidth = metadata?.decoderConfig?.codedWidth; encoderCodedHeight = metadata?.decoderConfig?.codedHeight;
            if (encoderCodedWidth != null && encoderCodedWidth !== width || encoderCodedHeight != null && encoderCodedHeight !== height) throw fail('ENCODED_DIMENSIONS_MISMATCH', '编码器返回了不同的分辨率，不能标为 UHD');
          } catch (error) { encodingError = error; reportError(); }
        },
        error(error) { encodingError = error; reportError(); },
      });
      encoder.configure(config); frame = new VideoFrame(canvas, { timestamp: 0, duration: durationMs * 1000 }); encoder.encode(frame, { keyFrame: true }); frame.close(); frame = null;
      const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(fail('ENCODE_TIMEOUT', '原图编码超时')), remaining()); });
      const aborted = new Promise((resolve, reject) => { abortListener = () => reject(new DOMException('Operation aborted', 'AbortError')); signal?.addEventListener('abort', abortListener, { once: true }); });
      await Promise.race([encoder.flush(), failed, timeout, aborted]);
      if (encodingError) throw encodingError;
      if (chunks.length !== 1 || !avcC) throw fail('INVALID_AVC', '编码器没有返回单帧 MP4 所需的信息');
      const output = muxAvcStill({ data: chunks[0], avcC, width, height, durationMs });
      return { blob: new Blob([output], { type: 'video/mp4' }), report: { sourceMime: mime, sourceWidth, sourceHeight, sourceUpscaled: scale > 1, outputWidth: width, outputHeight: height, encoderCodedWidth, encoderCodedHeight, encodedDimensionsVerified: encoderCodedWidth === width && encoderCodedHeight === height, fit, encodedSamples: 1, containerSamples: 2, durationMs, codec: config.codec, hardwareAccelerationHint: config.hardwareAcceleration, outputBytes: output.length, elapsedMs: Math.round(performance.now() - started), colorPreservation: 'unverified-lossy-video', nativeUhdConfirmed: false } };
    } finally {
      clearTimeout(timer); if (abortListener) signal?.removeEventListener('abort', abortListener);
      frame?.close(); image?.close?.(); decoder?.close(); if (encoder && encoder.state !== 'closed') encoder.close(); if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
  }
  async function encodeOriginal(url, options) { return encodeStill(await fetchOriginal(url, { signal: options?.signal }), options); }
  globalThis.PhotoUhdPipeline = Object.freeze({ PhotoUhdError, originalUrl, fetchOriginal, dimensions, muxAvcStill, encoderConfig, encodeStill, encodeOriginal });
})();
