async page => {
  const base = '__UI_BASE_URL__', cases = [], calls = [], requests = [], uhdUploads = [], filter = __UI_FILTER__;
  let scenario, infoPending = [], startPending = [], commitPending = [], candidates = new Map(), active = new Map();
  const check = (value, message) => { if (!value) throw new Error(message); };
  const until = async predicate => { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Mock request did not reach its synchronization point'); await new Promise(resolve => setTimeout(resolve, 5)); } };
  const uhdVideo = () => page.locator('video[data-cloudframe-photo-lease]');
  const hasUhdSource = () => page.evaluate(() => [...document.querySelectorAll('video')].some(video => video.src.includes('/photo-uhd/')));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHAAAAABJRU5ErkJggg==', 'base64');
  const photo = id => ({ id: String(id), name: '测试照片 ' + id, kind: 'image', format: 'png', width: 4000, height: 3000, thumb: '/mock.png', view: '/photo-image/preview-' + id, original: '/photo-original/original-' + id, motion: '/photo-motion/live-' + id, info: '/api/photos/info?asset=' + id, output: { browserOriginalCandidate: true, nativeUhdConfirmed: false } });
  await page.setViewportSize({ width: 1920, height: 1080 });
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => {
    window.__mediaEvents = []; window.__mediaElements = []; window.__pendingPhotoMedia = [];
    // Capture only public factory callbacks. These tests never read private S.
    let loginFactory, galleryFactory;
    Object.defineProperty(window, 'createDirectLogin', { configurable: true, get: () => loginFactory, set(factory) { loginFactory = options => { window.__reconnectPhotoGateway = gateway => options.connected(gateway, {}); return factory(options); }; } });
    Object.defineProperty(window, 'createPhotoGallery', { configurable: true, get: () => galleryFactory, set(factory) { galleryFactory = options => { if (localStorage.getItem('test.photoFallbackPlane') === 'true') options = { ...options, videoPlane: undefined }; const gallery = factory(options); window.__photoGallery = gallery; return gallery; }; } });
    const p = HTMLMediaElement.prototype, get = Element.prototype.getAttribute, remove = Element.prototype.removeAttribute;
    Object.defineProperties(p, {
      src: { configurable: true, get() { return this.__source || ''; }, set(value) { this.__source = value; } },
      paused: { configurable: true, get() { return this.__paused ?? true; } },
      currentTime: { configurable: true, get() { return this.__time || 0; }, set(value) { this.__time = value; } },
      duration: { configurable: true, get() { return 300; } },
      readyState: { configurable: true, get() { return this.__source ? 4 : 0; } },
    });
    Object.defineProperties(HTMLVideoElement.prototype, { videoWidth: { configurable: true, get() { return this.__source?.includes('/photo-uhd/') ? 3840 : 1920; } }, videoHeight: { configurable: true, get() { return this.__source?.includes('/photo-uhd/') ? 2160 : 1080; } } });
    p.getAttribute = function(name) { return name === 'src' ? this.__source || null : get.call(this, name); };
    p.removeAttribute = function(name) { if (name === 'src') { this.__source = ''; window.__mediaEvents.push({ tag: this.tagName, action: 'release' }); return; } return remove.call(this, name); };
    p.load = function() { if (!this.__source) this.__time = 0; };
    p.pause = function() { this.__paused = true; window.__mediaEvents.push({ tag: this.tagName, action: 'pause' }); this.dispatchEvent(new Event('pause')); };
    p.play = function() {
      if (!window.__mediaElements.includes(this)) window.__mediaElements.push(this);
      const overlap = window.__mediaElements.some(m => m !== this && m.__source && m.__paused === false);
      this.__paused = false; window.__mediaEvents.push({ tag: this.tagName, action: 'play', overlap, src: this.__source });
      if (this.tagName === 'AUDIO') window.__soundtrack = this;
      this.dispatchEvent(new Event('play')); const deliver = () => {
        if (this.tagName === 'VIDEO' && (this.__source.includes('/photo-hls/') && localStorage.getItem('test.photoCandidateFail') === 'true' || this.__source.includes('/photo-uhd/') && localStorage.getItem('test.photoUhdVideoFail') === 'true')) { this.dispatchEvent(new Event('error')); return; }
        this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('loadeddata'));
      }; if (this.__source.includes('/photo-hls/') && localStorage.getItem('test.photoDeferMedia') === 'true') __pendingPhotoMedia.push(deliver); else queueMicrotask(deliver); return Promise.resolve();
    };
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/photo-') || url.pathname === '/mock.png') return route.fulfill({ contentType: 'image/png', body: png });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push(url.pathname + url.search); const request = { path: url.pathname, query: url.search, token: route.request().headers().authorization, body: route.request().headers()['content-type']?.includes('application/json') && route.request().postData() ? route.request().postDataJSON() : null }; requests.push(request); let data;
    if (url.pathname === '/api/home') data = { name: 'Mock NAS', accountScope: 'synthetic-account-' + (scenario.account || 'a'), hero: [], recent: [], updates: [], favorites: [], libraries: [] };
    else if (url.pathname === '/api/photos/albums') data = { items: [{ id: 'album-' + (scenario.account || 'a'), type: 1, name: '示例相册', total: 2, cover: '/mock.png' }], total: 1, offset: 0, limit: 48, last: true };
    else if (url.pathname === '/api/photos/categories') data = { items: [{ id: 'groupcap', name: '示例分类', total: 1, cover: '/mock.png' }], total: 1, offset: 0, limit: 48, last: true };
    else if (url.pathname === '/api/photos/info') { data = { item: photo(url.searchParams.get('asset')), metadata: { camera: 'Test Camera', iso: '100' } }; if (scenario.deferInfo) await new Promise(resolve => infoPending.push({ resolve })); }
    else if (url.pathname === '/api/photos/preview-visibility') { const show = route.request().postDataJSON().show; data = { item: { ...photo(1), sensitive: true, revealed: show, original: show ? '/photo-original/original-1' : '', motion: '', view: show ? '/photo-image/sensitive-visible-1' : '/photo-image/preview-1' } }; }
    else if (url.pathname === '/api/photos/music') data = { items: [{ id: 'track-' + (scenario.account || 'a'), name: '示例背景音乐 ' + (scenario.account || 'a'), stream: '/photo-music/music-' + (scenario.account || 'a'), mime: 'audio/mpeg' }] };
    else if (url.pathname === '/api/photos/uhd') { const id = (uhdUploads.length + 1).toString(16).padStart(40, '0'); uhdUploads.push({ id, type: route.request().headers()['content-type'], asset: url.searchParams.get('asset'), bytes: route.request().postDataBuffer()?.length }); if (scenario.slowUhdUpload) await new Promise(r => setTimeout(r, 250)); data = { id, url: '/photo-uhd/' + id, nativeUhdConfirmed: false }; }
    else if (url.pathname === '/api/photos/uhd/close') data = { ok: true };
    else if (url.pathname === '/api/photos/video/start') { const id = (++scenario.startCount).toString(16).padStart(40, '0'); data = { id, original: '/photo-video/clip-2', options: { qualities: [{ id: 'original', label: '原画', original: true }, { id: '1080P@1920x1080', label: '1080P', resolution: '1920x1080' }] } }; active.set(id, { id, candidate: null, selected: 'original', kind: 'original', quality: data.options.qualities[0], url: data.original }); if (scenario.deferStarts) await new Promise(resolve => startPending.push({ id, resolve })); else if (scenario.slowVideoStart) await new Promise(r => setTimeout(r, 250)); }
    else if (url.pathname === '/api/photos/video/quality') { const { id, quality, request } = route.request().postDataJSON(); if (scenario.slowQuality) await new Promise(r => setTimeout(r, 250)); const candidate = (++scenario.qualityCount).toString(16).padStart(40, '0'); data = { candidate, request, kind: quality === 'original' ? 'original' : 'hls', quality: quality === 'original' ? { id: 'original', label: '原画', original: true } : { id: quality, label: '1080P', resolution: '1920x1080' }, url: quality === 'original' ? '/photo-video/clip-2' : '/photo-hls/' + candidate + '/playlist.m3u8' }; candidates.set(candidate, { ...data, id, selected: quality }); }
    else if (url.pathname === '/api/photos/video/commit') { const { id, candidate } = route.request().postDataJSON(), selected = candidates.get(candidate); if (!scenario.commitNotAccepted) active.set(id, { ...selected, candidate }); if (scenario.deferCommit) await new Promise(resolve => commitPending.push({ resolve })); if (scenario.loseCommit === true || scenario.loseCommit === selected.kind) return route.abort('failed'); data = { ok: true, selected: selected.selected }; }
    else if (url.pathname === '/api/photos/video/active') { if (scenario.activeUnavailable) return route.abort('failed'); data = active.get(url.searchParams.get('id')); }
    else if (url.pathname === '/api/photos/video/close') { active.delete(request.body.id); data = { ok: true }; }
    else if (url.pathname === '/api/photos/video/discard') data = { ok: true };
    else if (url.pathname === '/api/photos/memories') data = { items: [{ id: 'memory-1', name: '示例回忆', totalKnown: false, cover: '/mock.png' }], total: 1, offset: 0, limit: 48, last: true };
    else if (url.pathname === '/api/photos/folders') {
      const folder = url.searchParams.get('folder');
      data = !folder ? { folders: [{ id: 'folder-1', name: '照片目录', total: 1 }], items: [], breadcrumbs: [], title: '文件夹', total: 1, totalKnown: false, offset: 0, limit: 48, last: true } : { folders: folder === 'folder-1' ? [{ id: 'folder-2', name: '子目录', total: 1 }] : [], items: [photo(1)], breadcrumbs: [{ id: 'folder-1', name: '照片目录' }, ...(folder === 'folder-2' ? [{ id: 'folder-2', name: '子目录' }] : [])], title: folder === 'folder-1' ? '照片目录' : '子目录', total: 1, totalKnown: false, offset: 0, limit: 48, last: true };
    } else {
      const offset = Number(url.searchParams.get('offset') || 0), total = scenario.total;
      const items = Array.from({ length: Math.min(48, Math.max(0, total - offset)) }, (_, i) => photo(offset + i + 1));
      if (scenario.sensitive && items[0]) items[0] = { ...items[0], sensitive: true, revealed: false, original: '', motion: '' };
      if (scenario.videoSecond && offset === 0 && items[1]) items[1] = { ...items[1], kind: 'video', stream: '/photo-video/clip-2', original: '', motion: '' };
      data = { items, total, offset, limit: 48, last: offset + items.length >= total };
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  async function boot(options = {}) {
    scenario = { total: 2, startCount: 0, qualityCount: 0, account: 'a', ...options }; calls.length = 0; requests.length = 0; uhdUploads.length = 0; infoPending = []; startPending = []; commitPending = []; candidates = new Map(); active = new Map();
    await page.goto(base + '/blank.html');
    await page.evaluate(({ base, options }) => { localStorage.clear(); localStorage.setItem('cinema.server', base); localStorage.setItem('cinema.token', 'fake-token'); localStorage.setItem('cinema.photoInterval', String(options.interval || 5)); localStorage.setItem('cinema.photoMode', options.mode || 'sequential'); localStorage.setItem('cinema.photoMusicOn', options.music ? '1' : '0'); localStorage.setItem('test.photoCandidateFail', String(Boolean(options.candidateFail))); localStorage.setItem('test.photoUhdVideoFail', String(Boolean(options.uhdVideoFail))); localStorage.setItem('test.photoFallbackPlane', String(Boolean(options.fallbackPlane))); localStorage.setItem('test.photoDeferMedia', String(Boolean(options.deferMedia))); }, { base, options });
    await page.goto(base);
    await page.evaluate(options => {
      window.__photoMusicCreations = 0;
      if (options.frameCallbackUnsupported) { HTMLVideoElement.prototype.requestVideoFrameCallback = () => { throw new DOMException('Synthetic unsupported TV callback', 'NotSupportedError'); }; HTMLVideoElement.prototype.cancelVideoFrameCallback = () => { throw new DOMException('Synthetic unsupported TV callback', 'NotSupportedError'); }; }
      if (options.legacyMusic) { delete window.createPhotoMusic; return; }
      window.createPhotoMusic = () => {
        window.__photoMusicCreations++; let src = '', paused = true, currentTime = 0, loaded = false, disposed = false;
        const state = () => ({ src, paused, currentTime, loaded, contextState: disposed ? 'closed' : paused ? 'suspended' : 'running', audibleVerified: false });
        const event = action => window.__mediaEvents.push({ tag: 'WEBAUDIO', action, src });
        const player = { state, get currentTime() { return currentTime; }, set currentTime(value) { currentTime = value; }, play(url, { position = 0 } = {}) { src = url; paused = false; loaded = true; currentTime = position; window.__soundtrack = player; event('play'); return Promise.resolve(state()); }, pause() { paused = true; event('pause'); return Promise.resolve(state()); }, resume() { paused = false; event('play'); return Promise.resolve(state()); }, stop() { paused = true; src = ''; currentTime = 0; loaded = false; event('stop'); return Promise.resolve(state()); }, setVolume() {}, dispose() { disposed = true; return player.stop(); } };
        return player;
      };
    }, options);
    if (options.uhd) await page.evaluate(options => {
      window.__uhdSources = []; window.__uhdEncodePending = []; window.PhotoUhdPipeline = { async encodeOriginal(source, settings) { const record = { source, width: settings.expectedWidth, height: settings.expectedHeight, fit: settings.fit, aborted: false }; settings.signal.addEventListener('abort', () => { record.aborted = true; }, { once: true }); window.__uhdSources.push(record); if (options.deferEncode) await new Promise(resolve => window.__uhdEncodePending.push(resolve)); if (options.uhdDecodeFail) throw Object.assign(new Error('fake unsupported original'), { code: 'IMAGE_DECODE_UNSUPPORTED' }); return { blob: new Blob([new Uint8Array(12)], { type: 'video/mp4' }), report: { sourceUpscaled: true, nativeUhdConfirmed: false } }; } };
    }, options);
    await page.locator('[data-route="photos"]').click(); await page.waitForSelector('[data-photo="0"]');
  }
  async function run(name, options, fn) {
    if (filter && !name.includes(filter)) return;
    try { await boot(options); await fn(); cases.push({ name, ok: true }); }
    catch (e) { cases.push({ name, ok: false, error: e.message }); }
  }
  await run('原图切换保留源标记并可回到预览', {}, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-original').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.src.includes('/photo-original/'));
    check((await page.locator('.photo-view-top').textContent()).includes('原图文件'), 'Original source not labelled');
    await page.locator('#photo-original').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.src.includes('/photo-image/'));
  });
  await run('信息面板方向键不泄漏焦点且返回只关闭面板', {}, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-info').click(); await page.waitForFunction(() => document.querySelector('#photo-info-content')?.textContent.includes('Test Camera')); await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement.id) === 'photo-info-close', 'Info focus escaped'); await page.keyboard.press('Escape'); check(await page.locator('.photo-viewer').count() === 1 && await page.locator('#photo-info-dialog').count() === 0, 'Back closed viewer');
  });
  await run('文件夹面包屑和逐级返回保持上下文', {}, async () => {
    await page.locator('[data-photo-tab="folders"]').click(); await page.locator('[data-photo-folder="0"]').click(); await page.locator('[data-photo-folder="0"]').click(); await page.waitForFunction(() => document.querySelector('.photo-heading h2')?.textContent === '子目录');
    check(await page.locator('[data-folder-crumb]').count() === 2, 'Breadcrumbs missing'); await page.locator('[data-photo="0"]').click(); check((await page.locator('.photo-counter').textContent()).includes('本页'), 'Unknown folder total was presented as global photo total');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('.photo-heading h2')?.textContent === '照片目录');
    await page.locator('#photo-folder-root').click(); await page.waitForSelector('[data-photo-folder="0"]');
  });
  await run('精选回忆卡片通过短期句柄读取播放列表', {}, async () => {
    await page.locator('[data-photo-tab="memories"]').click(); await page.locator('[data-photo-memory="0"]').click(); await page.waitForSelector('[data-photo="0"]'); check(calls.some(path => path.includes('memory=memory-1')), 'Memory handle not used');
    await page.keyboard.press('Escape'); await page.waitForSelector('[data-photo-memory="0"]');
  });
  await run('幻灯片设置包含完整时长和适应填充且遥控焦点受限', {}, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-settings').click(); const duration = page.locator('[data-photo-setting="interval"]');
    const values = new Set(); for (let i = 0; i < 5; i++) { values.add(await duration.textContent()); await duration.click(); }
    for (const seconds of [2, 3, 5, 10, 15]) check([...values].some(value => value.includes(`：${seconds} 秒`)), 'Missing duration ' + seconds);
    await page.locator('[data-photo-setting="display"]').click(); check(await page.locator('#photo-full').evaluate(img => img.classList.contains('photo-fill')), 'Fill not applied');
    await page.locator('[data-photo-setting="mode"]').focus(); await page.keyboard.press('ArrowDown'); check(await page.evaluate(() => document.activeElement.dataset.photoSetting) === 'display', 'Settings focus navigation failed');
    await page.keyboard.press('Escape'); check(await page.locator('.photo-viewer').count() === 1, 'Settings Back left viewer');
  });
  await run('循环幻灯片在末项后返回首项', { interval: 2, mode: 'loop' }, async () => {
    await page.locator('#photo-start').click(); await page.waitForFunction(() => document.querySelector('.photo-counter')?.textContent.startsWith('2 /'), { timeout: 4000 }); await page.waitForFunction(() => document.querySelector('.photo-counter')?.textContent.startsWith('1 /'), { timeout: 4000 });
    check((await page.locator('#photo-slideshow').textContent()).includes('暂停'), 'Loop stopped unexpectedly');
  });
  await run('随机幻灯片可跨越当前页读取全局目标', { interval: 2, mode: 'random', total: 100 }, async () => {
    await page.evaluate(() => Math.random = () => .99); await page.locator('#photo-start').click(); await page.waitForFunction(() => document.querySelector('.photo-counter')?.textContent.startsWith('100 /'), { timeout: 4500 });
    check(calls.some(path => path.includes('offset=96')), 'Random mode only shuffled the current page');
  });
  await run('图片WebAudio音乐在视频前停止Source并在返回图片后恢复位置', { music: true, videoSecond: true, mode: 'loop' }, async () => {
    await page.locator('#photo-start').click(); await page.waitForFunction(() => window.__mediaEvents.some(event => event.tag === 'WEBAUDIO' && event.action === 'play'));
    await page.evaluate(() => window.__soundtrack.currentTime = 42); await page.locator('#photo-next').click(); await page.waitForSelector('#photo-clip');
    const events = await page.evaluate(() => window.__mediaEvents); const videoPlay = events.findIndex(event => event.tag === 'VIDEO' && event.action === 'play'); check(events.slice(0, videoPlay).some(event => event.tag === 'WEBAUDIO' && event.action === 'pause'), 'Software source was not stopped before movie audio');
    await page.locator('#photo-clip').evaluate(clip => clip.dispatchEvent(new Event('ended'))); await page.waitForSelector('#photo-full'); await page.waitForFunction(() => window.__soundtrack.state().paused === false && window.__soundtrack.currentTime === 42);
    check(await page.evaluate(() => !window.__mediaEvents.some(event => event.overlap || event.tag === 'AUDIO')), 'A second hardware audio element was allocated'); await page.keyboard.press('Escape'); check(await page.evaluate(() => window.__soundtrack.state().paused), 'Gallery left a software source playing');
  });
  await run('隐藏页面暂停幻灯片并释放背景音乐', { music: true }, async () => {
    await page.locator('#photo-start').click(); await page.waitForFunction(() => window.__soundtrack && !window.__soundtrack.state().paused);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    check(await page.evaluate(() => window.__soundtrack.state().paused), 'Hidden page kept audio active');
  });
  await run('敏感图像仅在用户显示操作后揭示且退出预览恢复默认', { sensitive: true }, async () => {
    await page.locator('[data-photo="0"]').click(); check((await page.locator('#photo-sensitive').textContent()).includes('显示'), 'Sensitive default was not hidden'); check(!calls.some(path => path.includes('preview-visibility')), 'Sensitive image was automatically revealed');
    await page.locator('#photo-sensitive').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.src.includes('sensitive-visible')); check((await page.locator('#photo-sensitive').textContent()).includes('隐藏'), 'Hide action missing');
    await page.keyboard.press('Escape'); await page.locator('[data-photo="0"]').click(); check((await page.locator('#photo-sensitive').textContent()).includes('显示'), 'Reveal persisted outside its preview');
  });
  await run('相册视频支持完整速度集合和重新播放', { videoSecond: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.waitForSelector('#photo-video-speed'); const values = new Set();
    for (let i = 0; i < 6; i++) { values.add(await page.locator('#photo-clip').evaluate(clip => clip.playbackRate)); await page.locator('#photo-video-speed').click(); }
    for (const rate of [.5, .75, 1, 1.25, 1.5, 2]) check(values.has(rate), 'Missing rate ' + rate);
    await page.locator('#photo-clip').evaluate(clip => clip.currentTime = 100); await page.locator('#photo-video-restart').click(); check(await page.locator('#photo-clip').evaluate(clip => clip.currentTime) === 0, 'Restart did not seek to beginning');
  });
  await run('相册视频画质切换保留位置并在离开时释放NAS任务', { videoSecond: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-clip').evaluate(clip => clip.currentTime = 75);
    check(!calls.some(path => path.endsWith('/video/start')), 'Transcode task started without opening quality');
    await page.locator('#photo-video-quality').click(); await page.waitForSelector('[data-photo-quality="1"]'); await page.keyboard.press('ArrowDown'); check(await page.evaluate(() => document.activeElement.dataset.photoQuality) === '1', 'Quality focus escaped dialog');
    await page.locator('[data-photo-quality="1"]').click(); await page.waitForFunction(() => document.querySelector('#photo-clip')?.src.includes('/photo-hls/')); await page.waitForFunction(() => !document.querySelector('#photo-video-quality')?.disabled);
    check(await page.locator('#photo-clip').evaluate(clip => clip.currentTime) === 75, 'Quality did not restore playback position');
    check(calls.some(path => path.endsWith('/video/commit')), 'Decoded candidate was not committed');
    await page.locator('#photo-video-quality').click(); await page.locator('[data-photo-quality="0"]').click(); await page.waitForFunction(() => document.querySelector('#photo-clip')?.src.includes('/photo-video/'));
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !!document.querySelector('.photo-grid')); check(calls.some(path => path.endsWith('/video/close')), 'Leaving video did not close NAS task');
  });
  await run('晚到的相册视频画质会话在关闭面板后立即释放', { videoSecond: true, slowVideoStart: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-video-quality').click(); await page.keyboard.press('Escape'); await page.waitForTimeout(350);
    check(calls.some(path => path.endsWith('/video/close')), 'Late transcode session leaked'); check(await page.locator('#photo-info-dialog').count() === 0, 'Late reply reopened quality panel');
  });
  await run('取消正在准备的画质候选会主动释放且保留原视频', { videoSecond: true, slowQuality: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-video-quality').click(); await page.waitForSelector('[data-photo-quality="1"]'); await page.locator('[data-photo-quality="1"]').click(); await page.keyboard.press('Escape'); await page.waitForTimeout(350);
    check(calls.some(path => path.endsWith('/video/discard')), 'Cancelled candidate was only ignored'); check(!calls.some(path => path.endsWith('/video/commit')), 'Cancelled candidate was committed');
    check(await page.locator('#photo-clip').evaluate(clip => clip.src.includes('/photo-video/')), 'Cancelled selection replaced original source');
  });
  await run('候选画质解码失败时丢弃候选并恢复原画位置', { videoSecond: true, candidateFail: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-clip').evaluate(clip => clip.currentTime = 75); await page.locator('#photo-video-quality').click(); await page.waitForSelector('[data-photo-quality="1"]');
    const discarded = page.waitForRequest(request => new URL(request.url()).pathname === '/api/photos/video/discard'); await page.locator('[data-photo-quality="1"]').click(); await discarded;
    await page.waitForFunction(() => document.querySelector('#photo-clip')?.src.includes('/photo-video/') && !document.querySelector('#photo-video-quality')?.disabled);
    check(calls.some(path => path.endsWith('/video/discard')), 'Failed candidate was not discarded'); check(!calls.some(path => path.endsWith('/video/commit')), 'Failed decode committed the candidate');
    check(await page.locator('#photo-clip').evaluate(clip => clip.currentTime) === 75, 'Fallback lost playback position'); check((await page.locator('#photo-video-quality').textContent()).includes('原画'), 'Failed quality was shown as selected');
  });
  await run('原始照片编码上传后只使用HTTP视频并明确标出有损与放大', { uhd: true, frameCallbackUnsupported: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden');
    const source = await page.evaluate(() => window.__uhdSources[0]); check(source.source.includes('/photo-original/'), 'Encoder received preview URL'); check(source.width === 4000 && source.height === 3000, 'Original source dimensions missing');
    check(uhdUploads[0].type === 'video/mp4' && uhdUploads[0].bytes === 12, 'Video was not uploaded raw'); check((await uhdVideo().evaluate(video => video.src)).includes('/photo-uhd/'), 'Video used a Blob URL');
    const text = await page.locator('#photo-uhd-status').textContent(); check(text.includes('4K 视频显示') && text.includes('有损') && text.includes('不会增加细节'), 'Output claims were inflated'); check(await page.locator('#photo-rotate').isDisabled(), 'CSS rotation could composite the UHD plane');
    await page.locator('#photo-uhd').click(); await page.waitForFunction(() => !document.querySelector('video[data-cloudframe-photo-lease]')); check(calls.some(path => path.includes('/api/photos/uhd/close')), 'HTTP RAM resource was not released'); check(await page.locator('#photo-full').evaluate(image => image.style.visibility !== 'hidden'), 'Preview not restored');
  });
  await run('4K静音视频保留同一WebAudio音乐并不创建HTMLAudio', { uhd: true, music: true }, async () => {
    await page.locator('#photo-start').click(); await page.waitForFunction(() => window.__soundtrack && !window.__soundtrack.state().paused); await page.locator('#photo-uhd').click(); await page.waitForSelector('video[data-cloudframe-photo-lease]'); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden');
    check(await page.evaluate(() => !window.__soundtrack.state().paused && !window.__mediaEvents.some(event => event.overlap || event.tag === 'AUDIO') && window.__photoMusicCreations === 1), 'UHD did not use a single software music graph');
    await page.locator('#photo-uhd').click(); check(await uhdVideo().count() === 0, 'UHD video remained'); check(await page.evaluate(() => !window.__soundtrack.state().paused), 'Software music unnecessarily stopped on return to image');
  });
  await run('4K解码或HTTP播放失败保留照片fallback', { uhd: true, uhdVideoFail: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-uhd-status')?.textContent.includes('已恢复'));
    check(await uhdVideo().count() === 0, 'Failed video resource remained'); check(await page.locator('#photo-full').evaluate(image => image.style.visibility !== 'hidden'), 'Failed UHD hid the fallback'); check(calls.some(path => path.includes('/api/photos/uhd/close')), 'Failed HTTP video was not closed');
  });
  await run('取消本机上传后关闭迟到资源且不覆盖当前照片', { uhd: true, slowUhdUpload: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForTimeout(50); await page.locator('#photo-uhd').click(); await page.waitForTimeout(350);
    check(uhdUploads.length === 1 && calls.some(path => path.includes('/api/photos/uhd/close')), 'Late upload was orphaned'); check(await hasUhdSource() === false, 'Late upload replaced current image');
  });
  await run('HEIF解码不可用时不上传假视频且保留预览', { uhd: true, uhdDecodeFail: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-uhd-status')?.textContent.includes('原图格式暂不能'));
    check(uhdUploads.length === 0 && await uhdVideo().count() === 0, 'Unsupported source produced a pretend UHD video'); check(await page.locator('#photo-full').evaluate(image => image.src.includes('/photo-image/') && image.style.visibility !== 'hidden'), 'Preview fallback was lost');
  });
  await run('切换照片和退出释放各自4K资源，旧回调不覆盖新照片', { uhd: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden');
    await page.locator('#photo-next').click(); await page.waitForFunction(() => document.querySelector('.photo-counter')?.textContent.startsWith('2 /') && document.querySelector('#photo-full')?.style.visibility === 'hidden');
    check(uhdUploads.length === 2 && await uhdVideo().count() === 1, 'New photo did not retain exactly one HTTP video');
    check(calls.filter(path => path.includes('/api/photos/uhd/close')).length >= 1, 'Previous photo RAM resource remained'); await page.keyboard.press('Escape'); await page.waitForSelector('.photo-grid'); await page.waitForTimeout(30);
    check(calls.filter(path => path.includes('/api/photos/uhd/close')).length >= 2 && await uhdVideo().count() === 0 && await page.locator('#video').count() === 1, 'Exit did not release current photo RAM/video or destroyed the borrowed movie plane');
  });
  await run('没有WebAudio模块时4K暂停旧HTMLAudio且不争抢媒体资源', { uhd: true, music: true, legacyMusic: true }, async () => {
    await page.locator('#photo-start').click(); await page.waitForFunction(() => window.__soundtrack && !window.__soundtrack.paused); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden');
    check(await page.evaluate(() => !window.__soundtrack.getAttribute('src') && !window.__mediaEvents.some(event => event.overlap)), 'Legacy hardware audio competed with UHD video'); check((await page.locator('#photo-uhd-status').textContent()).includes('背景音乐已暂停'), 'Legacy fallback was presented as working simultaneous audio');
  });
  await run('迟到EXIF不能覆盖随后打开的幻灯片设置', { deferInfo: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-info').click(); await until(() => infoPending.length === 1);
    await page.locator('#photo-info-close').click(); await page.locator('#photo-settings').click(); const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/photos/info'); infoPending[0].resolve(); await response; await page.waitForTimeout(30);
    check(await page.locator('#photo-info-dialog h2').textContent() === '幻灯片设置' && await page.locator('[data-photo-setting]').count() === 3, 'Old EXIF replaced a newer settings dialog'); check(!(await page.locator('#photo-info-content').textContent()).includes('Test Camera'), 'Old EXIF leaked into settings');
  });
  await run('快速关闭重开画质面板时每个start会话都按身份释放', { videoSecond: true, deferStarts: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-video-quality').click(); await until(() => startPending.length === 1); await page.locator('#photo-info-close').click(); await page.locator('#photo-video-quality').click(); await until(() => startPending.length === 2);
    const old = startPending[0], latest = startPending[1]; old.resolve(); await until(() => requests.some(value => value.path.endsWith('/video/close') && value.body?.id === old.id)); latest.resolve(); await page.waitForSelector('[data-photo-quality="1"]');
    await page.locator('#photo-info-close').click(); await page.locator('#photo-close').click(); await until(() => requests.some(value => value.path.endsWith('/video/close') && value.body?.id === latest.id));
    check(new Set(requests.filter(value => value.path.endsWith('/video/close')).map(value => value.body.id)).size === 2, 'One of two start sessions was orphaned');
  });
  await run('4K准备期间改填充会取消旧编码并在完成设置后重编', { uhd: true, deferEncode: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => window.__uhdEncodePending.length === 1); await page.locator('#photo-settings').click(); await page.locator('[data-photo-setting="display"]').click(); await page.locator('#photo-info-close').click(); await page.waitForFunction(() => window.__uhdSources.length === 2);
    const metadata = await page.evaluate(() => __uhdSources.map(value => ({ fit: value.fit, aborted: value.aborted }))); check(metadata[0].fit === 'contain' && metadata[0].aborted && metadata[1].fit === 'cover', 'Display change did not cancel/reconfigure the pending encoder');
    await page.evaluate(() => __uhdEncodePending[0]()); await page.waitForTimeout(30); check(uhdUploads.length === 0, 'Cancelled contain output was uploaded'); await page.evaluate(() => __uhdEncodePending[1]()); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden'); check(uhdUploads.length === 1, 'Latest cover output was not uniquely uploaded');
  });
  await run('独立4K成功后移除旧预览错误遮罩和loading', { uhd: true, deferEncode: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => __uhdEncodePending.length === 1); await page.locator('#photo-full').evaluate(image => image.dispatchEvent(new Event('error'))); check((await page.locator('#photo-view-error').textContent()).includes('照片加载失败'), 'Preview-error prerequisite missing');
    await page.evaluate(() => __uhdEncodePending[0]()); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden'); check(await page.locator('#photo-view-error').textContent() === '', 'Preview error overlay hid a successful independent UHD result'); check(await page.locator('#photo-view-loading').evaluate(node => node.style.display) === 'none', 'Preview loading overlay remained');
  });
  await run('相同电视owner切换accountScope后重新进入相册不带旧album句柄', {}, async () => {
    await page.locator('[data-photo-tab="albums"]').click(); await page.locator('[data-album="0"]').click(); await page.waitForSelector('[data-photo="0"]'); scenario.account = 'b'; await page.locator('[data-route="home"]').click(); await page.waitForSelector('[data-route="photos"]'); const before = requests.length; await page.locator('[data-route="photos"]').click(); await page.waitForSelector('[data-photo="0"]');
    const reads = requests.slice(before).filter(value => value.path === '/api/photos/list'); check(reads.length > 0 && reads.every(value => !new URLSearchParams(value.query).has('album')), 'New account reused an old album descriptor'); check(reads.every(value => value.token === 'Bearer fake-token'), 'This case must keep the same television owner');
  });
  await run('重新连接账号清除旧音乐名称和缓存并读取新列表', { music: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-settings').click(); await page.locator('#photo-music-setting').click(); await page.waitForSelector('[data-photo-track="0"]'); await page.locator('[data-photo-track="0"]').click(); check((await page.locator('#photo-music-setting').textContent()).includes('示例背景音乐 a'), 'Initial account music was not selected');
    scenario.account = 'b'; await page.evaluate(base => __reconnectPhotoGateway({ server: base, token: 'other-fake-token' }), base); await page.waitForSelector('[data-route="photos"]'); await page.locator('[data-route="photos"]').click(); await page.waitForSelector('[data-photo="0"]'); await page.locator('[data-photo="0"]').click(); await page.locator('#photo-settings').click(); check(!(await page.locator('#photo-music-setting').textContent()).includes('示例背景音乐 a'), 'Old account music name survived reconnect');
    await page.locator('#photo-music-setting').click(); await page.waitForSelector('[data-photo-track="0"]'); check((await page.locator('[data-photo-track="0"]').textContent()).includes('示例背景音乐 b'), 'New music list was not fetched'); check(requests.some(value => value.path === '/api/photos/music' && value.token === 'Bearer other-fake-token'), 'Music cache skipped owner-scoped refresh');
  });
  await run('账号改变后迟到start清理仍使用开始时的server和token', { videoSecond: true, deferStarts: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-video-quality').click(); await until(() => startPending.length === 1); const old = startPending[0]; scenario.account = 'b'; await page.evaluate(base => __reconnectPhotoGateway({ server: base, token: 'other-fake-token' }), base); await page.waitForSelector('[data-route="photos"]'); old.resolve(); await until(() => requests.some(value => value.path.endsWith('/video/close') && value.body?.id === old.id));
    const cleanup = requests.find(value => value.path.endsWith('/video/close') && value.body?.id === old.id); check(cleanup.token === 'Bearer fake-token', 'Late old task cleanup borrowed the replacement account token');
  });
  await run('4K借用唯一主video且在stage外无transform祖先并在退出归还属性', { uhd: true }, async () => {
    await page.evaluate(() => { const video = document.querySelector('#video'); video.style.cssText = 'display:none;opacity:0.73'; video.muted = false; video.volume = .37; video.preload = 'none'; video.loop = true; video.controls = true; video.autoplay = false; video.playsInline = false; window.__sharedPlane = video; window.__planeBaseline = { style: video.getAttribute('style'), muted: video.muted, volume: video.volume, preload: video.preload, loop: video.loop, controls: video.controls, autoplay: video.autoplay, playsInline: video.playsInline }; });
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden');
    const plane = await page.evaluate(() => { const video = document.querySelector('#video'), ancestors = []; for (let node = video; node; node = node.parentElement) ancestors.push(getComputedStyle(node).transform); return { same: video === __sharedPlane, outside: !video.closest('#stage'), videos: document.querySelectorAll('video').length, ancestors, lease: Boolean(video.dataset.cloudframePhotoLease), transparent: ['#stage','.photo-viewer','.photo-canvas'].every(selector => getComputedStyle(document.querySelector(selector)).backgroundColor === 'rgba(0, 0, 0, 0)') }; });
    check(plane.same && plane.outside && plane.videos === 1 && plane.lease && plane.ancestors.every(value => value === 'none') && plane.transparent, 'UHD allocated another or composited/occluded video plane');
    await page.keyboard.press('Escape'); await page.waitForSelector('.photo-grid'); const restored = await page.evaluate(() => { const video = document.querySelector('#video'); return video === __sharedPlane && !video.getAttribute('src') && !video.dataset.cloudframePhotoLease && !document.body.classList.contains('photo-uhd-presenting') && Object.entries(__planeBaseline).every(([key, value]) => (key === 'style' ? video.getAttribute('style') : video[key]) === value); }); check(restored, 'Borrowed plane source/properties/styles were not returned');
  });
  await run('旧4K清理不暂停清src或改写新owner的视频属性和回调', { uhd: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden');
    await page.evaluate(base => { const video = document.querySelector('#video'); video.src = base + '/media/new-owner'; video.style.cssText = 'display:block;opacity:0.81'; video.muted = false; video.volume = .81; video.__paused = false; window.__newVideoHandler = () => {}; video.onloadeddata = video.onerror = __newVideoHandler; }, base); await page.keyboard.press('Escape'); await page.waitForSelector('.photo-grid'); await page.waitForTimeout(30);
    check(await page.evaluate(() => { const video = document.querySelector('#video'); return video.src.endsWith('/media/new-owner') && !video.paused && video.style.opacity === '0.81' && !video.muted && video.volume === .81 && video.onloadeddata === __newVideoHandler && video.onerror === __newVideoHandler; }), 'Old photo cleanup overwrote newer video ownership'); check(calls.some(path => path.includes('/api/photos/uhd/close')), 'Old RAM resource itself was not closed');
  });
  await run('独立fallback视频也在body首层且退出删除自身', { uhd: true, fallbackPlane: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden');
    check(await uhdVideo().evaluate(video => video.id !== 'video' && video.parentElement === document.body && video === document.body.firstElementChild && !video.closest('#stage')), 'Fallback plane re-entered the transformed stage'); await page.keyboard.press('Escape'); await page.waitForSelector('.photo-grid'); check(await uhdVideo().count() === 0 && await page.locator('video').count() === 1, 'Standalone fallback was retained or removed the main plane');
  });
  await run('主video忙碌时不借用不停止未知源且保留照片预览', { uhd: true }, async () => {
    await page.evaluate(base => { const video = document.querySelector('#video'); video.src = base + '/media/busy-owner'; video.__paused = false; }, base); await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-uhd-status')?.textContent.includes('已恢复'));
    check(await page.evaluate(() => document.querySelector('#video').src.endsWith('/media/busy-owner') && !document.querySelector('#video').paused && document.querySelectorAll('video').length === 1 && document.querySelector('#photo-full').style.visibility !== 'hidden'), 'Busy external plane was stolen or another video was created');
  });
  await run('隐藏相册立即归还4K平面和RAM并暂停同一WebAudio', { uhd: true, music: true }, async () => {
    await page.locator('#photo-start').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden'); await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await until(() => requests.some(value => value.path === '/api/photos/uhd/close')); check(await page.evaluate(() => !document.querySelector('#video').getAttribute('src') && !document.querySelector('#video').dataset.cloudframePhotoLease && !document.body.classList.contains('photo-uhd-presenting') && __soundtrack.state().paused && document.querySelectorAll('video').length === 1), 'Hidden viewer retained its source, overlay, second video or software music');
  });
  await run('隐藏和换连接后迟到上传只关闭旧owner资源不触碰新video', { uhd: true, slowUhdUpload: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await until(() => uhdUploads.length === 1); const oldId = uhdUploads[0].id; await page.evaluate(base => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); __reconnectPhotoGateway({ server: base, token: 'other-fake-token' }); const video = document.querySelector('#video'); video.src = base + '/media/new-after-hidden'; video.__paused = false; video.style.cssText = 'display:block;opacity:0.79'; }, base);
    await until(() => requests.some(value => value.path === '/api/photos/uhd/close' && value.body?.id === oldId)); const cleanup = requests.find(value => value.path === '/api/photos/uhd/close' && value.body?.id === oldId); check(new URLSearchParams(cleanup.query).get('client') === 'fake-token', 'Late upload close borrowed a replacement capability'); check(await page.evaluate(() => document.querySelector('#video').src.endsWith('/media/new-after-hidden') && !document.querySelector('#video').paused && document.querySelector('#video').style.opacity === '0.79'), 'Late hidden upload cleanup changed a newer source');
  });
  await run('旧lease不能归还已经换lease的同一视频节点', { uhd: true }, async () => {
    await page.locator('[data-photo="0"]').click(); await page.locator('#photo-uhd').click(); await page.waitForFunction(() => document.querySelector('#photo-full')?.style.visibility === 'hidden'); await page.evaluate(() => { const video = document.querySelector('#video'); video.dataset.cloudframePhotoLease = 'external-new-lease'; video.__paused = false; video.style.opacity = '.62'; }); await page.keyboard.press('Escape'); await page.waitForSelector('.photo-grid');
    check(await page.evaluate(() => { const video = document.querySelector('#video'); return video.dataset.cloudframePhotoLease === 'external-new-lease' && !video.paused && video.src.includes('/photo-uhd/') && video.style.opacity === '0.62'; }), 'Old lease cleared a plane owned by a replacement lease'); check(calls.some(path => path.includes('/api/photos/uhd/close')), 'Lease protection must not orphan the old job own RAM object');
  });
  await run('画质commit响应丢失后active匹配保留已接受的新HLS源', { videoSecond: true, loseCommit: 'hls' }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-clip').evaluate(video => video.currentTime = 75); await page.locator('#photo-video-quality').click(); await page.waitForSelector('[data-photo-quality="1"]'); await page.locator('[data-photo-quality="1"]').click(); await page.waitForFunction(() => document.querySelector('#photo-video-quality')?.textContent.includes('1080P') && !document.querySelector('#photo-video-quality').disabled);
    const accepted = [...active.values()][0]; check(requests.some(value => value.path === '/api/photos/video/active'), 'Lost acknowledgement was not reconciled'); check(await page.locator('#photo-clip').evaluate((video, candidate) => video.src.includes('/photo-hls/' + candidate + '/') && video.currentTime === 75, accepted.candidate), 'Accepted HLS source or position was rolled back'); check(!requests.some(value => value.path.endsWith('/video/discard') || value.path.endsWith('/video/close')), 'Accepted candidate/root was discarded because one response was lost');
  });
  await run('commit结果未知且active不可达时保留新源并提示未知而不回旧源', { videoSecond: true, loseCommit: 'hls', activeUnavailable: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-video-quality').click(); await page.waitForSelector('[data-photo-quality="1"]'); await page.locator('[data-photo-quality="1"]').click(); await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('尚未确认'));
    check(await page.locator('#photo-clip').evaluate(video => video.src.includes('/photo-hls/')), 'Unknown commit reloaded a possibly retired original'); check(!requests.some(value => value.path.endsWith('/video/discard') || value.path.endsWith('/video/close')), 'Unknown commit speculatively discarded/closed a source'); await page.keyboard.press('Escape'); await page.waitForSelector('.photo-grid'); check(requests.some(value => value.path.endsWith('/video/close')), 'Explicit viewer exit did not clean the unknown session');
  });
  await run('commit待确认不勾旧原画且重新核对恢复后才标实际画质', { videoSecond: true, loseCommit: 'hls', activeUnavailable: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-video-quality').click(); await page.waitForSelector('[data-photo-quality="1"]'); await page.locator('[data-photo-quality="1"]').click(); await page.waitForFunction(() => document.querySelector('#photo-video-quality')?.textContent === '画质：待确认' && !document.querySelector('#photo-video-quality').disabled); const source = await page.locator('#photo-clip').evaluate(video => video.src);
    await page.locator('#photo-video-quality').click(); await page.waitForSelector('[data-photo-quality="0"]'); const unconfirmed = await page.locator('[data-photo-quality]').allTextContents(); check(unconfirmed.every(value => !value.includes('✓')) && await page.locator('#photo-video-quality').textContent() === '画质：待确认', 'Unknown state was falsely marked as the previous original quality'); check(requests.filter(value => value.path === '/api/photos/video/active').length === 2, 'Reopening an unconfirmed menu did not query actual state');
    await page.locator('#photo-info-close').click(); scenario.activeUnavailable = false; await page.locator('#photo-video-quality').click(); await page.waitForFunction(() => document.querySelector('[data-photo-quality="1"]')?.textContent.includes('✓')); check(!(await page.locator('[data-photo-quality="0"]').textContent()).includes('✓') && (await page.locator('#photo-video-quality').textContent()).includes('1080P'), 'Recovered query did not select the actual accepted quality');
    check(requests.filter(value => value.path === '/api/photos/video/active').length === 3 && requests.filter(value => value.path === '/api/photos/video/quality').length === 1, 'Read-only reconciliation prepared another candidate or skipped state validation'); check(await page.locator('#photo-clip').evaluate((video, expected) => video.src === expected, source), 'Reconciliation unnecessarily replaced the current video source'); check(!requests.some(value => value.path.endsWith('/video/discard') || value.path.endsWith('/video/close')), 'Unconfirmed/recovered state discarded an accepted source');
  });
  await run('切回原画commit丢响应也按原画candidate对账而不恢复已关闭HLS', { videoSecond: true, loseCommit: 'original' }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-clip').evaluate(video => video.currentTime = 75); await page.locator('#photo-video-quality').click(); await page.waitForSelector('[data-photo-quality="1"]'); await page.locator('[data-photo-quality="1"]').click(); await page.waitForFunction(() => document.querySelector('#photo-video-quality')?.textContent.includes('1080P') && !document.querySelector('#photo-video-quality').disabled);
    await page.locator('#photo-video-quality').click(); await page.locator('[data-photo-quality="0"]').click(); await page.waitForFunction(() => document.querySelector('#photo-video-quality')?.textContent.includes('原画') && !document.querySelector('#photo-video-quality').disabled);
    const restored = [...active.values()][0]; check(restored.kind === 'original' && restored.candidate, 'Mock promotion did not retain original candidate identity'); check(requests.filter(value => value.path === '/api/photos/video/active').length === 1 && !requests.some(value => value.path.endsWith('/video/discard')), 'Original commit response was not positively reconciled'); check(await page.locator('#photo-clip').evaluate(video => video.src.includes('/photo-video/') && video.currentTime === 75), 'Accepted original source was rolled back to retired HLS');
  });
  await run('active明确仍是旧源时才丢弃未接受候选并回退', { videoSecond: true, loseCommit: 'hls', commitNotAccepted: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-video-quality').click(); await page.waitForSelector('[data-photo-quality="1"]'); await page.locator('[data-photo-quality="1"]').click(); await until(() => requests.some(value => value.path.endsWith('/video/discard'))); await page.waitForFunction(() => document.querySelector('#photo-clip')?.src.includes('/photo-video/') && !document.querySelector('#photo-video-quality')?.disabled);
    check(requests.some(value => value.path === '/api/photos/video/active') && !requests.some(value => value.path.endsWith('/video/close')), 'A known-negative commit was not distinguished from an unknown outcome');
  });
  await run('解码首帧和commit在途时迟到选择不能覆盖busy事务', { videoSecond: true, deferMedia: true, deferCommit: true }, async () => {
    await page.locator('[data-photo="1"]').click(); await page.locator('#photo-video-quality').click(); await page.waitForSelector('[data-photo-quality="1"]'); await page.evaluate(() => window.__queuedPhotoSelection = document.querySelector('[data-photo-quality="0"]').onclick); await page.locator('[data-photo-quality="1"]').click(); await page.waitForFunction(() => __pendingPhotoMedia.length === 1); await page.evaluate(() => __queuedPhotoSelection());
    check(requests.filter(value => value.path === '/api/photos/video/quality').length === 1 && await page.locator('#photo-video-quality').isDisabled(), 'A stale selection replaced the candidate while its first frame was pending'); await page.evaluate(() => __pendingPhotoMedia[0]()); await until(() => commitPending.length === 1); await page.evaluate(() => __queuedPhotoSelection()); check(requests.filter(value => value.path === '/api/photos/video/quality').length === 1 && !requests.some(value => value.path.endsWith('/video/discard')), 'Busy was cleared before commit completed');
    scenario.deferCommit = false; commitPending[0].resolve(); await page.waitForFunction(() => document.querySelector('#photo-video-quality')?.textContent.includes('1080P') && !document.querySelector('#photo-video-quality').disabled); await page.locator('#photo-video-quality').click(); await page.locator('[data-photo-quality="0"]').click(); await page.waitForFunction(() => document.querySelector('#photo-video-quality')?.textContent.includes('原画') && !document.querySelector('#photo-video-quality').disabled); check(requests.filter(value => value.path === '/api/photos/video/quality').length === 2, 'Completed transaction did not release busy for an explicit next selection');
  });
  const report = { passed: cases.filter(c => c.ok).length, failed: cases.filter(c => !c.ok).length, cases }; check(cases.length, 'No photo tests matched'); if (report.failed) throw new Error(JSON.stringify(report)); return report;
}
