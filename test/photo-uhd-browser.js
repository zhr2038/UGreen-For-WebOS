async page => {
  const base = '__UI_BASE_URL__';
  await page.goto(base + '/blank.html');
  await page.addScriptTag({ url: base + '/photo-uhd-probe.js' });
  await page.addScriptTag({ url: base + '/photo-uhd-pipeline.js' });
  return page.evaluate(async base => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const capabilities = await probePhotoUhdCapabilities({ probe4kCanvas: true });
    await fetch(base + '/artifact/capabilities.json', { method: 'POST', body: JSON.stringify(capabilities) });
    const configs = capabilities.encoders.filter(item => item.supported && item.name.startsWith('avc'));
    check(configs.length, 'This local browser exposes no UHD AVC encoder');
    check(capabilities.canvas4k.onePixelPreserved, '4K canvas backing did not preserve one-pixel detail');
    const results = [], attempts = [];
    for (const type of ['png', 'jpg']) {
      const source = await (await fetch(base + '/source.' + type)).blob();
      let encoded, config;
      for (const candidate of configs) {
        try { encoded = await PhotoUhdPipeline.encodeStill(source, { expectedWidth: 3840, expectedHeight: 2160, durationMs: 15000, codec: candidate.codec, hardwareAcceleration: candidate.hardwareAcceleration }); config = candidate; break; }
        catch (error) { attempts.push({ input: type, codec: candidate.codec, hardware: candidate.hardwareAcceleration, error: error.name, code: error.code }); }
      }
      await fetch(base + '/artifact/attempts.json', { method: 'POST', body: JSON.stringify(attempts) }); check(encoded, 'All advertised UHD AVC encoders failed actual initialization');
      check(encoded.report.sourceWidth === 3840 && encoded.report.sourceHeight === 2160, 'Original dimensions were not decoded');
      check(encoded.report.nativeUhdConfirmed === false, 'Software test claimed physical output');
      const saved = await fetch(base + '/artifact/' + type + '.mp4', { method: 'POST', body: encoded.blob }); check(saved.ok, 'Could not save encoded validation artifact');
      const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.preload = 'auto'; video.style.width = '960px'; document.body.appendChild(video);
      const url = URL.createObjectURL(encoded.blob);
      try {
        const loaded = new Promise((resolve, reject) => { video.addEventListener('loadeddata', resolve, { once: true }); video.addEventListener('error', () => reject(new Error('Encoded file failed native HTML video decoding')), { once: true }); });
        video.src = url; await loaded; await video.play(); await new Promise(resolve => setTimeout(resolve, 250)); video.pause();
        check(video.videoWidth === 3840 && video.videoHeight === 2160, 'HTML video did not decode UHD pixels'); check(Math.abs(video.duration - 15) < .02, 'Single-frame sample has unreliable duration');
        check(video.currentTime >= .1 && video.currentTime < 1 && !video.ended, 'Video did not hold the still frame across time');
        const canvas = new OffscreenCanvas(3840, 2160), ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
        const samples = ctx.getImageData(3836, 100, 4, 1).data, contrast = Math.abs(samples[0] - samples[4]);
        check(contrast > 150, 'Decoded video lost one-pixel black/white contrast');
        const heldForMs = Math.round(video.currentTime * 1000); let minimumAnchorContrast;
        if (type === 'png') {
          const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true })); video.currentTime = 13.8; await seeked; await video.play();
          const contrasts = [];
          for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 100)); ctx.drawImage(video, 0, 0); const pixels = ctx.getImageData(3836, 100, 2, 1).data; contrasts.push(Math.abs(pixels[0] - pixels[4])); }
          video.pause(); minimumAnchorContrast = Math.min(...contrasts); check(minimumAnchorContrast > 150 && video.currentTime > 14.5 && !video.ended, 'Tail anchor produced a decoded black frame or premature ending');
        }
        results.push({ input: type, ...encoded.report, decodedWidth: video.videoWidth, decodedHeight: video.videoHeight, htmlDuration: video.duration, heldForMs, lumaContrast: contrast, minimumAnchorContrast, noPhysicalOutputClaim: true });
        canvas.width = 1; canvas.height = 1;
      } finally { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url); }
    }
    const preview = new OffscreenCanvas(1280, 720); preview.getContext('2d').fillRect(0, 0, 1280, 720); const reduced = await preview.convertToBlob({ type: 'image/png' }); let refused = false;
    try { await PhotoUhdPipeline.encodeStill(reduced, { expectedWidth: 3840, expectedHeight: 2160, codec: results[0].codec, hardwareAcceleration: results[0].hardwareAccelerationHint }); }
    catch (error) { refused = error.code === 'SOURCE_DIMENSIONS_MISMATCH'; }
    check(refused, '1280 preview was silently accepted as the requested original');
    return { capabilities, attempts, results, previewSubstitutionRejected: true, physicalUhdValidated: false };
  }, base);
}
