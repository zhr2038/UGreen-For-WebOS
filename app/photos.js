(() => {
  'use strict';
  window.createPhotoGallery = ({ root, api, asset, esc, header, nav, bind, focus, toast, store, exit, nativePhotoViewer, uhdPipeline, decodeImage, getConnection, videoPlane }) => {
    const $ = selector => root.querySelector(selector);
    const captureConnection = () => { if (getConnection) return { ...getConnection() }; const url = new URL(asset('/api/status'), document.baseURI); return { server: url.origin, token: url.searchParams.get('client') || '' }; };
    let planeSerial = 0;
    function acquirePlane(job) {
      const supplied = typeof videoPlane === 'function' ? videoPlane() : videoPlane;
      if (videoPlane && !supplied) throw new Error('当前视频仍在使用中');
      const clip = supplied || document.createElement('video');
      if (supplied && (!clip.paused || clip.getAttribute('src') || clip.src || clip.querySelector('source[src]'))) throw new Error('当前视频仍在使用中');
      job.borrowedPlane = Boolean(supplied); job.planeLease = 'photo-' + (++planeSerial);
      job.savedPlane = { style: clip.getAttribute('style'), muted: clip.muted, volume: clip.volume, preload: clip.preload, loop: clip.loop, controls: clip.controls, autoplay: clip.autoplay, playsInline: clip.playsInline };
      clip.dataset.cloudframePhotoLease = job.planeLease;
      if (!supplied) { clip.id = 'photo-uhd-video'; document.body.insertBefore(clip, document.body.firstChild); }
      clip.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;object-fit:contain;transform:none;z-index:0;pointer-events:none;background:#000';
      clip.muted = true; clip.playsInline = true; clip.preload = 'auto'; clip.loop = false; clip.controls = false; clip.autoplay = false;
      return clip;
    }
    const G = { active: false, tab: 'timeline', album: null, albumPage: 0, group: null, groupPage: 0, category: 'figure', search: '', searchType: '8', offset: 0, data: null, filter: 'all', sort: 'date', viewer: false, index: 0, playing: false, interval: Number(store.get('photoInterval', '5')), rotation: 0, zoom: false, controls: true, generation: 0, imageGeneration: 0, loading: false, infoOpen: false, source: 'preview' };
    let slideTimer, hideTimer, preload, soundtrack, softwareMusic, musicTask, heifDecoder, musicGeneration = 0, audioGeneration = 0;
    Object.assign(G, { uhdPreferred: store.get('photoUhd', '0') === '1', uhdJob: null, uhdActive: false, uhdNotices: new Set() });
    Object.assign(G, { folder: null, folderBack: [], folderSort: 'name', folderOrder: 'asc', memory: null, mode: store.get('photoMode', 'sequential'), display: store.get('photoDisplay', 'fit'), videoRate: Number(store.get('photoVideoRate', '1')), previewOverride: null, musicEnabled: store.get('photoMusicOn', '0') === '1', musicIndex: Number(store.get('photoMusicIndex', '0')) || 0, musicTrack: null, musicItems: null, musicLoading: null, musicPosition: 0, musicError: false, dialogType: null, resumeAfterDialog: false });
    if (![2, 3, 5, 10, 15].includes(G.interval)) G.interval = 5;
    if (!['sequential', 'random', 'loop'].includes(G.mode)) G.mode = 'sequential';
    if (!['fit', 'fill'].includes(G.display)) G.display = 'fit';
    if (![.5, .75, 1, 1.25, 1.5, 2].includes(G.videoRate)) G.videoRate = 1;
    const date = value => value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '日期未知';
    const month = value => value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' }) : '日期未知';
    const duration = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
    const bytes = value => value > 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value > 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value ? `${Math.ceil(value / 1024)} KB` : '';
    const categoryNames = { figure: '人物', city: '地点', object: '事物', pet: '宠物', custom: '自定义分类' };
    const thumb = (path, name) => path ? `<img src="${esc(asset(path))}" alt="${esc(name)}" loading="lazy">` : '<span class="photo-placeholder">▧</span>';
    const hasSoftwareMusic = () => typeof window.createPhotoMusic === 'function';
    function stopMusic() {
      if (softwareMusic) {
        const state = softwareMusic.state(); if (state.src && Number.isFinite(state.currentTime)) G.musicPosition = state.currentTime;
        ++audioGeneration; musicTask = null; softwareMusic.pause().catch(() => {});
      }
      if (!soundtrack) return;
      if (soundtrack.getAttribute('src')) ++audioGeneration;
      try { if (soundtrack.getAttribute('src') && Number.isFinite(soundtrack.currentTime)) G.musicPosition = soundtrack.currentTime; } catch {}
      soundtrack.onloadedmetadata = soundtrack.onerror = null;
      soundtrack.pause(); soundtrack.removeAttribute('src'); soundtrack.load();
    }
    async function musicList() {
      if (G.musicLoading) return G.musicLoading;
      const generation = musicGeneration;
      G.musicLoading = api('/api/photos/music').then(data => {
        if (!G.active || generation !== musicGeneration) return null;
        G.musicItems = Array.isArray(data.items) ? data.items : [];
        if (!G.musicTrack || !G.musicItems.some(track => track.id === G.musicTrack.id)) G.musicTrack = G.musicItems[Math.min(G.musicIndex, Math.max(0, G.musicItems.length - 1))] || null;
        return G.musicItems;
      }).finally(() => { if (generation === musicGeneration) G.musicLoading = null; });
      return G.musicLoading;
    }
    function syncMusic() {
      if (!G.active || !G.viewer || !G.ready || !G.playing || document.hidden || $('#photo-clip') || (G.uhdJob || G.uhdActive) && !hasSoftwareMusic() || !G.musicEnabled || G.musicError) { stopMusic(); return; }
      if (!G.musicTrack) { if (G.musicItems?.length === 0) return; musicList().then(items => { if (items?.length) syncMusic(); }).catch(() => { G.musicError = true; toast('背景音乐暂时无法读取，照片继续播放。'); }); return; }
      if (hasSoftwareMusic()) {
        if (soundtrack) { stopMusic(); soundtrack = null; }
        const url = asset(G.musicTrack.stream);
        softwareMusic ||= window.createPhotoMusic({ getGateway: () => new URL(asset('/')).origin });
        const state = softwareMusic.state(); if (musicTask || state.src === url && !state.paused) return;
        const generation = audioGeneration;
        const operation = state.src === url && state.loaded ? softwareMusic.resume() : softwareMusic.play(url, { position: G.musicPosition, loop: true });
        const task = Promise.resolve(operation).then(value => { if (G.active && generation === audioGeneration && value.contextState !== 'running') toast('背景音乐等待音频上下文恢复，可暂停后重新播放'); }).catch(error => {
          if (error.name !== 'AbortError' && G.active && generation === audioGeneration) { G.musicError = true; stopMusic(); toast('背景音乐暂时无法解码，照片继续播放。'); }
        }).finally(() => { if (musicTask === task) musicTask = null; }); musicTask = task; return;
      }
      if (!soundtrack) { soundtrack = new Audio(); soundtrack.preload = 'none'; soundtrack.loop = true; }
      const url = asset(G.musicTrack.stream);
      if (soundtrack.getAttribute('src') !== url) {
        ++audioGeneration;
        soundtrack.src = url;
        soundtrack.onloadedmetadata = () => { if (G.musicPosition > 0 && Number.isFinite(soundtrack.duration)) { try { soundtrack.currentTime = Math.min(G.musicPosition, Math.max(0, soundtrack.duration - .1)); } catch {} } };
      }
      const generation = audioGeneration;
      const failure = () => { if (!G.active || generation !== audioGeneration || soundtrack?.getAttribute('src') !== url) return; G.musicError = true; stopMusic(); toast('背景音乐已暂停，请在音乐设置中重试。'); };
      soundtrack.onerror = failure;
      if (soundtrack.paused) soundtrack.play().catch(e => { if (e.name !== 'AbortError') failure(); });
    }
    function closeUhdRemote(job) {
      if (!job?.remote || job.remoteClosed) return; job.remoteClosed = true;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
      fetch(job.closeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.remote.id }), signal: controller.signal, keepalive: true }).catch(() => {}).finally(() => clearTimeout(timer));
    }
    function releaseUhdJob(job) {
      if (!job) return; job.controller.abort(); clearTimeout(job.frameTimer); clearTimeout(job.presentationTimer);
      try { if (job.frameCallback != null) job.video?.cancelVideoFrameCallback?.(job.frameCallback); } catch {}
      if (job.video) {
        const clip = job.video, ownsLease = clip.dataset.cloudframePhotoLease === job.planeLease;
        const intent = clip.getAttribute('src') || clip.querySelector('source[src]')?.src || clip.src;
        const ownsSource = !job.mediaUrl || (intent ? intent === job.mediaUrl : clip.currentSrc === job.mediaUrl);
        if (ownsLease && ownsSource) {
          clip.onloadeddata = clip.onerror = null; try { clip.pause(); clip.removeAttribute('src'); clip.load(); } catch {}
          if (job.borrowedPlane) { const saved = job.savedPlane; if (saved.style == null) clip.removeAttribute('style'); else clip.setAttribute('style', saved.style); for (const key of ['muted','volume','preload','loop','controls','autoplay','playsInline']) clip[key] = saved[key]; }
          else clip.remove();
          delete clip.dataset.cloudframePhotoLease;
        }
        job.video = null;
      }
      closeUhdRemote(job);
    }
    function stopUhd(restore = true) {
      const job = G.uhdJob; G.uhdJob = null; G.uhdActive = false;
      document.body.classList.remove('photo-uhd-presenting'); $('.photo-viewer')?.classList.remove('photo-uhd-presenting');
      if (job) { releaseUhdJob(job); heifDecoder?.cancel?.(); }
      if (restore && $('#photo-full')) $('#photo-full').style.visibility = '';
      $('#photo-uhd-status')?.remove(); if ($('#photo-uhd')) $('#photo-uhd').textContent = '4K 视频显示';
      for (const id of ['photo-rotate', 'photo-zoom']) if ($('#' + id)) $('#' + id).disabled = false;
    }
    function uhdStatus(text) {
      let status = $('#photo-uhd-status');
      if (!status) { status = document.createElement('p'); status.id = 'photo-uhd-status'; status.className = 'photo-uhd-status photo-overlay'; $('.photo-viewer')?.appendChild(status); }
      status.textContent = text;
    }
    function heifHook() {
      if (typeof decodeImage === 'function') return decodeImage;
      if (typeof window.createPhotoHeifDecoder !== 'function') return undefined;
      return (blob, options) => { heifDecoder ||= window.createPhotoHeifDecoder(); return heifDecoder.decode(blob, options); };
    }
    async function startUhd(p, automatic = false) {
      if (!G.active || !G.viewer || !p.original || p.kind !== 'image' || $('#photo-clip') || document.hidden) return;
      const pipeline = uhdPipeline || window.PhotoUhdPipeline;
      if (!pipeline?.encodeOriginal) { if (!automatic) toast('4K 编码模块尚未加载'); return; }
      stopUhd(); clearTimeout(slideTimer); if (!hasSoftwareMusic()) stopMusic();
      G.rotation = 0; G.zoom = false; transform();
      let originalURL;
      try { originalURL = new URL(asset(p.original)); } catch { uhdStatus('原图链接不可用，继续使用照片显示'); schedule(); syncMusic(); return; }
      const client = originalURL.searchParams.get('client');
      const uploadURL = new URL('/api/photos/uhd', originalURL); uploadURL.searchParams.set('asset', originalURL.pathname.split('/').pop()); uploadURL.searchParams.set('client', client);
      const closeURL = new URL('/api/photos/uhd/close', originalURL); closeURL.searchParams.set('client', client);
      const job = { controller: new AbortController(), generation: G.imageGeneration, remote: null, video: null, closeUrl: closeURL.href };
      G.uhdJob = job;
      const current = () => G.active && G.viewer && G.uhdJob === job && G.imageGeneration === job.generation && !job.controller.signal.aborted && !document.hidden;
      if ($('#photo-uhd')) $('#photo-uhd').textContent = '取消 4K 准备';
      for (const id of ['photo-rotate', 'photo-zoom']) if ($('#' + id)) $('#' + id).disabled = true;
      uhdStatus('正在从原图生成 4K 视频…' + (G.musicEnabled && !hasSoftwareMusic() ? ' 背景音乐已暂停' : ''));
      try {
        let width = p.width, height = p.height;
        if ((!width || !height) && p.info) { const detail = await api(p.info, undefined, job.controller.signal); width = detail.item?.width; height = detail.item?.height; }
        if (!current()) return;
        const encoded = await pipeline.encodeOriginal(originalURL.href, { expectedWidth: width, expectedHeight: height, width: 3840, height: 2160, durationMs: 15000, fit: G.display === 'fill' ? 'cover' : 'contain', hardwareAcceleration: 'no-preference', signal: job.controller.signal, decodeImage: heifHook() });
        if (!current()) return;
        const uploading = new AbortController(), timeout = setTimeout(() => uploading.abort(), 30000);
        let reply;
        // Finish this bounded local upload even if the photo changes, so a late
        // opaque ID can be explicitly closed instead of orphaning a RAM slot.
        try { const uploaded = await fetch(uploadURL.href, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: encoded.blob, signal: uploading.signal }); reply = await uploaded.json(); if (!uploaded.ok) throw Object.assign(new Error('UHD upload failed'), { code: reply.code }); }
        finally { clearTimeout(timeout); }
        if (!/^[a-f0-9]{40}$/.test(reply?.id || '') || typeof reply.url !== 'string') throw new Error('Invalid UHD response');
        job.remote = reply; if (!current()) { closeUhdRemote(job); return; }
        const mediaURL = new URL(reply.url, originalURL); if (mediaURL.origin !== originalURL.origin || !/^\/photo-uhd\/[a-f0-9]{40}$/.test(mediaURL.pathname)) throw new Error('Invalid UHD URL'); mediaURL.searchParams.set('client', client); const url = mediaURL.href;
        const clip = acquirePlane(job); job.video = clip; job.mediaUrl = url;
        await new Promise((resolve, reject) => {
          const failed = () => reject(Object.assign(new Error('UHD video failed'), { code: 'VIDEO_FORMAT_UNSUPPORTED' }));
          let loaded = false, started = false, scheduled = false;
          const presented = () => { clearTimeout(job.frameTimer); clearTimeout(job.presentationTimer); resolve(); };
          const ready = () => {
            if (!loaded || !started || scheduled) return; scheduled = true;
            try { if (typeof clip.requestVideoFrameCallback === 'function') job.frameCallback = clip.requestVideoFrameCallback(presented); } catch {}
            // Native TV pipelines may not implement the frame callback even
            // when the property exists. Require loadeddata + fulfilled play,
            // then allow a short presentation interval before pausing.
            job.presentationTimer = setTimeout(presented, 250);
          };
          job.frameTimer = setTimeout(failed, 15000); job.controller.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
          clip.onerror = failed; clip.onloadeddata = () => { if (clip.videoWidth !== 3840 || clip.videoHeight !== 2160) { failed(); return; } loaded = true; ready(); };
          clip.src = url; clip.load(); clip.play().then(() => { started = true; ready(); }).catch(error => { if (error.name !== 'AbortError') failed(); });
        });
        if (!current()) { releaseUhdJob(job); return; }
        clip.pause(); clip.onloadeddata = null; clip.onerror = () => { if (G.uhdJob === job) { stopUhd(); uhdStatus('4K 视频暂不可用，已恢复照片显示'); if (G.playing) { schedule(); syncMusic(); } } };
        G.uhdActive = true; if ($('#photo-full')) $('#photo-full').style.visibility = 'hidden';
        document.body.classList.add('photo-uhd-presenting'); $('.photo-viewer')?.classList.add('photo-uhd-presenting');
        if ($('#photo-view-error')) $('#photo-view-error').replaceChildren();
        if ($('#photo-view-loading')) $('#photo-view-loading').style.display = 'none';
        for (const id of ['photo-rotate', 'photo-zoom']) if ($('#' + id)) $('#' + id).disabled = true;
        if ($('#photo-uhd')) $('#photo-uhd').textContent = '返回照片显示';
        uhdStatus('4K 视频显示 · 有损视频编码，颜色可能与原图不同' + (p.format === 'gif' ? ' · 动图使用静态首帧' : '') + (encoded.report?.sourceUpscaled ? ' · 原图较小，放大不会增加细节' : encoded.report?.intermediateUpscaled ? ' · 画面经过放大，不会增加细节' : '') + (G.musicEnabled ? hasSoftwareMusic() ? ' · 背景音乐启用' : ' · 背景音乐已暂停' : ''));
        G.ready = true; schedule(); syncMusic(); showControls();
      } catch (error) {
        if (current()) {
          stopUhd();
          const text = error.code === 'IMAGE_DECODE_UNSUPPORTED' ? '此原图格式暂不能生成 4K 视频，可使用照片预览或系统查看' : '4K 视频准备失败，已恢复照片显示';
          uhdStatus(text); const key = p.format + ':' + (error.code || error.name);
          if (!automatic || !G.uhdNotices.has(key)) toast(text); G.uhdNotices.add(key);
          schedule(); syncMusic();
        }
      } finally { clearTimeout(job.frameTimer); if (!current()) releaseUhdJob(job); }
    }
    function stopMedia() {
      clearTimeout(slideTimer); clearTimeout(hideTimer); ++G.imageGeneration;
      stopUhd();
      cancelVideoCandidate(false);
      if (G.videoSession) { const { id, connection } = G.videoSession; G.videoSession = null; api('/api/photos/video/close', { id }, undefined, connection).catch(() => {}); }
      const clip = $('#photo-clip');
      if (clip) { clip.onplay = clip.onpause = clip.onloadeddata = clip.onended = clip.onerror = null; clip.pause(); clip.removeAttribute('src'); clip.load(); }
      if (preload) { preload.onload = preload.onerror = null; preload.src = ''; preload = null; }
    }
    function leave() { G.active = false; G.playing = false; G.viewer = false; G.infoOpen = false; G.previewOverride = null; ++G.generation; ++musicGeneration; G.musicLoading = null; stopMedia(); stopMusic(); softwareMusic?.dispose().catch(() => {}); softwareMusic = null; heifDecoder?.dispose?.(); heifDecoder = null; }
    function query(offset) {
      const params = new URLSearchParams({ offset, filter: G.filter, sort: G.sort });
      if (G.album) { params.set('album', G.album.id); params.set('type', G.album.type); }
      else if (G.group) params.set('group', G.group.id);
      else if (G.folder) params.set('folder', G.folder.id);
      else if (G.memory) params.set('memory', G.memory.id);
      else if (G.tab === 'favorites') params.set('favorites', '1');
      if (G.tab === 'classifications' && !G.group) params.set('kind', G.category);
      if (G.tab === 'search' && G.search) { params.set('search', G.search); params.set('searchType', G.searchType); }
      if (G.tab === 'folders') { params.set('folderSort', G.folderSort); params.set('folderOrder', G.folderOrder); }
      return params;
    }
    function request(offset) { if (G.tab === 'search' && !G.search) return Promise.resolve({ items: [], total: 0, limit: 48, offset: 0, last: true }); return api((G.tab === 'albums' && !G.album ? '/api/photos/albums?' : G.tab === 'classifications' && !G.group ? '/api/photos/categories?' : G.tab === 'folders' ? '/api/photos/folders?' : G.tab === 'memories' && !G.memory ? '/api/photos/memories?' : '/api/photos/list?') + query(offset)); }
    function shell(content) { root.innerHTML = `${header('相册')}${nav('photos')}<main class="screen library-screen photo-screen">${content}</main>`; bind(); }
    function error(err, retry) {
      shell(`<div class="photo-error"><h2>暂时无法打开相册</h2><p>${esc(err.message)}</p><button class="action" id="photo-retry">重试</button></div>`);
      $('#photo-retry').onclick = retry; focus($('#photo-retry'));
    }
    function chooseFolder(folder, breadcrumb = false) {
      if (!folder) { G.folder = null; G.folderBack = []; }
      else {
        if (breadcrumb) {
          const crumbs = G.data.breadcrumbs || [], index = crumbs.findIndex(item => item.id === folder.id);
          G.folderBack = [{ folder: null, offset: 0 }, ...crumbs.slice(0, index).map(item => ({ folder: item, offset: 0 }))];
        } else G.folderBack.push({ folder: G.folder, offset: G.offset });
        G.folder = folder;
      }
      G.offset = 0; load();
    }
    function render(targetIndex = 0) {
      const data = G.data, albums = G.tab === 'albums' && !G.album, groups = G.tab === 'classifications' && !G.group, memories = G.tab === 'memories' && !G.memory, collections = albums || groups || memories, folders = G.tab === 'folders';
      const title = G.album?.name || G.group?.name || G.memory?.name || (folders ? data.title || '文件夹' : albums ? '我的相册' : groups ? categoryNames[G.category] : memories ? '精选回忆' : G.tab === 'favorites' ? '喜欢的照片' : G.tab === 'search' ? '搜索照片' : '所有照片');
      const collectionCards = (items, attribute) => `<div class="photo-albums">${items.map((item, index) => `<button class="photo-album" ${attribute}="${index}"><div class="photo-album-art">${thumb(item.cover, item.name)}<span>${item.totalKnown === false ? '精选播放' : item.hasSubfolders && !item.total ? '包含子文件夹' : `${Number(item.total).toLocaleString()} 项`}</span></div><b>${esc(item.name)}</b></button>`).join('')}</div>`;
      let content = '';
      if (collections) content = collectionCards(data.items, groups ? 'data-photo-group' : memories ? 'data-photo-memory' : 'data-album');
      else {
        let previousMonth = '';
        content = data.items.map((p, n) => {
          const group = month(p.date), heading = group !== previousMonth ? `<h3 class="photo-month">${esc(group)}</h3>` : ''; previousMonth = group;
          return `${heading}<button class="photo-tile" data-photo="${n}" aria-label="${esc(p.name)}，${p.kind === 'video' ? '视频' : '照片'}"><div>${thumb(p.thumb, p.name)}${p.kind === 'video' ? `<span class="photo-badge">▶ ${duration(p.duration)}</span>` : p.live ? '<span class="photo-badge">实况</span>' : ''}${p.favorite ? '<span class="photo-heart">♥</span>' : ''}</div></button>`;
        }).join('');
        content = `${folders && data.folders?.length ? collectionCards(data.folders, 'data-photo-folder') : ''}<div class="photo-grid">${content}</div>`;
      }
      const count = data.items.length + (data.folders?.length || 0);
      const countText = data.totalKnown === false ? `本页 ${count} 项` : `${Number(data.total).toLocaleString()} ${albums ? '个相册' : groups ? '个分类' : memories ? '段回忆' : '项'}`;
      const tabs = [['timeline', '照片'], ['albums', '相册'], ['folders', '文件夹'], ['memories', '回忆'], ['classifications', '分类'], ['favorites', '喜欢'], ['search', '搜索']];
      const filters = !collections ? `<div class="photo-filters"><select id="photo-filter" aria-label="照片类型"><option value="all">全部照片和视频</option><option value="image">仅照片</option><option value="video">仅视频</option><option value="live">实况照片</option><option value="gif">GIF 动图</option><option value="raw">RAW 照片</option></select>${folders ? `<select id="photo-folder-sort" aria-label="文件夹排序"><option value="name">名称</option><option value="date">拍摄时间</option><option value="size">大小</option><option value="type">文件类型</option></select><select id="photo-folder-order" aria-label="排序方向"><option value="asc">升序</option><option value="desc">降序</option></select>` : `<select id="photo-sort" aria-label="照片排序"><option value="date">拍摄时间 · 从新到旧</option><option value="oldest">拍摄时间 · 从旧到新</option><option value="upload">添加时间 · 从新到旧</option></select>`}<span>方向键选择 · 确定打开 · 返回退出</span></div>` : '';
      shell(`<div class="photo-tabs" aria-label="相册分类">${tabs.map(([key, name]) => `<button data-photo-tab="${key}" class="${G.tab === key ? 'selected' : ''}">${name}</button>`).join('')}<span>记录生活，随时重温</span></div>${G.tab === 'search' ? `<form id="photo-search-form" class="photo-search"><input id="photo-search" aria-label="搜索照片" value="${esc(G.search)}" placeholder="文件名或照片中的文字"><select id="photo-search-type" aria-label="搜索范围"><option value="8">文件名</option><option value="5">照片中的文字</option></select><button class="action secondary">搜索</button></form>` : ''}${groups ? `<div class="photo-filters"><select id="photo-category" aria-label="照片分类">${Object.entries(categoryNames).map(([key, name]) => `<option value="${key}">${name}</option>`).join('')}</select></div>` : ''}${folders ? `<div class="photo-breadcrumbs"><button id="photo-folder-root">全部文件夹</button>${(data.breadcrumbs || []).map((item, index) => `<span>›</span><button data-folder-crumb="${index}">${esc(item.name)}</button>`).join('')}</div>` : ''}<div class="photo-heading">${G.album || G.group || G.memory || G.folder ? '<button id="photo-album-back" aria-label="返回上级列表">‹</button>' : ''}<div><h2>${esc(title)}</h2><p>${countText}${count ? ` · 第 ${Math.floor(G.offset / data.limit) + 1} 页` : ''}</p></div>${!collections ? '<button class="action secondary" id="photo-start">幻灯片播放</button>' : ''}</div>${filters}${count ? content : `<div class="empty">${G.tab === 'search' && !G.search ? '输入关键词搜索 NAS 照片' : '这里还没有内容'}</div>`}<div class="photo-pagination">${G.offset > 0 ? '<button class="action secondary" id="photo-prev-page">上一页</button>' : ''}<span>${count ? data.totalKnown === false ? `第 ${Math.floor(G.offset / data.limit) + 1} 页` : `${G.offset + 1}–${G.offset + count} / ${Number(data.total).toLocaleString()}` : ''}</span>${!data.last ? '<button class="action secondary" id="photo-next-page">下一页</button>' : ''}</div>`);
      root.querySelectorAll('[data-photo-tab]').forEach(button => button.onclick = () => { G.tab = button.dataset.photoTab; G.album = null; G.group = null; G.folder = null; G.folderBack = []; G.memory = null; G.offset = 0; load(); });
      root.querySelectorAll('[data-photo]').forEach(button => button.onclick = () => openViewer(Number(button.dataset.photo)));
      root.querySelectorAll('[data-album]').forEach(button => button.onclick = () => { G.albumPage = G.offset; G.album = data.items[Number(button.dataset.album)]; G.offset = 0; load(); });
      root.querySelectorAll('[data-photo-group]').forEach(button => button.onclick = () => { G.groupPage = G.offset; G.group = data.items[Number(button.dataset.photoGroup)]; G.offset = 0; load(); });
      root.querySelectorAll('[data-photo-memory]').forEach(button => button.onclick = () => { G.memory = data.items[Number(button.dataset.photoMemory)]; G.offset = 0; load(); });
      root.querySelectorAll('[data-photo-folder]').forEach(button => button.onclick = () => chooseFolder(data.folders[Number(button.dataset.photoFolder)]));
      root.querySelectorAll('[data-folder-crumb]').forEach(button => button.onclick = () => chooseFolder(data.breadcrumbs[Number(button.dataset.folderCrumb)], true));
      if ($('#photo-folder-root')) $('#photo-folder-root').onclick = () => chooseFolder(null);
      if ($('#photo-category')) { $('#photo-category').value = G.category; $('#photo-category').onchange = event => { G.category = event.target.value; G.offset = 0; load(); }; }
      if ($('#photo-search-form')) { $('#photo-search-type').value = G.searchType; $('#photo-search-form').onsubmit = event => { event.preventDefault(); G.search = $('#photo-search').value.trim(); G.searchType = $('#photo-search-type').value; G.offset = 0; load(); }; }
      for (const [id, key] of [['photo-filter', 'filter'], ['photo-sort', 'sort'], ['photo-folder-sort', 'folderSort'], ['photo-folder-order', 'folderOrder']]) if ($('#' + id)) { $('#' + id).value = G[key]; $('#' + id).onchange = event => { G[key] = event.target.value; G.offset = 0; load(); }; }
      if ($('#photo-album-back')) $('#photo-album-back').onclick = back;
      if ($('#photo-start')) { $('#photo-start').disabled = !data.items.length; $('#photo-start').onclick = () => openViewer(0, true); }
      if ($('#photo-prev-page')) $('#photo-prev-page').onclick = () => { G.offset = Math.max(0, G.offset - data.limit); load(); };
      if ($('#photo-next-page')) $('#photo-next-page').onclick = () => { G.offset += data.limit; load(); };
      root.querySelectorAll('.photo-tile img,.photo-album img').forEach(img => img.onerror = () => { img.style.visibility = 'hidden'; });
      focus($(`[data-photo="${targetIndex}"]`) || $('[data-album]') || $('[data-photo-group]') || $('[data-photo-memory]') || $('[data-photo-folder]') || (G.tab === 'search' && !G.search ? $('#photo-search') : null) || $('[data-photo-tab]'));
    }

    async function load() {
      stopMedia(); G.viewer = false; G.playing = false; G.infoOpen = false; G.loading = true;
      const generation = ++G.generation;
      shell('<div class="photo-loading"><span class="spinner"></span>正在读取相册…</div>');
      try { const data = await request(G.offset); if (!G.active || generation !== G.generation) return; G.data = data; render(); }
      catch (err) { if (G.active && generation === G.generation) error(err, load); }
      finally { if (generation === G.generation) G.loading = false; }
    }
    function showControls() {
      if (!G.viewer) return;
      G.controls = true; $('.photo-viewer')?.classList.remove('clean');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (G.viewer && !G.infoOpen && (!G.uhdJob || G.uhdActive) && !$('#photo-view-error')?.textContent) { G.controls = false; $('.photo-viewer')?.classList.add('clean'); } }, 5000);
    }
    function schedule() {
      clearTimeout(slideTimer);
      if (G.ready && G.playing && G.viewer && G.active && !document.hidden && !$('#photo-clip') && (!G.uhdJob || G.uhdActive)) slideTimer = setTimeout(() => step(1, true), G.interval * 1000);
    }
    function setSlideshow(playing) {
      G.playing = playing;
      if ($('#photo-slideshow')) $('#photo-slideshow').textContent = G.playing ? '暂停幻灯片' : '播放幻灯片';
      const clip = $('#photo-clip');
      if (clip) { stopMusic(); if (G.playing && clip.paused) clip.play().catch(() => {}); else if (!G.playing) clip.pause(); }
      else { schedule(); syncMusic(); }
      if (!G.playing) clearTimeout(slideTimer);
      showControls();
    }
    function toggleSlideshow() { setSlideshow(!G.playing); }
    async function retryViewer() {
      if (G.loading || !G.viewer) return;
      G.loading = true; const generation = ++G.generation, id = G.data.items[G.index]?.id, oldIndex = G.index, source = G.source;
      const retry = $('#photo-view-retry'); if (retry) retry.disabled = true;
      try {
        const data = await request(G.offset);
        if (!G.active || !G.viewer || generation !== G.generation) return;
        if (!data.items.length) throw new Error('这页照片已变更，请返回列表刷新');
        G.data = data; const index = data.items.findIndex(p => p.id === id);
        openViewer(index >= 0 ? index : Math.min(oldIndex, data.items.length - 1), false, source);
      } catch (err) { if (G.active && G.viewer && generation === G.generation) { if (retry) retry.disabled = false; toast(err.message); } }
      finally { if (generation === G.generation) G.loading = false; }
    }
    function transform() {
      const img = $('#photo-full'); if (!img) return;
      img.classList.toggle('turned', G.rotation % 180 !== 0);
      img.style.transform = `rotate(${G.rotation}deg) scale(${G.zoom ? 1.5 : 1})`;
      $('#photo-zoom').textContent = G.zoom ? '适应屏幕' : '放大';
    }
    function applyDisplay() { ($('#photo-full') || $('#photo-clip'))?.classList.toggle('photo-fill', G.display === 'fill'); }
    function cancelVideoCandidate(restore = true) {
      const pending = G.videoPending; if (!pending) return;
      G.videoPending = null; pending.cleanup?.();
      // A commit already sent has an unknown outcome until active reconciles
      // it. Closing the viewer separately closes its whole owned session.
      if (pending.committing) return;
      if (restore) pending.restore?.();
      api('/api/photos/video/discard', { id: pending.id, request: pending.request, candidate: pending.candidate }, undefined, pending.connection).catch(() => {});
    }
    function closeInfo({ keepCandidate = false } = {}) {
      const resume = G.resumeAfterDialog, resumeClip = G.dialogResumeClip, returnFocus = G.dialogReturnFocus;
      if (G.dialogType === 'quality' && !keepCandidate) cancelVideoCandidate();
      G.infoOpen = false; G.dialogType = null; G.resumeAfterDialog = false; G.dialogResumeClip = false; $('#photo-info-dialog')?.remove();
      focus($('#' + (returnFocus || 'photo-info'))); showControls();
      if (G.active && G.viewer && !document.hidden) { if (resume) setSlideshow(true); else if (resumeClip && $('#photo-clip')) $('#photo-clip').play().catch(() => {}); }
      if (G.uhdNeedsRerender && G.uhdPreferred && G.viewer) { G.uhdNeedsRerender = false; startUhd(G.previewOverride || G.data.items[G.index], true); }
    }
    function settingsLabel(key) {
      if (key === 'interval') return `时长：${G.interval} 秒`;
      if (key === 'mode') return '播放：' + ({ sequential: '顺序', random: G.data?.totalKnown === false ? '随机（本页）' : '随机', loop: '循环' })[G.mode];
      if (key === 'display') return '显示：' + (G.display === 'fill' ? '填充' : '适应');
      return '背景音乐：' + (G.musicEnabled ? G.musicTrack?.name || '已开启' : '关闭');
    }
    function changeSetting(key, delta = 1) {
      const options = { interval: [2, 3, 5, 10, 15], mode: ['sequential', 'random', 'loop'], display: ['fit', 'fill'] }[key];
      if (!options) return;
      G[key] = options[(options.indexOf(G[key]) + delta + options.length) % options.length];
      store.set({ interval: 'photoInterval', mode: 'photoMode', display: 'photoDisplay' }[key], String(G[key]));
      const button = $(`[data-photo-setting="${key}"]`); if (button) button.textContent = settingsLabel(key);
      if ($('#photo-interval')) $('#photo-interval').textContent = `间隔 ${G.interval} 秒`;
      applyDisplay(); schedule();
      if (key === 'display' && G.uhdJob) { G.uhdNeedsRerender = true; stopUhd(); }
    }
    async function chooseMusic() {
      const content = $('#photo-music-choices'), generation = G.imageGeneration;
      if (!content) return;
      content.textContent = '正在读取 NAS 音乐…';
      try {
        const tracks = await musicList();
        if (!G.infoOpen || G.dialogType !== 'settings' || generation !== G.imageGeneration || !tracks) return;
        content.innerHTML = `<button id="photo-music-off">关闭背景音乐</button>${tracks.map((track, index) => `<button data-photo-track="${index}">${esc(track.name)}${G.musicEnabled && G.musicTrack?.id === track.id ? ' ✓' : ''}</button>`).join('')}${tracks.length ? '' : '<p>NAS 当前没有可用的幻灯片音乐</p>'}`;
        const select = index => {
          stopMusic(); softwareMusic?.stop().catch(() => {}); G.musicPosition = 0; G.musicError = false; G.musicEnabled = index >= 0; G.musicIndex = Math.max(0, index); G.musicTrack = index >= 0 ? tracks[index] : null;
          store.set('photoMusicOn', G.musicEnabled ? '1' : '0'); store.set('photoMusicIndex', String(G.musicIndex));
          content.innerHTML = ''; $('#photo-music-setting').textContent = settingsLabel('music'); focus($('#photo-music-setting'));
        };
        $('#photo-music-off').onclick = () => select(-1);
        content.querySelectorAll('[data-photo-track]').forEach(button => button.onclick = () => select(Number(button.dataset.photoTrack)));
        focus(content.querySelector('button'));
      } catch (e) { if (G.infoOpen && G.dialogType === 'settings' && generation === G.imageGeneration) content.textContent = e.message; }
    }
    function openSettings() {
      if (G.infoOpen || !G.viewer || G.loading) return;
      const resume = G.playing, resumeClip = Boolean($('#photo-clip') && !$('#photo-clip').paused);
      setSlideshow(false); G.infoOpen = true; G.dialogType = 'settings'; G.resumeAfterDialog = resume; G.dialogResumeClip = resumeClip; G.dialogReturnFocus = 'photo-settings';
      const dialog = document.createElement('section'); dialog.id = 'photo-info-dialog'; dialog.className = 'photo-info-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '幻灯片设置');
      dialog.innerHTML = `<div class="photo-info-panel"><h2>幻灯片设置</h2><div id="photo-info-content" class="photo-settings-list">${['interval', 'mode', 'display'].map(key => `<button data-photo-setting="${key}">${esc(settingsLabel(key))}</button>`).join('')}<button id="photo-music-setting">${esc(settingsLabel('music'))}</button><div id="photo-music-choices"></div><p>上下选择 · 左右调整 · 音乐只在图片幻灯片时播放</p></div><button id="photo-info-close">完成</button></div>`;
      root.appendChild(dialog); dialog.querySelectorAll('[data-photo-setting]').forEach(button => button.onclick = () => changeSetting(button.dataset.photoSetting));
      $('#photo-music-setting').onclick = chooseMusic; $('#photo-info-close').onclick = closeInfo; focus(dialog.querySelector('button'));
    }
    async function openInfo() {
      if (G.infoOpen || !G.viewer || G.loading) return;
      setSlideshow(false); G.infoOpen = true; G.dialogType = 'info'; G.resumeAfterDialog = false; G.dialogReturnFocus = 'photo-info'; const imageGeneration = G.imageGeneration, p = G.data.items[G.index];
      const dialog = document.createElement('section'); dialog.id = 'photo-info-dialog'; dialog.className = 'photo-info-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '照片信息');
      dialog.innerHTML = '<div class="photo-info-panel"><h2>照片信息</h2><div id="photo-info-content">正在读取…</div><button id="photo-info-close">关闭</button></div>'; root.appendChild(dialog); $('#photo-info-close').onclick = closeInfo; focus($('#photo-info-close'));
      try {
        const data = p.info ? await api(p.info) : { item: p, metadata: {} };
        if (!G.active || !G.viewer || !G.infoOpen || G.dialogType !== 'info' || $('#photo-info-dialog') !== dialog || imageGeneration !== G.imageGeneration) return;
        const item = data.item || p, m = data.metadata || {};
        const rows = [['名称', item.name], ['文件格式', item.format?.toUpperCase()], ['原始尺寸', item.width && item.height ? `${item.width} × ${item.height}` : ''], ['文件大小', bytes(item.size)], ['拍摄时间', m.created || date(item.date)], ['修改时间', m.modified], ['相机', m.camera], ['镜头', m.lens], ['焦距', m.focalLength], ['光圈', m.aperture], ['曝光', m.exposure], ['ISO', m.iso], ['地点', m.location]].filter(([, value]) => value);
        $('#photo-info-content').innerHTML = `<dl>${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
      } catch (e) { if (G.infoOpen && G.dialogType === 'info' && $('#photo-info-dialog') === dialog && imageGeneration === G.imageGeneration && $('#photo-info-content')) $('#photo-info-content').textContent = e.message; }
    }
    async function openQuality(p) {
      const clip = $('#photo-clip'); if (!clip || G.infoOpen || !G.viewer) return;
      const generation = G.imageGeneration, resume = G.playing, resumeClip = !clip.paused, connection = G.videoSession?.connection || captureConnection();
      setSlideshow(false); G.infoOpen = true; G.dialogType = 'quality'; G.resumeAfterDialog = resume; G.dialogResumeClip = resumeClip; G.dialogReturnFocus = 'photo-video-quality';
      const dialog = document.createElement('section'); dialog.id = 'photo-info-dialog'; dialog.className = 'photo-info-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '相册视频画质');
      dialog.innerHTML = '<div class="photo-info-panel"><h2>视频画质</h2><div id="photo-info-content" class="photo-settings-list">正在读取 NAS 可用画质…</div><button id="photo-info-close">返回</button></div>'; root.appendChild(dialog); $('#photo-info-close').onclick = closeInfo; focus($('#photo-info-close'));
      const current = () => G.active && G.viewer && G.infoOpen && G.dialogType === 'quality' && $('#photo-info-dialog') === dialog && generation === G.imageGeneration;
      try {
        if (!G.videoSession) {
          const started = await api('/api/photos/video/start', { asset: p.stream.slice(p.stream.lastIndexOf('/') + 1) }, undefined, connection);
          if (!current()) { if (started.id) api('/api/photos/video/close', { id: started.id }, undefined, connection).catch(() => {}); return; }
          G.videoSession = { ...started, connection };
        }
        if (!current()) return;
        const session = G.videoSession, qualities = session.options?.qualities || [];
        if (session.unconfirmed) {
          const active = await api('/api/photos/video/active?id=' + encodeURIComponent(session.id), undefined, undefined, session.connection).catch(() => null);
          if (!current() || G.videoSession !== session) return;
          if (active && typeof active.selected === 'string') { session.selected = active.selected; session.unconfirmed = false; if ($('#photo-video-quality')) $('#photo-video-quality').textContent = '画质：' + (active.quality?.label || active.selected); }
        }
        $('#photo-info-content').innerHTML = qualities.map((quality, i) => `<button data-photo-quality="${i}">${esc(quality.label)}${quality.resolution ? ` · ${esc(quality.resolution)}` : ''}${quality.id === (session.selected || 'original') ? ' ✓' : ''}</button>`).join('') || '<p>NAS 当前没有返回可用画质</p>';
        dialog.querySelectorAll('[data-photo-quality]').forEach(button => button.onclick = async () => {
          const quality = qualities[Number(button.dataset.photoQuality)]; if (!quality || session.busy) return;
          session.busy = true; dialog.querySelectorAll('[data-photo-quality]').forEach(item => item.disabled = true);
          const position = clip.currentTime, request = 'quality-' + (G.videoRequestCounter = (G.videoRequestCounter || 0) + 1);
          const pending = G.videoPending = { id: session.id, request, candidate: null, connection: session.connection };
          try {
            const result = await api('/api/photos/video/quality', { id: session.id, quality: quality.id, request }, undefined, session.connection);
            if (!current() || G.videoSession !== session || G.videoPending !== pending) { api('/api/photos/video/discard', { id: session.id, candidate: result.candidate, request }, undefined, session.connection).catch(() => {}); return; }
            pending.candidate = result.candidate;
            const oldUrl = clip.src, oldError = clip.onerror, qualityButton = $('#photo-video-quality'); qualityButton.disabled = true;
            let frameTimer;
            const restorePosition = () => { if (generation !== G.imageGeneration) return; try { clip.currentTime = Math.min(position, Number.isFinite(clip.duration) ? Math.max(0, clip.duration - .1) : position); clip.playbackRate = G.videoRate; } catch { toast('画质已切换，当前电视未能恢复播放位置'); } };
            const rollback = () => {
              if (generation !== G.imageGeneration) return;
              clip.pause(); clip.removeAttribute('src'); clip.load(); clip.addEventListener('loadedmetadata', restorePosition, { once: true }); clip.src = oldUrl; clip.load();
              if (resume || resumeClip) clip.play().catch(() => {});
            };
            const failed = () => { if (G.videoPending !== pending || pending.committing) return; cancelVideoCandidate(); toast('这个画质未能开始播放，已保留之前的画质'); };
            const accepted = async () => {
              if (G.videoPending !== pending || generation !== G.imageGeneration) return;
              clearTimeout(frameTimer); pending.committing = true;
              try {
                let result;
                try { result = await api('/api/photos/video/commit', { id: session.id, candidate: pending.candidate }, undefined, session.connection); }
                catch (commitError) {
                  if (G.videoPending !== pending || generation !== G.imageGeneration || G.videoSession !== session) return;
                  const actual = await api('/api/photos/video/active?id=' + encodeURIComponent(session.id), undefined, undefined, session.connection).catch(() => null);
                  if (actual?.candidate === pending.candidate) result = actual;
                  else if (actual) throw commitError;
                  else { pending.cleanup(); G.videoPending = null; session.selected = 'unconfirmed'; session.unconfirmed = true; qualityButton.textContent = '画质：待确认'; toast('画质提交结果尚未确认，可重新打开画质菜单核对'); return; }
                }
                if (G.videoPending !== pending || generation !== G.imageGeneration) return;
                session.selected = result.selected || quality.id; qualityButton.textContent = '画质：' + (result.quality?.label || quality.label); pending.cleanup(); G.videoPending = null; if (result.warning) toast(result.warning);
              } catch { pending.committing = false; failed(); }
              finally { pending.committing = false; }
            };
            pending.cleanup = () => { clearTimeout(frameTimer); clip.removeEventListener('loadeddata', accepted); clip.removeEventListener('error', failed); clip.removeEventListener('loadedmetadata', restorePosition); clip.onerror = oldError; qualityButton.disabled = false; if (!G.videoPending || G.videoPending === pending) session.busy = false; };
            pending.restore = rollback;
            clip.onerror = null; clip.addEventListener('error', failed, { once: true }); clip.addEventListener('loadeddata', accepted, { once: true }); clip.addEventListener('loadedmetadata', restorePosition, { once: true });
            clip.pause(); clip.removeAttribute('src'); clip.load();
            clip.src = asset(result.url); clip.load(); frameTimer = setTimeout(failed, 20000); closeInfo({ keepCandidate: true });
            // Preload metadata alone need not decode a first frame. Keep one
            // video element, and begin it only if it was playing beforehand.
          } catch (error) { if (G.videoPending === pending) cancelVideoCandidate(); if (current()) { toast(error.message); dialog.querySelectorAll('[data-photo-quality]').forEach(item => item.disabled = false); focus(button); } }
          finally { if (!G.videoPending || G.videoPending.id !== session.id) session.busy = false; }
        });
        focus(dialog.querySelector('[data-photo-quality]') || $('#photo-info-close'));
      } catch (error) { if (current()) $('#photo-info-content').textContent = error.message; }
    }
    function openViewer(index, playing = false, source = 'preview') {
      stopMedia(); G.viewer = true; G.index = index; G.playing = playing; G.rotation = 0; G.zoom = false; G.loading = false; G.ready = false; G.infoOpen = false; G.source = source;
      const item = G.data.items[index]; if (G.previewOverride?.id !== item.id) G.previewOverride = null;
      const p = G.previewOverride || item, isVideo = !(p.sensitive && !p.revealed) && (p.kind === 'video' || (source === 'live' && p.motion));
      if (isVideo) stopMusic();
      const isOriginal = !isVideo && source === 'original' && p.original;
      const counter = G.data.totalKnown === false ? `本页 ${index + 1} / ${G.data.items.length}` : `${G.offset + index + 1} / ${Number(G.data.total).toLocaleString()}`;
      root.innerHTML = `<section class="photo-viewer" aria-label="全屏查看"><div class="photo-canvas">${isVideo ? '<video id="photo-clip" playsinline preload="metadata"></video>' : '<img id="photo-full" alt="">'}<div id="photo-view-loading"><span class="spinner"></span></div></div><div class="photo-view-top photo-overlay"><button id="photo-close">‹ 返回</button><div><b>${esc(p.name)}</b><span>${esc(date(p.date))}${p.width && p.height ? ` · ${p.width} × ${p.height}` : ''}${isOriginal ? ' · 原图文件' : source === 'live' ? ' · 实况播放' : ''}</span></div><span class="photo-counter">${counter}</span></div><div id="photo-view-error" role="status"></div><div class="photo-view-bottom photo-overlay"><div class="photo-view-buttons"><button id="photo-previous">‹ 上一项</button>${isVideo ? '<button id="photo-video-pause">暂停视频</button>' : ''}<button id="photo-slideshow">${playing ? '暂停幻灯片' : '播放幻灯片'}</button><button id="photo-interval">间隔 ${G.interval} 秒</button>${!isVideo ? '<button id="photo-rotate">旋转</button><button id="photo-zoom">放大</button>' : ''}${!isVideo && p.original ? `<button id="photo-original">${isOriginal ? '预览图' : '原图'}</button>` : ''}${p.motion ? `<button id="photo-motion">${source === 'live' ? '静态照片' : '播放实况'}</button>` : ''}<button id="photo-info">信息</button>${!isVideo && p.original && nativePhotoViewer ? '<button id="photo-native">系统查看</button>' : ''}<button id="photo-next">下一项 ›</button></div><p>左右切换 · 确定显示操作 · 返回照片列表</p></div></section>`;
      $('#photo-close').onclick = closeViewer; $('#photo-previous').onclick = () => step(-1); $('#photo-next').onclick = () => step(1);
      $('#photo-slideshow').onclick = toggleSlideshow;
      $('#photo-info').onclick = openInfo;
      if (p.sensitive) {
        const button = document.createElement('button'); button.id = 'photo-sensitive'; button.textContent = p.revealed ? '隐藏图像' : '显示图像'; $('#photo-info').before(button);
        button.onclick = async () => {
          if (G.loading) return; setSlideshow(false); button.disabled = true; const generation = G.imageGeneration;
          try {
            const key = p.view.slice(p.view.lastIndexOf('/') + 1), result = await api('/api/photos/preview-visibility', { asset: key, show: !p.revealed });
            if (!G.active || !G.viewer || generation !== G.imageGeneration) return;
            G.previewOverride = result.item; openViewer(index, false, 'preview');
          } catch (e) { if (G.active && generation === G.imageGeneration) toast(e.message); }
          finally { if (button.isConnected) button.disabled = false; }
        };
      }
      const settingsButton = document.createElement('button'); settingsButton.id = 'photo-settings'; settingsButton.textContent = '幻灯片设置'; settingsButton.onclick = openSettings; $('#photo-info').before(settingsButton);
      if (!isVideo && p.kind === 'image' && p.original) {
        const uhdButton = document.createElement('button'); uhdButton.id = 'photo-uhd'; uhdButton.textContent = '4K 视频显示'; $('#photo-info').before(uhdButton);
        uhdButton.onclick = () => {
          if (G.uhdJob) { G.uhdPreferred = false; store.set('photoUhd', '0'); stopUhd(); schedule(); syncMusic(); }
          else { G.uhdPreferred = true; store.set('photoUhd', '1'); startUhd(p); }
          showControls();
        };
      }
      if ($('#photo-original')) $('#photo-original').onclick = () => {
        G.uhdPreferred = false; store.set('photoUhd', '0'); stopUhd();
        if (isOriginal) return openViewer(index);
        if (p.output?.browserOriginalCandidate === false) { toast(`${p.format?.toUpperCase() || '此格式'} 原图暂不能在当前查看器中显示，请使用预览图。`); showControls(); return; }
        openViewer(index, false, 'original');
      };
      if ($('#photo-motion')) $('#photo-motion').onclick = () => openViewer(index, false, source === 'live' ? 'preview' : 'live');
      if ($('#photo-native')) $('#photo-native').onclick = () => { setSlideshow(false); stopUhd(); Promise.resolve(nativePhotoViewer({ ...p, url: asset(p.original) })).catch(e => toast(e.message)); };
      $('#photo-interval').onclick = () => { changeSetting('interval'); showControls(); };
      const imageGeneration = ++G.imageGeneration;
      const failure = () => {
        if (!G.active || imageGeneration !== G.imageGeneration) return;
        if (!isVideo && G.uhdActive) { $('#photo-view-loading').style.display = 'none'; $('#photo-view-error').replaceChildren(); return; }
        G.playing = false; stopMusic(); clearTimeout(slideTimer); $('#photo-view-loading').style.display = 'none';
        $('#photo-slideshow').textContent = '播放幻灯片';
        $('#photo-view-error').innerHTML = `<p>${isVideo ? '电视无法播放这个视频，可能是编码不受支持。' : isOriginal ? '原图无法显示，可能是文件格式或尺寸不受电视支持。' : '照片加载失败，请检查 NAS 连接。'}</p>${isOriginal ? '<button id="photo-preview-fallback">使用预览图</button>' : ''}<button id="photo-view-retry">重试</button><button id="photo-error-back">返回列表</button>`;
        $('#photo-view-retry').onclick = retryViewer; $('#photo-error-back').onclick = closeViewer; showControls(); focus($('#photo-error-back'));
        if ($('#photo-preview-fallback')) $('#photo-preview-fallback').onclick = () => openViewer(index);
      };
      if (isVideo) {
        const clip = $('#photo-clip');
        const restart = document.createElement('button'); restart.id = 'photo-video-restart'; restart.textContent = '重新播放'; $('#photo-video-pause').after(restart);
        restart.onclick = () => { try { if (clip.readyState < 1) { toast('视频尚未准备好'); return; } clip.currentTime = 0; clip.play().catch(e => { if (e.name !== 'AbortError') failure(); }); } catch { toast('此视频暂时无法重新定位'); } showControls(); };
        const speed = document.createElement('button'); speed.id = 'photo-video-speed'; speed.textContent = `${G.videoRate}× 速度`; restart.after(speed);
        speed.onclick = () => { const values = [.5, .75, 1, 1.25, 1.5, 2], rate = values[(values.indexOf(G.videoRate) + 1) % values.length]; try { clip.playbackRate = rate; G.videoRate = rate; store.set('photoVideoRate', String(rate)); speed.textContent = `${rate}× 速度`; } catch { toast('电视暂不支持这个播放速度'); } showControls(); };
        try { clip.playbackRate = G.videoRate; } catch { G.videoRate = 1; speed.textContent = '1× 速度'; }
        if (source !== 'live' && p.stream) { const quality = document.createElement('button'); quality.id = 'photo-video-quality'; quality.textContent = '画质：原画'; quality.onclick = () => openQuality(p); speed.after(quality); }
        $('#photo-video-pause').onclick = () => { if (clip.paused) clip.play().catch(err => { if (err.name !== 'AbortError') failure(); }); else clip.pause(); showControls(); };
        clip.onplay = () => { if (G.active && imageGeneration === G.imageGeneration && $('#photo-video-pause')) $('#photo-video-pause').textContent = '暂停视频'; };
        clip.onpause = () => { if (G.active && imageGeneration === G.imageGeneration && $('#photo-video-pause')) $('#photo-video-pause').textContent = '播放视频'; };
        clip.onloadeddata = () => { if (imageGeneration === G.imageGeneration) $('#photo-view-loading').style.display = 'none'; };
        clip.onended = () => { if (!G.active || imageGeneration !== G.imageGeneration) return; if (G.playing) step(1, true); else if (source === 'live') openViewer(index); else showControls(); }; clip.onerror = failure;
        const stream = source === 'live' ? p.motion : p.stream;
        if (stream) { clip.src = asset(stream); clip.play().catch(err => { if (err.name !== 'AbortError') failure(); }); } else failure();
      } else {
        const img = $('#photo-full'); img.alt = p.name;
        $('#photo-rotate').onclick = () => { G.rotation = (G.rotation + 90) % 360; transform(); showControls(); };
        $('#photo-zoom').onclick = () => { G.zoom = !G.zoom; transform(); showControls(); };
        img.onload = () => {
          if (!G.active || imageGeneration !== G.imageGeneration) return;
          G.ready = true; $('#photo-view-loading').style.display = 'none';
          if (G.uhdPreferred && p.original && !G.uhdJob) startUhd(p, true);
          schedule(); syncMusic();
          const next = G.data.items[index + 1];
          if (next?.kind === 'image') { preload = new Image(); preload.src = asset(next.view); }
        };
        img.onerror = failure; img.src = asset(isOriginal ? p.original : p.view);
      }
      applyDisplay(); focus($('#photo-close')); showControls();
    }
    async function step(delta, automatic = false) {
      if (G.loading || !G.viewer || G.infoOpen) return;
      let index = G.index + delta, offset = G.offset, random = automatic && G.mode === 'random';
      if (random) {
        const total = G.data.totalKnown === false ? G.data.items.length : Number(G.data.total) || G.data.items.length;
        if (total <= 1) { schedule(); return; }
        const current = G.data.totalKnown === false ? G.index : G.offset + G.index;
        let target = Math.floor(Math.random() * (total - 1)); if (target >= current) target++;
        if (G.data.totalKnown === false) index = target;
        else { offset = Math.floor(target / G.data.limit) * G.data.limit; index = target - offset; }
      }
      if (offset === G.offset && index >= 0 && index < G.data.items.length) return openViewer(index, G.playing);
      if (!random) offset = G.offset + delta * G.data.limit;
      if (offset < 0 || (!random && delta > 0 && G.data.last)) {
        if (automatic && G.mode === 'loop' && delta > 0) { offset = 0; index = 0; if (G.offset === 0) return openViewer(0, G.playing); }
        else { setSlideshow(false); toast(delta > 0 ? '已到最后一项' : '已到第一项'); return; }
      }
      G.loading = true; clearTimeout(slideTimer); const generation = ++G.generation;
      try {
        const data = await request(offset);
        if (!G.active || !G.viewer || generation !== G.generation) return;
        if (!data.items.length) { setSlideshow(false); toast(data.last ? '已到最后一项' : '这一页没有照片，请返回列表选择其他页'); return; }
        G.offset = offset; G.data = data; openViewer(random ? Math.min(index, data.items.length - 1) : delta > 0 ? 0 : data.items.length - 1, G.playing);
      } catch (err) { if (G.active && generation === G.generation) { setSlideshow(false); toast(err.message); } }
      finally { if (generation === G.generation) G.loading = false; }
    }
    function closeViewer() { stopMedia(); stopMusic(); ++G.generation; G.loading = false; G.viewer = false; G.playing = false; G.infoOpen = false; G.previewOverride = null; render(G.index); }
    function back() {
      if (G.infoOpen) { closeInfo(); return; }
      if (G.viewer) { closeViewer(); return; }
      if (G.album) { G.album = null; G.offset = G.albumPage; load(); return; }
      if (G.group) { G.group = null; G.offset = G.groupPage; load(); return; }
      if (G.memory) { G.memory = null; G.offset = 0; load(); return; }
      if (G.folder) { const previous = G.folderBack.pop() || { folder: null, offset: 0 }; G.folder = previous.folder; G.offset = previous.offset; load(); return; }
      exit();
    }
    function key(e) {
      if (!G.viewer) return false;
      const code = e.keyCode;
      if (G.infoOpen) {
        if ([37, 38, 39, 40].includes(code)) {
          e.preventDefault();
          if (G.dialogType === 'settings' || G.dialogType === 'quality') {
            const buttons = [...$('#photo-info-dialog').querySelectorAll('button')].filter(button => !button.disabled && button.offsetParent !== null), index = buttons.indexOf(document.activeElement);
            if (code === 38 || code === 40) focus(buttons[Math.max(0, Math.min(buttons.length - 1, index + (code === 40 ? 1 : -1)))]);
            else if (document.activeElement?.dataset.photoSetting) changeSetting(document.activeElement.dataset.photoSetting, code === 39 ? 1 : -1);
          } else if (code === 38 || code === 40) $('#photo-info-content')?.scrollBy(0, code === 40 ? 100 : -100);
          return true;
        }
        return false;
      }
      if ([37, 39].includes(code)) {
        // Down opens the toolbar; left/right then navigate its buttons.
        if (!G.controls || !$('.photo-view-buttons')?.contains(document.activeElement)) { e.preventDefault(); step(code === 39 ? 1 : -1); return true; }
      }
      if (code === 13 && !G.controls) { e.preventDefault(); showControls(); focus($('#photo-slideshow')); return true; }
      if (code === 40 && !$('.photo-view-buttons')?.contains(document.activeElement)) { e.preventDefault(); showControls(); focus($('#photo-slideshow')); return true; }
      if (code === 415 || code === 19) { e.preventDefault(); setSlideshow(code === 415); return true; }
      if ([179, 10252].includes(code) || e.code === 'Space') { e.preventDefault(); if (!e.repeat) toggleSlideshow(); return true; }
      if (code === 413) { e.preventDefault(); closeViewer(); return true; }
      showControls(); return false;
    }
    document.addEventListener('mousemove', () => { if (G.active && G.viewer) showControls(); });
    document.addEventListener('visibilitychange', () => {
      if (!G.active || !document.hidden) return;
      G.playing = false; clearTimeout(slideTimer); $('#photo-clip')?.pause();
      stopUhd(); stopMusic();
      if ($('#photo-slideshow')) $('#photo-slideshow').textContent = '播放幻灯片';
    });
    return { open() { G.active = true; return load(); }, leave, back, key, reset() { leave(); G.tab = 'timeline'; G.album = null; G.group = null; G.folder = null; G.folderBack = []; G.memory = null; G.offset = 0; G.data = null; G.search = ''; G.musicTrack = null; G.musicItems = null; G.musicPosition = 0; G.musicError = false; } };
  };
})();
