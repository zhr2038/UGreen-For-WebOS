/* Read-only capability query. No network, playback, pairing or encoder creation. */
(() => {
  'use strict';
  const configs = [
    ['avc-baseline', 'avc1.420033', 'prefer-hardware'],
    ['avc-baseline', 'avc1.420033', 'no-preference'],
    ['avc-high', 'avc1.640033', 'prefer-hardware'],
    ['avc-high', 'avc1.640033', 'prefer-software'],
    ['avc-high', 'avc1.640033', 'no-preference'],
    ['hevc-main', 'hvc1.1.6.L153.B0', 'prefer-hardware'],
    ['hevc-main', 'hvc1.1.6.L153.B0', 'no-preference'],
    ['vp9', 'vp09.00.51.08', 'prefer-hardware'],
    ['vp9', 'vp09.00.51.08', 'no-preference'],
    ['vp8', 'vp8', 'no-preference'],
  ];
  const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heif', 'image/heic', 'image/heif-sequence', 'image/heic-sequence', 'image/tiff'];
  const timed = (fn, milliseconds) => {
    let timer;
    return Promise.race([Promise.resolve().then(fn), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), milliseconds); })]).finally(() => clearTimeout(timer));
  };
  globalThis.probePhotoUhdCapabilities = async ({ timeoutMs = 1200, probe4kCanvas = false } = {}) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 1500) throw new TypeError('Capability query timeout must be 100–1500 ms');
    const start = performance.now(), video = document.createElement('video');
    const report = {
      schema: 'cloudframe.photo-uhd-capabilities.v1',
      userAgent: navigator.userAgent, secureContext: globalThis.isSecureContext, protocol: location.protocol,
      apis: Object.fromEntries(['VideoEncoder', 'VideoDecoder', 'VideoFrame', 'ImageDecoder', 'OffscreenCanvas', 'createImageBitmap', 'MediaSource', 'AudioContext', 'OfflineAudioContext', 'AudioDecoder'].map(name => [name, typeof globalThis[name] !== 'undefined'])),
      encoders: [], images: [], playback: [], canvas4k: { tested: false },
      provesEncoding: false, provesPhysicalUhd: false,
    };
    const jobs = configs.map(([name, codec, hardwareAcceleration]) => async () => {
      const config = { codec, width: 3840, height: 2160, bitrate: 40000000, framerate: 1, hardwareAcceleration, latencyMode: 'quality', ...(name.startsWith('avc') ? { avc: { format: 'avc' } } : {}) };
      if (!globalThis.VideoEncoder?.isConfigSupported) return report.encoders.push({ name, codec, hardwareAcceleration, supported: false, reason: 'api-unavailable' });
      try { const support = await timed(() => VideoEncoder.isConfigSupported(config), timeoutMs); report.encoders.push({ name, codec, hardwareAcceleration, supported: support.supported === true, recognizedConfig: support.config }); }
      catch (error) { report.encoders.push({ name, codec, hardwareAcceleration, supported: false, reason: error.name === 'Error' && error.message === 'timeout' ? 'timeout' : error.name }); }
    });
    // Bounded concurrency avoids queuing ten platform capability checks at once.
    await Promise.all(Array.from({ length: 3 }, async () => { while (jobs.length) await jobs.shift()(); }));
    await Promise.all(imageTypes.map(async type => {
      if (!globalThis.ImageDecoder?.isTypeSupported) return report.images.push({ type, supported: false, reason: 'api-unavailable' });
      try { report.images.push({ type, supported: await timed(() => ImageDecoder.isTypeSupported(type), timeoutMs) }); }
      catch (error) { report.images.push({ type, supported: false, reason: error.message === 'timeout' ? 'timeout' : error.name }); }
    }));
    report.encoders.sort((a, b) => configs.findIndex(([, codec, hardware]) => codec === a.codec && hardware === a.hardwareAcceleration) - configs.findIndex(([, codec, hardware]) => codec === b.codec && hardware === b.hardwareAcceleration));
    report.images.sort((a, b) => imageTypes.indexOf(a.type) - imageTypes.indexOf(b.type));
    for (const mime of ['video/mp4; codecs="avc1.420033"', 'video/mp4; codecs="avc1.640033"', 'video/mp4; codecs="hvc1.1.6.L153.B0"', 'video/webm; codecs="vp9"', 'video/webm; codecs="vp8"']) {
      report.playback.push({ mime, canPlayType: video.canPlayType(mime), mediaSource: Boolean(globalThis.MediaSource?.isTypeSupported(mime)) });
    }
    if (probe4kCanvas && globalThis.OffscreenCanvas) {
      let canvas;
      try {
        canvas = new OffscreenCanvas(3840, 2160); const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('context-unavailable');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 3840, 2160); ctx.fillStyle = '#fff'; ctx.fillRect(3838, 0, 1, 2);
        const data = ctx.getImageData(3837, 0, 3, 1).data;
        report.canvas4k = { tested: true, width: canvas.width, height: canvas.height, onePixelPreserved: data[0] === 0 && data[4] === 255 && data[8] === 0 };
      } catch (error) { report.canvas4k = { tested: true, error: error.name || 'Error' }; }
      finally { if (canvas) { canvas.width = 1; canvas.height = 1; } }
    }
    report.elapsedMs = Math.round(performance.now() - start); return report;
  };
})();
