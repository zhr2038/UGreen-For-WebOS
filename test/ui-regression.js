async page => {
  const base = '__UI_BASE_URL__';
  const filter = __UI_FILTER__;
  await page.setViewportSize({ width: 1920, height: 1080 });
  const check = (value, message) => { if (!value) throw new Error(message); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
  const movie = id => ({ id, libraryId: 1, type: 1, name: '示例影片 ' + id, year: 2026, score: 7, duration: 3600, position: 120, progress: .03, overview: '测试影片资料', clarity: 'HD', genres: [], poster: '/mock-image/poster', backdrop: '/mock-image/background', cover: '/mock-image/cover' });
  let control, errors;
  const mockImage = Buffer.from(__UI_IMAGE_BASE64__, 'base64');
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
    if (url.pathname.startsWith('/mock-image/')) return route.fulfill({ contentType: 'image/png', body: mockImage });
    if (url.pathname.startsWith('/photo-image/')) {
      if (state.failPhoto && url.pathname.endsWith('/old')) return route.fulfill({ status: 503, body: 'offline' });
      return route.fulfill({ contentType: 'image/png', body: mockImage });
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' } });
    const call = { path: url.pathname, host: url.host, query: url.search, authorization: request.headers().authorization, body: request.postDataJSON() }; state.calls.push(call);
    if (url.pathname === '/api/connection') { const status = state.connectionStatus || { mode: 'ugreenlink-relay', verified: false, probing: false }; const gate = state.connectionGate; if (gate) await gate.promise; return response(route, status, state.connectionHttpStatus || 200); }
    if(url.pathname==='/api/connection/visibility'){if(call.body?.visible&&state.visibilityGate)await state.visibilityGate.promise;if(call.body?.visible&&state.nativeStartsOnVisible){state.connectionStatus={...state.connectionStatus,probing:true};setTimeout(()=>{state.connectionStatus={...state.connectionStatus,mode:'native-p2p',verified:true,authenticated:true,probing:false};},300);}return response(route,{ok:true});}
    if (url.pathname === '/api/direct/status') return response(route, { connected: Boolean(state.directConnected), alias: 'example', username: 'viewer' });
    if (url.pathname === '/api/direct/login') { if (state.directLoginGate) await state.directLoginGate.promise; if (state.directFail) return response(route, { error: 'NAS 用户名或密码错误' }, 401); state.directConnected = true; return response(route, { connected: true }); }
    if (url.pathname === '/api/direct/qr/create') return response(route, { url: 'https://www.ugnas.com/scan?example=1', expiresAt: Date.now() + 60000, interval: 60 });
    if (url.pathname === '/api/direct/qr/poll') return response(route, { state: state.qrState || 'waiting' });
    if (url.pathname === '/api/direct/qr/retry') { state.qrState = 'waiting'; return response(route, { state: 'waiting' }); }
    if (url.pathname === '/api/direct/logout') { state.directConnected = false; return response(route, { connected: false }); }
    if (url.pathname === '/api/direct/cancel') return response(route, { ok: true });
    if (url.host.startsWith('bad-nas.test')) return response(route, { error: '配对码错误' }, 401);
    if (url.pathname === '/api/home') return response(route, { connectionScope:state.connectionScope||'owner-A',accountScope: state.accountScope || 'account-A', name: '测试 NAS', connection: 'UGREENlink 中继', hero: [movie(1)], recent: [movie(1)], updates: [movie(2)], favorites: [movie(1)], libraries: [{ media_lib_set_id: 1, media_name: '电影', video_count: 120 }] });
    if (url.pathname === '/api/library') { if (state.libraryFailOnce) { state.libraryFailOnce = false; return response(route, { error: 'offline' }, 503); } const n = Number(url.searchParams.get('page') || 1); if (n === 2 && state.pageGate) await state.pageGate.promise; const sortOffset = url.searchParams.get('sort') === '1' ? 1000 : 0; return response(route, { items: Array.from({ length: 60 }, (_, j) => movie(sortOffset + (n - 1) * 60 + j + 1)), total: 120, last: n >= 2 }); }
    if (url.pathname === '/api/detail') return response(route, { item: movie(Number(url.searchParams.get('id'))), files: [{ index: 0, name: '原画' }, { index: 1, name: '备用版本' }], actors: [], technical: { container: 'mp4', video_info: { codec: 'h264', resolution: '1920x1080' }, audio_info: [] } });
    if (url.pathname === '/api/play') { const gate = state.playGate; if (gate) await gate.promise; if (state.playError) return response(route, { error: '无法打开版本' }, 503); const id = 'play-' + (++state.playId); return response(route, { id, stream: '/media/' + id, fileIndex: call.body.fileIndex || 0, title: '测试播放', position: call.body.restart ? 0 : 120, duration: 3600, technical: {} }); }
    if (url.pathname === '/api/play/options') { if (state.optionsGate) await state.optionsGate.promise; return response(route, { qualities: [{ id: 'original', label: '原画' }, { id: '720p', label: '720P', resolution: '1280×720' }, ...(state.threeQualities ? [{ id: '480p', label: '480P', resolution: '720×480' }] : [])], audio: [], subtitles: [], selected: 'original', preferences: state.preferences || { mode: 'sort_list', rate: 1, fit: 'contain' } }); }
    if (url.pathname === '/api/play/skips') return response(route, { enabled: false, ranges: [] });
    if (url.pathname === '/api/play/quality') {
      if (call.body.action === 'commit') { state.activeSource = { id: call.body.id, sourceId: call.body.candidateId, stream: '/media/candidate', kind: 'hls', quality: { id: '720p', label: '720P' } }; if (state.commitGate) await state.commitGate.promise; return response(route, state.activeSource); }
      if (call.body.action === 'discard') return response(route, { discarded: true });
      if (state.qualityGate) await state.qualityGate.promise;
      return response(route, { id: call.body.id, candidateId: 'candidate-' + state.playId, sourceId: 'candidate-' + state.playId, stream: '/media/candidate', kind: 'hls', quality: { id: '720p', label: '720P' } });
    }
    if (url.pathname === '/api/play/active') return response(route, state.activeSource || { sourceId: 'original' });
    if (url.pathname === '/api/play/close') return response(route, { closed: true });
    if (url.pathname === '/api/progress') { const gate = state.progressGate; if (gate) await gate.promise; if (state.progressError) return response(route, { error: 'offline' }, 503); return response(route, { ok: true }); }
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
  async function connectDirectHome() {
    await page.evaluate(() => sessionStorage.setItem('ui.direct', '1')); control.directConnected = true;
    await page.reload(); await page.waitForSelector('button[data-primary][data-item]');
  }
  await run('连接标签在后台探测后更新且保留隐藏页头和焦点', async () => {
    control.connectionStatus = { mode: 'ugreenlink-relay', verified: false, probing: true };
    await connectDirectHome(); await page.waitForFunction(() => document.querySelector('.connection')?.textContent.includes('中继'));
    await page.locator('[data-route="home"]').focus(); await page.locator('.screen').evaluate(el => el.scrollTop = 500);
    await page.waitForFunction(() => document.querySelector('.header')?.getAttribute('aria-hidden') === 'true');
    const scroll = await page.locator('.screen').evaluate(el => el.scrollTop);
    control.connectionStatus = { mode: 'lan-https', verified: true, probing: false };
    await page.waitForFunction(() => document.querySelector('.connection')?.textContent.includes('局域网直连'));
    check(await page.locator('.header').getAttribute('aria-hidden') === 'true', 'Connection refresh exposed the hidden header');
    check(await page.evaluate(() => document.activeElement.dataset.route) === 'home', 'Connection refresh stole focus');
    check(await page.locator('.screen').evaluate(el => el.scrollTop) === scroll, 'Connection refresh moved scroll');
    const count = control.calls.filter(c => c.path === '/api/connection').length; await delay(1150);
    check(control.calls.filter(c => c.path === '/api/connection').length === count, 'Finished connection round kept polling');
  });
  await run('连接标签拒绝旧账号迟到响应且未知状态保留中继', async () => {
    const gate = deferred(); control.gates.push(gate); control.connectionGate = gate;
    control.connectionStatus = { mode: 'lan-https', verified: true, probing: false };
    await connectDirectHome(); await page.waitForFunction(() => Boolean(document.querySelector('.connection')));
    while (!control.calls.some(c => c.path === '/api/connection')) await delay(10);
    await page.locator('[data-route="settings"]').click(); await page.waitForSelector('#direct-logout'); await page.locator('#direct-logout').click();
    await page.waitForSelector('#direct-password'); control.accountScope = 'account-B'; control.connectionGate = null;
    control.connectionStatus = { mode: 'lan-https', verified: false, probing: false };
    await page.locator('#direct-alias').fill('new-account'); await page.locator('#direct-user').fill('viewer'); await page.locator('#direct-password').fill('new-test-password');
    await page.locator('#direct-form button[type="submit"]').click(); await page.waitForSelector('button[data-primary][data-item]');
    await page.waitForFunction(() => document.querySelector('.connection')?.textContent.includes('中继'));
    gate.resolve(); await delay(200);
    check((await page.locator('.connection').textContent()).includes('中继'), 'Old account LAN result polluted the new account');
  });
  await run('原生P2P标签只采信已认证路由且隐藏后不续可见租约',async()=>{
    const gate=deferred();control.gates.push(gate);control.visibilityGate=gate;
    control.connectionStatus={mode:'native-p2p',verified:true,authenticated:true,mediaReadVerified:false,probing:false,nativeEnabled:true,visibilityScope:'owner-A',accountScope:'account-A'};
    await connectDirectHome();await page.waitForFunction(()=>document.querySelector('.connection')?.textContent.includes('原生P2P直连'));
    while(!control.calls.some(c=>c.path==='/api/connection/visibility'&&c.body.visible))await delay(10);
    await page.evaluate(()=>{window.__visibleTimerCount=0;const original=window.setTimeout;window.setTimeout=function(fn,ms,...args){if(ms===30000)window.__visibleTimerCount++;return original(fn,ms,...args);};Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    while(!control.calls.some(c=>c.path==='/api/connection/visibility'&&c.body.visible===false))await delay(10);const statusReads=control.calls.filter(c=>c.path==='/api/connection').length;gate.resolve();await delay(100);check(control.calls.filter(c=>c.path==='/api/connection').length===statusReads,'Late hidden pulse revived status reads');
    check(await page.evaluate(()=>window.__visibleTimerCount)===0,'Late visible response scheduled a hidden heartbeat');
    const hidden=control.calls.find(c=>c.path==='/api/connection/visibility'&&c.body.visible===false);check(hidden.body.scope==='owner-A'&&hidden.body.accountScope==='account-A','Hidden request lost its captured owner/account scope');
  });
  await run('首次可见脉冲启动原生后无需其他API也会及时更新标签且不动焦点滚动',async()=>{
    const gate=deferred();control.gates.push(gate);control.visibilityGate=gate;control.nativeStartsOnVisible=true;
    control.connectionStatus={mode:'ugreenlink-relay',verified:false,authenticated:false,probing:false,nativeEnabled:true,visibilityScope:'owner-A',accountScope:'account-A'};
    await connectDirectHome();while(!control.calls.some(c=>c.path==='/api/connection/visibility'&&c.body.visible))await delay(10);
    await page.locator('[data-route="home"]').focus();await page.locator('.screen').evaluate(el=>el.scrollTop=500);await page.waitForFunction(()=>document.querySelector('.header')?.getAttribute('aria-hidden')==='true');const scroll=await page.locator('.screen').evaluate(el=>el.scrollTop);
    gate.resolve();await page.waitForFunction(()=>document.querySelector('.connection')?.textContent.includes('原生P2P直连'),undefined,{timeout:2000});
    check(await page.locator('.header').getAttribute('aria-hidden')==='true','Forced connection refresh exposed header');check(await page.evaluate(()=>document.activeElement.dataset.route)==='home','Forced refresh stole focus');check(await page.locator('.screen').evaluate(el=>el.scrollTop)===scroll,'Forced refresh changed scroll');
    const count=control.calls.filter(c=>c.path==='/api/connection').length;await delay(1100);check(control.calls.filter(c=>c.path==='/api/connection').length===count,'Forced refresh became an endless poll');check(control.calls.filter(c=>c.path==='/api/connection/visibility'&&c.body.visible).length===1,'Status reread recursively renewed visibility');
  });
  await run('活动探测中的可见刷新只排队一次且完成后停止轮询',async()=>{
    const gate=deferred();control.gates.push(gate);control.visibilityGate=gate;control.nativeStartsOnVisible=true;
    control.connectionStatus={mode:'ugreenlink-relay',verified:false,authenticated:false,probing:true,nativeEnabled:true,visibilityScope:'owner-A',accountScope:'account-A'};
    await connectDirectHome();while(!control.calls.some(c=>c.path==='/api/connection/visibility'&&c.body.visible))await delay(10);gate.resolve();await page.waitForFunction(()=>document.querySelector('.connection')?.textContent.includes('原生P2P直连'),undefined,{timeout:2000});
    await delay(100);const count=control.calls.filter(c=>c.path==='/api/connection').length;check(count<=4,'Forced refresh queued more than one follow-up');await delay(1150);check(control.calls.filter(c=>c.path==='/api/connection').length===count,'Queued refresh did not terminate');check(control.calls.filter(c=>c.path==='/api/connection/visibility'&&c.body.visible).length===1,'Queued read recursively sent visibility');
  });
  await run('旧账号迟到的可见脉冲不能强制刷新或污染新账号标签',async()=>{
    const gate=deferred();control.gates.push(gate);control.visibilityGate=gate;
    control.connectionStatus={mode:'lan-https',verified:true,probing:false,nativeEnabled:true,visibilityScope:'owner-A',accountScope:'account-A'};
    await connectDirectHome();while(!control.calls.some(c=>c.path==='/api/connection/visibility'&&c.body.visible))await delay(10);
    await page.locator('[data-route="settings"]').click();await page.waitForSelector('#direct-logout');await page.locator('#direct-logout').click();await page.waitForSelector('#direct-password');const logoutDeadline=Date.now()+1000;while(!control.calls.some(c=>c.path==='/api/connection/visibility'&&c.body.visible===false)&&Date.now()<logoutDeadline)await delay(10);check(control.calls.some(c=>c.path==='/api/connection/visibility'&&c.body.visible===false),'Logout failed to release the old visible lease');
    control.accountScope='account-B';control.connectionScope='owner-B';control.connectionStatus={mode:'ugreenlink-relay',verified:false,probing:false,nativeEnabled:false,visibilityScope:'owner-B',accountScope:'account-B'};
    await page.locator('#direct-alias').fill('new-account');await page.locator('#direct-user').fill('viewer');await page.locator('#direct-password').fill('new-test-password');await page.locator('#direct-form button[type="submit"]').click();await page.waitForSelector('button[data-primary][data-item]');await delay(100);
    const count=control.calls.filter(c=>c.path==='/api/connection').length;gate.resolve();await delay(200);check(control.calls.filter(c=>c.path==='/api/connection').length===count,'Old visible pulse forced a new owner status read');check((await page.locator('.connection').textContent()).includes('中继'),'Old pulse polluted new owner label');
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
  await run('内容焦点丢失后按右键仍留在内容区', async () => {
    await page.locator('[data-route="movies"]').click(); await page.waitForSelector('.grid .movie'); await page.locator('.grid .movie').first().focus();
    await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press('ArrowRight');
    check(await page.evaluate(() => Boolean(document.activeElement.dataset.item) && !document.activeElement.closest('.nav')), 'Right recovered focus into the navigation rail');
  });
  await run('横向片单末尾右键不跳行，左键进入导航不滚动页面', async () => {
    const first = page.locator('.shelf-row .movie').first(); await page.locator('.shelf-row').first().locator('button').last().focus(); await page.keyboard.press('ArrowRight');
    check(await page.evaluate(() => Boolean(document.activeElement.closest('.shelf-row'))), 'Right at the end escaped the horizontal shelf');
    await first.focus();
    const before = await page.locator('.screen').evaluate(el => el.scrollTop); await page.keyboard.press('ArrowLeft');
    check(await page.evaluate(() => Boolean(document.activeElement.closest('.nav'))), 'Left at first item did not enter navigation');
    check(await page.locator('.screen').evaluate(el => el.scrollTop) === before, 'Focusing fixed navigation scrolled the page');
    await page.keyboard.press('ArrowRight'); check(await page.evaluate(() => Boolean(document.activeElement.closest('.shelf-row'))), 'Right did not restore the previous content focus');
  });
  await run('遥控器逐行返回首页海报且恢复顶部页头', async () => {
    await page.locator('.hero [data-primary]').focus();
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement.closest('.shelf')?.querySelector('h2')?.textContent) === '最近播放', 'Down from hero skipped the first shelf');
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement.closest('.shelf')?.querySelector('h2')?.textContent) === '我的媒体库', 'Down did not traverse the second shelf');
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement.closest('.shelf')?.querySelector('h2')?.textContent) === '最近更新', 'Down did not reach the third shelf');
    check(await page.locator('.hero [data-primary]').evaluate(el => el.getBoundingClientRect().bottom < 0), 'Remote traversal did not scroll the hero off screen');
    await page.keyboard.press('ArrowUp');
    check(await page.evaluate(() => document.activeElement.closest('.shelf')?.querySelector('h2')?.textContent) === '我的媒体库', 'Up teleported past the previous shelf');
    await page.keyboard.press('ArrowUp');
    check(await page.evaluate(() => document.activeElement.closest('.shelf')?.querySelector('h2')?.textContent) === '最近播放', 'Up skipped the first shelf');
    await page.keyboard.press('ArrowUp');
    check(await page.evaluate(() => document.activeElement.matches('.hero [data-primary]')), 'Up from first shelf did not return to hero CTA');
    check(await page.locator('.screen').evaluate(el => el.scrollTop) === 0, 'Returning to hero did not restore the top');
    await page.waitForFunction(() => document.querySelector('.header')?.getAttribute('aria-hidden') === 'false');
    await page.keyboard.press('ArrowLeft'); check(await page.evaluate(() => Boolean(document.activeElement.closest('.nav'))), 'Hero can no longer enter left navigation');
    await page.keyboard.press('ArrowRight'); check(await page.evaluate(() => document.activeElement.matches('.hero [data-primary]')), 'Navigation trapped hero focus');
  });
  await run('媒体库上下方向仍逐行导航且不会套用首页海报返回', async () => {
    await page.locator('[data-route="movies"]').click(); await page.waitForSelector('.grid .movie');
    await page.locator('.grid .movie').first().focus(); await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement.dataset.item) === '7', 'Library down skipped a grid row');
    await page.keyboard.press('ArrowUp'); check(await page.evaluate(() => document.activeElement.dataset.item) === '1', 'Library up did not return to its previous row');
    check(await page.locator('.hero').count() === 0, 'Library unexpectedly acquired a hero');
  });
  await run('首页海报铺到顶部，滚动隐藏透明页头并保留导航焦点', async () => {
    await page.waitForFunction(() => document.querySelector('.backdrop')?.naturalWidth > 0);
    check(await page.locator('.backdrop').evaluate(el => el.getBoundingClientRect().top === 0 && el.getBoundingClientRect().width === 1920), 'Backdrop does not reach the full-width top edge');
    check(await page.locator('.header').evaluate(el => getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)' && ['none','normal'].includes(getComputedStyle(el, '::before').content)), 'Header still paints a solid band');
    await page.locator('[data-route="home"]').focus();
    await page.locator('.screen').evaluate(el => el.scrollTop = 500);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.header')).visibility === 'hidden');
    check(await page.locator('.header').getAttribute('aria-hidden') === 'true', 'Scrolled header remains exposed');
    check(await page.evaluate(() => document.activeElement.dataset.route) === 'home', 'Scrolling stole navigation focus');
    check(await page.locator('.nav').isVisible(), 'Hiding the header hid navigation');
    await page.screenshot({ path: 'output/playwright/home-header-scrolled.png' });
    await page.locator('.screen').evaluate(el => el.scrollTop = 0);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.header')).visibility === 'visible');
    check(await page.locator('.header').getAttribute('aria-hidden') === 'false', 'Returning to top did not restore the header');
    await page.keyboard.press('ArrowRight');
    check(await page.evaluate(() => Boolean(document.activeElement.dataset.primary !== undefined)), 'Navigation no longer returns to the hero control');
    await page.screenshot({ path: 'output/playwright/home-header-overlay.png' });
  });
  await run('列表页头随滚动隐藏，换页恢复且旧屏幕不影响新页', async () => {
    await page.evaluate(() => window.__oldHeaderScreen = document.querySelector('.screen'));
    await page.locator('[data-route="movies"]').click(); await page.waitForSelector('.grid .movie');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.header')).visibility === 'visible');
    await page.evaluate(() => { __oldHeaderScreen.scrollTop = 500; __oldHeaderScreen.dispatchEvent(new Event('scroll')); });
    check(await page.locator('.header').getAttribute('aria-hidden') === 'false', 'Detached screen hid the new header');
    await page.locator('[data-item="15"]').focus();
    await page.locator('.screen').evaluate(el => el.scrollTop = 500);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.header')).visibility === 'hidden');
    check(await page.evaluate(() => document.activeElement.dataset.item) === '15', 'Header visibility update stole content focus');
    await page.keyboard.press('ArrowRight');
    check(await page.evaluate(() => Boolean(document.activeElement.dataset.item) && document.activeElement.dataset.item !== '15'), 'Hidden header blocked content navigation');
    await page.locator('[data-route="search"]').click(); await page.waitForSelector('#search');
    check(await page.locator('.header').getAttribute('aria-hidden') === 'false', 'New route inherited the old scroll state');
    check(await page.locator('.header h1').evaluate(el => el.getBoundingClientRect().bottom) < await page.locator('#search').evaluate(el => el.getBoundingClientRect().top), 'Restored header overlaps the search control');
  });
  await run('选择弹窗内左右键不能逃到页面导航', async () => {
    await page.locator('[data-route="movies"]').click(); await page.waitForSelector('#sort'); await page.locator('#sort').focus(); await page.keyboard.press('Enter'); await page.waitForSelector('.select-overlay');
    for (const key of ['ArrowLeft', 'ArrowRight']) { await page.keyboard.press(key); check(await page.evaluate(() => Boolean(document.activeElement.closest('.select-overlay'))), 'Horizontal key escaped the select overlay'); }
    await page.keyboard.press('Escape'); check(await page.evaluate(() => document.activeElement.id) === 'sort', 'Select did not restore focus');
  });
  async function qualityMenu() { await page.locator('#player-settings').click(); await page.locator('[data-po-action="open"][data-po-value="quality"]').click(); await page.waitForSelector('[data-po-action="quality"][data-po-value="720p"]'); }
  await run('右侧当前画质可用遥控器直接选择，切换后保留进度与焦点', async () => {
    await play(); await page.locator('#video').evaluate(v => { v.currentTime = 777; v.pause(); });
    const route = [];
    for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); route.push(await page.evaluate(() => document.activeElement.id)); }
    check(route[3] === 'player-quality', 'Right did not reach the current quality button: ' + route.join(' → '));
    check(await page.locator('#player-quality').getAttribute('aria-label') === '选择画质，当前为原画', 'Current quality is not exposed as a selector');
    check(await page.locator('#video').evaluate(v => v.currentTime === 777), 'Reaching quality sought the video');
    await page.keyboard.press('Enter'); await page.waitForSelector('.player-options[data-page="quality"] [data-po-value="720p"]');
    check(await page.locator('#player-quality').getAttribute('aria-expanded') === 'true', 'Direct quality entry did not open');
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement.dataset.poValue) === '720p', 'Remote Down did not reach the NAS quality');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#player-quality-label')?.textContent.includes('720P') && !document.querySelector('.player-options'));
    check(await page.locator('#video').evaluate(v => v.currentTime === 777 && v.paused), 'Direct quality change lost position or pause');
    check(control.calls.some(c => c.path === '/api/play/quality' && c.body.qualityId === '720p') && control.calls.some(c => c.body?.action === 'commit'), 'Remote selection did not prepare and commit');
    check(await page.evaluate(() => document.activeElement.id) === 'player-quality', 'Quality change did not return focus to its entry');
    check(await page.locator('#player-quality').getAttribute('aria-expanded') === 'false', 'Closed quality entry remained expanded');
    await page.screenshot({ path: 'output/playwright/player-quality-entry.png' });
  });
  await run('直接画质入口返回原按钮，设置内画质返回设置页', async () => {
    await play(); await page.locator('#player-quality').click(); await page.waitForSelector('.player-options[data-page="quality"]');
    await page.keyboard.press('Escape');
    check(await page.locator('.player-options').count() === 0 && await page.evaluate(() => document.activeElement.id) === 'player-quality', 'Direct quality Back did not return to the player button');
    await page.keyboard.press('Enter'); await page.waitForSelector('.player-options[data-page="quality"]'); await page.locator('[data-po-back]').click();
    check(await page.locator('.player-options').count() === 0 && await page.evaluate(() => document.activeElement.id) === 'player-quality', 'Visible Back did not return to the player button');
    await qualityMenu(); await page.keyboard.press('Escape'); await page.waitForSelector('.player-options[data-page="settings"]');
    check(await page.locator('#player-quality').getAttribute('aria-expanded') === 'false', 'Settings entry claimed the direct quality button was open');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => document.activeElement.id) === 'player-settings', 'Settings hierarchy did not retain its own return focus');
  });
  await run('画质切换经过解码和提交后保留进度与暂停状态', async () => {
    await play(); await page.locator('#video').evaluate(v => { v.currentTime = 777; v.pause(); }); await qualityMenu();
    await page.locator('[data-po-action="quality"][data-po-value="720p"]').click(); await page.waitForFunction(() => document.querySelector('.player-buttons .info')?.textContent.includes('720P'));
    check(await page.locator('#video').evaluate(v => v.currentTime === 777 && v.paused), 'Quality change lost position or pause');
    check(control.calls.some(c => c.body?.action === 'commit'), 'Decoded candidate was not committed');
  });
  await run('异步画质列表加载中返回后迟到选项不会重新夺取焦点', async () => {
    const gate = deferred(); control.gates.push(gate); control.optionsGate = gate; control.threeQualities = true;
    await play(); await page.locator('#player-quality').click();
    await page.waitForFunction(() => document.querySelector('.player-options')?.dataset.busy === 'true');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.player-options'));
    gate.resolve(); await delay(120);
    check(await page.evaluate(() => document.activeElement.id) === 'player-quality', 'Late options stole focus after closing');
    check(await page.locator('.player-options').count() === 0, 'Late options reopened the panel');
    check(!control.calls.some(c => c.path === '/api/play/quality'), 'Closing during load selected a quality');
  });
  await run('异步画质列表就绪后焦点回到当前档位，下键确认选择720P', async () => {
    const gate = deferred(); control.gates.push(gate); control.optionsGate = gate; control.threeQualities = true;
    await play(); await page.locator('#player-quality').click();
    await page.waitForFunction(() => document.querySelector('.player-options')?.dataset.busy === 'true');
    check(await page.evaluate(() => document.activeElement.hasAttribute('data-po-back')), 'Loading focus is not on the only available back action');
    gate.resolve(); await page.waitForFunction(() => document.querySelector('.player-options')?.dataset.busy === 'false' && document.querySelectorAll('[data-po-action="quality"]').length === 3);
    check(await page.evaluate(() => document.activeElement.dataset.poValue) === 'original', 'Loaded options inherited a numeric index instead of the selected quality');
    await page.keyboard.press('ArrowDown'); check(await page.evaluate(() => document.activeElement.dataset.poValue) === '720p', 'Down from selected original skipped 720P');
    await page.keyboard.press('Enter'); await page.waitForFunction(() => !document.querySelector('.player-options'));
    check(control.calls.some(c => c.path === '/api/play/quality' && c.body.qualityId === '720p'), 'Remote selection did not request NAS 720P');
    check(await page.evaluate(() => document.activeElement.id) === 'player-quality', 'Completed switch lost the quality entry focus');
  });
  await run('画质元数据加载中返回不会切断当前源', async () => {
    await play(); const old = await page.locator('#video').evaluate(v => v.src); await qualityMenu(); const gate = deferred(); control.gates.push(gate); control.qualityGate = gate;
    await page.locator('[data-po-action="quality"][data-po-value="720p"]').click(); await page.keyboard.press('Escape'); gate.resolve(); await delay(120);
    check(await page.locator('#video').evaluate(v => v.src) === old, 'Cancelled preparation replaced the current source'); check(!control.calls.some(c => c.body?.action === 'commit'), 'Cancelled preparation was committed');
  });
  await run('切换画质解码未完成时退出不会上报重载产生的零进度', async () => {
    await play(); await page.locator('#video').evaluate(v => v.currentTime = 777); await qualityMenu(); await page.evaluate(() => window.__holdMetadata = true);
    await page.locator('[data-po-action="quality"][data-po-value="720p"]').click(); await delay(70); await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.locator('#stop-player').click(); await page.waitForSelector('#play'); await delay(100);
    check(!control.calls.some(c => c.path === '/api/progress' && c.body.position === 0), 'Candidate reload overwrote history with zero');
    check(await page.locator('#play').textContent() === '继续播放 00:12:57', 'Candidate reload overwrote the detail resume position');
    check(control.calls.some(c => c.path === '/api/progress' && c.body.position === 777), 'Exiting during quality load lost the final position');
    check(control.calls.some(c => c.path === '/api/play/close'), 'Exiting failed to close the playback service');
  });
  await run('画质提交中关闭设置仍对账并显示真实活动画质', async () => {
    await play(); await qualityMenu(); const gate = deferred(); control.gates.push(gate); control.commitGate = gate;
    await page.locator('[data-po-action="quality"][data-po-value="720p"]').click(); await page.waitForFunction(() => document.querySelector('.player-options')?.dataset.busy === 'true'); await delay(80);
    await page.keyboard.press('Escape'); gate.resolve(); await page.waitForFunction(() => document.querySelector('.player-buttons .info')?.textContent.includes('720P'));
    check(!control.calls.some(c => c.body?.action === 'discard'), 'Closing settings discarded an already committing source');
  });
  await run('设置提前打开时后台仍恢复播放偏好', async () => {
    const gate = deferred(); control.gates.push(gate); control.optionsGate = gate; control.preferences = { mode: 'sort_list', rate: 1.5, fit: 'cover' };
    await play(); await page.locator('#player-settings').click(); gate.resolve();
    await page.waitForFunction(() => document.querySelector('#video').playbackRate === 1.5 && document.querySelector('#video').style.objectFit === 'cover');
  });
  await run('起播响应迟于进度确认仍使用请求开始时的本地续播', async () => {
    await play(); const progress = deferred(); control.gates.push(progress); control.progressGate = progress;
    await page.locator('#video').evaluate(v => v.currentTime = 777); await page.locator('#stop-player').click(); await page.waitForSelector('#play');
    const start = deferred(); control.gates.push(start); control.playGate = start; await page.locator('#play').click(); await delay(80);
    progress.resolve(); await delay(100); start.resolve(); await page.waitForSelector('#pause');
    check(await page.locator('#video').evaluate(v => v.currentTime === 777), 'Acknowledgement erased the start request resume snapshot');
  });
  await run('同一网关切账号不会串用未同步的本地续播', async () => {
    await play(); control.progressError = true; await page.locator('#video').evaluate(v => v.currentTime = 777); await page.locator('#stop-player').click(); await page.waitForSelector('#play'); await page.locator('#back').click();
    await page.locator('[data-route="settings"]').click(); await page.locator('#nas-login').click(); control.accountScope = 'account-B';
    await page.locator('#nas-user').fill('other-user'); await page.locator('#nas-password').fill('fake-password'); await page.locator('#login-form button').first().click(); await page.waitForSelector('button[data-primary][data-item]');
    await play(); check(await page.locator('#video').evaluate(v => v.currentTime === 120), 'Previous account resume overrode the current account');
  });
  await run('新画质就绪且提交等待中退出保存当前有效进度', async () => {
    await play(); await qualityMenu(); const gate = deferred(); control.gates.push(gate); control.commitGate = gate;
    await page.locator('[data-po-action="quality"][data-po-value="720p"]').click(); await delay(80);
    await page.locator('#video').evaluate(v => v.currentTime = 800); await page.locator('#stop-player').click(); await page.waitForSelector('#play'); gate.resolve(); await delay(80);
    check(await page.locator('#play').textContent() === '继续播放 00:13:20', 'Stop saved the pre-switch position after the candidate was ready');
    check(control.calls.some(c => c.path === '/api/progress' && c.body.position === 800), 'Ready candidate final position was not reported');
  });
  const report = { passed: cases.filter(c => c.ok).length, failed: cases.filter(c => !c.ok).length, cases };
  check(cases.length, 'No UI checks matched the filter');
  if (report.failed) throw new Error(JSON.stringify(report));
  return report;
}
