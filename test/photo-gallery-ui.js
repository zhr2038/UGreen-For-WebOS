async page => {
  const base = '__UI_BASE_URL__', cases = [], calls = [], filter = __UI_FILTER__;
  let scenario;
  const check = (value, message) => { if (!value) throw new Error(message); };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHAAAAABJRU5ErkJggg==', 'base64');
  const photo = id => ({ id: String(id), name: '测试照片 ' + id, kind: 'image', format: 'png', width: 4000, height: 3000, thumb: '/mock.png', view: '/photo-image/preview-' + id, original: '/photo-original/original-' + id, motion: '/photo-motion/live-' + id, info: '/api/photos/info?asset=' + id, output: { browserOriginalCandidate: true, nativeUhdConfirmed: false } });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    window.__mediaEvents = []; window.__mediaElements = [];
    const p = HTMLMediaElement.prototype, get = Element.prototype.getAttribute, remove = Element.prototype.removeAttribute;
    Object.defineProperties(p, {
      src: { configurable: true, get() { return this.__source || ''; }, set(value) { this.__source = value; } },
      paused: { configurable: true, get() { return this.__paused ?? true; } },
      currentTime: { configurable: true, get() { return this.__time || 0; }, set(value) { this.__time = value; } },
      duration: { configurable: true, get() { return 300; } },
      readyState: { configurable: true, get() { return this.__source ? 4 : 0; } },
    });
    p.getAttribute = function(name) { return name === 'src' ? this.__source || null : get.call(this, name); };
    p.removeAttribute = function(name) { if (name === 'src') { this.__source = ''; window.__mediaEvents.push({ tag: this.tagName, action: 'release' }); return; } return remove.call(this, name); };
    p.load = function() { if (!this.__source) this.__time = 0; };
    p.pause = function() { this.__paused = true; window.__mediaEvents.push({ tag: this.tagName, action: 'pause' }); this.dispatchEvent(new Event('pause')); };
    p.play = function() {
      if (!window.__mediaElements.includes(this)) window.__mediaElements.push(this);
      const overlap = window.__mediaElements.some(m => m !== this && m.__source && m.__paused === false);
      this.__paused = false; window.__mediaEvents.push({ tag: this.tagName, action: 'play', overlap, src: this.__source });
      if (this.tagName === 'AUDIO') window.__soundtrack = this;
      this.dispatchEvent(new Event('play')); queueMicrotask(() => {
        if (this.tagName === 'VIDEO' && this.__source.includes('/photo-hls/') && localStorage.getItem('test.photoCandidateFail') === 'true') { this.dispatchEvent(new Event('error')); return; }
        this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('loadeddata'));
      }); return Promise.resolve();
    };
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/photo-') || url.pathname === '/mock.png') return route.fulfill({ contentType: 'image/png', body: png });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push(url.pathname + url.search); let data;
    if (url.pathname === '/api/home') data = { name: 'Mock NAS', hero: [], recent: [], updates: [], favorites: [], libraries: [] };
    else if (url.pathname === '/api/photos/categories') data = { items: [{ id: 'groupcap', name: '示例分类', total: 1, cover: '/mock.png' }], total: 1, offset: 0, limit: 48, last: true };
    else if (url.pathname === '/api/photos/info') data = { item: photo(url.searchParams.get('asset')), metadata: { camera: 'Test Camera', iso: '100' } };
    else if (url.pathname === '/api/photos/preview-visibility') { const show = route.request().postDataJSON().show; data = { item: { ...photo(1), sensitive: true, revealed: show, original: show ? '/photo-original/original-1' : '', motion: '', view: show ? '/photo-image/sensitive-visible-1' : '/photo-image/preview-1' } }; }
    else if (url.pathname === '/api/photos/music') data = { items: [{ id: 'track-1', name: '示例背景音乐', stream: '/photo-music/music-1', mime: 'audio/mpeg' }] };
    else if (url.pathname === '/api/photos/video/start') { if (scenario.slowVideoStart) await new Promise(r => setTimeout(r, 250)); data = { id: 'session-photo', original: '/photo-video/clip-2', options: { qualities: [{ id: 'original', label: '原画', original: true }, { id: '1080P@1920x1080', label: '1080P', resolution: '1920x1080' }] } }; }
    else if (url.pathname === '/api/photos/video/quality') { const { quality, request } = route.request().postDataJSON(); if (scenario.slowQuality) await new Promise(r => setTimeout(r, 250)); data = { candidate: 'candidate-' + request, request, kind: quality === 'original' ? 'original' : 'hls', url: quality === 'original' ? '/photo-video/clip-2' : '/photo-hls/candidate-photo/master' }; }
    else if (['/api/photos/video/close', '/api/photos/video/commit', '/api/photos/video/discard'].includes(url.pathname)) data = { ok: true };
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
    scenario = { total: 2, ...options }; calls.length = 0;
    await page.goto(base + '/blank.html');
    await page.evaluate(({ base, options }) => { localStorage.clear(); localStorage.setItem('cinema.server', base); localStorage.setItem('cinema.token', 'fake-token'); localStorage.setItem('cinema.photoInterval', String(options.interval || 5)); localStorage.setItem('cinema.photoMode', options.mode || 'sequential'); localStorage.setItem('cinema.photoMusicOn', options.music ? '1' : '0'); localStorage.setItem('test.photoCandidateFail', String(Boolean(options.candidateFail))); }, { base, options });
    await page.goto(base); await page.locator('[data-route="photos"]').click(); await page.waitForSelector('[data-photo="0"]');
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
  await run('图片背景音乐在视频前释放并在返回图片后恢复位置', { music: true, videoSecond: true, mode: 'loop' }, async () => {
    await page.locator('#photo-start').click(); await page.waitForFunction(() => window.__mediaEvents.some(event => event.tag === 'AUDIO' && event.action === 'play'));
    await page.evaluate(() => window.__soundtrack.currentTime = 42); await page.locator('#photo-next').click(); await page.waitForSelector('#photo-clip');
    const events = await page.evaluate(() => window.__mediaEvents); const videoPlay = events.findIndex(event => event.tag === 'VIDEO' && event.action === 'play'); check(events.slice(0, videoPlay).some(event => event.tag === 'AUDIO' && event.action === 'release'), 'Audio source not released before video');
    await page.locator('#photo-clip').evaluate(clip => clip.dispatchEvent(new Event('ended'))); await page.waitForSelector('#photo-full'); await page.waitForFunction(() => window.__soundtrack.__paused === false && window.__soundtrack.currentTime === 42);
    check(await page.evaluate(() => !window.__mediaEvents.some(event => event.overlap)), 'Two audio/video sources played together'); await page.keyboard.press('Escape'); check(await page.evaluate(() => !window.__soundtrack.getAttribute('src')), 'Gallery left the soundtrack source allocated');
  });
  await run('隐藏页面暂停幻灯片并释放背景音乐', { music: true }, async () => {
    await page.locator('#photo-start').click(); await page.waitForFunction(() => window.__soundtrack && !window.__soundtrack.paused);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    check(await page.evaluate(() => window.__soundtrack.paused && !window.__soundtrack.getAttribute('src')), 'Hidden page kept audio active');
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
  const report = { passed: cases.filter(c => c.ok).length, failed: cases.filter(c => !c.ok).length, cases }; check(cases.length, 'No photo tests matched'); if (report.failed) throw new Error(JSON.stringify(report)); return report;
}
