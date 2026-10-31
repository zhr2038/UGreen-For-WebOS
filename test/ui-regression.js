async page => {
  const base = '__UI_BASE_URL__';
  const filter = __UI_FILTER__;
  await page.setViewportSize({ width: 1920, height: 1080 });
  const check = (value, message) => { if (!value) throw new Error(message); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
  const movie = id => ({ id, libraryId: 1, type: 1, name: '示例影片 ' + id, year: 2026, score: 7, duration: 3600, position: 120, progress: .03, overview: '测试影片资料', clarity: 'HD', genres: [], poster: '/mock-image/poster', backdrop: '/mock-image/background', cover: '/mock-image/cover' });
  let control, errors;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#225577"/></svg>';
  await page.addInitScript(() => {
    const proto = HTMLMediaElement.prototype;
    Object.defineProperties(proto, {
      src: { configurable: true, get() { return this.__src || ''; }, set(value) { this.__src = value; } },
      paused: { configurable: true, get() { return this.__paused ?? true; } },
      duration: { configurable: true, get() { return this.__src ? 3600 : NaN; } },
      readyState: { configurable: true, get() { return this.__ready || 0; } },
      currentTime: { configurable: true, get() { return this.__time || 0; }, set(value) { if (!Number.isFinite(value) || !this.readyState) throw new TypeError('invalid seek before metadata'); this.__time = value; } },
    });
    const remove = Element.prototype.removeAttribute;
    proto.removeAttribute = function(name) { if (name === 'src') { this.__src = ''; this.__ready = 0; this.__time = 0; } return remove.call(this, name); };
    proto.load = function() { this.__time = 0; this.__ready = this.__src && !window.__holdMetadata ? 4 : 0; if (this.__ready) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); };
    proto.play = function() { if (!this.__ready && this.__src && !window.__holdMetadata) { this.__ready = 4; queueMicrotask(() => this.dispatchEvent(new Event('loadeddata'))); } this.__paused = false; this.dispatchEvent(new Event('play')); if (window.__deferMediaPlay) return new Promise((resolve, reject) => this.__rejectPlay = reject); return Promise.resolve(); };
    proto.pause = function() { if (!this.paused) { this.__paused = true; this.dispatchEvent(new Event('pause')); const reject = this.__rejectPlay; this.__rejectPlay = null; if (reject) reject(new DOMException('play was interrupted by pause', 'AbortError')); } };
  });
  await page.addInitScript(base => {
    if (sessionStorage.getItem('ui.direct') !== '1') return;
    window.PalmServiceBridge = class {
      call() { queueMicrotask(() => this.onservicecallback(JSON.stringify({ returnValue: true, server: base, token: 'test-client' }))); }
      cancel() {}
    };
  }, base);
  const response = async (route, data, status = 200) => {
    try { await route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); } catch { /* Navigation can abandon a mock response. */ }
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), request = route.request(), state = control;
    if (url.pathname.startsWith('/mock-image/')) return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    if (url.pathname.startsWith('/photo-image/')) {
      if (state.failPhoto && url.pathname.endsWith('/old')) return route.fulfill({ status: 503, body: 'offline' });
      return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' } });
    const call = { path: url.pathname, host: url.host, query: url.search, authorization: request.headers().authorization, body: request.postDataJSON() }; state.calls.push(call);
    if (url.pathname === '/api/direct/status') return response(route, { connected: Boolean(state.directConnected), alias: 'example', username: 'viewer' });
    if (url.pathname === '/api/direct/login') { if (state.directLoginGate) await state.directLoginGate.promise; if (state.directFail) return response(route, { error: 'NAS 用户名或密码错误' }, 401); state.directConnected = true; return response(route, { connected: true }); }
    if (url.pathname === '/api/direct/qr/create') return response(route, { url: 'https://www.ugnas.com/scan?example=1', expiresAt: Date.now() + 60000, interval: 60 });
    if (url.pathname === '/api/direct/qr/poll') return response(route, { state: state.qrState || 'waiting' });
    if (url.pathname === '/api/direct/qr/retry') { state.qrState = 'waiting'; return response(route, { state: 'waiting' }); }
    if (url.pathname === '/api/direct/logout') { state.directConnected = false; return response(route, { connected: false }); }
    if (url.pathname === '/api/direct/cancel') return response(route, { ok: true });
    if (url.host.startsWith('bad-nas.test')) return response(route, { error: '配对码错误' }, 401);
    if (url.pathname === '/api/home') return response(route, { name: '测试 NAS', hero: [movie(1)], recent: [movie(1)], updates: [movie(2)], favorites: [movie(1)], libraries: [{ media_lib_set_id: 1, media_name: '电影', video_count: 120 }] });
    if (url.pathname === '/api/library') { if (state.libraryFailOnce) { state.libraryFailOnce = false; return response(route, { error: 'offline' }, 503); } const n = Number(url.searchParams.get('page') || 1); if (n === 2 && state.pageGate) await state.pageGate.promise; const sortOffset = url.searchParams.get('sort') === '1' ? 1000 : 0; return response(route, { items: Array.from({ length: 60 }, (_, j) => movie(sortOffset + (n - 1) * 60 + j + 1)), total: 120, last: n >= 2 }); }
    if (url.pathname === '/api/detail') return response(route, { item: movie(Number(url.searchParams.get('id'))), files: [{ index: 0, name: '原画' }, { index: 1, name: '备用版本' }], actors: [], technical: { container: 'mp4', video_info: { codec: 'h264', resolution: '1920x1080' }, audio_info: [] } });
    if (url.pathname === '/api/play') { const gate = state.playGate; if (gate) await gate.promise; if (state.playError) return response(route, { error: '无法打开版本' }, 503); const id = 'play-' + (++state.playId); return response(route, { id, stream: '/media/' + id, fileIndex: call.body.fileIndex || 0, title: '测试播放', position: call.body.restart ? 0 : 120, duration: 3600, technical: {} }); }
    if (url.pathname === '/api/progress') { const gate = state.progressGate; if (gate) await gate.promise; return response(route, { ok: true }); }
    if (url.pathname === '/api/search') { const q = url.searchParams.get('q'); if (q === 'slow' && state.searchGate) await state.searchGate.promise; return response(route, { items: [movie(q === 'slow' ? 901 : 902)] }); }
    if (url.pathname === '/api/photos/list') { state.photoRequests++; const video = state.photoVideo; return response(route, { items: [{ id: 'p1', name: video ? '示例视频' : '示例照片', kind: video ? 'video' : 'image', thumb: '/mock-image/photo', view: '/photo-image/' + (state.photoFresh ? 'new' : 'old'), stream: video ? '/photo-video/mock' : '', width: 320, height: 180 }], total: 1, offset: 0, limit: 48, last: true }); }
    if (url.pathname === '/api/pair') return response(route, { token: 'new-client' });
    if (url.pathname === '/api/login') { if (state.loginGate) await state.loginGate.promise; return response(route, { ok: true }); }
    return response(route, { ok: true });
  });
  async function boot() {
    control = { calls: [], gates: [], playId: 0, photoRequests: 0 }; errors = [];
    page.removeAllListeners('pageerror'); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/blank.html');
    await page.evaluate(base => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('cinema.server', base); localStorage.setItem('cinema.token', 'test-client'); }, base);
    await page.goto(base); await page.waitForSelector('button[data-primary][data-item]');
  }
  async function detail() { await page.locator('button[data-primary][data-item]').click(); await page.waitForSelector('#play'); }
  async function directLogin() { await page.evaluate(() => sessionStorage.setItem('ui.direct', '1')); await page.reload(); await page.waitForSelector('#direct-form'); }
  async function play() { await detail(); await page.locator('#play').click(); await page.waitForSelector('#pause'); }
  async function key(code) { await page.evaluate(code => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true })), code); }
  const cases = [];
  async function run(name, fn) {
    if (filter && !name.includes(filter)) return;
    await boot();
    try { await fn(); check(!errors.length, 'Unhandled browser errors: ' + errors.join('; ')); cases.push({ name, ok: true }); }
    catch (error) { cases.push({ name, ok: false, error: error.message }); }
    finally { for (const gate of control.gates) gate.resolve(); await delay(40); }
  }
  await run('播放按钮上的左右键移动焦点，不改变进度', async () => {
    await play(); const before = await page.locator('#video').evaluate(v => v.currentTime);
    await page.keyboard.press('ArrowRight');
    check(await page.evaluate(() => document.activeElement.id) === 'episode-list', 'Right did not reach playback list');
    check(await page.locator('#video').evaluate(v => v.currentTime) === before, 'Button navigation sought the video');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); await page.waitForSelector('.player-dialog');
    check(await page.locator('.player-dialog h2').textContent() === '播放设置', 'Settings button is unreachable');
    await page.keyboard.press('Escape'); check(await page.locator('#player-dialog').textContent() === '', 'Back did not close the dialog');
  });
  await run('专用播放和暂停键保持幂等', async () => {
    await play(); await key(415); await key(415); check(await page.locator('#video').evaluate(v => !v.paused), 'PLAY paused playback');
    await key(19); await key(19); check(await page.locator('#video').evaluate(v => v.paused), 'PAUSE resumed playback');
  });
  await run('控制栏隐藏时快进，进入按钮区后可导航', async () => {
    await play(); await page.waitForSelector('.player-ui.hidden', { state: 'attached', timeout: 6500 });
    const before = await page.locator('#video').evaluate(v => v.currentTime); await page.keyboard.press('ArrowRight');
    check(await page.locator('#video').evaluate(v => v.currentTime) === before + 10, 'Hidden playback did not seek by 10 seconds');
    check(await page.evaluate(() => document.activeElement.id) === 'player-seek', 'Seeking did not focus the progress bar');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
    check(await page.evaluate(() => document.activeElement.id) === 'episode-list', 'Could not leave progress bar for playback buttons');
  });
  await run('元数据未就绪时方向键不会非法跳转', async () => {
    await detail(); await page.evaluate(() => window.__holdMetadata = true); await page.locator('#play').click(); await page.waitForSelector('#pause'); await key(417);
    await page.evaluate(() => document.querySelector('#player-seek')?.focus()); await key(39);
    check(await page.locator('#video').evaluate(v => v.currentTime) === 0, 'Seek ran before metadata');
  });
  await run('网络上报阻塞时仍可立即退出，保留本地续播位置', async () => {
    await play(); const gate = deferred(); control.gates.push(gate); control.progressGate = gate;
    await page.locator('#video').evaluate(v => v.currentTime = 777); await page.locator('#stop-player').click();
    await page.waitForSelector('#play', { timeout: 1200 });
    check((await page.locator('#play').textContent()).includes('00:12:57'), 'Local resume position was lost');
    check(!await page.locator('#video').evaluate(v => v.src), 'Video resource was not released');
    await page.locator('#play').click(); await page.waitForSelector('#pause');
    check(await page.locator('#video').evaluate(v => v.currentTime) === 777, 'Quick resume used an outdated NAS position');
  });
  await run('离开详情后，迟到的播放请求不会自动打开影片', async () => {
    await detail(); const gate = deferred(); control.gates.push(gate); control.playGate = gate; await page.locator('#play').click(); await page.locator('#play').click();
    check(control.calls.filter(c => c.path === '/api/play').length === 1, 'Repeated confirmation started duplicate playback requests');
    await page.keyboard.press('Escape'); await page.waitForSelector('h1'); gate.resolve(); await delay(150);
    check(!await page.locator('body').evaluate(b => b.classList.contains('playing')), 'Stale play request changed the route');
  });
  await run('配对失败后仍可使用原有 NAS', async () => {
    await page.locator('button[data-route="settings"]').click(); await page.locator('#server').fill('http://bad-nas.test:8780'); await page.locator('#pair-code').fill('123456');
    await page.locator('#pair-form button[type="submit"]').click(); await page.waitForFunction(() => document.querySelector('#setup-message')?.textContent);
    check(!control.calls.find(c => c.host.startsWith('bad-nas.test'))?.authorization?.includes('test-client'), 'Old pairing token was sent to the new NAS address');
    await page.locator('#setup-back').click(); await page.waitForFunction(() => document.querySelector('h1')?.textContent === '影视中心', undefined, { timeout: 1200 });
  });
  await run('迟到的搜索结果不会覆盖新搜索', async () => {
    await page.locator('button[data-route="search"]').click(); const gate = deferred(); control.gates.push(gate); control.searchGate = gate;
    await page.locator('#search').fill('slow'); await page.locator('#search').press('Enter');
    await page.locator('#search').fill('fast'); await page.locator('#search').press('Enter'); await page.waitForSelector('[data-item="902"]'); gate.resolve(); await delay(150);
    check(await page.locator('[data-item="902"]').count() === 1, 'Old search replaced the latest search');
    await page.locator('[data-item="902"]').click(); await page.waitForSelector('#play'); await page.keyboard.press('Escape'); await page.waitForSelector('#search');
    check(await page.locator('#search').inputValue() === 'fast' && await page.locator('[data-item="902"]').count() === 1, 'Returning from detail lost the search');
  });
  await run('从详情返回时保留列表页码、位置和焦点', async () => {
    await page.locator('button[data-route="movies"]').click(); await page.waitForSelector('#load-more'); await page.locator('#load-more').click(); await page.waitForSelector('[data-item="85"]');
    await page.locator('[data-item="85"]').focus(); await page.keyboard.press('Enter'); await page.waitForSelector('#play'); await page.keyboard.press('Escape'); await page.waitForSelector('.grid');
    check(await page.locator('[data-item="85"]').count() === 1, 'Returning lost the second page');
    check(await page.evaluate(() => document.activeElement.dataset.item) === '85', 'Returning lost the selected movie');
  });
  await run('相册预览失败后重取有效链接再重试', async () => {
    control.failPhoto = true; await page.locator('[data-route="photos"]').click(); await page.waitForSelector('[data-photo="0"]'); await page.locator('[data-photo="0"]').click(); await page.waitForSelector('#photo-view-retry');
    control.photoFresh = true; await page.locator('#photo-view-retry').click();
    await page.waitForFunction(() => document.querySelector('#photo-full')?.src.includes('/new') && document.querySelector('#photo-full')?.naturalWidth > 0, undefined, { timeout: 1200 });
    check(control.photoRequests >= 2, 'Retry reused the expired photo capability');
  });
  await run('暂停视频幻灯片会暂停当前视频', async () => {
    control.photoVideo = true; await page.locator('[data-route="photos"]').click(); await page.waitForSelector('[data-photo="0"]'); await page.locator('[data-photo="0"]').click(); await page.waitForSelector('#photo-slideshow');
    await page.locator('#photo-slideshow').click(); await page.locator('#photo-slideshow').click();
    check(await page.locator('#photo-clip').evaluate(v => v.paused), 'Pausing slideshow left its video playing');
    await key(19); await key(19); check(await page.locator('#photo-clip').evaluate(v => v.paused), 'Photo PAUSE resumed playback');
    await key(415); await key(415); check(await page.locator('#photo-clip').evaluate(v => !v.paused), 'Photo PLAY paused playback');
  });
  await run('慢上报按顺序提交，最终位置不会被旧请求覆盖', async () => {
    await play(); const gate = deferred(); control.gates.push(gate); control.progressGate = gate;
    await page.locator('#video').evaluate(v => { v.currentTime = 166; v.dispatchEvent(new Event('timeupdate')); });
    for (let n = 0; n < 30 && !control.calls.some(c => c.path === '/api/progress'); n++) await delay(20);
    await page.locator('#video').evaluate(v => { v.currentTime = 777; v.pause(); }); await page.locator('#stop-player').click(); await page.waitForSelector('#play');
    check(control.calls.filter(c => c.path === '/api/progress').length === 1, 'Final progress bypassed a pending older report');
    gate.resolve();
    for (let n = 0; n < 30 && control.calls.filter(c => c.path === '/api/progress').length < 2; n++) await delay(20);
    const sent = control.calls.filter(c => c.path === '/api/progress').map(c => c.body.position);
    check(JSON.stringify(sent) === JSON.stringify([166, 777]), 'Final progress was duplicated or reordered: ' + sent);
  });
  await run('取消切换版本后不会迟到打开新版本', async () => {
    await play(); const gate = deferred(); control.gates.push(gate); control.playGate = gate;
    await page.locator('#episode-list').click(); await page.locator('[data-switch="1"]').click(); await page.keyboard.press('Escape'); gate.resolve(); await delay(150);
    check((await page.locator('#video').evaluate(v => v.src)).includes('/media/play-1'), 'Canceled stream was activated');
    check(await page.locator('#player-dialog').textContent() === '', 'Playback dialog remained open');
  });
  await run('版本加载失败后，错误按钮仍能用遥控器操作', async () => {
    await play(); control.playError = true; await page.locator('#episode-list').click(); await page.locator('[data-switch="1"]').click(); await page.waitForSelector('#error-back');
    check(await page.locator('#player-dialog').textContent() === '', 'Old episode dialog covered the error action');
    await page.keyboard.press('ArrowRight'); check(await page.evaluate(() => document.activeElement.id) === 'error-back', 'Focus escaped the error action');
    await page.keyboard.press('Enter'); await page.waitForSelector('#play');
  });
  await run('离开登录表单后，迟到响应不会覆盖新页面', async () => {
    await page.locator('[data-route="settings"]').click(); await page.locator('#nas-login').click(); const gate = deferred(); control.gates.push(gate); control.loginGate = gate;
    await page.locator('#nas-user').fill('test-user'); await page.locator('#nas-password').fill('fake-password'); const password = await page.locator('#nas-password').elementHandle();
    await page.locator('#login-form button').first().click(); await page.locator('#login-back').click(); gate.resolve(); await delay(150);
    check(await page.locator('#pair-form').count() === 1, 'Late login changed the settings page'); check(await password.evaluate(el => el.value) === '', 'Detached password was not cleared');
  });
  await run('媒体库重试保留原页面', async () => {
    control.libraryFailOnce = true; await page.locator('[data-route="movies"]').click(); await page.waitForSelector('#retry'); await page.locator('#retry').click(); await page.waitForSelector('.grid [data-item="1"]');
    check(await page.locator('h1').textContent() === '电影', 'Retry went to the homepage instead of the library');
  });
  await run('选择框先用确定打开，方向键不会意外修改排序', async () => {
    await page.locator('[data-route="movies"]').click(); await page.waitForSelector('#sort'); await page.locator('#sort').focus(); await page.keyboard.press('ArrowDown'); await delay(80);
    check(await page.locator('#sort').inputValue() === '2', 'Arrow navigation unexpectedly changed the sort order');
    check(await page.evaluate(() => Boolean(document.activeElement.dataset.item)), 'Focus could not leave the closed select');
    await page.locator('#sort').focus(); await page.keyboard.press('Enter'); await page.waitForSelector('.select-overlay'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
    check(await page.locator('#sort').inputValue() === '2' && await page.locator('.select-overlay').count() === 0, 'Cancel changed the selected option');
    await page.keyboard.press('Enter'); await page.waitForSelector('.select-overlay'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForSelector('.grid');
    check(await page.locator('#sort').inputValue() === '1', 'Confirmed option was not applied');
    await page.locator('#sort').click(); await page.waitForSelector('.select-overlay'); await page.locator('[data-select-close]').click();
  });
  await run('影片加载中暂停不会被误报成播放故障', async () => {
    await detail(); await page.evaluate(() => { window.__holdMetadata = true; window.__deferMediaPlay = true; });
    await page.locator('#play').click(); await page.waitForSelector('#pause'); await page.locator('#pause').click(); await delay(80);
    check(await page.locator('#video').evaluate(v => v.paused), 'Loading video did not pause');
    check(await page.locator('#player-message').textContent() === '', 'Expected pause AbortError was shown as a failure');
  });
  await run('分页加载中更改排序不会混入旧页面', async () => {
    await page.locator('[data-route="movies"]').click(); await page.waitForSelector('#load-more'); const gate = deferred(); control.gates.push(gate); control.pageGate = gate;
    await page.locator('#load-more').click(); await page.locator('#sort').selectOption('1'); await page.waitForSelector('[data-item="1001"]', { timeout: 1200 }); gate.resolve(); await delay(100);
    check(await page.locator('.grid .movie').count() === 60 && await page.locator('[data-item="61"]').count() === 0, 'Old pagination response polluted the newly sorted library');
  });
  await run('电视直连账号登录通过本机服务，不保存 NAS 密码', async () => {
    await directLogin(); await page.locator('#direct-alias').fill('example'); await page.locator('#direct-user').fill('viewer'); await page.locator('#direct-password').fill('private-test-password');
    await page.locator('#direct-form button[type="submit"]').click(); await page.waitForSelector('button[data-primary][data-item]');
    check(control.calls.some(c => c.path === '/api/direct/login' && c.body.password === 'private-test-password'), 'Direct login did not use the on-TV service');
    check(await page.evaluate(() => !JSON.stringify(localStorage).includes('private-test-password')), 'NAS password was saved in the browser');
  });
  await run('已扫码状态继续等待手机确认，成功后进入影视中心', async () => {
    await directLogin(); await page.locator('#login-qr-tab').click(); await page.waitForSelector('#login-qr svg');
    check(!await page.locator('#retry-qr').isVisible(), 'Retry appeared before a QR failure');
    control.qrState = 'scanned'; await page.waitForFunction(() => document.querySelector('#direct-message')?.textContent.includes('已扫码'));
    check(await page.locator('#login-qr svg').count() === 1, 'Scanned was treated as a failure');
    control.directConnected = true; control.qrState = 'connected'; await page.waitForSelector('button[data-primary][data-item]');
  });
  await run('离开扫码页后，迟到的扫码结果不能自动切换页面', async () => {
    await directLogin(); await page.locator('#login-qr-tab').click(); await page.waitForSelector('#login-qr svg'); await page.locator('#login-password-tab').click();
    control.directConnected = true; control.qrState = 'connected'; await delay(180);
    check(await page.locator('#direct-form').count() === 1, 'Cancelled QR flow navigated the app');
  });
  await run('扫码失败保留重试入口，失败密码会清空', async () => {
    await directLogin(); control.directFail = true; await page.locator('#direct-password').fill('wrong'); await page.locator('#direct-form button[type="submit"]').click(); await page.waitForFunction(() => document.querySelector('#direct-message')?.textContent.includes('错误'));
    check(await page.locator('#direct-password').inputValue() === '', 'Failed password remained in the form');
    await page.locator('#login-qr-tab').click(); await page.waitForSelector('#login-qr svg'); control.qrState = 'error'; await page.waitForSelector('#retry-qr:visible');
    await page.locator('#retry-qr').click(); await delay(100); check(control.calls.some(c => c.path === '/api/direct/qr/retry'), 'QR retry was not sent');
  });
  const report = { passed: cases.filter(c => c.ok).length, failed: cases.filter(c => !c.ok).length, cases };
  check(cases.length, 'No UI checks matched the filter');
  if (report.failed) throw new Error(JSON.stringify(report));
  return report;
}
