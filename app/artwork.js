(() => {
  'use strict';
  const DEFAULTS = { poster: { width: 480, height: 720 }, cover: { width: 720, height: 416 }, backdrop: { width: 1920, height: 1080 } };
  const MAX_CACHE = 16 * 1024 * 1024;
  const abortError = () => Object.assign(new Error('Artwork request cancelled'), { name: 'AbortError' });

  // This function is self-contained so exactly the same bounded conversion can
  // run in a Worker or as an asynchronous bitmap + small-canvas fallback.
  async function resizeArtwork(blob, limit) {
    let bitmap, canvas;
    try {
      if (typeof createImageBitmap !== 'function') throw new Error('Thumbnail conversion is unavailable');
      const header = new Uint8Array(await blob.slice(0, 524288).arrayBuffer());
      const u16 = (p, little = false) => little ? header[p] + header[p + 1] * 256 : header[p] * 256 + header[p + 1];
      const u32 = p => header[p] * 16777216 + header[p + 1] * 65536 + header[p + 2] * 256 + header[p + 3];
      let knownWidth, knownHeight;
      if (header[0] === 137 && header[1] === 80 && header.length >= 24) { knownWidth = u32(16); knownHeight = u32(20); }
      else if (header[0] === 255 && header[1] === 216) {
        let p = 2;
        while (p + 7 < header.length) {
          if (header[p] !== 255) break;
          while (header[p] === 255) p++;
          const marker = header[p++]; if (marker === 218 || marker === 217) break;
          if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { knownHeight = u16(p + 3); knownWidth = u16(p + 5); break; }
          const length = u16(p); if (length < 2) break; p += length;
        }
      } else if (header[0] === 82 && header[1] === 73 && header[8] === 87 && header[9] === 69 && header.length >= 30) {
        const chunk = String.fromCharCode(...header.slice(12, 16));
        if (chunk === 'VP8X') { knownWidth = 1 + header[24] + header[25] * 256 + header[26] * 65536; knownHeight = 1 + header[27] + header[28] * 256 + header[29] * 65536; }
        else if (chunk === 'VP8L') { const bits = header[21] + header[22] * 256 + header[23] * 65536 + header[24] * 16777216; knownWidth = (bits & 16383) + 1; knownHeight = ((bits >>> 14) & 16383) + 1; }
        else if (chunk === 'VP8 ') { knownWidth = u16(26, true) & 16383; knownHeight = u16(28, true) & 16383; }
      } else if (header[0] === 71 && header[1] === 73 && header[2] === 70 && header.length >= 10) { knownWidth = u16(6, true); knownHeight = u16(8, true); }
      if (!knownWidth || !knownHeight || knownWidth * knownHeight > 24000000) throw new Error('Artwork header is unsupported or dimensions exceed the limit');
      bitmap = await createImageBitmap(blob);
      const sourceWidth = bitmap.width, sourceHeight = bitmap.height;
      if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > 24000000) throw new Error('Artwork dimensions exceed the limit');
      const scale = Math.min(1, limit.width / sourceWidth, limit.height / sourceHeight);
      const width = Math.max(1, Math.floor(sourceWidth * scale)), height = Math.max(1, Math.floor(sourceHeight * scale));
      canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : typeof document !== 'undefined' ? document.createElement('canvas') : null;
      if (!canvas) throw new Error('Thumbnail canvas is unavailable');
      canvas.width = width; canvas.height = height;
      let context = canvas.getContext('2d', { alpha: false });
      if (!context && typeof document !== 'undefined') { canvas.width = canvas.height = 0; canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; context = canvas.getContext('2d', { alpha: false }); }
      if (!context) throw new Error('Thumbnail canvas could not start');
      context.fillStyle = '#101419'; context.fillRect(0, 0, width, height); context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close(); bitmap = null;
      const converted = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/jpeg', quality: .82 }) : await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Thumbnail encoding failed')), 'image/jpeg', .82));
      if (!converted || converted.type !== 'image/jpeg') throw new Error('Thumbnail encoder did not return JPEG');
      return { blob: converted, width, height, sourceWidth, sourceHeight };
    } finally { bitmap?.close(); if (canvas) { canvas.width = 0; canvas.height = 0; } }
  }

  window.createArtworkLoader = ({ workerUrl, worker = true, fetch: fetcher = window.fetch.bind(window), limits = {}, cacheBytes = MAX_CACHE, rootMargin = 180, onStatus = () => {} } = {}) => {
    const bounds = Object.fromEntries(Object.entries(DEFAULTS).map(([kind, original]) => [kind, { width: Math.max(1, Math.min(original.width, Number(limits[kind]?.width) || original.width)), height: Math.max(1, Math.min(original.height, Number(limits[kind]?.height) || original.height)) }]));
    const budget = Math.max(1, Math.min(MAX_CACHE, Number(cacheBytes) || MAX_CACHE));
    const records = new Map(), jobs = new Map(), cache = new Map(); let queue = [], cacheSize = 0, active = null, epoch = 0, destroyed = false, timer;
    let processor, processorUrl, workerReady, workerStartup, workerDisabled = !worker || typeof Worker !== 'function', serial = 0, pendingWorker;
    const isPhoto = img => img.closest?.('.photo-grid,.photo-albums,.photo-viewer,.photo-screen') || /\/photo-(?:image|video)\//.test(img.dataset.artSource || '');
    const supported = img => img?.tagName === 'IMG' && DEFAULTS[img.dataset.artKind] && img.dataset.artSource && !isPhoto(img);
    function announce(record, state) {
      record.state = state; record.img.dataset.artState = state; record.img.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
      try { onStatus(record.img, { state, kind: record.kind }); } catch {}
      if (state === 'loading' || state === 'error') {
        if (!record.status && record.img.parentElement) {
          const node = document.createElement('span'); node.className = 'artwork-status'; node.setAttribute('aria-hidden', 'true');
          Object.assign(node.style, { position: 'absolute', left: record.img.offsetLeft + 'px', top: record.img.offsetTop + 'px', width: record.img.offsetWidth + 'px', height: record.img.offsetHeight + 'px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#15191f', color: '#a6a6ab', fontSize: '22px', pointerEvents: 'none', zIndex: '0' });
          record.img.parentElement.appendChild(node); record.status = node;
        }
        if (record.status) record.status.textContent = state === 'loading' ? '加载中…' : '封面暂不可用';
      } else { record.status?.remove(); record.status = null; }
    }
    function clearImage(record) {
      record.img.removeEventListener('load', record.loaded); record.img.removeEventListener('error', record.failed);
      if (record.url) { if (record.img.getAttribute('src') === record.url) record.img.removeAttribute('src'); URL.revokeObjectURL(record.url); record.url = null; }
      record.targetPixels = 0;
    }
    function detach(record) {
      record.wanted = false; clearImage(record); announce(record, 'idle');
      const job = jobs.get(record.key); if (job) { job.consumers.delete(record); if (!job.consumers.size) { job.abort.abort(); if (!job.started) jobs.delete(job.key); } }
    }
    function forget(record) { observer?.unobserve(record.img); detach(record); records.delete(record.img); }
    function getCached(key) { const entry = cache.get(key); if (entry) { cache.delete(key); cache.set(key, entry); } return entry; }
    function putCached(key, entry) {
      const old = cache.get(key); if (old) { cacheSize -= old.blob.size; cache.delete(key); }
      if (entry.blob.size > budget) return;
      cache.set(key, entry); cacheSize += entry.blob.size;
      while (cacheSize > budget) { const first = cache.keys().next().value; cacheSize -= cache.get(first).blob.size; cache.delete(first); }
    }
    function attach(record, entry) {
      if (destroyed || !record.wanted || !record.img.isConnected || records.get(record.img) !== record || record.img.dataset.artSource !== record.source) return;
      clearImage(record); const url = URL.createObjectURL(entry.blob); record.url = url; record.targetPixels = entry.width * entry.height;
      record.img.dataset.sourceWidth = String(entry.sourceWidth); record.img.dataset.sourceHeight = String(entry.sourceHeight);
      record.img.dataset.artWidth = String(entry.width); record.img.dataset.artHeight = String(entry.height); record.img.dataset.artProcessor = entry.processor;
      record.loaded = () => { if (record.url === url && record.wanted) announce(record, 'ready'); };
      record.failed = () => { if (record.url === url && record.wanted) { clearImage(record); record.retryAt = Date.now() + 15000; announce(record, 'error'); } };
      record.img.addEventListener('load', record.loaded, { once: true }); record.img.addEventListener('error', record.failed, { once: true }); record.img.src = url;
    }
    function terminateWorker(error = abortError()) {
      if (workerStartup) { clearTimeout(workerStartup.timer); workerStartup.reject(error); workerStartup = null; }
      if (pendingWorker) { clearTimeout(pendingWorker.timer); pendingWorker.reject(error); pendingWorker = null; }
      processor?.terminate(); processor = null; workerReady = null;
      if (processorUrl) { URL.revokeObjectURL(processorUrl); processorUrl = null; }
    }
    async function startWorker() {
      if (workerDisabled) throw new Error('Worker unavailable');
      if (workerReady) return workerReady;
      workerReady = new Promise((resolve, reject) => {
        let readyTimer;
        try {
          let url = workerUrl;
          if (!url) {
            const source = `const resize=${resizeArtwork.toString()};self.onmessage=async event=>{const{id,blob,limit}=event.data;try{const result=await resize(blob,limit);self.postMessage({id,result});}catch{self.postMessage({id,error:true});}};self.postMessage({ready:typeof createImageBitmap==='function'&&typeof OffscreenCanvas==='function'});`;
            processorUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' })); url = processorUrl;
          }
          const instance = new Worker(url); processor = instance;
          readyTimer = setTimeout(() => { workerDisabled = true; terminateWorker(new Error('Worker startup timed out')); }, 1800);
          workerStartup = { reject, timer: readyTimer };
          processor.onmessage = event => {
            if (processor !== instance) return;
            const message = event.data;
            if ('ready' in message) { clearTimeout(readyTimer); workerStartup = null; if (message.ready) resolve(); else { workerDisabled = true; terminateWorker(); reject(new Error('Worker conversion unavailable')); } return; }
            const pending = pendingWorker; if (!pending || message.id !== pending.id) return;
            clearTimeout(pending.timer); pendingWorker = null; if (message.error) pending.reject(new Error('Worker conversion failed')); else pending.resolve(message.result);
          };
          processor.onerror = () => { if (processor !== instance) return; clearTimeout(readyTimer); workerDisabled = true; terminateWorker(new Error('Worker unavailable')); reject(new Error('Worker unavailable')); };
        } catch (error) { clearTimeout(readyTimer); workerDisabled = true; terminateWorker(error); reject(error); }
      });
      return workerReady;
    }
    async function convert(blob, kind, signal) {
      const cancel = () => terminateWorker(); signal.addEventListener('abort', cancel, { once: true });
      try {
        if (!workerDisabled) {
          try {
            await startWorker(); if (signal.aborted) throw abortError();
            const result = await new Promise((resolve, reject) => { const id = ++serial; pendingWorker = { id, resolve, reject, timer: setTimeout(() => { workerDisabled = true; terminateWorker(new Error('Worker conversion timed out')); }, 12000) }; processor.postMessage({ id, blob, limit: bounds[kind] }); });
            return { ...result, processor: 'worker' };
          } catch (error) { if (signal.aborted) throw abortError(); workerDisabled = true; terminateWorker(error); }
        }
        if (signal.aborted) throw abortError();
        const result = await resizeArtwork(blob, bounds[kind]); if (signal.aborted) throw abortError(); return { ...result, processor: 'main' };
      } finally { signal.removeEventListener('abort', cancel); }
    }
    async function readSource(response, signal) {
      const maximum = 20 * 1024 * 1024;
      if (!response.ok || Number(response.headers?.get('content-length')) > maximum) throw new Error('Artwork response unavailable');
      if (!response.body?.getReader) { const blob = await response.blob(); if (blob.size > maximum) throw new Error('Artwork response too large'); return blob; }
      const reader = response.body.getReader(), parts = []; let bytes = 0;
      try { for (;;) { if (signal.aborted) throw abortError(); const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maximum) throw new Error('Artwork response too large'); parts.push(next.value); } }
      catch (error) { await reader.cancel().catch(() => {}); throw error; }
      return new Blob(parts, { type: response.headers.get('content-type') || 'application/octet-stream' });
    }
    async function pump() {
      if (active || destroyed) return;
      queue = queue.filter(job => jobs.get(job.key) === job && job.consumers.size && !job.abort.signal.aborted);
      queue.sort((a,b) => a.priority - b.priority); const job = queue.shift(); if (!job) return;
      active = job; job.started = true;
      try {
        const response = await fetcher(job.source, { signal: job.abort.signal, credentials: 'omit', cache: 'no-store' });
        const blob = await readSource(response, job.abort.signal); if (job.abort.signal.aborted || !job.consumers.size) throw abortError();
        const result = await convert(blob, job.kind, job.abort.signal);
        if (destroyed || job.epoch !== epoch || job.abort.signal.aborted || !job.consumers.size) throw abortError();
        putCached(job.key, result); for (const record of job.consumers) attach(record, result);
      } catch (error) {
        if (error.name !== 'AbortError') for (const record of job.consumers) if (record.wanted && records.get(record.img) === record) { record.retryAt = Date.now() + 15000; announce(record, 'error'); }
      } finally { if (jobs.get(job.key) === job) jobs.delete(job.key); active = null; Promise.resolve().then(pump); }
    }
    function request(record) {
      if (!record.wanted || record.url || destroyed) return;
      const cached = getCached(record.key); if (cached) { attach(record, cached); return; }
      if (record.retryAt > Date.now()) return;
      let job = jobs.get(record.key);
      if (!job || job.abort.signal.aborted) { job = { key: record.key, source: record.source, kind: record.kind, priority: record.priority || 10, consumers: new Set(), abort: new AbortController(), epoch, started: false }; jobs.set(job.key, job); queue.push(job); }
      job.consumers.add(record); job.priority = Math.min(job.priority, record.priority || 10); announce(record, 'loading'); Promise.resolve().then(pump);
    }
    function visible(record, value) { if (record.wanted === value) return; record.wanted = value; if (value) request(record); else detach(record); }
    function near(img) { const rect = img.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.bottom > -rootMargin && rect.top < innerHeight + rootMargin && rect.right > -rootMargin && rect.left < innerWidth + rootMargin; }
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { for (const entry of entries) { const record = records.get(entry.target); if (record) visible(record, entry.isIntersecting); } }, { rootMargin: rootMargin + 'px' }) : null;
    function checkVisible() { timer = null; for (const record of records.values()) { if (!record.img.isConnected) forget(record); else visible(record, near(record.img)); } }
    function scheduleVisible() { if (!timer) timer = setTimeout(checkVisible, 80); }
    if (!observer) { window.addEventListener('scroll', scheduleVisible, { capture: true, passive: true }); window.addEventListener('resize', scheduleVisible, { passive: true }); }
    function sync(images) {
      if (destroyed) return;
      const incoming = new Set(Array.from(images || []).filter(supported));
      for (const img of incoming) {
        const previous = records.get(img); if (previous && (previous.source !== img.dataset.artSource || previous.kind !== img.dataset.artKind)) forget(previous);
        if (!records.has(img)) {
          img.removeAttribute('src'); const record = { img, source: img.dataset.artSource, kind: img.dataset.artKind, key: img.dataset.artKind + '|' + img.dataset.artSource, wanted: false, url: null, targetPixels: 0 }; records.set(img, record); announce(record, 'idle');
          if (observer) observer.observe(img); else visible(record, near(img));
        }
      }
      for (const record of Array.from(records.values())) if (!incoming.has(record.img) || !record.img.isConnected) forget(record);
    }
    function observe(container) { sync([...(container?.tagName === 'IMG' ? [container] : []), ...Array.from(container?.querySelectorAll?.('img[data-art-source][data-art-kind]') || [])]); }
    function clearView() { observer?.disconnect(); for (const record of Array.from(records.values())) forget(record); clearTimeout(timer); timer = null; queue = queue.filter(j => j.consumers.size && !j.abort.signal.aborted); }
    function clearAll() { epoch++; clearView(); for (const job of jobs.values()) job.abort.abort(); jobs.clear(); queue = []; cache.clear(); cacheSize = 0; terminateWorker(); }
    function destroy() { if (destroyed) return; clearAll(); destroyed = true; observer?.disconnect(); window.removeEventListener('scroll', scheduleVisible, true); window.removeEventListener('resize', scheduleVisible); }
    return { observe, sync, clearView, clearAll, destroy, prioritize(img) { const record = records.get(img); if (!record) return; record.priority = -10; record.retryAt = 0; const job = jobs.get(record.key); if (job) job.priority = -10; if (record.wanted) request(record); else if (near(img)) visible(record, true); }, stats() { return { cacheBytes: cacheSize, cacheEntries: cache.size, cacheLimit: budget, active: active ? 1 : 0, queued: queue.filter(j => j.consumers.size && !j.abort.signal.aborted).length, activeUrls: Array.from(records.values()).filter(r => r.url).length, decodedTargetPixels: Array.from(records.values()).reduce((n,r) => n + r.targetPixels,0), workerDisabled, records: records.size }; } };
  };
})();
