(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const root = $('#app'), video = $('#video');
  const store = {
    get(k, fallback = '') { try { return localStorage.getItem('cinema.' + k) || fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem('cinema.' + k, v); } catch {} },
  };
  const S = { server: store.get('server', location.protocol.startsWith('http') ? location.origin : ''), token: store.get('token'), route: 'home', home: null, hero: 0, list: [], page: 1, last: true, detail: null, playback: null, returnRoute: 'home', dialog: null, controls: true, busy: false, epoch: 0, lastReport: 0, exitConfirm: false };
  let toastTimer, controlsTimer, heroTimer;
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
  function focus(el) { if (!el) return; try { el.focus({ preventScroll: true }); } catch { el.focus(); } el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' }); }
  function firstFocus() { focus(root.querySelector('[data-primary]') || root.querySelector('button,input,select')); }
  async function api(path, data, signal) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 35000);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const res = await fetch(S.server + path, { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + S.token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined, signal: controller.signal });
      const result = await res.json(); if (!res.ok) throw new Error(result.error || '连接失败'); return result;
    } catch (error) { if (error.name === 'AbortError') throw new Error('连接超时，请检查电视和 NAS 的网络'); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function image(path, className = '', alt = '') { return path ? `<img class="${className}" src="${esc(asset(path))}" alt="${esc(alt)}" loading="lazy">` : ''; }
  function header(title) { return `<header class="header"><img class="logo" src="logo.png" alt="UGREEN"><h1>${esc(title)}</h1><span class="connection">${esc(S.home?.name || '绿联 NAS')} · 局域网</span></header>`; }
  function nav(active) { return `<nav class="nav" aria-label="主导航">${['search', 'home', 'movies', 'tv', 'favorites', 'history', 'folders', 'photos', 'settings'].map(k => `<button data-route="${k}" class="${active === k ? 'active' : ''}" aria-label="${labels[k]}">${icon(k)}<span>${labels[k]}</span></button>`).join('')}</nav>`; }
  const photoGallery = window.createPhotoGallery({ root, api, asset, esc, header, nav, bind, focus, toast, store, exit: () => route('home') });
  function meta(item) { return [item.score > 0 ? Number(item.score).toFixed(1) : '', item.year || '', (item.genres || []).map(g => genres[g]).filter(Boolean).slice(0, 3).join(' · '), item.duration ? `${Math.floor(item.duration / 60)} 分钟` : ''].filter(Boolean).map(esc).join('　/　'); }
  function card(item, wide = false) {
    const attributes = `data-item="${item.id}" data-type="${item.type}" data-library="${item.libraryId}" data-focus="item-${item.id}"`;
    if (wide) return `<button class="movie continue" ${attributes}><div class="art">${image(item.cover || item.backdrop || item.poster, '', item.name)}<span class="progress"><i style="width:${item.progress * 100}%"></i></span></div><span class="name">${esc(item.name)}</span></button>`;
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
    S.route = 'home'; S.dialog = null; const epoch = ++S.epoch; clearInterval(heroTimer); loading();
    try { const data = await api('/api/home'); if (epoch !== S.epoch) return; S.home = data; S.hero = 0; renderHome(); }
    catch (err) { if (epoch === S.epoch) errorScreen(err); }
  }
  function loading() { root.innerHTML = '<div class="loading"><span class="spinner"></span>正在连接影视中心…</div>'; }
  function errorScreen(error) { root.innerHTML = `<div class="error-screen"><h1>暂时无法连接</h1><p>${esc(error.message)}</p><div class="actions"><button class="action" data-primary id="retry">重试</button><button class="action secondary" data-route="settings">连接设置</button></div></div>`; $('#retry').onclick = home; bind(); firstFocus(); }
  function renderLibrary() {
    const title = S.libraryTitle || labels[S.route] || '全部影片';
    root.innerHTML = `${header(title)}${nav(S.route)}<main class="screen library-screen"><div class="toolbar"><button data-route="movies" class="${S.route === 'movies' ? 'selected' : ''}">电影</button><button data-route="tv" class="${S.route === 'tv' ? 'selected' : ''}">电视剧</button><span>${S.total || 0} 部</span><select id="sort" aria-label="排序"><option value="2">按添加时间 ↓</option><option value="1">按名称</option><option value="4">按评分</option></select></div><div class="grid ${S.route === 'history' ? 'history-grid' : ''}">${S.list.map(i => card(i, S.route === 'history')).join('')}</div>${!S.list.length ? '<div class="empty">暂无影片</div>' : ''}${S.last ? '' : '<div class="more-row"><button class="action secondary" id="load-more">加载更多</button></div>'}</main>`;
    $('#sort').value = S.sort || '2'; $('#sort').onchange = () => { S.sort = $('#sort').value; loadLibrary(true); };
    if ($('#load-more')) $('#load-more').onclick = () => loadLibrary(false);
    bind();
  }
  async function loadLibrary(reset) {
    if (S.busy) return; S.busy = true;
    const epoch = ++S.epoch, oldCount = reset ? 0 : S.list.length;
    if (reset) { S.list = []; S.page = 1; loading(); }
    try {
      const query = new URLSearchParams({ kind: S.route, page: S.page, sort: S.sort || '2' });
      if (S.libraryId) query.set('id', S.libraryId);
      const data = await api('/api/library?' + query); if (epoch !== S.epoch) return;
      S.list = reset ? data.items : S.list.concat(data.items); S.last = data.last || data.items.length === 0; S.total = data.total; S.page++;
      renderLibrary(); focus(root.querySelectorAll('.grid .movie')[oldCount] || root.querySelector('#load-more') || root.querySelector('button'));
    } catch (err) { if (epoch === S.epoch) errorScreen(err); }
    finally { S.busy = false; }
  }
  async function openDetail(id, type, library, preserveRoute = false) {
    if (!preserveRoute) S.returnRoute = S.route;
    S.route = 'detail'; const epoch = ++S.epoch; loading();
    try { const data = await api(`/api/detail?id=${id}&type=${type}&library=${library}`); if (epoch !== S.epoch) return; S.detail = data; renderDetail(); }
    catch (err) { if (epoch === S.epoch) errorScreen(err); }
  }
  function renderDetail() {
    const { item: i, files, actors, technical } = S.detail;
    root.innerHTML = `<main class="screen detail-screen">${image(i.backdrop, 'backdrop')}<div class="shade"></div><button class="back" id="back">${icon('back')}返回</button><div class="detail-copy"><h2>${esc(i.name)}</h2><p class="meta">${meta(i)}</p><p class="overview">${esc(i.overview)}</p><p class="meta">${[i.clarity, technical?.video_info?.codec?.toUpperCase(), i.imageQuality, i.audioQuality].filter(Boolean).map(esc).join(' · ')}</p><div class="actions"><button class="action" data-primary id="play">${i.position > 0 ? '继续播放 ' + time(i.position) : '立即播放'}</button><button class="action secondary" id="restart">从头播放</button><button class="action secondary" id="favorite">${i.favorite ? '已收藏' : '收藏'}</button></div></div>${files.length > 1 ? `<section class="details-section"><h3>${i.type === 2 ? '选集' : '播放版本'}</h3><div class="episodes">${files.map(f => `<button class="episode" data-file="${f.index}">${esc(f.episode ? '第 ' + f.episode + ' 集' : f.name)}</button>`).join('')}</div></section>` : ''}${actors.some(a => a.name) ? `<section class="details-section"><h3>演职人员</h3><div class="actor-list">${actors.filter(a => a.name).map(a => `<div>${esc(a.name)}<small>${esc(a.role || '')}</small></div>`).join('')}</div></section>` : ''}${technical ? `<section class="details-section"><h3>影片信息</h3><div class="technical">${esc(technical.container?.toUpperCase() || '')} · ${esc(technical.video_info?.resolution || '')} · ${esc(technical.video_info?.framerate || '')}<br>${(technical.audio_info || []).map(a => `${esc(a.language)} · ${esc(a.codec)} · ${esc(a.channels)} 声道`).join('<br>')}</div></section>` : ''}</main>`;
    $('#back').onclick = back; $('#play').onclick = () => play(); $('#restart').onclick = () => play(true);
    $('#favorite').onclick = async () => {
      try { await api('/api/favorite', { id: i.id, type: i.type, library: i.libraryId, favorite: !i.favorite }); i.favorite = !i.favorite; $('#favorite').textContent = i.favorite ? '已收藏' : '收藏'; toast(i.favorite ? '已收藏' : '已取消收藏'); }
      catch (err) { toast(err.message); }
    };
    root.querySelectorAll('[data-file]').forEach(b => b.onclick = () => play(false, Number(b.dataset.file))); firstFocus();
  }
  async function play(restart = false, fileIndex) {
    const i = S.detail.item; toast('正在打开影片…');
    try {
      const data = await api('/api/play', { id: i.id, type: i.type, library: i.libraryId, restart, fileIndex });
      S.playback = data; S.route = 'player'; S.dialog = null; S.controls = true; S.lastReport = 0;
      document.body.classList.add('playing'); video.src = asset(data.stream); video.load(); renderPlayer();
      await video.play(); showControls();
    } catch (err) { toast(err.message); if (S.route === 'player') playerError(err.message); }
  }
  function renderPlayer() {
    root.innerHTML = `<div class="player-ui ${S.controls ? '' : 'hidden'}"><div class="player-top"><button class="back" style="position:static" id="stop-player" aria-label="返回">${icon('back')}</button><span>${esc(S.playback.title)}</span></div><div class="player-bottom"><div class="player-time"><b id="elapsed">${time(video.currentTime)}</b><span>/ <b id="duration">${time(video.duration || S.playback.duration)}</b></span></div><div class="seek"><i id="seek-progress"></i></div><div class="player-buttons"><button id="pause" data-primary>${video.paused ? '播放' : '暂停'}</button><button id="episode-list">列表</button><button id="player-settings">设置</button><button id="player-info">信息</button><span class="info">原画 · ${esc(S.detail.item.clarity)} · ${esc(S.playback.technical?.video_info?.codec?.toUpperCase() || '')}</span></div></div></div><div id="player-dialog"></div><div id="player-message"></div>`;
    $('#stop-player').onclick = stop; $('#pause').onclick = togglePause; $('#episode-list').onclick = () => playerDialog('episodes'); $('#player-settings').onclick = () => playerDialog('settings'); $('#player-info').onclick = () => playerDialog('info'); firstFocus(); updateProgress();
  }
  function showControls() {
    S.controls = true; $('.player-ui')?.classList.remove('hidden');
    clearTimeout(controlsTimer); controlsTimer = setTimeout(() => { if (S.route === 'player' && !S.dialog && !video.paused) { S.controls = false; $('.player-ui')?.classList.add('hidden'); } }, 5000);
  }
  function togglePause() { if (video.paused) video.play().catch(err => playerError(err.message)); else video.pause(); if ($('#pause')) $('#pause').textContent = video.paused ? '播放' : '暂停'; showControls(); }
  function playerError(message) { if ($('#player-message')) $('#player-message').innerHTML = `<div class="player-message">${esc(message)}<br>可返回后选择其他片源或播放版本。<br><button class="action secondary" id="error-back">返回影片</button></div>`; S.dialog = 'error'; if ($('#error-back')) { $('#error-back').onclick = stop; focus($('#error-back')); } showControls(); }
  function updateProgress() {
    if (S.route !== 'player') return;
    const duration = Number.isFinite(video.duration) ? video.duration : S.playback.duration;
    if ($('#elapsed')) $('#elapsed').textContent = time(video.currentTime);
    if ($('#duration')) $('#duration').textContent = time(duration);
    if ($('#seek-progress')) $('#seek-progress').style.width = Math.min(100, duration ? video.currentTime / duration * 100 : 0) + '%';
  }
  async function reportProgress(force = false) {
    const p = S.playback;
    if (!p || !Number.isFinite(video.duration) || video.duration <= 0 || (!force && Date.now() - S.lastReport < 15000)) return;
    S.lastReport = Date.now();
    try { await api('/api/progress', { id: p.id, position: video.currentTime, duration: video.duration }); }
    catch (err) { if (force) toast('播放记录未能同步：' + err.message); }
  }
  async function stop() {
    if (S.route !== 'player') return;
    clearTimeout(controlsTimer); video.pause(); await reportProgress(true);
    video.removeAttribute('src'); video.load(); document.body.classList.remove('playing'); S.playback = null; S.dialog = null;
    const i = S.detail.item; await openDetail(i.id, i.type, i.libraryId, true);
  }
  function closeDialog() { S.dialog = null; if ($('#player-dialog')) $('#player-dialog').innerHTML = ''; showControls(); focus($('#pause')); }
  function playerDialog(kind) {
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
    if (kind === 'info') content = `<h2>播放信息</h2><p>${esc(S.playback.title)}<br>${esc(S.playback.technical?.container?.toUpperCase() || '')} · ${esc(S.playback.technical?.video_info?.codec?.toUpperCase() || '')}<br>${esc(S.playback.technical?.video_info?.resolution || '')} · ${esc(S.playback.technical?.video_info?.bitrate || '')}<br>${esc(S.detail.item.imageQuality || '')} · ${esc(S.detail.item.audioQuality || '')}</p>`;
    $('#player-dialog').innerHTML = `<section class="player-dialog">${content}<button id="close-dialog">返回</button></section>`;
    $('#close-dialog').onclick = closeDialog;
    root.querySelectorAll('[data-subdialog]').forEach(b => b.onclick = () => playerDialog(b.dataset.subdialog));
    root.querySelectorAll('[data-speed]').forEach(b => b.onclick = () => { video.playbackRate = Number(b.dataset.speed); closeDialog(); });
    root.querySelectorAll('[data-ratio]').forEach(b => b.onclick = () => { video.style.objectFit = b.dataset.ratio; closeDialog(); });
    root.querySelectorAll('[data-audio]').forEach(b => b.onclick = () => { Array.from(video.audioTracks).forEach((t, n) => t.enabled = n === Number(b.dataset.audio)); closeDialog(); });
    root.querySelectorAll('[data-subtitle]').forEach(b => b.onclick = () => { Array.from(video.textTracks).forEach((t, n) => t.mode = n === Number(b.dataset.subtitle) ? 'showing' : 'disabled'); closeDialog(); });
    root.querySelectorAll('[data-switch]').forEach(b => b.onclick = async () => { await reportProgress(true); video.pause(); await play(false, Number(b.dataset.switch)); });
    focus(root.querySelector('.player-dialog button'));
  }
  function setup() {
    S.route = 'settings'; ++S.epoch;
    root.innerHTML = `<main class="screen setup"><h1>连接绿联 NAS</h1><p>${S.token ? '电视已配对。可更换服务地址或重新登录 NAS。' : '首次使用：输入 NAS 影视服务地址和配对码。'}</p><form class="form" id="pair-form"><label>影视服务地址<input id="server" placeholder="例如 http://192.168.1.100:8780" value="${esc(S.server)}" inputmode="url" autocomplete="url"></label><label>配对码<input id="pair-code" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="六位数字"></label><div class="message" id="setup-message"></div><div class="actions"><button class="action" type="submit">连接</button>${S.token ? '<button class="action secondary" type="button" id="setup-back">返回</button>' : ''}</div></form>${S.token ? '<button class="episode" id="nas-login">重新登录 NAS 账号</button>' : ''}</main>`;
    $('#pair-form').onsubmit = async e => {
      e.preventDefault(); const address = $('#server').value.trim().replace(/\/$/, '');
      try {
        const url = new URL(address); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入正确的 http:// 或 https:// 地址');
        S.server = url.origin;
        const data = await api('/api/pair', { code: $('#pair-code').value.trim(), name: 'LG webOS TV' });
        S.token = data.token; store.set('server', S.server); store.set('token', S.token); home();
      } catch (err) { $('#setup-message').textContent = err.message; }
    };
    if ($('#setup-back')) $('#setup-back').onclick = home;
    if ($('#nas-login')) $('#nas-login').onclick = loginForm;
    focus($('#server'));
  }
  function loginForm() {
    root.innerHTML = '<main class="setup"><h1>登录 NAS</h1><p>使用 NAS 本地账号</p><form class="form" id="login-form"><label>用户名<input id="nas-user" autocomplete="username"></label><label>密码<input id="nas-password" type="password" autocomplete="current-password"></label><div class="message" id="setup-message"></div><div class="actions"><button class="action">登录</button><button class="action secondary" type="button" id="login-back">返回</button></div></form></main>';
    $('#login-back').onclick = setup; $('#login-form').onsubmit = async e => { e.preventDefault(); try { await api('/api/login', { username: $('#nas-user').value, password: $('#nas-password').value }); $('#nas-password').value = ''; home(); } catch (err) { $('#nas-password').value = ''; $('#setup-message').textContent = err.message; } }; focus($('#nas-user'));
  }
  function search() {
    S.route = 'search'; ++S.epoch;
    root.innerHTML = `${header('搜索')}${nav('search')}<main class="screen library-screen"><form id="search-form"><input class="search-box" id="search" placeholder="搜索 NAS 中的电影、电视剧" aria-label="搜索影片"><button class="action" style="margin-left:24px">搜索</button></form><div id="search-results" class="grid" style="margin-top:44px"></div></main>`;
    $('#search-form').onsubmit = async e => { e.preventDefault(); try { const q = $('#search').value.trim(); if (!q) return; const data = await api('/api/search?q=' + encodeURIComponent(q)); $('#search-results').innerHTML = data.items.length ? data.items.map(i => card(i)).join('') : '<div class="empty">没有找到影片</div>'; bind(); focus($('#search-results button') || $('#search')); } catch (err) { toast(err.message); } }; bind(); focus($('#search'));
  }
  function route(name, libraryId, title) {
    photoGallery.leave();
    S.exitConfirm = false; S.libraryId = libraryId || null; S.libraryTitle = title || null; S.busy = false;
    if (name === 'photos') { S.route = 'photos'; ++S.epoch; return photoGallery.open(); }
    if (name === 'home') return home(); if (name === 'settings') return setup(); if (name === 'search') return search();
    if (name === 'folders') { S.route = 'folders'; ++S.epoch; root.innerHTML = `${header('我的媒体库')}${nav('folders')}<main class="screen library-screen"><div class="shelf-row">${libraries()}</div></main>`; bind(); firstFocus(); return; }
    S.route = name; loadLibrary(true);
  }
  function bind() {
    root.querySelectorAll('[data-route]').forEach(b => b.onclick = () => route(b.dataset.route));
    root.querySelectorAll('[data-item]').forEach(b => b.onclick = () => openDetail(b.dataset.item, Number(b.dataset.type), Number(b.dataset.library)));
    root.querySelectorAll('[data-library-route]').forEach(b => b.onclick = () => route('library', b.dataset.libraryRoute, b.dataset.title));
    root.querySelectorAll('[data-hero]').forEach(b => b.onclick = () => { S.hero = Number(b.dataset.hero); renderHome(); });
  }
  function back() {
    if (S.route === 'photos') { photoGallery.back(); return; }
    if (S.route === 'player') { if (S.dialog && S.dialog !== 'error') closeDialog(); else stop(); return; }
    if (S.route === 'detail') { const previous = S.returnRoute; if (previous === 'library') { S.route = previous; renderLibrary(); firstFocus(); } else route(previous); return; }
    if (S.route !== 'home') { home(); return; }
    const scroll = $('.screen'); if (scroll && scroll.scrollTop > 10) { scroll.scrollTop = 0; focus(root.querySelector('[data-primary]')); return; }
    if (!S.exitConfirm) { S.exitConfirm = true; toast('再按一次返回键退出'); setTimeout(() => S.exitConfirm = false, 2500); }
    else window.close();
  }
  function moveFocus(direction) {
    const scope = S.route === 'player' ? (S.dialog ? $('.player-dialog') || $('#player-message') : $('.player-ui')) : root;
    if (!scope) return;
    const all = Array.from(scope.querySelectorAll('button,input,select')).filter(el => !el.disabled && el.offsetParent !== null);
    const current = document.activeElement;
    if (!all.includes(current)) { focus(all[0]); return; }
    const a = current.getBoundingClientRect(); const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let winner, best = Infinity;
    for (const el of all) {
      if (el === current) continue;
      const b = el.getBoundingClientRect(); const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      const forward = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
      if (forward <= 2) continue;
      const side = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = forward + side * 3.2;
      if (score < best) { best = score; winner = el; }
    }
    focus(winner);
  }
  document.addEventListener('keydown', e => {
    const code = e.keyCode; const input = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (code === 461 || (e.key === 'Escape') || (code === 8 && !input)) { e.preventDefault(); back(); return; }
    if (S.route === 'photos' && photoGallery.key(e)) return;
    const direction = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' }[code];
    if (input && (document.activeElement.tagName === 'SELECT' || ![38, 40].includes(code))) return;
    if (S.route === 'player') {
      if ([415, 19, 179, 10252].includes(code) || (e.code === 'Space')) { e.preventDefault(); togglePause(); return; }
      if (!S.dialog && (code === 37 || code === 39)) { e.preventDefault(); const duration = Number.isFinite(video.duration) ? video.duration : S.playback.duration; video.currentTime = Math.max(0, Math.min(duration - .5, video.currentTime + (code === 39 ? 10 : -10))); updateProgress(); showControls(); return; }
      if (code === 13 && !S.controls && !S.dialog) { e.preventDefault(); togglePause(); return; }
      if (direction && !S.controls) { e.preventDefault(); showControls(); focus($('#pause')); return; }
      showControls();
    }
    if (direction) { e.preventDefault(); moveFocus(direction); }
  });
  document.addEventListener('mousemove', () => { if (S.route === 'player') showControls(); });
  video.addEventListener('loadedmetadata', () => { if (S.playback?.position > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(S.playback.position, Math.max(0, video.duration - 1)); updateProgress(); });
  video.addEventListener('timeupdate', () => { updateProgress(); reportProgress(); });
  video.addEventListener('pause', () => { if (S.route === 'player') { if ($('#pause')) $('#pause').textContent = '播放'; showControls(); reportProgress(true); } });
  video.addEventListener('play', () => { if ($('#pause')) $('#pause').textContent = '暂停'; });
  video.addEventListener('ended', async () => { await reportProgress(true); toast('播放结束'); showControls(); });
  video.addEventListener('error', () => { if (S.route === 'player') playerError('电视无法播放这个片源。可能是音视频编码或封装格式不受支持。'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.route === 'player') { video.pause(); reportProgress(true); } });
  function resize() { const scale = Math.min(innerWidth / 1920, innerHeight / 1080); $('#stage').style.transform = `scale(${scale})`; $('#stage').style.left = ((innerWidth - 1920 * scale) / 2) + 'px'; $('#stage').style.top = ((innerHeight - 1080 * scale) / 2) + 'px'; }
  addEventListener('resize', resize); resize();
  if (S.token) home(); else setup();
})();
