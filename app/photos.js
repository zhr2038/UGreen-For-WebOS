(() => {
  'use strict';
  window.createPhotoGallery = ({ root, api, asset, esc, header, nav, bind, focus, toast, store, exit }) => {
    const $ = selector => root.querySelector(selector);
    const G = { active: false, tab: 'timeline', album: null, albumPage: 0, offset: 0, data: null, filter: 'all', sort: 'date', viewer: false, index: 0, playing: false, interval: Number(store.get('photoInterval', '5')), rotation: 0, zoom: false, controls: true, generation: 0, imageGeneration: 0, loading: false };
    let slideTimer, hideTimer, preload;
    const date = value => value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '日期未知';
    const month = value => value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' }) : '日期未知';
    const duration = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
    const thumb = (path, name) => path ? `<img src="${esc(asset(path))}" alt="${esc(name)}" loading="lazy">` : '<span class="photo-placeholder">▧</span>';
    function stopMedia() {
      clearTimeout(slideTimer); clearTimeout(hideTimer); ++G.imageGeneration;
      const clip = $('#photo-clip');
      if (clip) { clip.onplay = clip.onpause = clip.onloadeddata = clip.onended = clip.onerror = null; clip.pause(); clip.removeAttribute('src'); clip.load(); }
      if (preload) { preload.onload = preload.onerror = null; preload.src = ''; preload = null; }
    }
    function leave() { G.active = false; G.playing = false; G.viewer = false; ++G.generation; stopMedia(); }
    function query(offset) {
      const params = new URLSearchParams({ offset, filter: G.filter, sort: G.sort });
      if (G.album) { params.set('album', G.album.id); params.set('type', G.album.type); }
      else if (G.tab === 'favorites') params.set('favorites', '1');
      return params;
    }
    function request(offset) { return api((G.tab === 'albums' && !G.album ? '/api/photos/albums?' : '/api/photos/list?') + query(offset)); }
    function shell(content) { root.innerHTML = `${header('相册')}${nav('photos')}<main class="screen library-screen photo-screen">${content}</main>`; bind(); }
    function error(err, retry) {
      shell(`<div class="photo-error"><h2>暂时无法打开相册</h2><p>${esc(err.message)}</p><button class="action" id="photo-retry">重试</button></div>`);
      $('#photo-retry').onclick = retry; focus($('#photo-retry'));
    }
    function render(targetIndex = 0) {
      const data = G.data;
      const albums = G.tab === 'albums' && !G.album;
      const title = G.album?.name || (albums ? '我的相册' : G.tab === 'favorites' ? '喜欢的照片' : '所有照片');
      let content = '';
      if (albums) content = `<div class="photo-albums">${data.items.map((a, n) => `<button class="photo-album" data-album="${n}"><div class="photo-album-art">${thumb(a.cover, a.name)}<span>${Number(a.total).toLocaleString()} 项</span></div><b>${esc(a.name)}</b></button>`).join('')}</div>`;
      else {
        let previousMonth = '';
        content = data.items.map((p, n) => {
          const group = month(p.date), heading = group !== previousMonth ? `<h3 class="photo-month">${esc(group)}</h3>` : ''; previousMonth = group;
          return `${heading}<button class="photo-tile" data-photo="${n}" aria-label="${esc(p.name)}，${p.kind === 'video' ? '视频' : '照片'}"><div>${thumb(p.thumb, p.name)}${p.kind === 'video' ? `<span class="photo-badge">▶ ${duration(p.duration)}</span>` : p.live ? '<span class="photo-badge">实况</span>' : ''}${p.favorite ? '<span class="photo-heart">♥</span>' : ''}</div></button>`;
        }).join('');
        content = `<div class="photo-grid">${content}</div>`;
      }
      shell(`<div class="photo-tabs" aria-label="相册分类">${[['timeline', '照片'], ['albums', '相册'], ['favorites', '喜欢']].map(([key, label]) => `<button data-photo-tab="${key}" class="${G.tab === key ? 'selected' : ''}">${label}</button>`).join('')}<span>记录生活，随时重温</span></div><div class="photo-heading">${G.album ? '<button id="photo-album-back" aria-label="返回相册列表">‹</button>' : ''}<div><h2>${esc(title)}</h2><p>${Number(data.total).toLocaleString()} ${albums ? '个相册' : '项'}${data.items.length ? ` · 第 ${Math.floor(G.offset / data.limit) + 1} 页` : ''}</p></div>${!albums ? '<button class="action secondary" id="photo-start">幻灯片播放</button>' : ''}</div>${!albums ? `<div class="photo-filters"><select id="photo-filter" aria-label="照片类型"><option value="all">全部照片和视频</option><option value="image">仅照片</option><option value="video">仅视频</option></select><select id="photo-sort" aria-label="照片排序"><option value="date">拍摄时间 · 从新到旧</option><option value="oldest">拍摄时间 · 从旧到新</option><option value="upload">添加时间 · 从新到旧</option></select><span>方向键选择 · 确定打开 · 返回退出</span></div>` : ''}${data.items.length ? content : '<div class="empty">这里还没有内容</div>'}<div class="photo-pagination">${G.offset > 0 ? '<button class="action secondary" id="photo-prev-page">上一页</button>' : ''}<span>${data.items.length ? `${G.offset + 1}–${G.offset + data.items.length} / ${Number(data.total).toLocaleString()}` : ''}</span>${!data.last ? '<button class="action secondary" id="photo-next-page">下一页</button>' : ''}</div>`);
      root.querySelectorAll('[data-photo-tab]').forEach(b => b.onclick = () => { G.tab = b.dataset.photoTab; G.album = null; G.offset = 0; load(); });
      root.querySelectorAll('[data-photo]').forEach(b => b.onclick = () => openViewer(Number(b.dataset.photo)));
      root.querySelectorAll('[data-album]').forEach(b => b.onclick = () => { G.albumPage = G.offset; G.album = data.items[Number(b.dataset.album)]; G.offset = 0; load(); });
      if ($('#photo-album-back')) $('#photo-album-back').onclick = back;
      if ($('#photo-start')) { $('#photo-start').disabled = !data.items.length; $('#photo-start').onclick = () => openViewer(0, true); }
      for (const id of ['filter', 'sort']) if ($('#photo-' + id)) { $('#photo-' + id).value = G[id]; $('#photo-' + id).onchange = e => { G[id] = e.target.value; G.offset = 0; load(); }; }
      if ($('#photo-prev-page')) $('#photo-prev-page').onclick = () => { G.offset = Math.max(0, G.offset - data.limit); load(); };
      if ($('#photo-next-page')) $('#photo-next-page').onclick = () => { G.offset += data.limit; load(); };
      root.querySelectorAll('.photo-tile img,.photo-album img').forEach(img => img.onerror = () => { img.style.visibility = 'hidden'; });
      focus($(`[data-photo="${targetIndex}"]`) || $('[data-album]') || $('[data-photo-tab]'));
    }
    async function load() {
      stopMedia(); G.viewer = false; G.playing = false; G.loading = true;
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
      hideTimer = setTimeout(() => { if (G.viewer && !$('#photo-view-error')?.textContent) { G.controls = false; $('.photo-viewer')?.classList.add('clean'); } }, 5000);
    }
    function schedule() {
      clearTimeout(slideTimer);
      if (G.ready && G.playing && G.viewer && G.active && !document.hidden && !$('#photo-clip')) slideTimer = setTimeout(() => step(1), G.interval * 1000);
    }
    function setSlideshow(playing) {
      G.playing = playing;
      if ($('#photo-slideshow')) $('#photo-slideshow').textContent = G.playing ? '暂停幻灯片' : '播放幻灯片';
      const clip = $('#photo-clip');
      if (clip) { if (G.playing && clip.paused) clip.play().catch(() => {}); else if (!G.playing) clip.pause(); }
      else schedule();
      if (!G.playing) clearTimeout(slideTimer);
      showControls();
    }
    function toggleSlideshow() { setSlideshow(!G.playing); }
    async function retryViewer() {
      if (G.loading || !G.viewer) return;
      G.loading = true; const generation = ++G.generation, id = G.data.items[G.index]?.id, oldIndex = G.index;
      const retry = $('#photo-view-retry'); if (retry) retry.disabled = true;
      try {
        const data = await request(G.offset);
        if (!G.active || !G.viewer || generation !== G.generation) return;
        if (!data.items.length) throw new Error('这页照片已变更，请返回列表刷新');
        G.data = data; const index = data.items.findIndex(p => p.id === id);
        openViewer(index >= 0 ? index : Math.min(oldIndex, data.items.length - 1));
      } catch (err) { if (G.active && G.viewer && generation === G.generation) { if (retry) retry.disabled = false; toast(err.message); } }
      finally { if (generation === G.generation) G.loading = false; }
    }
    function transform() {
      const img = $('#photo-full'); if (!img) return;
      img.classList.toggle('turned', G.rotation % 180 !== 0);
      img.style.transform = `rotate(${G.rotation}deg) scale(${G.zoom ? 1.5 : 1})`;
      $('#photo-zoom').textContent = G.zoom ? '适应屏幕' : '放大';
    }
    function openViewer(index, playing = false) {
      stopMedia(); G.viewer = true; G.index = index; G.playing = playing; G.rotation = 0; G.zoom = false; G.loading = false; G.ready = false;
      const p = G.data.items[index], isVideo = p.kind === 'video';
      root.innerHTML = `<section class="photo-viewer" aria-label="全屏查看"><div class="photo-canvas">${isVideo ? '<video id="photo-clip" playsinline preload="metadata"></video>' : '<img id="photo-full" alt="">'}<div id="photo-view-loading"><span class="spinner"></span></div></div><div class="photo-view-top photo-overlay"><button id="photo-close">‹ 返回</button><div><b>${esc(p.name)}</b><span>${esc(date(p.date))}${p.width && p.height ? ` · ${p.width} × ${p.height}` : ''}</span></div><span class="photo-counter">${G.offset + index + 1} / ${Number(G.data.total).toLocaleString()}</span></div><div id="photo-view-error" role="status"></div><div class="photo-view-bottom photo-overlay"><div class="photo-view-buttons"><button id="photo-previous">‹ 上一项</button>${isVideo ? '<button id="photo-video-pause">暂停视频</button>' : ''}<button id="photo-slideshow">${playing ? '暂停幻灯片' : '播放幻灯片'}</button><button id="photo-interval">间隔 ${G.interval} 秒</button>${!isVideo ? '<button id="photo-rotate">旋转</button><button id="photo-zoom">放大</button>' : ''}<button id="photo-next">下一项 ›</button></div><p>左右切换 · 确定显示操作 · 返回照片列表</p></div></section>`;
      $('#photo-close').onclick = closeViewer; $('#photo-previous').onclick = () => step(-1); $('#photo-next').onclick = () => step(1);
      $('#photo-slideshow').onclick = toggleSlideshow;
      $('#photo-interval').onclick = () => { G.interval = ({ 5: 10, 10: 15, 15: 5 })[G.interval] || 5; store.set('photoInterval', String(G.interval)); $('#photo-interval').textContent = `间隔 ${G.interval} 秒`; schedule(); showControls(); };
      const imageGeneration = ++G.imageGeneration;
      const failure = () => {
        if (!G.active || imageGeneration !== G.imageGeneration) return;
        G.playing = false; clearTimeout(slideTimer); $('#photo-view-loading').style.display = 'none';
        $('#photo-slideshow').textContent = '播放幻灯片';
        $('#photo-view-error').innerHTML = `<p>${isVideo ? '电视无法播放这个视频，可能是编码不受支持。' : '照片加载失败，请检查 NAS 连接。'}</p><button id="photo-view-retry">重试</button><button id="photo-error-back">返回列表</button>`;
        $('#photo-view-retry').onclick = retryViewer; $('#photo-error-back').onclick = closeViewer; showControls(); focus($('#photo-error-back'));
      };
      if (isVideo) {
        const clip = $('#photo-clip');
        $('#photo-video-pause').onclick = () => { if (clip.paused) clip.play().catch(err => { if (err.name !== 'AbortError') failure(); }); else clip.pause(); showControls(); };
        clip.onplay = () => { if (G.active && imageGeneration === G.imageGeneration && $('#photo-video-pause')) $('#photo-video-pause').textContent = '暂停视频'; };
        clip.onpause = () => { if (G.active && imageGeneration === G.imageGeneration && $('#photo-video-pause')) $('#photo-video-pause').textContent = '播放视频'; };
        clip.onloadeddata = () => { if (imageGeneration === G.imageGeneration) $('#photo-view-loading').style.display = 'none'; };
        clip.onended = () => { if (!G.active || imageGeneration !== G.imageGeneration) return; if (G.playing) step(1); else showControls(); }; clip.onerror = failure;
        if (p.stream) { clip.src = asset(p.stream); clip.play().catch(err => { if (err.name !== 'AbortError') failure(); }); } else failure();
      } else {
        const img = $('#photo-full'); img.alt = p.name;
        $('#photo-rotate').onclick = () => { G.rotation = (G.rotation + 90) % 360; transform(); showControls(); };
        $('#photo-zoom').onclick = () => { G.zoom = !G.zoom; transform(); showControls(); };
        img.onload = () => {
          if (!G.active || imageGeneration !== G.imageGeneration) return;
          G.ready = true; $('#photo-view-loading').style.display = 'none'; schedule();
          const next = G.data.items[index + 1];
          if (next?.kind === 'image') { preload = new Image(); preload.src = asset(next.view); }
        };
        img.onerror = failure; img.src = asset(p.view);
      }
      focus($('#photo-close')); showControls();
    }
    async function step(delta) {
      if (G.loading || !G.viewer) return;
      const index = G.index + delta;
      if (index >= 0 && index < G.data.items.length) return openViewer(index, G.playing);
      const offset = G.offset + delta * G.data.limit;
      if (offset < 0 || (delta > 0 && G.data.last)) {
        G.playing = false; clearTimeout(slideTimer); $('#photo-slideshow').textContent = '播放幻灯片'; showControls(); toast(delta > 0 ? '已到最后一项' : '已到第一项'); return;
      }
      G.loading = true; clearTimeout(slideTimer); const generation = ++G.generation;
      try {
        const data = await request(offset);
        if (!G.active || !G.viewer || generation !== G.generation) return;
        if (!data.items.length) { G.data.last = true; G.playing = false; $('#photo-slideshow').textContent = '播放幻灯片'; showControls(); toast('已到最后一项'); return; }
        G.offset = offset; G.data = data; openViewer(delta > 0 ? 0 : data.items.length - 1, G.playing);
      } catch (err) { if (G.active && generation === G.generation) { G.playing = false; $('#photo-slideshow').textContent = '播放幻灯片'; showControls(); toast(err.message); } }
      finally { if (generation === G.generation) G.loading = false; }
    }
    function closeViewer() { stopMedia(); ++G.generation; G.loading = false; G.viewer = false; G.playing = false; render(G.index); }
    function back() {
      if (G.viewer) { closeViewer(); return; }
      if (G.album) { G.album = null; G.offset = G.albumPage; load(); return; }
      exit();
    }
    function key(e) {
      if (!G.viewer) return false;
      const code = e.keyCode;
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
      if ($('#photo-slideshow')) $('#photo-slideshow').textContent = '播放幻灯片';
    });
    return { open() { G.active = true; return load(); }, leave, back, key };
  };
})();
