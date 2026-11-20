(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const root = $('#app'), video = $('#video');
  const artwork = window.createArtworkLoader();
  const store = {
    get(k, fallback = '') { try { return localStorage.getItem('cinema.' + k) || fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem('cinema.' + k, v); } catch {} },
  };
  const defaultFilters = () => ({ mediaType: 'all', style: '', country: '', year: '', clarity: '', watched: '-1' });
  const S = {
    server: store.get('server', location.protocol.startsWith('http') ? location.origin : ''),
    token: store.get('token'),
    route: 'home', home: null, hero: 0, list: [], page: 1, last: true, detail: null, playback: null,
    returnRoute: 'home', returnView: null, dialog: null, controls: true, busy: false, epoch: 0,
    exitConfirm: false, playGeneration: 0, playStarting: false, pendingResume: new Map(),
    filters: defaultFilters(), sortOrder: 'desc', filterOpen: false, filterOptions: null,
    historyManage: false, historyConfirmClear: false, detailSeason: null, detailEpRange: 0,
  };
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
  const labels = { home: '影视中心', movies: '电影', tv: '电视剧', favorites: '我的收藏', history: '最近播放', recent: '最近更新', folders: '媒体库', photos: '相册', settings: '设置', search: '搜索', library: '媒体库' };
  const genres = { 28: '动作', 12: '冒险', 16: '动画', 35: '喜剧', 80: '犯罪', 99: '纪录', 18: '剧情', 10751: '家庭', 14: '奇幻', 36: '历史', 27: '恐怖', 10402: '音乐', 9648: '悬疑', 10749: '爱情', 878: '科幻', 53: '惊悚', 10752: '战争', 10765: '科幻 / 奇幻', 10759: '动作 / 冒险' };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.movies}</svg>`;
  const bytes = value => value > 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value > 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value ? `${Math.ceil(value / 1024)} KB` : '';
  function formatDuration(sec) {
    const mins = Math.floor((Number(sec) || 0) / 60);
    if (!mins) return '';
    return mins >= 60 ? `${Math.floor(mins / 60)} 小时${mins % 60 ? ` ${mins % 60} 分钟` : ''}` : `${mins} 分钟`;
  }
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
  function clearAccountState() { S.pendingResume.clear(); S.filterOptions = null; S.home = null; S.returnView = null; S.list = []; photoGallery.reset(); artwork.clearAll(); }
  function sortStorageKey() { return S.route === 'movies' && !S.libraryId ? 'librarySort' : 'librarySort.' + (S.libraryId ? 'lib-' + S.libraryId : S.route); }
  function sortOrderKey() { return 'librarySortOrder.' + (S.libraryId ? 'lib-' + S.libraryId : S.route); }
  function activeFilterCount() {
    const f = S.filters || defaultFilters();
    return ['style', 'country', 'year', 'clarity'].filter(k => f[k]).length + (f.watched && f.watched !== '-1' ? 1 : 0);
  }
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
  function stopForegroundLease(hidden = false) { const lease = foregroundLease; foregroundLease = null; if (!lease) return; clearTimeout(lease.timer); if (hidden) api('/api/connection/visibility', { visible: false, scope: lease.scope, accountScope: lease.accountScope }, undefined, lease.connection).catch(() => {}); }
  function renewForegroundLease(status, home, connection) {
    if (!status.nativeEnabled || !home.connectionScope || status.visibilityScope !== home.connectionScope || status.accountScope !== home.accountScope || document.hidden || connectionMode !== 'direct') return;
    if (foregroundLease?.scope === status.visibilityScope && foregroundLease.home === home) return;
    stopForegroundLease(); const lease = { scope: status.visibilityScope, accountScope: home.accountScope, home, connection }; foregroundLease = lease;
    async function renew() {
      const stillValid = () => foregroundLease === lease && !document.hidden && !connectionUnloaded && connectionMode === 'direct' && S.server === connection.server && S.token === connection.token && S.home === home;
      if (!stillValid()) { if (foregroundLease === lease) stopForegroundLease(); return; }
      try { await api('/api/connection/visibility', { visible: true, scope: lease.scope, accountScope: lease.accountScope }, undefined, connection); if (foregroundLease === lease) refreshConnection(true); }
      catch { if (!stillValid()) { if (foregroundLease === lease) stopForegroundLease(); return; } }
      if (foregroundLease === lease && !document.hidden) lease.timer = setTimeout(renew, 30000);
    }
    renew();
  }
  let connectionCheck, connectionCheckedHome, connectionCheckedAt = 0, connectionUnloaded = false;
  function cancelConnectionCheck(reset = false) {
    const check = connectionCheck; connectionCheck = null;
    if (check) { clearTimeout(check.timer); clearTimeout(check.deadline); check.controller?.abort(); }
    if (reset) { connectionCheckedHome = null; connectionCheckedAt = 0; }
  }
  function refreshConnection(force = false) {
    if (connectionUnloaded || !window.PalmServiceBridge || connectionMode !== 'direct' || document.hidden || !S.home) return;
    if (connectionCheck && (connectionCheck.home !== S.home || connectionCheck.server !== S.server || connectionCheck.token !== S.token)) cancelConnectionCheck(true);
    if (connectionCheck) { if (force) connectionCheck.refreshAfter = true; return; }
    if (!force && connectionCheckedHome === S.home && Date.now() - connectionCheckedAt < 10000) return;
    const check = { home: S.home, server: S.server, token: S.token, started: Date.now() };
    connectionCheck = check; connectionCheckedHome = S.home; connectionCheckedAt = check.started;
    const current = () => connectionCheck === check && !document.hidden && !connectionUnloaded && connectionMode === 'direct' && check.home === S.home && check.server === S.server && check.token === S.token;
    const stop = () => { if (connectionCheck !== check) return; const refreshAfter = check.refreshAfter && current(); cancelConnectionCheck(); if (refreshAfter) refreshConnection(true); };
    check.deadline = setTimeout(stop, 12000);
    async function read() {
      if (!current()) { stop(); return; }
      check.controller = new AbortController();
      try {
        const status = await api('/api/connection?owner=' + encodeURIComponent(check.home.connectionScope || '') + '&accountScope=' + encodeURIComponent(check.home.accountScope || ''), undefined, check.controller.signal, { server: check.server, token: check.token });
        if (!current()) { stop(); return; }
        renewForegroundLease(status, check.home, { server: check.server, token: check.token });
        check.home.connection = status.mode === 'native-p2p' && status.verified === true && status.authenticated === true ? '原生P2P直连' : status.mode === 'lan-https' && status.verified === true ? '局域网直连' : 'UGREENlink 中继';
        const label = $('.header .connection');
        if (label) label.textContent = (check.home.name || '绿联 NAS') + ' · ' + check.home.connection;
        if (status.probing === true && Date.now() - check.started < 11000) check.timer = setTimeout(read, 1000);
        else stop();
      } catch { stop(); }
    }
    read();
  }
  function cancelPlayRequest() { S.playAbort?.abort(); S.playAbort = null; S.playStarting = false; S.playGeneration++; }
  function beginView(name) {
    if (name === 'settings') cancelConnectionCheck(true);
    clearInterval(heroTimer); clearHeaderScroll();
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
    element.onclick = e => { if (e.target === element) closeSelect(); };
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
    return { route: S.route, libraryId: S.libraryId, libraryTitle: S.libraryTitle, list: S.list, page: S.page, last: S.last, total: S.total, sort: S.sort, sortOrder: S.sortOrder, filters: { ...S.filters }, filterOpen: S.filterOpen, historyManage: S.historyManage, searchView: S.searchView, scrollTop: root.querySelector('.screen')?.scrollTop || 0, focusIndex: nodes.indexOf(document.activeElement), focusKey: document.activeElement?.dataset.focus };
  }
  function restoreView() {
    const view = S.returnView;
    if (!view) return home();
    beginView(view.route); photoGallery.leave();
    Object.assign(S, { libraryId: view.libraryId, libraryTitle: view.libraryTitle, list: view.list, page: view.page, last: view.last, total: view.total, sort: view.sort, sortOrder: view.sortOrder || 'desc', filters: view.filters || defaultFilters(), filterOpen: Boolean(view.filterOpen), historyManage: Boolean(view.historyManage), searchView: view.searchView, busy: false });
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
  function header(title) { return `<header class="header"><span class="app-brand"><img src="icon-cloudframe.png" alt=""><b>云映</b></span><h1>${esc(title)}</h1><span class="connection" id="header-connection" role="button" tabindex="-1">${esc(S.home?.name || '绿联 NAS')} · ${esc(S.home?.connection || (connectionMode === 'direct' ? 'UGREENlink' : '兼容服务'))}</span></header>`; }
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
    loadSubtitle: async (subtitleId, { signal, encoding } = {}) => {
      const p = S.playback; if (!p) throw new Error('播放已结束');
      return (await api('/api/play/subtitle', { id: p.id, subtitleId, format: 'vtt', encoding: encoding || 'auto' }, signal, p.connection)).body;
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
    detail.textContent = p.kind === 'hls' ? [pixels, conversionLabel(p)].filter(Boolean).join(' · ') : [pixels || S.detail?.item.clarity, p.tvCompatible ? '电视兼容' : p.technical?.video_info?.codec?.toUpperCase()].filter(Boolean).join(' · ');
    $('#player-quality')?.setAttribute('aria-label', '选择画质，当前为' + label.textContent);
  }
  function conversionLabel(playback) {
    if (playback.kind !== 'hls') return '';
    return playback.quality?.id === 'audio-compatible' ? '仅转换音轨' : 'NAS 转码';
  }
  function releasePlayback(p) { if (!p) return; (p.reportPromise || Promise.resolve()).finally(() => api('/api/play/close', { id: p.id }, undefined, p.connection)).catch(() => {}); }
  function resumeKey(id, scope = S.accountScope) { return (scope || S.server + '|' + S.token) + '|' + String(id); }
  async function initializePlaybackOptions(p, data) {
    if (S.playback !== p) return;
    playerOptions.hydrate(data);
    playerTracks.updateMetadata(data);
    await playerTracks.applyPreferences(data.preferences || {}, { metadata: data, isCurrent: () => S.playback === p });
  }
  async function applyRemoteTrackFallback(p, options, nasTracks) {
    if (S.playback !== p || !nasTracks || typeof nasTracks !== 'object') return;
    const local = playerTracks.preference?.() || {};
    const patch = {};
    if (!local.audio && Number.isInteger(nasTracks.audio?.index) && nasTracks.audio.index >= 0) {
      patch.audio = { index: nasTracks.audio.index, ...(nasTracks.audio.language ? { language: nasTracks.audio.language } : {}) };
    }
    if (!local.subtitle && nasTracks.subtitle && [0, 1, 2].includes(nasTracks.subtitle.type)) {
      if (nasTracks.subtitle.type === 0 && nasTracks.subtitle.index === -99) patch.subtitle = { selection: { kind: 'off' } };
      else if (nasTracks.subtitle.type === 1 && nasTracks.subtitle.index >= 0) patch.subtitle = { selection: { kind: 'native', index: nasTracks.subtitle.index, ...(nasTracks.subtitle.language ? { language: nasTracks.subtitle.language } : {}) } };
    }
    if (Object.keys(patch).length) await playerTracks.applyPreferences(patch, { metadata: options, isCurrent: () => S.playback === p }).catch(() => {});
  }
  async function fetchSkips(p) {
    if (S.playback !== p) return;
    const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (p.duration || 0);
    try {
      const data = await api('/api/play/skips?id=' + encodeURIComponent(p.id) + '&duration=' + encodeURIComponent(d), undefined, undefined, p.connection);
      if (S.playback === p) { p.skips = data; p.skipsDuration = d; if (playerOptions.active()) playerOptions.render(); updateSkipPrompt(p); }
    } catch {}
  }
  async function loadPlaybackOptions(p) {
    try {
      const [options, nasTracks] = await Promise.all([
        api('/api/play/options?id=' + encodeURIComponent(p.id), undefined, undefined, p.connection),
        api('/api/play/track-preferences?id=' + encodeURIComponent(p.id), undefined, undefined, p.connection).catch(() => null),
      ]);
      if (S.playback !== p) return;
      await applyRemoteTrackFallback(p, options, nasTracks);
      await recoverMovieAudio(p, options);
    } catch { /* Original playback remains available when metadata is unavailable. */ }
    fetchSkips(p);
  }
  async function recoverMovieAudio(p, options) {
    const isCurrent = () => S.playback === p && S.route === 'player' && p.kind === 'original' && !playerOptions.active();
    if (!(p.audioCompatibility || options?.audioCompatibility) || !isCurrent() || video.audioTracks?.length !== 0 || movieMedia.switching()) return;
    const quality = options?.qualities?.find(q => q.id === 'audio-compatible');
    if (!quality) return;
    toast('电视无法解码原音轨，正在准备兼容音轨…');
    try {
      const candidate = await api('/api/play/quality', { id: p.id, qualityId: quality.id, action: 'prepare' }, undefined, p.connection);
      await movieMedia.switchSource(candidate, {
        id: p.id, playback: p, isCurrent, verify: () => video.audioTracks?.length > 0,
      });
      if (S.playback === p && p.kind === 'hls') toast('已启用兼容音轨');
    } catch (error) {
      if (error.name !== 'AbortError' && isCurrent()) toast('兼容播放未准备好，可在画质菜单中重试');
    }
  }
  function nextPlayableIndex(files, currentIndex) {
    let mode = 'sort_list';
    try { mode = JSON.parse(store.get('player.preferences', '{}') || '{}').mode || 'sort_list'; } catch {}
    const next = playerOptions.nextIndex(currentIndex, files.length);
    if (next === null || mode === 'loop_single') return next;
    const curEp = files[currentIndex]?.episode;
    if (!curEp) return next;
    let idx = next;
    while (idx !== currentIndex && files[idx]?.episode === curEp) {
      const candidate = playerOptions.nextIndex(idx, files.length);
      if (candidate === null || candidate === idx) return null;
      idx = candidate;
      if (idx === next) break;
    }
    return files[idx]?.episode === curEp ? null : idx;
  }
  function meta(item) { return [item.score > 0 ? Number(item.score).toFixed(1) : '', item.releaseDate || item.year || '', (item.genres || []).map(g => genres[g] || g).filter(Boolean).slice(0, 3).join(' · '), formatDuration(item.duration)].filter(Boolean).map(esc).join('　/　'); }
  function card(item, wide = false) {
    const attributes = `data-item="${esc(item.id)}" data-type="${esc(item.type)}" data-library="${esc(item.libraryId)}" data-focus="${esc('item-' + item.id)}"`;
    if (wide) {
      const sub = item.episode ? `第 ${item.episode} 集 · ${time(item.position)}` : item.position > 0 ? `已看至 ${time(item.position)}` : '';
      return `<button class="movie continue" ${attributes}><div class="art">${image(item.cover || item.backdrop || item.poster, '', item.name, 'cover')}<span class="progress"><i style="width:${(item.progress || 0) * 100}%"></i></span></div><span class="name">${esc(item.name)}</span>${sub ? `<span class="year">${esc(sub)}</span>` : ''}</button>`;
    }
    return `<button class="movie" ${attributes}>${image(item.poster || item.backdrop, '', item.name)}${item.clarity ? `<span class="quality">${esc(item.clarity)}</span>` : ''}${item.score > 0 ? `<span class="score">${Number(item.score).toFixed(1)}</span>` : ''}${item.watched ? '<span class="watched-tag">已看</span>' : ''}<span class="name">${esc(item.name)}</span><span class="year">${esc(item.year || '')}</span></button>`;
  }
  function shelf(title, items, wide = false, routeName) { if (!items?.length) return ''; return `<section class="shelf"><h2>${esc(title)}</h2><div class="shelf-row">${items.map(i => card(i, wide)).join('')}${routeName ? `<button class="library-shortcut" data-route="${esc(routeName)}">查看全部</button>` : ''}</div></section>`; }
  function libraries() { return (S.home?.libraries || []).map(l => `<button class="library-shortcut" data-library-route="${esc(l.media_lib_set_id)}" data-title="${esc(l.media_name)}">${icon(String(l.media_name || '').includes('剧') ? 'tv' : 'movies')}${esc(l.media_name)}<small>${esc(l.video_count)} 部</small></button>`).join(''); }
  function scheduleHeroRotation() {
    clearInterval(heroTimer);
    if (S.route !== 'home' || !S.home?.hero?.length || S.home.hero.length <= 1) return;
    heroTimer = setInterval(() => {
      if (S.route !== 'home' || document.hidden || S.selectPopup || $('.nav:focus-within,.nav:hover') || ($('.screen')?.scrollTop || 0) > 10 || document.activeElement?.closest('.dots')) return;
      S.hero = (S.hero + 1) % S.home.hero.length;
      renderHome(true);
    }, 8000);
  }
  function renderHome(preserve = false) {
    const key = preserve ? document.activeElement?.dataset.focus : null;
    const homeData = S.home; const hero = homeData.hero[S.hero % Math.max(1, homeData.hero.length)];
    root.innerHTML = `<main class="screen">${hero ? image(hero.backdrop, 'backdrop') + '<div class="shade"></div>' : ''}${header('影视中心')}${nav('home')}<section class="hero"><div class="hero-copy">${hero ? `<h2>${esc(hero.name)}</h2><p class="meta">${meta(hero)}</p><p class="overview">${esc(hero.overview)}</p><button class="action" data-primary data-focus="hero" data-item="${esc(hero.id)}" data-type="${esc(hero.type)}" data-library="${esc(hero.libraryId)}">查看详情</button>` : '<h2>影视中心</h2><p class="meta">选择媒体库，开始观看</p>'}</div><div class="dots">${homeData.hero.slice(0, 8).map((_, i) => `<button class="dot ${i === S.hero ? 'selected' : ''}" data-hero="${i}" aria-label="第 ${i + 1} 张海报"></button>`).join('')}</div></section>${shelf('最近播放', homeData.recent, true, 'history')}${homeData.libraries.length ? `<section class="shelf"><h2>我的媒体库</h2><div class="shelf-row">${libraries()}</div></section>` : ''}${shelf('最近更新', homeData.updates, false, 'recent')}${shelf('我的收藏', homeData.favorites, false, 'favorites')}</main>`;
    bind(); scheduleHeroRotation();
    if (key) focus(root.querySelector(`[data-focus="${CSS.escape(key)}"]`)); else firstFocus();
  }
  async function home() {
    photoGallery.leave();
    const epoch = beginView('home'); S.dialog = null; loading();
    try { const data = await api('/api/home'); if (epoch !== S.epoch) return; const scope = data.accountScope || S.server + '|' + S.token; if (S.accountScope && S.accountScope !== scope) { clearAccountState(); } S.home = data; S.accountScope = scope; S.hero = 0; renderHome(); }
    catch (err) { if (epoch === S.epoch) errorScreen(err); }
  }
  function loading() { clearHeaderScroll(); artwork.clearView(); imageObserver?.disconnect(); imageObserver = null; root.innerHTML = '<div class="loading"><span class="spinner"></span>正在连接影视中心…</div>'; }
  function errorScreen(error, retry = home) { root.innerHTML = `<div class="error-screen"><h1>暂时无法连接</h1><p>${esc(error.message)}</p><div class="actions"><button class="action" data-primary id="retry">重试</button><button class="action secondary" data-route="settings">连接设置</button></div></div>`; $('#retry').onclick = retry; bind(); firstFocus(); }
  function renderFilterPanel() {
    if (!S.filterOpen) return '';
    const f = S.filters, opts = S.filterOptions;
    if (!opts) return '<section class="filter-panel"><span>正在加载筛选项…</span><button class="toolbar-btn" id="filter-reset">重置筛选</button></section>';
    const sel = (id, label, list, val, keyName = 'id') => `<label class="filter-field">${esc(label)}<select id="${id}" aria-label="${esc(label)}"><option value="">全部</option>${(list || []).map(o => `<option value="${esc(String(o[keyName] ?? o))}" ${String(val) === String(o[keyName] ?? o) ? 'selected' : ''}>${esc(o.name ?? o)}</option>`).join('')}</select></label>`;
    return `<section class="filter-panel">${sel('filter-style', '流派', opts.styles, f.style)}${sel('filter-country', '地区', opts.countries, f.country)}${sel('filter-year', '年份', (opts.years || []).map(y => ({ id: y.id, name: y.label })), f.year)}${sel('filter-clarity', '清晰度', (opts.clarities || []).map(c => typeof c === 'object' && c ? c : { id: c, name: c }), f.clarity)}<label class="filter-field">状态<select id="filter-watched" aria-label="观看状态"><option value="-1" ${f.watched === '-1' ? 'selected' : ''}>全部</option><option value="0" ${f.watched === '0' ? 'selected' : ''}>未看</option><option value="2" ${f.watched === '2' ? 'selected' : ''}>已看</option></select></label><button class="toolbar-btn" id="filter-reset">重置筛选</button></section>`;
  }
  function renderLibrary() {
    const title = S.libraryTitle || labels[S.route] || '全部影片';
    const filterable = ['movies', 'tv', 'library', 'favorites', 'recent'].includes(S.route);
    const inViewTypeTabs = ['library', 'favorites', 'recent'].includes(S.route);
    const navActive = S.route === 'library' ? 'folders' : S.route === 'recent' ? 'home' : S.route;
    const fCount = activeFilterCount();
    let leftTabs = '';
      if (S.route === 'movies' || S.route === 'tv') {
      leftTabs = `<button data-route="movies" class="${S.route === 'movies' ? 'selected' : ''}">电影</button><button data-route="tv" class="${S.route === 'tv' ? 'selected' : ''}">电视剧</button>`;
    } else if (inViewTypeTabs) {
      leftTabs = [['all', '全部'], ['movies', '电影'], ['tv', '电视剧']].map(([val, text]) => `<button data-media-type="${val}" class="${(S.filters.mediaType || 'all') === val ? 'selected' : ''}">${text}</button>`).join('');
    } else if (S.route === 'history' && S.list.length) {
      leftTabs = `<button id="history-manage" class="toolbar-btn ${S.historyManage ? 'selected' : ''}">${S.historyManage ? '完成管理' : '管理记录'}</button><button id="history-clear" class="toolbar-btn">${S.historyConfirmClear ? '确认清空记录' : '清空记录'}</button>`;
    }
    const rightControls = filterable
      ? `<div class="toolbar-meta"><span>${S.total || 0} 部</span><button id="filter-toggle" class="toolbar-btn ${fCount ? 'selected' : ''}" aria-expanded="${S.filterOpen}">筛选${fCount ? ' · ' + fCount : ''}</button><select id="sort" aria-label="排序"><option value="2">按添加时间 ↓</option><option value="1">按名称 A–Z</option><option value="3">按上映时间 ↓</option><option value="4">按评分 ↓</option></select><button id="sort-order" class="toolbar-btn" aria-label="排序方向">${S.sortOrder === 'asc' ? '↑ 升序' : '↓ 降序'}</button></div>`
      : `<div class="toolbar-meta"><span>${S.total || 0} 部</span></div>`;
    const gridHtml = S.route === 'history' && S.historyManage
      ? S.list.map(i => `<div class="history-card">${card(i, true)}<button class="history-delete" data-history-delete="${esc(i.recentlyPlayedId || i.id)}">移除此记录</button></div>`).join('')
      : S.list.map(i => card(i, S.route === 'history')).join('');
    root.innerHTML = `${header(title)}${nav(navActive)}<main class="screen library-screen"><div class="toolbar">${leftTabs}${rightControls}</div>${renderFilterPanel()}<div class="grid ${S.route === 'history' ? 'history-grid' : ''}">${gridHtml}</div>${!S.list.length ? '<div class="empty">暂无影片</div>' : ''}${S.last ? '' : '<div class="more-row"><button class="action secondary" id="load-more">加载更多</button></div>'}</main>`;
    bindLibraryHandlers();
    bind();
  }
  function bindLibraryHandlers() {
    const sort = $('#sort');
    if (sort) {
      sort.value = S.sort || '2';
      sort.onchange = () => { S.sort = sort.value; store.set(sortStorageKey(), S.sort); loadLibrary(true); };
    }
    if ($('#sort-order')) $('#sort-order').onclick = () => { S.sortOrder = S.sortOrder === 'asc' ? 'desc' : 'asc'; store.set(sortOrderKey(), S.sortOrder); loadLibrary(true); };
    if ($('#filter-toggle')) {
      $('#filter-toggle').onclick = async () => {
        S.filterOpen = !S.filterOpen; renderLibrary(); focus($('#filter-style') || $('#filter-toggle'));
        if (S.filterOpen && !S.filterOptions) {
          try {
            const opts = await api('/api/filters' + (S.libraryId ? '?id=' + encodeURIComponent(S.libraryId) : ''));
            if (S.filterOpen) { S.filterOptions = opts; renderLibrary(); focus($('#filter-style') || $('#filter-toggle')); }
          } catch {}
        }
      };
    }
    for (const [id, key] of [['filter-style', 'style'], ['filter-country', 'country'], ['filter-year', 'year'], ['filter-clarity', 'clarity'], ['filter-watched', 'watched']]) {
      const el = $('#' + id);
      if (el) { el.value = S.filters[key] || (key === 'watched' ? '-1' : ''); el.onchange = () => { S.filters[key] = el.value; loadLibrary(true); }; }
    }
    if ($('#filter-reset')) $('#filter-reset').onclick = () => { S.filters = { ...defaultFilters(), mediaType: S.filters.mediaType }; S.filterOpen = false; loadLibrary(true); };
    root.querySelectorAll('[data-media-type]').forEach(b => b.onclick = () => { S.filters.mediaType = b.dataset.mediaType; loadLibrary(true); });
    if ($('#history-manage')) $('#history-manage').onclick = () => { S.historyManage = !S.historyManage; S.historyConfirmClear = false; renderLibrary(); focus($('#history-manage')); };
    if ($('#history-clear')) $('#history-clear').onclick = async () => {
      if (!S.historyConfirmClear) { S.historyConfirmClear = true; renderLibrary(); focus($('#history-clear')); toast('再次点击确认清空全部播放记录'); return; }
      try {
        await api('/api/history/delete', { all: true, clearAll: true });
        S.list = []; S.total = 0; S.last = true; S.historyManage = false; S.historyConfirmClear = false;
        if (S.home) S.home.recent = [];
        renderLibrary(); toast('已清空最近播放记录');
      } catch (err) { S.historyConfirmClear = false; renderLibrary(); toast(err.message); }
    };
    root.querySelectorAll('[data-history-delete]').forEach(b => b.onclick = async () => {
      const delId = b.dataset.historyDelete;
      const target = S.list.find(item => String(item.recentlyPlayedId || item.id) === delId);
      try {
        await api('/api/history/delete', { id: target?.id || delId, ...(target?.recentlyPlayedId ? { recentlyPlayedId: target.recentlyPlayedId } : {}) });
        S.list = S.list.filter(item => String(item.recentlyPlayedId || item.id) !== delId);
        S.total = Math.max(0, (S.total || 0) - 1);
        if (S.home?.recent) S.home.recent = S.home.recent.filter(item => String(item.recentlyPlayedId || item.id) !== delId);
        renderLibrary(); focus(root.querySelector('[data-history-delete]') || $('#history-manage') || $('.nav button.active')); toast('已移除该条播放记录');
      } catch (err) { toast(err.message); }
    });
    if ($('#load-more')) $('#load-more').onclick = () => loadLibrary(false, true);
    const screen = $('.library-screen');
    if (screen && !S.last) {
      screen.addEventListener('scroll', () => {
        if (S.busy || S.last || screen.scrollTop <= 100) return;
        if (screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 280) loadLibrary(false, false);
      }, { passive: true });
    }
  }
  async function loadLibrary(reset, focusAppend = true) {
    if (S.busy && !reset) return;
    if (reset) S.libraryAbort?.abort();
    S.busy = true;
    const owner = {}, controller = new AbortController(); S.libraryLoad = owner; S.libraryAbort = controller;
    const epoch = ++S.epoch, oldCount = reset ? 0 : S.list.length;
    if (reset) { S.list = []; S.page = 1; loading(); }
    try {
      const f = S.filters || defaultFilters();
      const query = new URLSearchParams({ kind: S.route, page: S.page, sort: S.sort || '2', order: S.sortOrder === 'asc' ? '1' : '2' });
      if (S.libraryId) query.set('id', S.libraryId);
      if (f.mediaType && f.mediaType !== 'all' && f.mediaType !== '0') query.set('mediaType', f.mediaType);
      if (f.style) query.set('style', f.style);
      if (f.country) query.set('country', f.country);
      if (f.year) query.set('year', f.year);
      if (f.clarity) query.set('clarity', f.clarity);
      if (f.watched && f.watched !== '-1') query.set('watched', f.watched);
      const data = await api('/api/library?' + query, undefined, controller.signal); if (epoch !== S.epoch) return;
      const seen = new Set();
      S.list = (reset ? data.items : S.list.concat(data.items)).filter(value => { const key = JSON.stringify([String(value.type ?? ''), String(value.libraryId ?? ''), String(value.id)]); if (seen.has(key)) return false; seen.add(key); return true; });
      S.last = data.last || data.items.length === 0; S.total = data.total; S.page++;
      const existingGrid = !reset && !S.historyManage && $('.library-screen .grid');
      if (existingGrid) {
        const added = S.list.slice(oldCount);
        if (added.length) {
          existingGrid.insertAdjacentHTML('beforeend', added.map(i => card(i, S.route === 'history')).join(''));
          const metaSpan = $('.toolbar-meta > span'); if (metaSpan) metaSpan.textContent = `${S.total || 0} 部`;
        }
        if (S.last) $('.more-row')?.remove();
        bind();
        if (focusAppend) focus(root.querySelectorAll('.grid .movie')[oldCount] || root.querySelector('#load-more') || root.querySelector('button'));
      } else {
        renderLibrary();
        focus(root.querySelectorAll('.grid .movie')[oldCount] || root.querySelector('#load-more') || root.querySelector('button'));
      }
    } catch (err) { if (epoch === S.epoch) { if (reset) errorScreen(err, () => loadLibrary(true)); else { renderLibrary(); focus($('#load-more')); toast(err.message); } } }
    finally { if (S.libraryLoad === owner) { S.busy = false; S.libraryAbort = null; } }
  }
  async function openDetail(id, type, library, preserveRoute = false) {
    if (!preserveRoute) { S.returnRoute = S.route; S.returnView = captureView(); }
    const epoch = beginView('detail'); loading();
    const key = resumeKey(id), pendingAtStart = S.pendingResume.get(key);
    try {
      const q = new URLSearchParams({ id: String(id), type: String(type), library: String(library) });
      const data = await api('/api/detail?' + q); if (epoch !== S.epoch) return;
      const pending = S.pendingResume.get(key) || pendingAtStart;
      if (pending) { data.item.position = pending.position; data.resumeFileIndex = pending.fileIndex; }
      S.detail = data;
      const resumeFile = data.files.find(f => f.index === data.resumeFileIndex) || data.files[0];
      S.detailSeason = resumeFile?.season || 1;
      const seasonFiles = data.files.filter(f => (f.season || 1) === S.detailSeason);
      const posInSeason = Math.max(0, seasonFiles.indexOf(resumeFile));
      S.detailEpRange = Math.floor(posInSeason / 30);
      renderDetail();
    } catch (err) { if (epoch === S.epoch) errorScreen(err, () => openDetail(id, type, library, true)); }
  }
  function renderDetail(preserveFocus = false) {
    const focusKey = preserveFocus ? document.activeElement?.id || document.activeElement?.dataset.season || document.activeElement?.dataset.epRange : null;
    const { item: i, files, directors: apiDirectors = [], writers: apiWriters = [], actors = [], releaseDateText = '', countries: apiCountries = [], technical } = S.detail;
    const seasons = [...new Set(files.map(f => f.season || 1))].sort((a, b) => a - b);
    const activeSeason = seasons.includes(S.detailSeason) ? S.detailSeason : seasons[0];
    const seasonFiles = seasons.length > 1 ? files.filter(f => (f.season || 1) === activeSeason) : files;
    const rangeCount = Math.ceil(seasonFiles.length / 30);
    const activeRange = Math.min(Math.max(0, S.detailEpRange || 0), Math.max(0, rangeCount - 1));
    const visibleFiles = seasonFiles.slice(activeRange * 30, (activeRange + 1) * 30);
    const directors = (apiDirectors.length ? apiDirectors : actors.filter(a => a.role === '导演')).map(a => a.name).filter(Boolean);
    const writers = (apiWriters.length ? apiWriters : actors.filter(a => a.role === '编剧')).map(a => a.name).filter(Boolean);
    const cast = apiDirectors.length || apiWriters.length ? actors.filter(a => a.name) : actors.filter(a => a.name && a.role !== '导演' && a.role !== '编剧');
    const detailCountries = apiCountries.length ? apiCountries : (i.countries || []);
    const detailMeta = [i.score > 0 ? Number(i.score).toFixed(1) : '', releaseDateText || i.year || '', (i.genres || []).map(g => genres[g] || g).filter(Boolean).slice(0, 3).join(' · '), formatDuration(i.duration), detailCountries.slice(0, 3).join(' · ')].filter(Boolean).map(esc).join('　/　');
    const techParts = [technical?.file_name || files[S.detail.resumeFileIndex || 0]?.fileName || technical?.path?.split('/').pop(), bytes(technical?.size), technical?.container?.toUpperCase(), technical?.video_info?.resolution, technical?.video_info?.codec?.toUpperCase(), technical?.video_info?.hdr, technical?.video_info?.framerate, technical?.video_info?.bitrate].filter(Boolean);
    root.innerHTML = `<main class="screen detail-screen">${image(i.backdrop, 'backdrop')}<div class="shade"></div><button class="back" id="back">${icon('back')}返回</button><div class="detail-copy"><h2>${esc(i.name)}</h2><p class="meta">${detailMeta}</p><p class="overview">${esc(i.overview)}</p><p class="meta">${[i.clarity, technical?.video_info?.codec?.toUpperCase(), i.imageQuality, i.audioQuality].filter(Boolean).map(esc).join(' · ')}</p><div class="actions"><button class="action" data-primary id="play">${i.position > 0 ? '继续播放 ' + time(i.position) : '立即播放'}</button>${i.position > 0 ? '<button class="action secondary" id="restart">从头播放</button>' : ''}<button class="action secondary" id="favorite">${i.favorite ? '已收藏' : '收藏'}</button><button class="action secondary" id="watched-toggle">${i.watched ? '已看 ✓' : '标记已看'}</button></div></div>${files.length > 1 ? `<section class="details-section"><h3>${i.type === 2 ? '选集' : '播放版本'}</h3>${seasons.length > 1 ? `<div class="season-tabs">${seasons.map(s => `<button data-season="${s}" class="${s === activeSeason ? 'selected' : ''}">第 ${s} 季</button>`).join('')}</div>` : ''}${rangeCount > 1 ? `<div class="range-tabs">${Array.from({ length: rangeCount }, (_, r) => `<button data-ep-range="${r}" class="${r === activeRange ? 'selected' : ''}">${r * 30 + 1}–${Math.min((r + 1) * 30, seasonFiles.length)}</button>`).join('')}</div>` : ''}<div class="episodes">${visibleFiles.map(f => `<button class="episode ${f.index === S.detail.resumeFileIndex ? 'active' : ''}" data-file="${f.index}">${esc(f.episode ? '第 ' + f.episode + ' 集' : f.name)}${f.multiVersion && f.versionLabel ? `<small>${esc(f.versionLabel)}</small>` : ''}${f.index === S.detail.resumeFileIndex ? '<small>✓</small>' : ''}</button>`).join('')}</div></section>` : ''}${directors.length || writers.length || cast.length ? `<section class="details-section"><h3>演职人员</h3>${directors.length || writers.length ? `<div class="credit-groups">${directors.length ? `<div class="credit-row"><b>导演</b><span>${esc(directors.join(' / '))}</span></div>` : ''}${writers.length ? `<div class="credit-row"><b>编剧</b><span>${esc(writers.join(' / '))}</span></div>` : ''}</div>` : ''}${cast.length ? `<div class="actor-list">${cast.map(a => `<div>${esc(a.name)}<small>${esc(a.role || '')}</small></div>`).join('')}</div>` : ''}</section>` : ''}${technical ? `<section class="details-section"><h3>影片信息</h3><div class="technical">${esc(techParts.join(' · '))}${technical.audio_info?.length ? '<br>' + technical.audio_info.map(a => `${esc(a.language || '未知语言')} · ${esc(a.codec)} · ${esc(a.channels)} 声道`).join('<br>') : ''}</div></section>` : ''}</main>`;
    artwork.observe(root);
    $('#back').onclick = back; $('#play').onclick = () => play(); if ($('#restart')) $('#restart').onclick = () => play(true);
    const favoriteButton = $('#favorite'); favoriteButton.onclick = async () => {
      if (favoriteButton.disabled) return; favoriteButton.disabled = true;
      const connection = { server: S.server, token: S.token }, scope = S.accountScope, epoch = S.epoch, selected = !i.favorite;
      const sameAccount = () => S.server === connection.server && S.token === connection.token && S.accountScope === scope;
      const sameItem = value => value.id === i.id && value.type === i.type && value.libraryId === i.libraryId;
      try {
        await api('/api/favorite', { id: i.id, type: i.type, library: i.libraryId, favorite: selected }, undefined, connection);
        if (!sameAccount()) return;
        i.favorite = selected;
        if (S.home) { const list = S.home.favorites || []; S.home.favorites = selected ? list.some(sameItem) ? list : [{ ...i }, ...list] : list.filter(value => !sameItem(value)); }
        if (S.returnView?.route === 'favorites' && !selected) { const count = S.returnView.list.length; S.returnView.list = S.returnView.list.filter(value => !sameItem(value)); S.returnView.total = Math.max(0, S.returnView.total - (count - S.returnView.list.length)); }
        if (epoch === S.epoch && favoriteButton.isConnected) { favoriteButton.textContent = selected ? '已收藏' : '收藏'; toast(selected ? '已收藏' : '已取消收藏'); }
        else if (S.route === 'home' || S.route === 'favorites') {
          const view = captureView(), navRoute = document.activeElement?.closest('.nav') ? document.activeElement.dataset.route : null;
          if (S.route === 'home') renderHome(true);
          else { const count = S.list.length; if (!selected) S.list = S.list.filter(value => !sameItem(value)); S.total = Math.max(0, S.total - (count - S.list.length)); renderLibrary(); }
          if (navRoute) focus(root.querySelector(`.nav [data-route="${CSS.escape(navRoute)}"]`));
          else if (view.focusKey) focus(root.querySelector(`[data-focus="${CSS.escape(view.focusKey)}"]`) || root.querySelector('button'));
          const screen = root.querySelector('.screen'); if (screen) screen.scrollTop = view.scrollTop;
        }
      } catch (err) { if (sameAccount() && epoch === S.epoch) toast(err.message); }
      finally { favoriteButton.disabled = false; }
    };
    const watchedBtn = $('#watched-toggle'); watchedBtn.onclick = async () => {
      if (watchedBtn.disabled) return; watchedBtn.disabled = true;
      const watched = !i.watched, epoch = S.epoch;
      try {
        await api('/api/watched', { id: i.id, type: i.type, library: i.libraryId, watched });
        if (epoch !== S.epoch) return;
        i.watched = watched;
        watchedBtn.textContent = watched ? '已看 ✓' : '标记已看';
        toast(watched ? '已标记为已看' : '已标记为未看');
      } catch (err) { if (epoch === S.epoch) toast(err.message); }
      finally { watchedBtn.disabled = false; }
    };
    root.querySelectorAll('[data-season]').forEach(b => b.onclick = () => { S.detailSeason = Number(b.dataset.season); S.detailEpRange = 0; renderDetail(); focus(root.querySelector(`[data-season="${S.detailSeason}"]`)); });
    root.querySelectorAll('[data-ep-range]').forEach(b => b.onclick = () => { S.detailEpRange = Number(b.dataset.epRange); renderDetail(); focus(root.querySelector(`[data-ep-range="${S.detailEpRange}"]`)); });
    root.querySelectorAll('[data-file]').forEach(b => b.onclick = () => play(false, Number(b.dataset.file)));
    if (preserveFocus && focusKey) focus(root.querySelector('#' + focusKey) || root.querySelector('[data-primary]'));
    else firstFocus();
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
      S.playback = { ...data, accountScope: data.accountScope || scope, itemId: i.id, fileIndex: data.fileIndex ?? selected, connection, skippedRanges: new Set(), dismissedSkips: new Set() };
      S.route = 'player'; S.dialog = null; S.controls = true;
      playerTracks.setSource(data.preferenceScope || 'play:' + data.id);
      video.style.objectFit = ''; video.playbackRate = 1; video.muted = false;
      document.body.classList.add('playing'); video.src = asset(data.stream); video.load(); renderPlayer();
      loadPlaybackOptions(S.playback);
      await video.play();
      if (generation === S.playGeneration && S.route === 'player') showControls();
    } catch (err) { if (generation === S.playGeneration && epoch === S.epoch && err.name !== 'AbortError') { toast(err.message); if (S.route === 'player') playerError(err.message); } }
    finally { if (generation === S.playGeneration) { S.playStarting = false; S.playAbort = null; } }
  }
  function updateSkipPrompt(p = S.playback) {
    const btn = $('#skip-prompt');
    if (!btn || S.route !== 'player' || !p?.skips?.ranges?.length || p.skips.enabled || movieMedia.switching()) { btn?.classList.add('hidden'); return; }
    const range = p.skips.ranges.find(r => video.currentTime >= r.start && video.currentTime < r.end - 1 && !p.dismissedSkips?.has(`${r.type}:${r.start}:${r.end}`));
    if (!range) { btn.classList.add('hidden'); return; }
    btn.textContent = range.type === 'op' ? '跳过片头' : '跳过片尾';
    btn.classList.remove('hidden');
    btn.onclick = () => {
      try { video.currentTime = Math.min(range.end, Number.isFinite(video.duration) && video.duration > 0 ? video.duration - .1 : range.end); p.dismissedSkips.add(`${range.type}:${range.start}:${range.end}`); btn.classList.add('hidden'); } catch {}
    };
  }
  function setBuffering(visible) {
    $('#player-buffering')?.classList.toggle('hidden', !visible);
  }
  function renderPlayer() {
    clearHeaderScroll();
    artwork.clearView();
    const isSeries = S.detail?.item?.type === 2 && S.detail.files.length > 1;
    const hasFiles = (S.detail?.files?.length || 0) > 1;
    root.innerHTML = `<div class="player-ui ${S.controls ? '' : 'hidden'}"><div class="player-top"><button class="back" style="position:static" id="stop-player" aria-label="返回">${icon('back')}</button><span>${esc(S.playback.title)}</span></div><div class="player-bottom"><div class="player-time"><b id="elapsed">${time(video.currentTime)}</b><span>/ <b id="duration">${time(video.duration || S.playback.duration)}</b></span></div><div class="seek" id="player-seek" tabindex="0" role="slider" aria-label="播放进度" aria-valuemin="0" aria-valuemax="${S.playback.duration || 0}" aria-valuenow="0"><i id="seek-progress"></i><span id="seek-hover">00:00:00</span></div><div class="player-buttons"><button id="pause" data-primary>${video.paused ? '播放' : '暂停'}</button>${isSeries ? '<button id="player-next">下一集</button>' : ''}<button id="episode-list" ${hasFiles ? '' : 'hidden'}>列表</button><button id="player-settings">设置</button><button id="player-info">信息</button><button type="button" id="player-quality" class="info player-quality" aria-haspopup="dialog" aria-controls="player-dialog" aria-expanded="false"><span id="player-quality-label">原画</span><span id="player-quality-detail"></span><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div><p class="player-hint">左右选择按钮 · 上键调整进度 · 下键返回按钮</p></div></div><div id="player-buffering" class="player-buffering hidden"><span class="spinner"></span>正在缓冲…</div><button id="skip-prompt" class="skip-prompt hidden" type="button"></button><div id="player-dialog"></div><div id="player-message"></div>`;
    $('.player-ui').onclick = e => {
      if (e.target.classList.contains('player-ui')) {
        if (S.dialog) closeDialog();
        else if (S.controls) { clearTimeout(controlsTimer); S.controls = false; $('.player-ui')?.classList.add('hidden'); }
        else showControls();
      }
    };
    const seekBar = $('#player-seek'), seekHover = $('#seek-hover');
    seekBar.onmousemove = e => {
      const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (S.playback?.duration || 0);
      if (!total) return;
      const rect = seekBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      seekHover.style.left = (ratio * 100) + '%';
      seekHover.textContent = time(ratio * total);
    };
    seekBar.onclick = e => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) { toast('影片尚未准备好'); return; }
      const rect = seekBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      try { video.currentTime = Math.min(Math.max(0, video.duration - .1), ratio * video.duration); updateProgress(); } catch { toast('此片源暂时无法跳转'); }
      showControls();
    };
    if ($('#player-next')) $('#player-next').onclick = () => {
      const idx = S.detail.files.findIndex(f => f.index === S.playback.fileIndex);
      const next = nextPlayableIndex(S.detail.files, Math.max(0, idx));
      if (next !== null) play(true, S.detail.files[next].index);
      else toast('已是最后一集');
    };
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
  function playerError(message) {
    setBuffering(false); $('#skip-prompt')?.classList.add('hidden');
    playerOptions.close(); movieMedia.cancel();
    if ($('#player-dialog')) $('#player-dialog').innerHTML = '';
    if ($('#player-message')) $('#player-message').innerHTML = `<div class="player-message">${esc(message)}<br>可返回后选择其他片源或播放版本。<br><button class="action secondary" id="error-back">返回影片</button></div>`;
    S.dialog = 'error';
    if ($('#error-back')) { $('#error-back').onclick = stop; focus($('#error-back')); }
    showControls();
  }
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
    p.lastReportAt = Date.now(); p.lastReportKey = key; p.reportFailed = false; p.latestSnapshot = snapshot;
    const itemId = resumeKey(p.itemId, p.accountScope); S.pendingResume.set(itemId, snapshot);
    while (S.pendingResume.size > 128) S.pendingResume.delete(S.pendingResume.keys().next().value);
    const job = progressTail.then(async () => {
      if (p.latestSnapshot !== snapshot) return;
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
    clearTimeout(controlsTimer); setBuffering(false); video.pause(); reportProgress(true, saved);
    if (saved || video.readyState >= 1 && Number.isFinite(video.duration)) {
      const pos = saved?.position ?? Math.max(0, Math.min(video.duration, video.currentTime));
      const dur = saved?.duration ?? video.duration;
      S.detail.item.position = dur > 0 && pos >= dur * 0.98 ? 0 : pos;
      S.detail.resumeFileIndex = playback?.fileIndex;
    }
    releasePlayback(playback); beginView('detail'); S.playback = null; S.dialog = null;
    video.style.objectFit = ''; video.playbackRate = 1; video.muted = false;
    video.removeAttribute('src'); video.load(); document.body.classList.remove('playing'); renderDetail();
  }
  function closeDialog() { playerOptions.close(); if (S.playStarting) cancelPlayRequest(); S.dialog = null; if ($('#player-dialog')) $('#player-dialog').innerHTML = ''; showControls(); focus(document.getElementById(S.dialogReturnFocus) || $('#pause')); }
  function dialogBack() { closeDialog(); }
  function playerDialog(kind) {
    if (!S.dialog) S.dialogReturnFocus = document.activeElement?.id;
    if (kind === 'settings' || kind === 'quality') { S.dialog = 'advanced'; showControls(); $('#player-quality')?.setAttribute('aria-expanded', String(kind === 'quality')); playerOptions.open(kind, { backToPlayer: kind === 'quality' }); return; }
    S.dialog = kind; showControls();
    let content = '';
    if (kind === 'episodes') {
      content = `<h2>播放列表</h2>${S.detail.files.map(f => `<button class="${f.index === S.playback.fileIndex ? 'active' : ''}" data-switch="${f.index}">${esc(f.episode ? '第 ' + f.episode + ' 集' + (f.versionLabel ? ' · ' + f.versionLabel : '') + (f.title && !f.title.startsWith('第') ? ' · ' + f.title : '') : f.name)}${f.index === S.playback.fileIndex ? ' ✓' : ''}</button>`).join('')}`;
    } else if (kind === 'info') {
      const conversion = conversionLabel(S.playback);
      content = `<h2>播放信息</h2><p>${esc(S.playback.title)}<br>当前播放：${esc(S.playback.quality?.label || '原画')} · ${video.videoWidth || '—'} × ${video.videoHeight || '—'}${conversion ? ' · ' + conversion : ''}</p><p>原文件：${esc(S.playback.technical?.file_name || '')} ${esc(bytes(S.playback.technical?.size))}<br>${esc(S.playback.technical?.container?.toUpperCase() || '')} · ${esc(S.playback.technical?.video_info?.codec?.toUpperCase() || '')} · ${esc(S.playback.technical?.video_info?.resolution || '')} · ${esc(S.playback.technical?.video_info?.bitrate || '')}<br>${esc(S.detail.item.imageQuality || '')} · ${esc(S.detail.item.audioQuality || '')}</p>`;
    }
    const host = $('#player-dialog');
    host.innerHTML = `<section class="player-dialog">${content}<button id="close-dialog">返回</button></section>`;
    host.onclick = e => { if (e.target === host) closeDialog(); };
    $('#close-dialog').onclick = dialogBack;
    root.querySelectorAll('[data-switch]').forEach(b => b.onclick = () => play(false, Number(b.dataset.switch)));
    focus(root.querySelector('.player-dialog button.active') || root.querySelector('.player-dialog button'));
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
        clearAccountState(); connectionMode = 'bridge'; store.set('connectionMode', 'bridge');
        S.server = url.origin; S.token = data.token; store.set('server', S.server); store.set('token', S.token); home();
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
      try { await api('/api/login', { username: username.value, password: password.value }); if (epoch === S.epoch && form.isConnected) { clearAccountState(); home(); } }
      catch (err) { if (epoch === S.epoch && form.isConnected) message.textContent = err.message; }
      finally { password.value = ''; submit.disabled = false; }
    }; focus(username);
  }
  function search() { beginView('search'); S.searchView = { query: '', items: null }; renderSearch(); focus($('#search')); }
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
  function renderFolders() { root.innerHTML = `${header('我的媒体库')}${nav('folders')}<main class="screen library-screen"><div class="shelf-row">${libraries()}</div></main>`; bind(); firstFocus(); }
  function route(name, libraryId, title) {
    photoGallery.leave();
    S.exitConfirm = false; S.libraryId = libraryId || null; S.libraryTitle = title || null; S.busy = false;
    S.filters = defaultFilters(); S.filterOpen = false; S.filterOptions = null; S.historyManage = false; S.historyConfirmClear = false;
    if (name === 'photos') { beginView('photos'); return photoGallery.open(); }
    if (name === 'home') return home(); if (name === 'settings') return setup(); if (name === 'search') return search();
    if (name === 'folders') { beginView('folders'); renderFolders(); return; }
    beginView(name);
    const savedSort = store.get(sortStorageKey());
    const savedOrder = store.get(sortOrderKey());
    S.sort = ['1', '2', '3', '4'].includes(savedSort) ? savedSort : '2';
    S.sortOrder = ['asc', 'desc'].includes(savedOrder) ? savedOrder : (S.sort === '1' ? 'asc' : 'desc');
    loadLibrary(true);
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
    root.querySelectorAll('[data-hero]').forEach(b => b.onclick = () => { S.hero = Number(b.dataset.hero); renderHome(true); });
    if ($('#header-connection')) $('#header-connection').onclick = () => route('settings');
    root.querySelectorAll('.shelf-row').forEach(rowEl => {
      if (rowEl.dataset.wheelBound) return;
      rowEl.dataset.wheelBound = '1';
      rowEl.addEventListener('wheel', e => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && rowEl.scrollWidth > rowEl.clientWidth) {
          e.preventDefault(); rowEl.scrollLeft += e.deltaY;
        }
      }, { passive: false });
    });
  }
  function back() {
    if (S.selectPopup) { closeSelect(); return; }
    if (S.route === 'settings' && directAuth?.available && connectionMode === 'direct') { if (directAuth.back()) return; }
    if (S.route === 'photos') { photoGallery.back(); return; }
    if (S.route === 'player') { if (S.dialog && S.dialog !== 'error') dialogBack(); else stop(); return; }
    if (S.route === 'detail') { restoreView(); return; }
    if (S.filterOpen) { S.filterOpen = false; renderLibrary(); focus($('#filter-toggle')); return; }
    if (S.historyManage) { S.historyManage = false; S.historyConfirmClear = false; renderLibrary(); focus($('#history-manage')); return; }
    if (S.route !== 'home') { home(); return; }
    const scroll = $('.screen'); if (scroll && scroll.scrollTop > 10) { scroll.scrollTop = 0; focus(root.querySelector('[data-primary]')); return; }
    if (!S.exitConfirm) { S.exitConfirm = true; toast('再按一次返回键退出'); setTimeout(() => S.exitConfirm = false, 2500); }
    else if (window.PalmSystem?.platformBack) window.PalmSystem.platformBack();
    else window.close();
  }
  function moveFocus(direction) {
    const scope = S.selectPopup?.element || (S.route === 'player' ? (S.dialog === 'error' ? $('#player-message') : S.dialog ? $('.player-dialog') : $('.player-ui')) : root);
    if (!scope) return;
    const selector = 'button,input,select,[tabindex="0"]';
    const usable = el => Boolean(el?.isConnected && !el.disabled && el.offsetParent !== null);
    let all;
    const candidates = () => all ||= Array.from(scope.querySelectorAll(selector)).filter(usable);
    const current = document.activeElement;
    if (!scope.contains(current) || !current.matches?.(selector) || !usable(current)) {
      const items = candidates();
      focus(items.includes(S.lastContentFocus) ? S.lastContentFocus : scope.querySelector('[data-primary]') || items.find(el => !el.closest('.nav')) || items[0]); return;
    }
    const inNav = current.closest('.nav');
    if (inNav) {
      const buttons = Array.from(inNav.querySelectorAll('button')).filter(usable);
      if (direction === 'left') return;
      if (direction === 'up' || direction === 'down') { focus(buttons[Math.max(0, Math.min(buttons.length - 1, buttons.indexOf(current) + (direction === 'up' ? -1 : 1)))]); return; }
      if (S.lastContentFocus?.matches(selector) && scope.contains(S.lastContentFocus) && usable(S.lastContentFocus) && !S.lastContentFocus.closest('.nav')) { focus(S.lastContentFocus); return; }
    }
    const row = current.closest('.shelf-row');
    const homeHero = S.route === 'home' && scope === root && root.querySelector('.hero [data-primary]');
    if (homeHero === current && direction === 'left') { focus(root.querySelector('.nav button.active')); return; }
    if (homeHero === current && direction === 'right' && S.home?.hero?.length > 1) { S.hero = (S.hero + 1) % S.home.hero.length; renderHome(true); return; }
    if (homeHero && !inNav && (direction === 'up' || direction === 'down')) {
      const rows = Array.from(root.querySelectorAll('.shelf-row')).filter(value => Array.from(value.querySelectorAll(selector)).some(usable));
      const index = rows.indexOf(row), inHero = current.closest('.hero');
      if (index >= 0 || inHero) {
        if (direction === 'up' && (index === 0 || inHero)) { focus(homeHero); const screen = homeHero.closest('.screen'); if (screen) screen.scrollTop = 0; return; }
        const target = rows[inHero ? 0 : index + (direction === 'up' ? -1 : 1)];
        if (target) {
          const a = current.getBoundingClientRect(), center = a.left + a.width / 2;
          let nearest, distance = Infinity;
          for (const item of Array.from(target.querySelectorAll(selector)).filter(usable)) {
            const rect = item.getBoundingClientRect(), delta = Math.abs(rect.left + rect.width / 2 - center);
            if (delta < distance) { distance = delta; nearest = item; }
          }
          focus(nearest);
        }
        return;
      }
    }
    if (row && (direction === 'left' || direction === 'right')) {
      const items = Array.from(row.querySelectorAll('button')).filter(usable);
      const next = items[items.indexOf(current) + (direction === 'right' ? 1 : -1)];
      if (next) focus(next); else if (direction === 'left') focus(root.querySelector('.nav button.active'));
      return;
    }
    // Fast O(1) column grid navigation without forcing full DOM layout scans.
    const grid = scope === root && (current.matches('.movie') && current.closest('.grid') || current.closest('.photo-grid,.photo-albums'));
    if (grid) {
      const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
      const itemSelector = grid.classList.contains('grid') ? ':scope > .movie' : 'button';
      const items = Array.from(grid.querySelectorAll(itemSelector)), index = items.indexOf(current);
      if (index >= 0) {
        if (direction === 'left' && index % columns === 0) { focus(root.querySelector('.nav button.active')); return; }
        if (columns > 1) {
          const horizontal = direction === 'left' || direction === 'right';
          const delta = direction === 'left' ? -1 : direction === 'right' ? 1 : direction === 'up' ? -columns : columns;
          const target = index + delta;
          if (target >= 0 && target < items.length && (!horizontal || Math.floor(target / columns) === Math.floor(index / columns)) && usable(items[target])) { focus(items[target]); return; }
        }
      }
    }
    const a = current.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let winner, best = Infinity;
    for (const el of candidates()) {
      if (el === current || !inNav && el.closest('.nav')) continue;
      const b = el.getBoundingClientRect(), dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      const forward = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
      if (forward <= 2) continue;
      const side = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (side > forward * 2.2) continue;
      const score = forward + side * 3.2;
      if (score < best) { best = score; winner = el; }
    }
    if (!winner && direction === 'left' && !inNav && scope === root) winner = root.querySelector('.nav button.active');
    focus(winner);
  }
  document.addEventListener('keydown', e => {
    if (S.route === 'player' && playerOptions.key(e)) return;
    const code = e.keyCode; const active = document.activeElement; const input = ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName);
    if (code === 461 || e.key === 'Escape' || (code === 8 && !input)) { e.preventDefault(); if (!e.repeat) back(); return; }
    if (S.route === 'photos' && photoGallery.key(e)) return;
    const direction = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' }[code];
    if (active?.tagName === 'SELECT' && (code === 13 || e.code === 'Space')) { e.preventDefault(); openSelect(active); return; }
    if (input && active.tagName !== 'SELECT') {
      if (code === 37 && active.selectionStart === 0 && active.selectionEnd === 0) { e.preventDefault(); moveFocus('left'); return; }
      if (code === 39 && active.selectionStart === active.value.length && active.selectionEnd === active.value.length) { e.preventDefault(); moveFocus('right'); return; }
      if (![38, 40].includes(code)) return;
    }
    if ((code === 33 || code === 34) && S.route !== 'player') {
      const grid = $('.grid');
      if (grid && active?.matches('.movie')) {
        e.preventDefault();
        const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
        const items = Array.from(grid.querySelectorAll(':scope > .movie'));
        const nextIdx = Math.max(0, Math.min(items.length - 1, items.indexOf(active) + (code === 34 ? cols * 3 : -cols * 3)));
        focus(items[nextIdx]); return;
      }
      const scr = $('.screen');
      if (scr) { e.preventDefault(); scr.scrollBy(0, (code === 34 ? 1 : -1) * Math.round(scr.clientHeight * 0.8)); return; }
    }
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
      if (S.dialog === 'info' && (code === 38 || code === 40)) { e.preventDefault(); $('.player-dialog')?.scrollBy(0, code === 40 ? 90 : -90); return; }
      if (!S.dialog) {
        if ((code === 37 || code === 39) && (!S.controls || active?.id === 'player-seek')) { e.preventDefault(); seek(code === 39 ? 10 : -10); return; }
        if ((code === 37 || code === 39) && active?.closest('.player-buttons')) { e.preventDefault(); showControls(); const buttons = Array.from($('.player-buttons').querySelectorAll('button')).filter(button => !button.disabled && !button.hidden && button.offsetParent !== null); focus(buttons[buttons.indexOf(active) + (code === 39 ? 1 : -1)] || active); return; }
        if (code === 13 && (!S.controls || active?.id === 'player-seek')) { e.preventDefault(); if (!e.repeat) togglePause(); focus($('#pause')); return; }
        if (direction && !S.controls) { e.preventDefault(); showControls(); focus(code === 38 ? $('#player-seek') : $('#pause')); return; }
        if (code === 38 && $('.player-buttons')?.contains(active)) { e.preventDefault(); showControls(); focus($('#player-seek')); return; }
        if (code === 40 && active?.id === 'player-seek') { e.preventDefault(); showControls(); focus($('#pause')); return; }
      }
      showControls();
    }
    if (direction) { e.preventDefault(); e.stopPropagation(); moveFocus(direction); }
  });
  document.addEventListener('mousemove', () => { if (S.route === 'player') showControls(); });
  root.addEventListener('focusin', () => { if (root.contains(document.activeElement) && !document.activeElement.closest('.nav')) { S.lastContentFocus = document.activeElement; artwork.prioritize(document.activeElement.querySelector('img[data-art-kind]')); } const hint = $('.player-hint'); if (hint) hint.textContent = document.activeElement?.id === 'player-seek' ? '左右快退 / 快进 10 秒 · 下键选择按钮 · 确定播放 / 暂停' : '左右选择按钮 · 上键调整进度 · 下键返回按钮'; });
  addEventListener('beforeunload', () => { connectionUnloaded = true; stopForegroundLease(true); cancelConnectionCheck(); clearHeaderScroll(); clearInterval(heroTimer); artwork.destroy(); });
  video.addEventListener('loadedmetadata', () => {
    if (S.route !== 'player') return;
    if (!movieMedia.switching()) {
      if (S.playback?.position > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(S.playback.position, Math.max(0, video.duration - 1));
      if (S.playback && S.playback.skipsDuration === 0 && Number.isFinite(video.duration) && video.duration > 0) fetchSkips(S.playback);
      updatePlayerInfo();
    }
    updateProgress();
  });
  video.addEventListener('waiting', () => { if (S.route === 'player' && !video.paused && !video.ended) setBuffering(true); });
  video.addEventListener('stalled', () => { if (S.route === 'player' && !video.paused && !video.ended) setBuffering(true); });
  video.addEventListener('canplay', () => setBuffering(false));
  video.addEventListener('playing', () => setBuffering(false));
  video.addEventListener('timeupdate', () => {
    if (S.route !== 'player') return;
    const p = S.playback;
    if (p?.skips?.ranges?.length && !movieMedia.switching() && !video.seeking) {
      for (const r of p.skips.ranges) {
        const key = `${r.type}:${r.start}:${r.end}`;
        if (video.currentTime < r.start - 1) p.skippedRanges?.delete(key);
      }
      if (p.skips.enabled) {
        const range = p.skips.ranges.find(r => video.currentTime >= r.start && video.currentTime < r.end && !p.skippedRanges?.has(`${r.type}:${r.start}:${r.end}`));
        if (range) {
          p.skippedRanges?.add(`${range.type}:${range.start}:${range.end}`);
          try { video.currentTime = Math.min(range.end, video.duration - .1); toast(range.type === 'op' ? '已跳过片头' : '已跳过片尾'); } catch {}
        }
      }
      updateSkipPrompt(p);
    }
    updateProgress(); reportProgress();
  });
  video.addEventListener('pause', () => { setBuffering(false); if (S.route === 'player') { if ($('#pause')) $('#pause').textContent = '播放'; showControls(); reportProgress(true); } });
  video.addEventListener('play', () => { if ($('#pause')) $('#pause').textContent = '暂停'; });
  video.addEventListener('ended', async () => {
    const p = S.playback; if (S.route !== 'player' || !p || movieMedia.switching()) return;
    setBuffering(false);
    await reportProgress(true); if (S.playback !== p || S.route !== 'player') return;
    S.pendingResume.delete(resumeKey(p.itemId, p.accountScope));
    const index = S.detail.files.findIndex(f => f.index === p.fileIndex), next = nextPlayableIndex(S.detail.files, index);
    if (next !== null) play(true, S.detail.files[next].index); else { toast('播放结束'); showControls(); }
  });
  video.addEventListener('error', () => { setBuffering(false); if (S.route === 'player' && !movieMedia.switching()) playerError('电视无法播放这个片源。可能是音视频编码或封装格式不受支持。'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopForegroundLease(true); if (document.hidden) cancelConnectionCheck(); else refreshConnection(); if (document.hidden && S.route === 'player') { video.pause(); reportProgress(true); } });
  function resize() { const scale = Math.min(innerWidth / 1920, innerHeight / 1080); $('#stage').style.transform = `scale(${scale})`; $('#stage').style.left = ((innerWidth - 1920 * scale) / 2) + 'px'; $('#stage').style.top = ((innerHeight - 1080 * scale) / 2) + 'px'; }
  addEventListener('resize', resize); resize();
  directAuth = window.createDirectLogin({ root, esc, store, bind, focus,
    disconnected() { stopForegroundLease(true); cancelConnectionCheck(true); clearAccountState(); },
    connected(gateway) { stopForegroundLease(true); cancelConnectionCheck(true); clearAccountState(); connectionMode = 'direct'; S.server = gateway.server; S.token = gateway.token; home(); },
    bridgeMode() { stopForegroundLease(true); cancelConnectionCheck(true); connectionMode = 'bridge'; if (S.token) store.set('connectionMode', 'bridge'); S.server = store.get('server', location.protocol.startsWith('http') ? location.origin : ''); S.token = store.get('token'); setupLegacy(); },
    back: () => { if (S.token) { home(); return true; } return false; },
  });
  if (directAuth.available && connectionMode !== 'bridge') {
    beginView('settings'); root.innerHTML = '<main class="setup"><h1>正在连接 UGREENlink</h1><p>请稍候…</p></main>';
    directAuth.init().catch(err => { toast(err.message); connectionMode = 'bridge'; setupLegacy(); });
  } else if (S.token) home(); else setup();
})();
