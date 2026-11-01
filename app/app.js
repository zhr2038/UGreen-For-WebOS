(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const root = $('#app'), video = $('#video');
  const artwork = window.createArtworkLoader();
  const store = {
    get(k, fallback = '') { try { return localStorage.getItem('cinema.' + k) || fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem('cinema.' + k, v); } catch {} },
  };
  const S = { server: store.get('server', location.protocol.startsWith('http') ? location.origin : ''), token: store.get('token'), route: 'home', home: null, hero: 0, list: [], page: 1, last: true, detail: null, playback: null, returnRoute: 'home', returnView: null, dialog: null, controls: true, busy: false, epoch: 0, exitConfirm: false, playGeneration: 0, playStarting: false, pendingResume: new Map() };
  let toastTimer, controlsTimer, heroTimer, lastNavigationAt = 0, lastNavigationCode;
  let directAuth, connectionMode = store.get('connectionMode', 'direct');
  let imageObserver, headerScroll;
  let progressTail = Promise.resolve();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const icons = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    home: '<path d="m3 10 9-7 9 7v11H3z"/><path d="M9 21v-8h6v8"/>',
    movies: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
    tv: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    favorites: '<path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    folders: '<path d="M3 5h7l2 3h9v13H3z"/>',
    photos: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
    settings: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M20 4l-2 2M6 18l-2 2"/>',
    back: '<path d="m15 4-8 8 8 8"/>',
  };
  const labels = { home: '影视中心', movies: '电影', tv: '电视剧', favorites: '我的收藏', history: '最近播放', recent: '最近更新', folders: '媒体库', photos: '相册', settings: '设置', search: '搜索' };
  const genres = { 28: '动作', 12: '冒险', 16: '动画', 35: '喜剧', 80: '犯罪', 99: '纪录', 18: '剧情', 10751: '家庭', 14: '奇幻', 36: '历史', 27: '恐怖', 10402: '音乐', 9648: '悬疑', 10749: '爱情', 878: '科幻', 53: '惊悚', 10752: '战争', 10765: '科幻 / 奇幻', 10759: '动作 / 冒险' };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.movies}</svg>`;
  function asset(path) {
    if (!path) return '';
    const url = new URL(path, S.server);
    if (url.origin !== new URL(S.server).origin) return '';
    url.searchParams.set('client', S.token); return url.href;
  }
  function time(value) {
    const sec = Math.max(0, Math.floor(Number(value) || 0));
    return [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map(n => String(n).padStart(2, '0')).join(':');
  }
  function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').classList.add('visible'); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200); }
  function focus(el) { if (!el) return; try { el.focus({ preventScroll: true }); } catch { el.focus(); } if (!el.closest('.nav')) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' }); }
  function firstFocus() { focus(root.querySelector('[data-primary]') || root.querySelector('button,input,select')); }
  async function api(path, data, signal, connection = { server: S.server, token: S.token }) {
    const controller = new AbortController(); let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 35000);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    if (path === '/api/play/preferences' && data?.id === S.playback?.id) S.playback.preferencesChanged = true;
    try {
      const res = await fetch(connection.server + path, { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + connection.token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined, signal: controller.signal });
      const result = await res.json(); if (!res.ok) throw new Error(result.error || '连接失败');
      if (path.startsWith('/api/play/options?')) { const p = S.playback; if (p && new URL(path, 'http://app').searchParams.get('id') === p.id) initializePlaybackOptions(p, result).catch(() => {}); }
      if (!path.startsWith('/api/connection') && connection.server === S.server && connection.token === S.token) refreshConnection();
      return result;
    } catch (error) { if (error.name === 'AbortError' && timedOut) throw new Error('连接超时，请检查电视和 NAS 的网络'); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  let foregroundLease;
  function stopForegroundLease(hidden=false){const lease=foregroundLease;foregroundLease=null;if(!lease)return;clearTimeout(lease.timer);if(hidden)api('/api/connection/visibility',{visible:false,scope:lease.scope,accountScope:lease.accountScope},undefined,lease.connection).catch(()=>{});}
  function renewForegroundLease(status,home,connection){
    if(!status.nativeEnabled||!home.connectionScope||status.visibilityScope!==home.connectionScope||status.accountScope!==home.accountScope||document.hidden||connectionMode!=='direct')return;
    if(foregroundLease?.scope===status.visibilityScope&&foregroundLease.home===home)return;
    stopForegroundLease();const lease={scope:status.visibilityScope,accountScope:home.accountScope,home,connection};foregroundLease=lease;
    async function renew(){if(foregroundLease!==lease||document.hidden||connectionUnloaded||connectionMode!=='direct'||S.server!==connection.server||S.token!==connection.token||S.home!==home){if(foregroundLease===lease)stopForegroundLease();return;}
      try{await api('/api/connection/visibility',{visible:true,scope:lease.scope,accountScope:lease.accountScope},undefined,connection);if(foregroundLease===lease)refreshConnection(true);}catch{if(foregroundLease===lease)stopForegroundLease();return;}
      if(foregroundLease===lease&&!document.hidden)lease.timer=setTimeout(renew,30000);
    }renew();
  }
  let connectionCheck, connectionCheckedHome, connectionCheckedAt = 0, connectionUnloaded = false;
  function cancelConnectionCheck(reset = false) {
    const check = connectionCheck; connectionCheck = null;
    if (check) { clearTimeout(check.timer); clearTimeout(check.deadline); check.controller?.abort(); }
    if (reset) { connectionCheckedHome = null; connectionCheckedAt = 0; }
  }
  function refreshConnection(force=false) {
    if (connectionUnloaded || !window.PalmServiceBridge || connectionMode !== 'direct' || document.hidden || !S.home) return;
    if (connectionCheck && (connectionCheck.home !== S.home || connectionCheck.server !== S.server || connectionCheck.token !== S.token)) cancelConnectionCheck(true);
    if(connectionCheck){if(force)connectionCheck.refreshAfter=true;return;}
    if(!force&&connectionCheckedHome===S.home&&Date.now()-connectionCheckedAt<10000)return;
    const check = { home: S.home, server: S.server, token: S.token, started: Date.now() };
    connectionCheck = check; connectionCheckedHome = S.home; connectionCheckedAt = check.started;
    const current = () => connectionCheck === check && !document.hidden && !connectionUnloaded && connectionMode === 'direct' && check.home === S.home && check.server === S.server && check.token === S.token;
    const stop = () => { if(connectionCheck!==check)return;const refreshAfter=check.refreshAfter&&current();cancelConnectionCheck();if(refreshAfter)refreshConnection(true); };
    check.deadline = setTimeout(stop, 12000);
    async function read() {
      if (!current()) { stop(); return; }
      check.controller = new AbortController();
      try {
        const status = await api('/api/connection?owner='+encodeURIComponent(check.home.connectionScope||'')+'&accountScope='+encodeURIComponent(check.home.accountScope||''), undefined, check.controller.signal, { server: check.server, token: check.token });
        if (!current()) { stop(); return; }
        renewForegroundLease(status,check.home,{server:check.server,token:check.token});
        check.home.connection = status.mode === 'native-p2p' && status.verified === true && status.authenticated === true ? '原生P2P直连' : status.mode === 'lan-https' && status.verified === true ? '局域网直连' : 'UGREENlink 中继';
        const label = $('.header .connection');
        if (label) label.textContent = (check.home.name || '绿联 NAS') + ' · ' + check.home.connection;
        if (status.probing === true && Date.now() - check.started < 11000) check.timer = setTimeout(read, 1000);
        else stop();
      } catch { stop(); }
    }
    read();
  }
  function cancelPlayRequest() {
    S.playAbort?.abort(); S.playAbort = null; S.playStarting = false; S.playGeneration++;
  }
  function beginView(name) {
    if (name === 'settings') cancelConnectionCheck(true);
    clearHeaderScroll();
    artwork.clearView();
    imageObserver?.disconnect(); imageObserver = null;
    if (name !== 'settings') directAuth?.leave();
    closeSelect(false);
    cancelPlayRequest();
    S.searchAbort?.abort(); S.searchAbort = null;
    S.libraryAbort?.abort(); S.libraryAbort = null; S.libraryLoad = null; S.busy = false;
    S.route = name; return ++S.epoch;
  }
  function closeSelect(restore = true) {
    const popup = S.selectPopup; S.selectPopup = null;
    popup?.element.remove(); if (restore && popup?.select.isConnected) focus(popup.select);
  }
  function openSelect(select) {
    if (S.selectPopup || !select?.isConnected || select.disabled) return;
    const options = Array.from(select.options);
    const element = document.createElement('section'); element.className = 'select-overlay'; element.setAttribute('role', 'dialog'); element.setAttribute('aria-modal', 'true'); element.setAttribute('aria-label', select.getAttribute('aria-label') || '选择选项');
    element.innerHTML = `<div class="select-panel"><h2>${esc(select.getAttribute('aria-label') || '选择选项')}</h2>${options.map((option, index) => `<button data-option="${index}" ${option.disabled ? 'disabled' : ''} aria-pressed="${option.selected}">${esc(option.text)}${option.selected ? ' ✓' : ''}</button>`).join('')}<button data-select-close>返回</button></div>`;
    root.appendChild(element); S.selectPopup = { element, select };
    element.querySelectorAll('[data-option]').forEach(button => button.onclick = () => {
      const option = options[Number(button.dataset.option)], changed = select.value !== option.value;
      closeSelect(false);
      if (select.isConnected) { if (changed) { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); } else focus(select); }
    });
    element.querySelector('[data-select-close]').onclick = () => closeSelect();
    focus(element.querySelector(`[data-option="${select.selectedIndex}"]`) || element.querySelector('button:not([disabled])'));
  }
  function captureView() {
    const nodes = Array.from(root.querySelectorAll('button,input,select,[tabindex="0"]'));
    return { route: S.route, libraryId: S.libraryId, libraryTitle: S.libraryTitle, list: S.list, page: S.page, last: S.last, total: S.total, sort: S.sort, searchView: S.searchView, scrollTop: root.querySelector('.screen')?.scrollTop || 0, focusIndex: nodes.indexOf(document.activeElement), focusKey: document.activeElement?.dataset.focus };
  }
  function restoreView() {
    const view = S.returnView;
    if (!view) return home();
    beginView(view.route); photoGallery.leave();
    Object.assign(S, { libraryId: view.libraryId, libraryTitle: view.libraryTitle, list: view.list, page: view.page, last: view.last, total: view.total, sort: view.sort, searchView: view.searchView, busy: false });
    if (view.route === 'home') renderHome();
    else if (view.route === 'search') renderSearch();
    else if (view.route === 'folders') renderFolders();
    else renderLibrary();
    const nodes = Array.from(root.querySelectorAll('button,input,select,[tabindex="0"]'));
    const original = nodes[view.focusIndex];
    focus(original && (!view.focusKey || original.dataset.focus === view.focusKey) ? original : (view.focusKey ? root.querySelector(`[data-focus="${CSS.escape(view.focusKey)}"]`) : null) || root.querySelector('button'));
    const screen = root.querySelector('.screen'); if (screen) screen.scrollTop = view.scrollTop;
  }
  function image(path, className = '', alt = '', kind = 'poster') { return path ? `<img class="${className}" data-art-source="${esc(asset(path))}" data-art-kind="${className === 'backdrop' ? 'backdrop' : kind}" alt="${esc(alt)}">` : ''; }
  function header(title) { return `<header class="header"><span class="app-brand"><img src="icon-cloudframe.png" alt=""><b>云映</b></span><h1>${esc(title)}</h1><span class="connection">${esc(S.home?.name || '绿联 NAS')} · ${esc(S.home?.connection || (connectionMode === 'direct' ? 'UGREENlink' : '兼容服务'))}</span></header>`; }
  function clearHeaderScroll() { if (headerScroll) { headerScroll.screen.removeEventListener('scroll', headerScroll.update); headerScroll = null; } }
  function bindHeaderScroll() {
    const screen = root.querySelector('.screen'), element = root.querySelector('.header');
    if (headerScroll?.screen === screen && headerScroll?.element === element) { headerScroll.update(); return; }
    clearHeaderScroll(); if (!screen || !element) return;
    const binding = { screen, element, hidden: null, update() { const hidden = screen.scrollTop > 12; if (binding.hidden === hidden) return; binding.hidden = hidden; element.classList.toggle('is-scrolled', hidden); element.setAttribute('aria-hidden', String(hidden)); } };
    headerScroll = binding; screen.addEventListener('scroll', binding.update, { passive: true }); binding.update();
  }
  function nav(active) { return `<nav class="nav" aria-label="主导航">${['search', 'home', 'movies', 'tv', 'favorites', 'history', 'folders', 'photos', 'settings'].map(k => `<button data-route="${k}" class="${active === k ? 'active' : ''}" aria-label="${labels[k]}">${icon(k)}<span>${labels[k]}</span></button>`).join('')}</nav>`; }
  const photoGallery = window.createPhotoGallery({ root, api, asset, esc, header, nav, bind, focus, toast, store, getConnection: () => ({ server: S.server, token: S.token }), videoPlane: () => S.route === 'photos' && !S.playback ? video : null, exit: () => route('home') });
  const playerTracks = new window.CloudFramePlayback.MediaTrackController(video, {
    store,
    loadSubtitle: async (subtitleId, { signal }) => {
      const p = S.playback; if (!p) throw new Error('播放已结束');
      return (await api('/api/play/subtitle', { id: p.id, subtitleId, format: 'vtt', encoding: 'auto' }, signal, p.connection)).body;
    },
  });
  const movieMedia = window.createMovieMedia({ video, api, asset, getPlayback: () => S.playback, onChange: updatePlayerInfo, onWarning: toast, captureTracks: () => playerTracks.capture(), restoreTracks: (saved, options) => playerTracks.restore(saved, options) });
  const playerOptions = window.createPlayerOptions({ video, api, asset, root: () => $('#player-dialog'), getPlayback: () => S.playback, tracks: playerTracks, store, focus, toast,
    onSourceSwitch: movieMedia.switchSource,
    onClose() { $('#player-quality')?.setAttribute('aria-expanded', 'false'); if (S.dialog === 'advanced') { S.dialog = null; showControls(); focus(document.getElementById(S.dialogReturnFocus) || $('#player-settings')); } },
  });
  function updatePlayerInfo() {
    const p = S.playback, label = $('#player-quality-label'), detail = $('#player-quality-detail'); if (!p || !label || !detail) return;
    const pixels = video.videoWidth && video.videoHeight ? video.videoWidth + ' × ' + video.videoHeight : '';
    label.textContent = p.quality?.label || '原画';
    detail.textContent = p.kind === 'hls' ? [pixels, 'NAS 转码'].filter(Boolean).join(' · ') : [pixels || S.detail?.item.clarity, p.technical?.video_info?.codec?.toUpperCase()].filter(Boolean).join(' · ');
    $('#player-quality')?.setAttribute('aria-label', '选择画质，当前为' + label.textContent);
  }
  function releasePlayback(p) { if (!p) return; (p.reportPromise || Promise.resolve()).finally(() => api('/api/play/close', { id: p.id }, undefined, p.connection)).catch(() => {}); }
  function resumeKey(id, scope = S.accountScope) { return (scope || S.server + '|' + S.token) + '|' + String(id); }
  async function initializePlaybackOptions(p, data) {
    if (S.playback !== p) return;
    playerOptions.hydrate(data);
    playerTracks.updateMetadata(data);
    await playerTracks.applyPreferences(data.preferences || {}, { metadata: data, isCurrent: () => S.playback === p });
  }
  async function loadPlaybackOptions(p) {
    try {
      await api('/api/play/options?id=' + encodeURIComponent(p.id), undefined, undefined, p.connection);
    } catch { /* Original playback remains available when metadata is unavailable. */ }
    try { const data = await api('/api/play/skips?id=' + encodeURIComponent(p.id) + '&duration=' + encodeURIComponent(video.duration || p.duration), undefined, undefined, p.connection); if (S.playback === p) { p.skips = data; if (playerOptions.active()) playerOptions.render(); } } catch {}
  }
  function meta(item) { return [item.score > 0 ? Number(item.score).toFixed(1) : '', item.year || '', (item.genres || []).map(g => genres[g]).filter(Boolean).slice(0, 3).join(' · '), item.duration ? `${Math.floor(item.duration / 60)} 分钟` : ''].filter(Boolean).map(esc).join('　/　'); }
  function card(item, wide = false) {
    const attributes = `data-item="${item.id}" data-type="${item.type}" data-library="${item.libraryId}" data-focus="item-${item.id}"`;
    if (wide) return `<button class="movie continue" ${attributes}><div class="art">${image(item.cover || item.backdrop || item.poster, '', item.name, 'cover')}<span class="progress"><i style="width:${item.progress * 100}%"></i></span></div><span class="name">${esc(item.name)}</span></button>`;
    return `<button class="movie" ${attributes}>${image(item.poster || item.backdrop, '', item.name)}${item.clarity ? `<span class="quality">${esc(item.clarity)}</span>` : ''}${item.score > 0 ? `<span class="score">${Number(item.score).toFixed(1)}</span>` : ''}<span class="name">${esc(item.name)}</span><span class="year">${esc(item.year || '')}</span></button>`;
  }
  function shelf(title, items, wide = false, route) { if (!items?.length) return ''; return `<section class="shelf"><h2>${esc(title)}</h2><div class="shelf-row">${items.map(i => card(i, wide)).join('')}${route ? `<button class="library-shortcut" data-route="${route}">查看全部</button>` : ''}</div></section>`; }
  function libraries() { return (S.home?.libraries || []).map(l => `<button class="library-shortcut" data-library-route="${l.media_lib_set_id}" data-title="${esc(l.media_name)}">${icon(l.media_name.includes('剧') ? 'tv' : 'movies')}${esc(l.media_name)}<small>${l.video_count} 部</small></button>`).join(''); }
  function renderHome(preserve = false) {
    const key = preserve ? document.activeElement?.dataset.focus : null;
    const home = S.home; const hero = home.hero[S.hero % Math.max(1, home.hero.length)];
    root.innerHTML = `<main class="screen">${hero ? image(hero.backdrop, 'backdrop') + '<div class="shade"></div>' : ''}${header('影视中心')}${nav('home')}<section class="hero"><div class="hero-copy">${hero ? `<h2>${esc(hero.name)}</h2><p class="meta">${meta(hero)}</p><p class="overview">${esc(hero.overview)}</p><button class="action" data-primary data-focus="hero" data-item="${hero.id}" data-type="${hero.type}" data-library="${hero.libraryId}">查看详情</button>` : '<h2>影视中心</h2><p class="meta">选择媒体库，开始观看</p>'}</div><div class="dots">${home.hero.slice(0, 8).map((_, i) => `<button class="dot ${i === S.hero ? 'selected' : ''}" data-hero="${i}" aria-label="第 ${i + 1} 张海报"></button>`).join('')}</div></section>${shelf('最近播放', home.recent, true, 'history')}${home.libraries.length ? `<section class="shelf"><h2>我的媒体库</h2><div class="shelf-row">${libraries()}</div></section>` : ''}${shelf('最近更新', home.updates, false, 'recent')}${shelf('我的收藏', home.favorites, false, 'favorites')}</main>`;
    bind(); if (key) focus(root.querySelector(`[data-focus="${CSS.escape(key)}"]`)); else firstFocus();
  }
  async function home() {
    photoGallery.leave();
    const epoch = beginView('home'); S.dialog = null; clearInterval(heroTimer); loading();
    try { const data = await api('/api/home'); if (epoch !== S.epoch) return; const scope = data.accountScope || S.server + '|' + S.token; if (S.accountScope && S.accountScope !== scope) photoGallery.reset(); S.home = data; S.accountScope = scope; S.hero = 0; renderHome(); }
    catch (err) { if (epoch === S.epoch) errorScreen(err); }
  }
  function loading() { clearHeaderScroll(); artwork.clearView(); imageObserver?.disconnect(); imageObserver = null; root.innerHTML = '<div class="loading"><span class="spinner"></span>正在连接影视中心…</div>'; }
  function errorScreen(error, retry = home) { root.innerHTML = `<div class="error-screen"><h1>暂时无法连接</h1><p>${esc(error.message)}</p><div class="actions"><button class="action" data-primary id="retry">重试</button><button class="action secondary" data-route="settings">连接设置</button></div></div>`; $('#retry').onclick = retry; bind(); firstFocus(); }
  function renderLibrary() {
    const title = S.libraryTitle || labels[S.route] || '全部影片';
    root.innerHTML = `${header(title)}${nav(S.route)}<main class="screen library-screen"><div class="toolbar"><button data-route="movies" class="${S.route === 'movies' ? 'selected' : ''}">电影</button><button data-route="tv" class="${S.route === 'tv' ? 'selected' : ''}">电视剧</button><span>${S.total || 0} 部</span><select id="sort" aria-label="排序"><option value="2">按添加时间 ↓</option><option value="1">按名称</option><option value="4">按评分</option></select></div><div class="grid ${S.route === 'history' ? 'history-grid' : ''}">${S.list.map(i => card(i, S.route === 'history')).join('')}</div>${!S.list.length ? '<div class="empty">暂无影片</div>' : ''}${S.last ? '' : '<div class="more-row"><button class="action secondary" id="load-more">加载更多</button></div>'}</main>`;
    $('#sort').value = S.sort || '2'; $('#sort').onchange = () => { S.sort = $('#sort').value; loadLibrary(true); };
    if ($('#load-more')) $('#load-more').onclick = () => loadLibrary(false);
    bind();
  }
  async function loadLibrary(reset) {
    if (S.busy && !reset) return;
    if (reset) S.libraryAbort?.abort();
    S.busy = true;
    const owner = {}, controller = new AbortController(); S.libraryLoad = owner; S.libraryAbort = controller;
    const epoch = ++S.epoch, oldCount = reset ? 0 : S.list.length;
    if (reset) { S.list = []; S.page = 1; loading(); }
    try {
      const query = new URLSearchParams({ kind: S.route, page: S.page, sort: S.sort || '2' });
      if (S.libraryId) query.set('id', S.libraryId);
      const data = await api('/api/library?' + query, undefined, controller.signal); if (epoch !== S.epoch) return;
      S.list = reset ? data.items : S.list.concat(data.items); S.last = data.last || data.items.length === 0; S.total = data.total; S.page++;
      renderLibrary(); focus(root.querySelectorAll('.grid .movie')[oldCount] || root.querySelector('#load-more') || root.querySelector('button'));
    } catch (err) { if (epoch === S.epoch) { if (reset) errorScreen(err, () => loadLibrary(true)); else { renderLibrary(); focus($('#load-more')); toast(err.message); } } }
    finally { if (S.libraryLoad === owner) { S.busy = false; S.libraryAbort = null; } }
  }
  async function openDetail(id, type, library, preserveRoute = false) {
    if (!preserveRoute) { S.returnRoute = S.route; S.returnView = captureView(); }
    const epoch = beginView('detail'); loading();
    const key = resumeKey(id), pendingAtStart = S.pendingResume.get(key);
    try { const data = await api(`/api/detail?id=${id}&type=${type}&library=${library}`); if (epoch !== S.epoch) return; const pending = S.pendingResume.get(key) || pendingAtStart; if (pending) { data.item.position = pending.position; data.resumeFileIndex = pending.fileIndex; } S.detail = data; renderDetail(); }
    catch (err) { if (epoch === S.epoch) errorScreen(err, () => openDetail(id, type, library, true)); }
  }
  function renderDetail() {
    const { item: i, files, actors, technical } = S.detail;
    root.innerHTML = `<main class="screen detail-screen">${image(i.backdrop, 'backdrop')}<div class="shade"></div><button class="back" id="back">${icon('back')}返回</button><div class="detail-copy"><h2>${esc(i.name)}</h2><p class="meta">${meta(i)}</p><p class="overview">${esc(i.overview)}</p><p class="meta">${[i.clarity, technical?.video_info?.codec?.toUpperCase(), i.imageQuality, i.audioQuality].filter(Boolean).map(esc).join(' · ')}</p><div class="actions"><button class="action" data-primary id="play">${i.position > 0 ? '继续播放 ' + time(i.position) : '立即播放'}</button><button class="action secondary" id="restart">从头播放</button><button class="action secondary" id="favorite">${i.favorite ? '已收藏' : '收藏'}</button></div></div>${files.length > 1 ? `<section class="details-section"><h3>${i.type === 2 ? '选集' : '播放版本'}</h3><div class="episodes">${files.map(f => `<button class="episode" data-file="${f.index}">${esc(f.episode ? '第 ' + f.episode + ' 集' : f.name)}</button>`).join('')}</div></section>` : ''}${actors.some(a => a.name) ? `<section class="details-section"><h3>演职人员</h3><div class="actor-list">${actors.filter(a => a.name).map(a => `<div>${esc(a.name)}<small>${esc(a.role || '')}</small></div>`).join('')}</div></section>` : ''}${technical ? `<section class="details-section"><h3>影片信息</h3><div class="technical">${esc(technical.container?.toUpperCase() || '')} · ${esc(technical.video_info?.resolution || '')} · ${esc(technical.video_info?.framerate || '')}<br>${(technical.audio_info || []).map(a => `${esc(a.language)} · ${esc(a.codec)} · ${esc(a.channels)} 声道`).join('<br>')}</div></section>` : ''}</main>`;
    artwork.observe(root);
    $('#back').onclick = back; $('#play').onclick = () => play(); $('#restart').onclick = () => play(true);
    const favoriteButton = $('#favorite'); favoriteButton.onclick = async () => {
      if (favoriteButton.disabled) return; favoriteButton.disabled = true;
      try { await api('/api/favorite', { id: i.id, type: i.type, library: i.libraryId, favorite: !i.favorite }); i.favorite = !i.favorite; favoriteButton.textContent = i.favorite ? '已收藏' : '收藏'; if (S.returnView?.route === 'favorites' && !i.favorite) { S.returnView.list = S.returnView.list.filter(v => v.id !== i.id); S.returnView.total = Math.max(0, S.returnView.total - 1); } toast(i.favorite ? '已收藏' : '已取消收藏'); }
      catch (err) { toast(err.message); }
      finally { favoriteButton.disabled = false; }
    };
    root.querySelectorAll('[data-file]').forEach(b => b.onclick = () => play(false, Number(b.dataset.file))); firstFocus();
  }
  async function play(restart = false, fileIndex) {
    if (S.playStarting || !S.detail || !['detail', 'player'].includes(S.route)) return;
    const detail = S.detail, i = detail.item, epoch = S.epoch, generation = ++S.playGeneration;
    const controller = new AbortController(); S.playAbort = controller; S.playStarting = true;
    const selected = Number.isInteger(fileIndex) ? fileIndex : detail.resumeFileIndex, connection = { server: S.server, token: S.token }, scope = S.accountScope;
    const key = resumeKey(i.id, scope), pendingAtStart = S.pendingResume.get(key);
    const previous = S.playback;
    if (S.route === 'player') { const snapshot = movieMedia.snapshot(); movieMedia.cancel(); playerOptions.close(); video.pause(); reportProgress(true, snapshot); }
    toast('正在打开影片…');
    try {
      const data = await api('/api/play', { id: i.id, type: i.type, library: i.libraryId, restart, fileIndex: selected }, controller.signal, connection);
      if (generation !== S.playGeneration || epoch !== S.epoch || detail !== S.detail) { releasePlayback({ ...data, connection }); return; }
      const pending = S.pendingResume.get(key) || pendingAtStart;
      if (!restart && pending && (selected === undefined || pending.fileIndex === undefined || selected === pending.fileIndex)) data.position = pending.position;
      releasePlayback(previous); playerTracks.reset();
      S.playback = { ...data, accountScope: data.accountScope || scope, itemId: i.id, fileIndex: data.fileIndex ?? selected, connection }; S.route = 'player'; S.dialog = null; S.controls = true;
      playerTracks.setSource(data.preferenceScope || 'play:' + data.id);
      document.body.classList.add('playing'); video.src = asset(data.stream); video.load(); renderPlayer();
      await video.play(); if (generation === S.playGeneration && S.route === 'player') { showControls(); loadPlaybackOptions(S.playback); }
    } catch (err) { if (generation === S.playGeneration && epoch === S.epoch && err.name !== 'AbortError') { toast(err.message); if (S.route === 'player') playerError(err.message); } }
    finally { if (generation === S.playGeneration) { S.playStarting = false; S.playAbort = null; } }
  }
  function renderPlayer() {
    clearHeaderScroll();
    artwork.clearView();
    root.innerHTML = `<div class="player-ui ${S.controls ? '' : 'hidden'}"><div class="player-top"><button class="back" style="position:static" id="stop-player" aria-label="返回">${icon('back')}</button><span>${esc(S.playback.title)}</span></div><div class="player-bottom"><div class="player-time"><b id="elapsed">${time(video.currentTime)}</b><span>/ <b id="duration">${time(video.duration || S.playback.duration)}</b></span></div><div class="seek" id="player-seek" tabindex="0" role="slider" aria-label="播放进度" aria-valuemin="0" aria-valuemax="${S.playback.duration || 0}" aria-valuenow="0"><i id="seek-progress"></i></div><div class="player-buttons"><button id="pause" data-primary>${video.paused ? '播放' : '暂停'}</button><button id="episode-list">列表</button><button id="player-settings">设置</button><button id="player-info">信息</button><button type="button" id="player-quality" class="info player-quality" aria-haspopup="dialog" aria-controls="player-dialog" aria-expanded="false"><span id="player-quality-label">原画</span><span id="player-quality-detail"></span><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div><p class="player-hint">左右选择按钮 · 上键调整进度 · 下键返回按钮</p></div></div><div id="player-dialog"></div><div id="player-message"></div>`;
    $('#stop-player').onclick = stop; $('#pause').onclick = togglePause; $('#episode-list').onclick = () => playerDialog('episodes'); $('#player-settings').onclick = () => playerDialog('settings'); $('#player-info').onclick = () => playerDialog('info'); $('#player-quality').onclick = () => playerDialog('quality'); firstFocus(); updateProgress(); updatePlayerInfo();
  }
  function showControls() {
    if (S.route !== 'player') return;
    S.controls = true; $('.player-ui')?.classList.remove('hidden');
    clearTimeout(controlsTimer); controlsTimer = setTimeout(() => { if (S.route === 'player' && !S.dialog && !video.paused) { S.controls = false; $('.player-ui')?.classList.add('hidden'); } }, 5000);
  }
  function setPaused(paused) {
    const playback = S.playback;
    if (!playback || S.route !== 'player') return;
    if (paused) video.pause();
    else video.play().catch(err => { if (S.playback === playback && S.route === 'player' && err.name !== 'AbortError') playerError(err.message); });
    if ($('#pause')) $('#pause').textContent = video.paused ? '播放' : '暂停'; showControls();
  }
  function togglePause() { setPaused(!video.paused); }
  function seek(delta) {
    if (!S.playback || video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) { toast('影片尚未准备好'); return; }
    try { video.currentTime = Math.max(0, Math.min(Math.max(0, video.duration - .1), (Number.isFinite(video.currentTime) ? video.currentTime : 0) + delta)); updateProgress(); }
    catch { toast('此片源暂时无法跳转'); }
    showControls(); focus($('#player-seek'));
  }
  function playerError(message) { if ($('#player-dialog')) $('#player-dialog').innerHTML = ''; if ($('#player-message')) $('#player-message').innerHTML = `<div class="player-message">${esc(message)}<br>可返回后选择其他片源或播放版本。<br><button class="action secondary" id="error-back">返回影片</button></div>`; S.dialog = 'error'; if ($('#error-back')) { $('#error-back').onclick = stop; focus($('#error-back')); } showControls(); }
  function updateProgress() {
    if (S.route !== 'player') return;
    const duration = Number.isFinite(video.duration) ? video.duration : S.playback.duration;
    if ($('#elapsed')) $('#elapsed').textContent = time(video.currentTime);
    if ($('#duration')) $('#duration').textContent = time(duration);
    if ($('#seek-progress')) $('#seek-progress').style.width = Math.min(100, duration ? video.currentTime / duration * 100 : 0) + '%';
    if ($('#player-seek')) { $('#player-seek').setAttribute('aria-valuemax', Number.isFinite(duration) ? duration : 0); $('#player-seek').setAttribute('aria-valuenow', Math.floor(video.currentTime || 0)); $('#player-seek').setAttribute('aria-valuetext', time(video.currentTime) + ' / ' + time(duration)); }
  }
  function reportProgress(force = false, saved) {
    const p = S.playback;
    const duration = saved?.duration ?? video.duration, position = saved?.position ?? video.currentTime;
    if (!p || (!saved && (movieMedia.switching() || video.readyState < 1)) || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position) || (!force && Date.now() - (p.lastReportAt || 0) < 15000)) return Promise.resolve();
    const snapshot = { id: p.id, position: Math.max(0, Math.min(duration, position)), duration, fileIndex: p.fileIndex };
    const key = `${snapshot.position}:${snapshot.duration}`;
    if (key === p.lastReportKey && !p.reportFailed) return p.reportPromise || Promise.resolve();
    p.lastReportAt = Date.now(); p.lastReportKey = key; p.reportFailed = false;
    const itemId = resumeKey(p.itemId, p.accountScope); S.pendingResume.set(itemId, snapshot);
    while (S.pendingResume.size > 128) S.pendingResume.delete(S.pendingResume.keys().next().value);
    const job = progressTail.then(async () => {
      if (S.pendingResume.get(itemId) !== snapshot) return;
      await api('/api/progress', { id: snapshot.id, position: snapshot.position, duration: snapshot.duration }, undefined, p.connection);
      if (p.lastReportKey === key) p.reportFailed = false;
      if (S.pendingResume.get(itemId) === snapshot) S.pendingResume.delete(itemId);
    }).catch(err => { p.reportFailed = true; if (force) toast('播放记录未能同步：' + err.message); });
    p.reportPromise = job; progressTail = job; return job;
  }
  function stop() {
    if (S.route !== 'player') return;
    const playback = S.playback;
    const saved = movieMedia.snapshot();
    movieMedia.cancel(); playerOptions.close(); playerTracks.reset();
    clearTimeout(controlsTimer); video.pause(); reportProgress(true, saved);
    if (saved || video.readyState >= 1 && Number.isFinite(video.duration)) { S.detail.item.position = saved?.position ?? Math.max(0, Math.min(video.duration, video.currentTime)); S.detail.resumeFileIndex = playback?.fileIndex; }
    releasePlayback(playback); beginView('detail'); S.playback = null; S.dialog = null;
    video.removeAttribute('src'); video.load(); document.body.classList.remove('playing'); renderDetail();
  }
  function closeDialog() { playerOptions.close(); if (S.playStarting) cancelPlayRequest(); S.dialog = null; if ($('#player-dialog')) $('#player-dialog').innerHTML = ''; showControls(); focus(document.getElementById(S.dialogReturnFocus) || $('#pause')); }
  function dialogBack() { if (['audio', 'subtitle', 'speed', 'ratio'].includes(S.dialog)) playerDialog('settings'); else closeDialog(); }
  function playerDialog(kind) {
    if (!S.dialog) S.dialogReturnFocus = document.activeElement?.id;
    if (kind === 'settings' || kind === 'quality') { S.dialog = 'advanced'; showControls(); $('#player-quality')?.setAttribute('aria-expanded', String(kind === 'quality')); playerOptions.open(kind, { backToPlayer: kind === 'quality' }); return; }
    S.dialog = kind; showControls();
    let content = '';
    if (kind === 'episodes') content = `<h2>播放列表</h2>${S.detail.files.map(f => `<button data-switch="${f.index}">${esc(f.episode ? '第 ' + f.episode + ' 集 · ' + f.name : f.name)}</button>`).join('')}`;
    if (kind === 'settings') content = '<h2>播放设置</h2><button data-subdialog="audio">音轨</button><button data-subdialog="subtitle">字幕</button><button data-subdialog="speed">倍速</button><button data-subdialog="ratio">画面比例</button>';
    if (kind === 'speed') content = `<h2>倍速</h2>${[.75, 1, 1.25, 1.5, 2].map(x => `<button data-speed="${x}">${x} × ${video.playbackRate === x ? '✓' : ''}</button>`).join('')}`;
    if (kind === 'ratio') content = '<h2>画面比例</h2><button data-ratio="contain">适应屏幕</button><button data-ratio="cover">填满屏幕</button><button data-ratio="fill">拉伸</button>';
    if (kind === 'audio') {
      const tracks = video.audioTracks ? Array.from(video.audioTracks) : [];
      content = `<h2>音轨</h2>${tracks.length ? tracks.map((t, n) => `<button data-audio="${n}">${esc(t.label || t.language || '音轨 ' + (n + 1))}${t.enabled ? ' ✓' : ''}</button>`).join('') : '<p>电视未返回可切换的音轨，当前使用片源默认音轨。</p>'}`;
    }
    if (kind === 'subtitle') {
      const tracks = Array.from(video.textTracks || []);
      content = `<h2>字幕</h2><button data-subtitle="-1">关闭字幕</button>${tracks.map((t, n) => `<button data-subtitle="${n}">${esc(t.label || t.language || '字幕 ' + (n + 1))}</button>`).join('')}${tracks.length ? '' : '<p>电视未返回字幕轨道。此版本暂不能提取片源内嵌的 ASS / PGS 字幕。</p>'}`;
    }
    if (kind === 'info') content = `<h2>播放信息</h2><p>${esc(S.playback.title)}<br>当前播放：${esc(S.playback.quality?.label || '原画')} · ${video.videoWidth || '—'} × ${video.videoHeight || '—'}${S.playback.kind === 'hls' ? ' · NAS 转码' : ''}</p><p>原文件：${esc(S.playback.technical?.container?.toUpperCase() || '')} · ${esc(S.playback.technical?.video_info?.codec?.toUpperCase() || '')}<br>${esc(S.playback.technical?.video_info?.resolution || '')} · ${esc(S.playback.technical?.video_info?.bitrate || '')}<br>${esc(S.detail.item.imageQuality || '')} · ${esc(S.detail.item.audioQuality || '')}</p>`;
    $('#player-dialog').innerHTML = `<section class="player-dialog">${content}<button id="close-dialog">返回</button></section>`;
    $('#close-dialog').onclick = dialogBack;
    root.querySelectorAll('[data-subdialog]').forEach(b => b.onclick = () => playerDialog(b.dataset.subdialog));
    root.querySelectorAll('[data-speed]').forEach(b => b.onclick = () => { video.playbackRate = Number(b.dataset.speed); closeDialog(); });
    root.querySelectorAll('[data-ratio]').forEach(b => b.onclick = () => { video.style.objectFit = b.dataset.ratio; closeDialog(); });
    root.querySelectorAll('[data-audio]').forEach(b => b.onclick = () => { Array.from(video.audioTracks).forEach((t, n) => t.enabled = n === Number(b.dataset.audio)); closeDialog(); });
    root.querySelectorAll('[data-subtitle]').forEach(b => b.onclick = () => { Array.from(video.textTracks).forEach((t, n) => t.mode = n === Number(b.dataset.subtitle) ? 'showing' : 'disabled'); closeDialog(); });
    root.querySelectorAll('[data-switch]').forEach(b => b.onclick = () => play(false, Number(b.dataset.switch)));
    focus(root.querySelector('.player-dialog button'));
  }
  function setup() {
    if (directAuth?.available && connectionMode === 'direct') { photoGallery.leave(); beginView('settings'); return directAuth.show(); }
    return setupLegacy();
  }
  function setupLegacy() {
    const epoch = beginView('settings');
    root.innerHTML = `<main class="screen setup"><h1>连接绿联 NAS</h1><p>${S.token ? '电视已配对。可更换服务地址或重新登录 NAS。' : '首次使用：输入 NAS 影视服务地址和配对码。'}</p><form class="form" id="pair-form"><label>影视服务地址<input id="server" placeholder="例如 http://192.168.1.100:8780" value="${esc(S.server)}" inputmode="url" autocomplete="url"></label><label>配对码<input id="pair-code" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="六位数字"></label><div class="message" id="setup-message"></div><div class="actions"><button class="action" type="submit">连接</button>${S.token ? '<button class="action secondary" type="button" id="setup-back">返回</button>' : ''}</div></form>${S.token ? '<button class="episode" id="nas-login">重新登录 NAS 账号</button>' : ''}</main>`;
    const form = $('#pair-form'), addressInput = $('#server'), codeInput = $('#pair-code'), message = $('#setup-message'), submit = form.querySelector('button[type="submit"]');
    form.onsubmit = async e => {
      e.preventDefault(); if (submit.disabled) return; submit.disabled = true;
      const address = addressInput.value.trim().replace(/\/$/, '');
      try {
        const url = new URL(address); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入正确的 http:// 或 https:// 地址');
        const data = await api('/api/pair', { code: codeInput.value.trim(), name: 'LG webOS TV' }, undefined, { server: url.origin, token: '' });
        if (epoch !== S.epoch || !form.isConnected) return;
        photoGallery.reset(); S.server = url.origin; S.token = data.token; store.set('server', S.server); store.set('token', S.token); home();
      } catch (err) { if (epoch === S.epoch && form.isConnected) message.textContent = err.message; }
      finally { submit.disabled = false; }
    };
    if ($('#setup-back')) $('#setup-back').onclick = home;
    if ($('#nas-login')) $('#nas-login').onclick = loginForm;
    if (directAuth?.available) {
      const switchMode = document.createElement('button'); switchMode.className = 'episode'; switchMode.textContent = '使用 UGREENlink 直接登录';
      switchMode.onclick = () => { connectionMode = 'direct'; store.set('connectionMode', 'direct'); directAuth.init().catch(err => toast(err.message)); };
      root.querySelector('main').appendChild(switchMode);
    }
    focus($('#server'));
  }
  function loginForm() {
    const epoch = beginView('settings');
    root.innerHTML = '<main class="setup"><h1>登录 NAS</h1><p>使用 NAS 本地账号</p><form class="form" id="login-form"><label>用户名<input id="nas-user" autocomplete="username"></label><label>密码<input id="nas-password" type="password" autocomplete="current-password"></label><div class="message" id="setup-message"></div><div class="actions"><button class="action">登录</button><button class="action secondary" type="button" id="login-back">返回</button></div></form></main>';
    const form = $('#login-form'), username = $('#nas-user'), password = $('#nas-password'), message = $('#setup-message'), submit = form.querySelector('button');
    $('#login-back').onclick = setup;
    form.onsubmit = async e => {
      e.preventDefault(); if (submit.disabled) return; submit.disabled = true;
      try { await api('/api/login', { username: username.value, password: password.value }); if (epoch === S.epoch && form.isConnected) { photoGallery.reset(); home(); } }
      catch (err) { if (epoch === S.epoch && form.isConnected) message.textContent = err.message; }
      finally { password.value = ''; submit.disabled = false; }
    }; focus(username);
  }
  function search() {
    beginView('search'); S.searchView = { query: '', items: null }; renderSearch(); focus($('#search'));
  }
  function renderSearch() {
    const epoch = S.epoch, state = S.searchView || { query: '', items: null };
    root.innerHTML = `${header('搜索')}${nav('search')}<main class="screen library-screen"><form id="search-form"><input class="search-box" id="search" value="${esc(state.query)}" placeholder="搜索 NAS 中的电影、电视剧" aria-label="搜索影片"><button class="action" style="margin-left:24px">搜索</button></form><div id="search-results" class="grid" style="margin-top:44px">${state.items === null ? '' : state.items.length ? state.items.map(i => card(i)).join('') : '<div class="empty">没有找到影片</div>'}</div></main>`;
    const form = $('#search-form'), input = $('#search'), results = $('#search-results');
    form.onsubmit = async e => {
      e.preventDefault(); const q = input.value.trim(); if (!q) return;
      S.searchAbort?.abort(); const controller = new AbortController(); S.searchAbort = controller;
      try {
        const data = await api('/api/search?q=' + encodeURIComponent(q), undefined, controller.signal);
        if (epoch !== S.epoch || S.searchAbort !== controller || !form.isConnected) return;
        S.searchView = { query: q, items: data.items };
        results.innerHTML = data.items.length ? data.items.map(i => card(i)).join('') : '<div class="empty">没有找到影片</div>'; bind(); focus(results.querySelector('button') || input);
      } catch (err) { if (epoch === S.epoch && S.searchAbort === controller && form.isConnected) toast(err.message); }
      finally { if (S.searchAbort === controller) S.searchAbort = null; }
    }; bind();
  }
  function renderFolders() {
    root.innerHTML = `${header('我的媒体库')}${nav('folders')}<main class="screen library-screen"><div class="shelf-row">${libraries()}</div></main>`; bind(); firstFocus();
  }
  function route(name, libraryId, title) {
    photoGallery.leave();
    S.exitConfirm = false; S.libraryId = libraryId || null; S.libraryTitle = title || null; S.busy = false;
    if (name === 'photos') { beginView('photos'); return photoGallery.open(); }
    if (name === 'home') return home(); if (name === 'settings') return setup(); if (name === 'search') return search();
    if (name === 'folders') { beginView('folders'); renderFolders(); return; }
    beginView(name); loadLibrary(true);
  }
  function bind() {
    bindHeaderScroll();
    if (S.route !== 'settings') refreshConnection();
    artwork.observe(root);
    imageObserver?.disconnect();
    if (window.IntersectionObserver) {
      imageObserver = new IntersectionObserver(entries => entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting) { target.loading = 'eager'; if (!target.getAttribute('src') && target.dataset.artSource) target.src = target.dataset.artSource; }
        else target.removeAttribute('src');
      }), { rootMargin: '180px' });
      root.querySelectorAll('.photo-grid img,.photo-albums img').forEach(img => { img.dataset.artSource ||= img.getAttribute('src') || ''; imageObserver.observe(img); });
    } else root.querySelectorAll('.photo-grid img[data-art-source],.photo-albums img[data-art-source]').forEach(img => { img.loading = 'lazy'; img.src = img.dataset.artSource; });
    root.querySelectorAll('select').forEach(select => { if (select.dataset.cinemaSelect) return; select.dataset.cinemaSelect = 'true'; select.addEventListener('mousedown', e => { e.preventDefault(); focus(select); openSelect(select); }); });
    root.querySelectorAll('[data-route]').forEach(b => b.onclick = () => route(b.dataset.route));
    root.querySelectorAll('[data-item]').forEach(b => b.onclick = () => openDetail(b.dataset.item, Number(b.dataset.type), Number(b.dataset.library)));
    root.querySelectorAll('[data-library-route]').forEach(b => b.onclick = () => route('library', b.dataset.libraryRoute, b.dataset.title));
    root.querySelectorAll('[data-hero]').forEach(b => b.onclick = () => { S.hero = Number(b.dataset.hero); renderHome(); });
  }
  function back() {
    if (S.selectPopup) { closeSelect(); return; }
    if (S.route === 'settings' && directAuth?.available && connectionMode === 'direct') { directAuth.back(); return; }
    if (S.route === 'photos') { photoGallery.back(); return; }
    if (S.route === 'player') { if (S.dialog && S.dialog !== 'error') dialogBack(); else stop(); return; }
    if (S.route === 'detail') { restoreView(); return; }
    if (S.route !== 'home') { home(); return; }
    const scroll = $('.screen'); if (scroll && scroll.scrollTop > 10) { scroll.scrollTop = 0; focus(root.querySelector('[data-primary]')); return; }
    if (!S.exitConfirm) { S.exitConfirm = true; toast('再按一次返回键退出'); setTimeout(() => S.exitConfirm = false, 2500); }
    else window.close();
  }
  function moveFocus(direction) {
    const scope = S.selectPopup?.element || (S.route === 'player' ? (S.dialog === 'error' ? $('#player-message') : S.dialog ? $('.player-dialog') : $('.player-ui')) : root);
    if (!scope) return;
    const all = Array.from(scope.querySelectorAll('button,input,select,[tabindex="0"]')).filter(el => !el.disabled && el.offsetParent !== null);
    let current = document.activeElement;
    if (!all.includes(current)) {
      current = all.includes(S.lastContentFocus) ? S.lastContentFocus : scope.querySelector('[data-primary]') || all.find(el => !el.closest('.nav')) || all[0];
      focus(current); return;
    }
    const inNav = current.closest('.nav');
    if (inNav) {
      const buttons = Array.from(inNav.querySelectorAll('button'));
      if (direction === 'left') return;
      if (direction === 'up' || direction === 'down') { focus(buttons[Math.max(0, Math.min(buttons.length - 1, buttons.indexOf(current) + (direction === 'up' ? -1 : 1)))]); return; }
      if (all.includes(S.lastContentFocus) && !S.lastContentFocus.closest('.nav')) { focus(S.lastContentFocus); return; }
    }
    const row = current.closest('.shelf-row');
    // Home has ordered content shelves. Geometry alone can prefer a hero
    // pagination dot or a distant row once the hero has scrolled off screen.
    const homeHero = S.route === 'home' && scope === root && root.querySelector('.hero [data-primary]');
    if (homeHero === current && direction === 'left') { focus(root.querySelector('.nav button.active')); return; }
    if (homeHero && !inNav && (direction === 'up' || direction === 'down')) {
      const rows = Array.from(root.querySelectorAll('.shelf-row')).filter(value => all.some(el => value.contains(el)));
      const index = rows.indexOf(row), inHero = current.closest('.hero');
      if (index >= 0 || inHero) {
        if (direction === 'up' && (index === 0 || inHero)) {
          focus(homeHero); const screen = homeHero.closest('.screen'); if (screen) screen.scrollTop = 0;
          return;
        }
        const target = rows[inHero ? 0 : index + (direction === 'up' ? -1 : 1)];
        if (target) {
          const a = current.getBoundingClientRect(), center = a.left + a.width / 2;
          const items = all.filter(el => target.contains(el));
          items.sort((a, b) => { const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect(); return Math.abs(ar.left + ar.width / 2 - center) - Math.abs(br.left + br.width / 2 - center); });
          focus(items[0]);
        }
        return;
      }
    }
    if (row && (direction === 'left' || direction === 'right')) {
      const items = Array.from(row.querySelectorAll('button')).filter(el => !el.disabled);
      const next = items[items.indexOf(current) + (direction === 'right' ? 1 : -1)];
      if (next) focus(next);
      else if (direction === 'left') focus(root.querySelector('.nav button.active'));
      return;
    }
    const a = current.getBoundingClientRect(); const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let winner, best = Infinity;
    for (const el of all) {
      if (el === current) continue;
      if (!inNav && el.closest('.nav')) continue;
      const b = el.getBoundingClientRect(); const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      const forward = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
      if (forward <= 2) continue;
      const side = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = forward + side * 3.2;
      if (score < best) { best = score; winner = el; }
    }
    if (!winner && direction === 'left' && !inNav && scope === root) winner = root.querySelector('.nav button.active');
    focus(winner);
  }
  document.addEventListener('keydown', e => {
    if (S.route === 'player' && playerOptions.key(e)) return;
    const code = e.keyCode; const input = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (code === 461 || (e.key === 'Escape') || (code === 8 && !input)) { e.preventDefault(); if (!e.repeat) back(); return; }
    if (S.route === 'photos' && photoGallery.key(e)) return;
    const direction = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' }[code];
    if (document.activeElement?.tagName === 'SELECT' && (code === 13 || e.code === 'Space')) { e.preventDefault(); openSelect(document.activeElement); return; }
    if (input && document.activeElement.tagName !== 'SELECT' && ![38, 40].includes(code)) return;
    if (direction && S.route !== 'player') {
      const now = performance.now();
      if (e.repeat && lastNavigationCode === code && now - lastNavigationAt < 75) { e.preventDefault(); e.stopPropagation(); return; }
      lastNavigationAt = now; lastNavigationCode = code;
    }
    if (S.route === 'player') {
      if (code === 415 || code === 19) { e.preventDefault(); setPaused(code === 19); return; }
      if ([179, 10252].includes(code) || e.code === 'Space') { e.preventDefault(); if (!e.repeat) togglePause(); return; }
      if (code === 413) { e.preventDefault(); stop(); return; }
      if ([412, 417].includes(code) && !S.dialog) { e.preventDefault(); seek(code === 417 ? 10 : -10); return; }
      if (!S.dialog) {
        const current = document.activeElement;
        if ((code === 37 || code === 39) && (!S.controls || current?.id === 'player-seek')) { e.preventDefault(); seek(code === 39 ? 10 : -10); return; }
        if ((code === 37 || code === 39) && current?.closest('.player-buttons')) { e.preventDefault(); showControls(); const buttons = Array.from($('.player-buttons').querySelectorAll('button')).filter(button => !button.disabled); focus(buttons[buttons.indexOf(current) + (code === 39 ? 1 : -1)] || current); return; }
        if (code === 13 && (!S.controls || current?.id === 'player-seek')) { e.preventDefault(); if (!e.repeat) togglePause(); focus($('#pause')); return; }
        if (direction && !S.controls) { e.preventDefault(); showControls(); focus(code === 38 ? $('#player-seek') : $('#pause')); return; }
        if (code === 38 && $('.player-buttons')?.contains(current)) { e.preventDefault(); showControls(); focus($('#player-seek')); return; }
        if (code === 40 && current?.id === 'player-seek') { e.preventDefault(); showControls(); focus($('#pause')); return; }
      }
      showControls();
    }
    if (direction) { e.preventDefault(); e.stopPropagation(); moveFocus(direction); }
  });
  document.addEventListener('mousemove', () => { if (S.route === 'player') showControls(); });
  root.addEventListener('focusin', () => { if (root.contains(document.activeElement) && !document.activeElement.closest('.nav')) { S.lastContentFocus = document.activeElement; artwork.prioritize(document.activeElement.querySelector('img[data-art-kind]')); } const hint = $('.player-hint'); if (hint) hint.textContent = document.activeElement?.id === 'player-seek' ? '左右快退 / 快进 10 秒 · 下键选择按钮 · 确定播放 / 暂停' : '左右选择按钮 · 上键调整进度 · 下键返回按钮'; });
  addEventListener('beforeunload', () => { connectionUnloaded = true;stopForegroundLease(true); cancelConnectionCheck(); clearHeaderScroll(); artwork.destroy(); });
  video.addEventListener('loadedmetadata', () => { if (S.route !== 'player') return; if (!movieMedia.switching()) { if (S.playback?.position > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(S.playback.position, Math.max(0, video.duration - 1)); updatePlayerInfo(); } updateProgress(); });
  video.addEventListener('timeupdate', () => {
    if (S.route !== 'player') return;
    const p = S.playback;
    if (p?.skips?.enabled && !movieMedia.switching() && !video.seeking) {
      const range = p.skips.ranges?.find(r => video.currentTime >= r.start && video.currentTime < r.end);
      if (range) { try { video.currentTime = Math.min(range.end, video.duration - .1); toast(range.type === 'op' ? '已跳过片头' : '已跳过片尾'); } catch {} }
    }
    updateProgress(); reportProgress();
  });
  video.addEventListener('pause', () => { if (S.route === 'player') { if ($('#pause')) $('#pause').textContent = '播放'; showControls(); reportProgress(true); } });
  video.addEventListener('play', () => { if ($('#pause')) $('#pause').textContent = '暂停'; });
  video.addEventListener('ended', async () => {
    const p = S.playback; if (S.route !== 'player' || !p || movieMedia.switching()) return;
    await reportProgress(true); if (S.playback !== p || S.route !== 'player') return;
    const index = S.detail.files.findIndex(f => f.index === p.fileIndex), next = playerOptions.nextIndex(index, S.detail.files.length);
    if (next !== null) play(true, S.detail.files[next].index); else { toast('播放结束'); showControls(); }
  });
  video.addEventListener('error', () => { if (S.route === 'player' && !movieMedia.switching()) playerError('电视无法播放这个片源。可能是音视频编码或封装格式不受支持。'); });
  document.addEventListener('visibilitychange', () => { if(document.hidden)stopForegroundLease(true);if (document.hidden) cancelConnectionCheck(); else refreshConnection(); if (document.hidden && S.route === 'player') { video.pause(); reportProgress(true); } });
  function resize() { const scale = Math.min(innerWidth / 1920, innerHeight / 1080); $('#stage').style.transform = `scale(${scale})`; $('#stage').style.left = ((innerWidth - 1920 * scale) / 2) + 'px'; $('#stage').style.top = ((innerHeight - 1080 * scale) / 2) + 'px'; }
  addEventListener('resize', resize); resize();
  directAuth = window.createDirectLogin({ root, esc, store, bind, focus,
    disconnected(){stopForegroundLease(true);cancelConnectionCheck(true);S.home=null;},
    connected(gateway, status) { stopForegroundLease(true);cancelConnectionCheck(true); photoGallery.reset(); artwork.clearAll(); connectionMode = 'direct'; S.server = gateway.server; S.token = gateway.token; S.home = null; home(); },
    bridgeMode() { stopForegroundLease(true); cancelConnectionCheck(true); connectionMode = 'bridge'; store.set('connectionMode', 'bridge'); S.server = store.get('server', location.protocol.startsWith('http') ? location.origin : ''); S.token = store.get('token'); setupLegacy(); },
    back: home,
  });
  if (directAuth.available && connectionMode !== 'bridge') {
    beginView('settings'); root.innerHTML = '<main class="setup"><h1>正在连接 UGREENlink</h1><p>请稍候…</p></main>';
    directAuth.init().catch(err => { toast(err.message); connectionMode = 'bridge'; setupLegacy(); });
  } else if (S.token) home(); else setup();
})();
