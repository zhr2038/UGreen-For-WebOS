(() => {
  'use strict';
  const RATES = [.5, .75, 1, 1.25, 1.5, 2];
  const MODES = { sort_list: '顺序播放', loop_list: '列表循环', loop_single: '单集循环' };
  const FITS = { contain: '适应画面', cover: '铺满并裁切', fill: '拉伸铺满' };
  const COLORS = { '#FFFFFF': '白色', '#FFFF00': '黄色', '#FF0000': '红色', '#00FF00': '绿色', '#0000FF': '蓝色', '#000000': '黑色' };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const list = value => value ? Array.from({ length: value.length || 0 }, (_, i) => value[i]).filter(Boolean) : [];
  window.createPlayerOptions = ({ video, api, asset = path => path, root, getPlayback, onSourceSwitch, onClose = () => {}, toast = () => {}, tracks, store, focus: setFocus } = {}) => {
    if (!video || typeof api !== 'function' || typeof getPlayback !== 'function' || typeof onSourceSwitch !== 'function') throw new TypeError('Player options require video, api, getPlayback and onSourceSwitch');
    const S = { active: false, page: 'settings', generation: 0, id: null, options: null, busy: false, message: '', preferences: { mode: 'sort_list', rate: 1, fit: 'contain', subtitle: { offset: 0, size: 100, color: '#FFFFFF', position: 90, language: '' } } };
    try { const saved = JSON.parse(store?.get('player.preferences', '{}') || '{}'); if (MODES[saved.mode]) S.preferences.mode = saved.mode; if (RATES.includes(saved.rate)) S.preferences.rate = saved.rate; if (FITS[saved.fit]) S.preferences.fit = saved.fit; } catch {}
    const host = () => typeof root === 'function' ? root() : root;
    const current = () => { const p = getPlayback(); return p && p.id != null ? p : null; };
    const same = generation => S.active && generation === S.generation && String(current()?.id) === S.id && Boolean(S.element?.isConnected);
    const find = selector => S.element?.querySelector(selector);
    function focus(element) { if (!element) return; if (setFocus) setFocus(element); else { element.focus(); element.scrollIntoView?.({ block: 'nearest' }); } }
    function abort() { S.abort?.abort(); S.abort = null; S.generation++; S.busy = false; }
    function close() { const wasActive = S.active; abort(); S.active = false; S.element?.remove(); S.element = null; if (wasActive) onClose(); }
    function stateTracks() { try { return tracks?.state?.() || {}; } catch { return {}; } }
    function audioOptions() {
      if (tracks?.state) return stateTracks().audio || [];
      const runtime = list(video.audioTracks), labels = runtime.length === S.options?.audio?.length ? S.options.audio : [];
      return runtime.map((t, index) => ({ id: 'native-audio:' + index, index, label: t.label || labels[index]?.label || t.language || `音轨 ${index + 1}`, language: t.language || labels[index]?.language || '', enabled: Boolean(t.enabled) }));
    }
    function subtitleOptions() {
      if (tracks?.state) return stateTracks().subtitles || [];
      return list(video.textTracks).filter(t => !['metadata', 'chapters'].includes(t.kind)).map((t, index) => ({ id: 'native-text:' + index, index, label: t.label || t.language || `字幕 ${index + 1}`, language: t.language || '', showing: t.mode === 'showing' }));
    }
    function button(label, action, value = '', { selected = false, disabled = false, detail = '' } = {}) {
      return `<button type="button" data-po-action="${esc(action)}" data-po-value="${esc(value)}" ${disabled || S.busy ? 'disabled' : ''} ${selected ? 'aria-pressed="true"' : ''}><span>${esc(label)}</span>${selected ? '<b aria-hidden="true">✓</b>' : ''}${detail ? `<small>${esc(detail)}</small>` : ''}</button>`;
    }
    function saveLocal() { try { store?.set('player.preferences', JSON.stringify(S.preferences)); } catch {} }
    async function persist(patch, generation) {
      S.preferences = { ...S.preferences, ...patch, subtitle: { ...S.preferences.subtitle, ...patch.subtitle } }; saveLocal();
      try { await api('/api/play/preferences', { id: S.id, preferences: patch }, S.abort?.signal); }
      catch (error) { if (same(generation)) { S.message = '已应用到当前播放，播放偏好未保存：' + error.message; toast('播放偏好未能同步'); } }
    }
    function content() {
      const p = current(), selected = p?.quality?.id || p?.qualityId || S.qualityId || S.options?.selected || 'original';
      if (S.page === 'settings') return `<h2>播放设置</h2>${button('画质', 'open', 'quality', { detail: S.options?.qualities?.find(q => q.id === selected)?.label || '原画' })}${button('音轨', 'open', 'audio')}${button('字幕', 'open', 'subtitles')}${button('播放速度', 'open', 'rate', { detail: (video.playbackRate || 1) + '×' })}${button('播放模式', 'open', 'mode', { detail: MODES[S.preferences.mode] })}${button('画面比例', 'open', 'fit', { detail: FITS[S.preferences.fit] })}`;
      if (S.page === 'quality') {
        const qualities = S.options?.qualities || [{ id: 'original', label: '原画', original: true }];
        return `<h2>画质</h2><p>仅显示 NAS 为此影片提供的画质。</p>${qualities.map(q => button(q.label || q.id, 'quality', q.id, { selected: q.id === selected, detail: q.resolution || '' })).join('')}${!S.options ? button('重新读取画质', 'reload') : ''}`;
      }
      if (S.page === 'audio') { const options = audioOptions(); return `<h2>音轨</h2>${options.length ? options.map(t => button(t.label, 'audio', t.id, { selected: t.enabled, detail: t.language })).join('') : '<p>电视当前没有提供可切换的音轨。</p>'}`; }
      if (S.page === 'subtitles') {
        const native = subtitleOptions(), external = (S.options?.subtitles || []).filter(t => t.kind === 'external');
        return `<h2>字幕</h2>${button('关闭字幕', 'subtitle-off', '', { selected: S.subtitleOff === true })}${native.map(t => button(t.label, 'native-subtitle', t.id, { selected: t.showing, detail: '内嵌 · ' + (t.language || '') })).join('')}${external.map(t => button(t.label, 'external-subtitle', t.id, { detail: '外挂 · ' + (t.codec || '') })).join('')}${!native.length && !external.length ? '<p>此片源暂未提供可用字幕，可尝试外挂或在线字幕。</p>' : ''}${button('字幕调整', 'open', 'subtitleStyle', { disabled: !tracks?.setStyle })}${button('优先字幕语言', 'open', 'language')}${button('搜索在线字幕', 'open', 'online')}${external.length ? button('管理外挂字幕', 'open', 'manage') : ''}`;
      }
      if (S.page === 'subtitleStyle') {
        const style = S.preferences.subtitle, ass = stateTracks().selectedSubtitle?.kind === 'ass';
        return `<h2>字幕调整</h2><p>延迟 ${Number(style.offset).toFixed(2)} 秒 · 正值延后</p>${ass ? '<p>ASS 保留脚本样式；普通文本的字号、颜色和位置不覆盖 ASS。</p>' : ''}<div class="po-grid">${button('提前 0.5 秒', 'offset', '-0.5')}${button('提前 50 毫秒', 'offset', '-0.05')}${button('延后 50 毫秒', 'offset', '0.05')}${button('延后 0.5 秒', 'offset', '0.5')}</div><h3>字号</h3><div class="po-grid">${[75,100,125,150,200].map(n => button(n + '%', 'size', n, { selected: style.size === n, disabled: ass })).join('')}</div><h3>颜色</h3><div class="po-grid">${Object.entries(COLORS).map(([c,n]) => button(n, 'color', c, { selected: style.color === c, disabled: ass })).join('')}</div><h3>位置</h3><div class="po-grid">${[[10,'顶部'],[50,'居中'],[90,'底部']].map(([n,label]) => button(label, 'position', n, { selected: style.position === n, disabled: ass })).join('')}</div>${button('恢复默认', 'subtitle-reset', '', { disabled: ass })}`;
      }
      if (S.page === 'rate') return `<h2>播放速度</h2><div class="po-grid">${RATES.map(rate => button(rate + '×', 'rate', rate, { selected: video.playbackRate === rate })).join('')}</div>`;
      if (S.page === 'mode') return `<h2>播放模式</h2>${Object.entries(MODES).map(([mode,label]) => button(label, 'mode', mode, { selected: S.preferences.mode === mode })).join('')}`;
      if (S.page === 'fit') return `<h2>画面比例</h2>${Object.entries(FITS).map(([fit,label]) => button(label, 'fit', fit, { selected: S.preferences.fit === fit })).join('')}`;
      if (S.page === 'language') return `<h2>优先字幕语言</h2><p>优先使用所选语言；片源没有该语言时，保留当前字幕。</p>${[['zh','中文'],['en','English'],['ja','日本語'],['ko','한국어']].map(([code,label]) => button(label, 'language', code, { selected: S.preferences.subtitle.language === code })).join('')}`;
      if (S.page === 'online') return `<h2>在线字幕</h2><form data-po-search><label>片名<input aria-label="搜索字幕片名" value="${esc(S.query || p?.title || '')}" maxlength="200"></label><button type="submit" ${S.busy ? 'disabled' : ''}>搜索</button></form>${(S.results || []).map(item => button('下载并使用 · ' + item.label, 'online-download', item.id, { detail: item.language })).join('')}`;
      if (S.page === 'manage') return `<h2>管理外挂字幕</h2><p>删除操作会移除 NAS 上的字幕文件。</p>${(S.options?.subtitles || []).filter(s => s.kind === 'external').map(item => button('删除 · ' + item.label, 'confirm-delete', item.id)).join('')}`;
      if (S.page === 'confirmDelete') return `<h2>删除字幕？</h2><p>将从 NAS 删除「${esc(S.deleteItem?.label)}」。</p>${button('确认删除 NAS 字幕', 'delete', S.deleteItem?.id)}${button('取消', 'open', 'manage')}`;
      return '<h2>播放设置</h2>';
    }
    function render() {
      if (!S.active || !host()) return;
      const previousKey = S.renderPage === S.page && host().contains(document.activeElement) ? document.activeElement?.dataset.poKey : null;
      if (!S.element || !S.element.isConnected) { S.element = document.createElement('section'); S.element.className = 'player-dialog player-options'; S.element.setAttribute('role', 'dialog'); S.element.setAttribute('aria-modal', 'true'); host().replaceChildren(S.element); }
      S.element.dataset.page = S.page; S.element.dataset.busy = String(S.busy); S.element.innerHTML = content() + `<p class="po-message" role="status">${esc(S.message)}</p><button type="button" data-po-back>返回</button>`;
      bind(); const buttons = Array.from(S.element.querySelectorAll('button,input')); buttons.forEach((b,i) => b.dataset.poKey = String(i));
      const actionTarget = !S.busy && S.focusTarget?.page === S.page ? buttons.find(b => !b.disabled && b.dataset.poAction === S.focusTarget.action && b.dataset.poValue === S.focusTarget.value) : null;
      S.renderPage = S.page;
      focus(actionTarget || (previousKey && S.element.querySelector(`[data-po-key="${previousKey}"]:not(:disabled)`)) || S.element.querySelector('button[aria-pressed="true"]:not(:disabled),button:not(:disabled),input'));
    }
    async function ensureOptions(generation) {
      const result = await api('/api/play/options?id=' + encodeURIComponent(S.id), undefined, S.abort?.signal);
      if (!same(generation)) return;
      S.options = result; if (result.preferences) { S.preferences = { ...S.preferences, ...result.preferences, subtitle: { ...S.preferences.subtitle, ...result.preferences.subtitle } }; }
    }
    async function open(page = 'settings') {
      const p = current(); if (!p || !host()) return;
      const changed = S.id !== String(p.id); abort(); S.id = String(p.id); if (changed) { S.options = null; S.qualityId = null; S.subtitleOff = false; S.results = []; }
      S.active = true; S.page = page; S.focusTarget = null; S.message = ''; S.abort = new AbortController(); const generation = S.generation; render();
      if (['quality','subtitles','manage'].includes(page) && !S.options) {
        S.busy = true; S.message = '正在读取可用选项…'; render();
        try { await ensureOptions(generation); if (same(generation)) S.message = ''; }
        catch (error) { if (same(generation)) S.message = '读取失败：' + error.message; }
        finally { if (same(generation)) { S.busy = false; render(); } }
      }
    }
    async function run(action, value) {
      if (!S.active || S.busy) return; if (action === 'open') return open(value); if (action === 'reload') { S.options = null; return open(S.page); }
      if (action === 'confirm-delete') { S.deleteItem = S.options?.subtitles?.find(s => s.id === value && s.kind === 'external'); if (S.deleteItem) return open('confirmDelete'); return; }
      const generation = S.generation; S.focusTarget = { page: S.page, action, value }; S.busy = true; S.message = ''; render();
      try {
        if (action === 'quality') {
          const selected = S.options?.qualities?.find(q => q.id === value) || (value === 'original' ? { id: value, label: '原画' } : null); if (!selected) throw new Error('这个画质不在 NAS 提供的列表中');
          S.message = '正在准备 ' + selected.label + '…'; render();
          const response = await api('/api/play/quality', { id: S.id, qualityId: value, preferH264: true }, S.abort?.signal);
          if (!same(generation)) return;
          if (typeof response?.stream !== 'string' || !response.stream) throw new Error('NAS 尚未提供可用播放地址');
          const sourceUrl = asset(response.stream); if (!sourceUrl) throw new Error('播放地址无效');
          await onSourceSwitch(response, { id: S.id, playback: current(), sourceUrl, position: video.currentTime, paused: video.paused, signal: S.abort.signal, isCurrent: () => same(generation) });
          if (!same(generation)) return; S.qualityId = value; close(); return;
        }
        if (action === 'audio') { const options = audioOptions(), choice = options.find(t => t.id === value); if (!choice) throw new Error('电视未提供这个音轨'); if (tracks?.selectAudio) tracks.selectAudio(value); else { const runtime = list(video.audioTracks); runtime[choice.index].enabled = true; runtime.forEach((t,i) => { if (i !== choice.index && t.enabled) t.enabled = false; }); if (!runtime[choice.index].enabled) throw new Error('电视没有接受音轨切换'); } await persist({ audio: { label: choice.label, language: choice.language, index: choice.index } }, generation); }
        if (action === 'native-subtitle') { const choice = subtitleOptions().find(t => t.id === value); if (!choice) throw new Error('电视未提供这个字幕'); if (tracks?.selectText) tracks.selectText(value); else list(video.textTracks).filter(t => !['metadata','chapters'].includes(t.kind)).forEach((t,i) => t.mode = i === choice.index ? 'showing' : 'disabled'); S.subtitleOff = false; await persist({ subtitle: { selection: { kind: 'native', label: choice.label, language: choice.language, index: choice.index } } }, generation); }
        if (action === 'subtitle-off') { if (tracks?.off) tracks.off(); else list(video.textTracks).forEach(t => t.mode = 'disabled'); S.subtitleOff = true; await persist({ subtitle: { selection: { kind: 'off' } } }, generation); }
        if (action === 'external-subtitle') { await applyExternal(value); if (same(generation)) S.subtitleOff = false; }
        if (action === 'rate') { const rate = Number(value); if (!RATES.includes(rate)) throw new Error('无效的播放速度'); if (tracks?.setRate) tracks.setRate(rate, { passthrough: Boolean(current()?.passthrough) }); else { if (current()?.passthrough && rate !== 1) throw new Error('音频直通仅支持正常速度'); video.playbackRate = rate; if (video.playbackRate !== rate) throw new Error('电视没有接受这个倍速'); } await persist({ rate }, generation); }
        if (action === 'mode') { if (!MODES[value]) throw new Error('无效的播放模式'); await persist({ mode: value }, generation); }
        if (action === 'fit') { if (!FITS[value]) throw new Error('无效的画面比例'); if (tracks?.setFit) tracks.setFit(value); else video.style.objectFit = value; await persist({ fit: value }, generation); }
        if (['offset','size','color','position','subtitle-reset'].includes(action)) {
          if (!tracks?.setStyle || !tracks?.setOffset) throw new Error('字幕调整暂不可用');
          const patch = action === 'subtitle-reset' ? { offset: 0, size: 100, color: '#FFFFFF', position: 90 } : { [action === 'offset' ? 'offset' : action]: action === 'color' ? value : Number(value) + (action === 'offset' ? Number(S.preferences.subtitle.offset) : 0) };
          let applied;
          if ('offset' in patch) applied = tracks.setOffset(patch.offset);
          if (Object.keys(patch).some(k => k !== 'offset')) applied = tracks.setStyle(Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'offset')));
          await persist({ subtitle: patch }, generation);
          if (applied?.applied === false) S.message = '已保存偏好；' + (applied.reason || '当前字幕尚未提供可调整的文本。');
        }
        if (action === 'language') { let applied = tracks?.selectLanguage?.('subtitle', value); await persist({ subtitle: { language: value } }, generation); if (applied?.applied === false || !tracks?.selectLanguage) S.message = '已保存语言偏好；当前没有对应的可用轨道。'; }
        if (action === 'online-download') { const result = await api('/api/play/subtitle', { id: S.id, action: 'download', resultId: value }, S.abort?.signal); if (same(generation)) { if (result.subtitle?.id) { S.options ||= { subtitles: [] }; S.options.subtitles ||= []; S.options.subtitles.push(result.subtitle); await applyExternal(result.subtitle.id); } else S.message = '下载请求已提交，请稍后重新读取字幕。'; } }
        if (action === 'delete') { await api('/api/play/subtitle', { id: S.id, action: 'delete', subtitleId: value }, S.abort?.signal); if (same(generation)) { S.options = null; await open('manage'); return; } }
      } catch (error) { if (same(generation)) { S.message = error.message || '操作失败'; toast(S.message); } }
      finally { if (same(generation)) { S.busy = false; render(); } }
    }
    async function applyExternal(id) {
      const option = S.options?.subtitles?.find(s => s.id === id);
      if (/^(ass|ssa)$/i.test(option?.codec || '') && tracks?.state?.().assAvailable && tracks?.selectAss) return tracks.selectAss(id);
      if (!tracks?.selectExternal) throw new Error('外挂字幕播放暂不可用');
      return tracks.selectExternal(id);
    }
    function bind() {
      S.element?.querySelectorAll('[data-po-action]').forEach(b => b.onclick = () => run(b.dataset.poAction, b.dataset.poValue));
      const backButton = find('[data-po-back]'); if (backButton) backButton.onclick = back;
      const form = find('[data-po-search]'); if (form) form.onsubmit = async event => {
        event.preventDefault(); if (S.busy) return; const generation = S.generation; const query = form.querySelector('input').value.trim(); if (!query) return; S.query = query; S.busy = true; S.message = '正在搜索…'; render();
        try { const result = await api('/api/play/subtitle', { id: S.id, action: 'search', query, language: S.preferences.subtitle.language || 'zh-cn', page: 1 }, S.abort?.signal); if (same(generation)) { S.results = result.items || []; S.message = S.results.length ? '' : '没有找到字幕'; } }
        catch (error) { if (same(generation)) S.message = error.message; }
        finally { if (same(generation)) { S.busy = false; render(); } }
      };
    }
    function back() { if (!S.active) return false; if (S.page === 'settings') close(); else open(['subtitleStyle','language','online','manage'].includes(S.page) ? 'subtitles' : S.page === 'confirmDelete' ? 'manage' : 'settings'); return true; }
    function key(event) {
      if (!S.active) return false;
      const active = document.activeElement;
      if (event.keyCode === 461 || event.key === 'Escape' || event.keyCode === 8 && !['INPUT','TEXTAREA'].includes(active?.tagName)) { event.preventDefault(); if (!event.repeat) back(); return true; }
      if ((event.keyCode === 13 || event.key === 'Enter' || event.code === 'Space') && S.element?.contains(active) && active.tagName === 'BUTTON') { event.preventDefault(); if (!event.repeat && !active.disabled) active.click(); return true; }
      const direction = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' }[event.keyCode];
      if (!direction || !S.element?.contains(active) || active.tagName === 'INPUT' && ['left','right'].includes(direction)) return false;
      const controls = Array.from(S.element.querySelectorAll('button,input')).filter(b => !b.disabled && !b.hidden), grid = active.closest('.po-grid'); let target;
      if (grid) {
        const items = controls.filter(b => grid.contains(b)), at = items.indexOf(active), delta = direction === 'up' ? -2 : direction === 'down' ? 2 : direction === 'left' ? -1 : 1;
        const next = at + delta;
        if (next >= 0 && next < items.length && (!['left','right'].includes(direction) || Math.floor(next / 2) === Math.floor(at / 2))) target = items[next];
        else if (['up','down'].includes(direction)) target = controls[controls.indexOf(direction === 'up' ? items[0] : items[items.length - 1]) + (direction === 'up' ? -1 : 1)];
      } else target = controls[controls.indexOf(active) + (['up','left'].includes(direction) ? -1 : 1)];
      event.preventDefault(); focus(target); return true;
    }
    return { open, render, bind, close, back, key, active: () => S.active, mode: () => S.preferences.mode, preferences: () => JSON.parse(JSON.stringify(S.preferences)), nextIndex(index, length) { if (!Number.isInteger(index) || !Number.isInteger(length) || length < 1 || index < 0 || index >= length) return null; if (S.preferences.mode === 'loop_single') return index; if (index + 1 < length) return index + 1; return S.preferences.mode === 'loop_list' ? 0 : null; } };
  };
})();
