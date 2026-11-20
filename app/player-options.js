(() => {
  'use strict';
  const RATES = [.5, .75, 1, 1.25, 1.5, 2];
  const MODES = { sort_list: '顺序播放', loop_list: '列表循环', loop_single: '单集循环' };
  const FITS = { contain: '适应画面', cover: '铺满并裁切', fill: '拉伸铺满' };
  const COLORS = { '#FFFFFF': '白色', '#FFFF00': '黄色', '#FF0000': '红色', '#00FF00': '绿色', '#0000FF': '蓝色', '#000000': '黑色' };
  const ENCODINGS = [['auto', '自动识别'], ['utf-8', 'UTF-8'], ['gb18030', '简体 GB18030'], ['big5', '繁体 Big5'], ['utf-16le', 'UTF-16LE'], ['shift_jis', '日文 Shift-JIS'], ['windows-1252', '西欧 Windows-1252']];
  const BACKGROUNDS = [[0, '无底框'], [0.45, '半透明黑底'], [0.8, '深黑底框']];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const list = value => value ? Array.from({ length: value.length || 0 }, (_, i) => value[i]).filter(Boolean) : [];
  const preferenceDefaults = () => ({ mode: 'sort_list', rate: 1, fit: 'contain', subtitle: { offset: 0, size: 100, color: '#FFFFFF', opacity: 1, background: 0, outline: true, position: 90, language: '', encoding: 'auto' } });
  window.createPlayerOptions = ({ video, api, asset = path => path, root, getPlayback, onSourceSwitch, onClose = () => {}, toast = () => {}, tracks, store, focus: setFocus } = {}) => {
    if (!video || typeof api !== 'function' || typeof getPlayback !== 'function' || typeof onSourceSwitch !== 'function') throw new TypeError('Player options require video, api, getPlayback and onSourceSwitch');
    const loadLocalPrefs = () => {
      const base = preferenceDefaults();
      try {
        const saved = JSON.parse(store?.get('player.preferences', '{}') || '{}');
        if (MODES[saved.mode]) base.mode = saved.mode;
        if (RATES.includes(saved.rate)) base.rate = saved.rate;
        if (FITS[saved.fit]) base.fit = saved.fit;
        if (saved.subtitle && typeof saved.subtitle === 'object') {
          const s = saved.subtitle;
          if (COLORS[s.color]) base.subtitle.color = s.color;
          if ([75, 100, 125, 150, 200].includes(s.size)) base.subtitle.size = s.size;
          if ([10, 50, 90].includes(s.position)) base.subtitle.position = s.position;
          if (typeof s.opacity === 'number' && s.opacity >= 0 && s.opacity <= 1) base.subtitle.opacity = s.opacity;
          if (typeof s.background === 'number' && s.background >= 0 && s.background <= 1) base.subtitle.background = s.background;
          if (typeof s.outline === 'boolean') base.subtitle.outline = s.outline;
          if (typeof s.language === 'string') base.subtitle.language = s.language;
          if (ENCODINGS.some(([code]) => code === s.encoding)) base.subtitle.encoding = s.encoding;
        }
      } catch {}
      return base;
    };
    const S = { active: false, page: 'settings', generation: 0, id: null, options: null, busy: false, message: '', preferences: loadLocalPrefs(), onlinePage: 1, onlinePages: 0 };
    const host = () => typeof root === 'function' ? root() : root;
    const current = () => { const p = getPlayback(); return p && p.id != null ? p : null; };
    const same = generation => S.active && generation === S.generation && String(current()?.id) === S.id && Boolean(S.element?.isConnected);
    const find = selector => S.element?.querySelector(selector);
    function focus(element) { if (!element) return; if (setFocus) setFocus(element); else { element.focus(); element.scrollIntoView?.({ block: 'nearest' }); } }
    function abort() { S.abort?.abort(); S.abort = null; S.generation++; S.busy = false; }
    function close() { const wasActive = S.active; abort(); S.active = false; S.element?.remove(); S.element = null; if (wasActive) onClose(); }
    function resetPlayback(p) {
      const id = String(p.id); if (S.id === id) return false;
      abort(); S.id = id; S.options = null; S.qualityId = null; S.subtitleOff = false;
      S.results = []; S.onlinePage = 1; S.onlinePages = 0; S.query = ''; S.deleteItem = null; S.preferences = loadLocalPrefs(); return true;
    }
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
    function syncRemoteTracks(trackPatch) {
      const p = current();
      if (!p || !trackPatch) return;
      api('/api/play/preferences', { id: S.id, action: 'tracks', tracks: trackPatch }, S.abort?.signal, p.connection).catch(() => {});
    }
    async function persist(patch, generation) {
      const p = current();
      S.preferences = { ...S.preferences, ...patch, subtitle: { ...S.preferences.subtitle, ...patch.subtitle } }; saveLocal();
      const serverPatch = { ...patch };
      if (serverPatch.subtitle) {
        serverPatch.subtitle = { ...serverPatch.subtitle };
        delete serverPatch.subtitle.encoding;
      }
      if (Object.keys(serverPatch).some(k => k !== 'subtitle' || Object.keys(serverPatch.subtitle).length)) {
        try { await api('/api/play/preferences', { id: S.id, preferences: serverPatch }, S.abort?.signal, p?.connection); }
        catch (error) { if (same(generation)) { S.message = '已应用到当前播放，播放偏好未保存：' + error.message; toast('播放偏好未能同步'); } return false; }
      }
      if (patch.audio) syncRemoteTracks({ audio: { index: patch.audio.index, language: patch.audio.language || '' } });
      if (patch.subtitle?.selection) {
        const sel = patch.subtitle.selection;
        if (sel.kind === 'off') syncRemoteTracks({ subtitle: { type: 0, index: -99, language: '' } });
        else if (sel.kind === 'native') syncRemoteTracks({ subtitle: { type: 1, index: sel.index ?? 0, language: sel.language || '' } });
        else if (sel.kind === 'external') syncRemoteTracks({ subtitle: { type: 2, index: 0, language: sel.language || '', id: S.activeExternalId || '' } });
      }
      return true;
    }
    function content() {
      const p = current(), selected = p?.quality?.id || p?.qualityId || S.qualityId || S.options?.selected || 'original';
      if (S.page === 'settings') return `<h2>播放设置</h2>${button('画质', 'open', 'quality', { detail: S.options?.qualities?.find(q => q.id === selected)?.label || '原画' })}${button('音轨', 'open', 'audio')}${button('字幕', 'open', 'subtitles')}${button('播放速度', 'open', 'rate', { detail: (video.playbackRate || 1) + '×' })}${button('播放模式', 'open', 'mode', { detail: MODES[S.preferences.mode] })}${button('画面比例', 'open', 'fit', { detail: FITS[S.preferences.fit] })}${button('跳过片头片尾', 'skip', '', { disabled: !p?.skips, detail: p?.skips ? p.skips.enabled ? '已开启' : '已关闭' : '正在读取标记' })}`;
      if (S.page === 'quality') {
        const qualities = S.options?.qualities || [{ id: 'original', label: '原画', original: true }];
        return `<h2>画质</h2><p>仅显示 NAS 为此影片提供的画质。</p>${qualities.map(q => button(q.label || q.id, 'quality', q.id, { selected: q.id === selected, detail: q.resolution || '' })).join('')}${!S.options ? button('重新读取画质', 'reload') : ''}`;
      }
      if (S.page === 'audio') { const options = audioOptions(); return `<h2>音轨</h2>${options.length ? options.map(t => button(t.label, 'audio', t.id, { selected: t.enabled, detail: t.language })).join('') : '<p>电视当前没有提供可切换的音轨。</p>'}`; }
      if (S.page === 'subtitles') {
        const ts = stateTracks(), native = subtitleOptions(), external = (S.options?.subtitles || []).filter(t => t.kind === 'external');
        const activeSub = ts.selectedSubtitle;
        const offSelected = S.subtitleOff === true || activeSub?.kind === 'off';
        const encLabel = ENCODINGS.find(([c]) => c === (S.preferences.subtitle.encoding || 'auto'))?.[1] || '自动识别';
        return `<h2>字幕</h2>${button('关闭字幕', 'subtitle-off', '', { selected: offSelected })}${native.map(t => button(t.label, 'native-subtitle', t.id, { selected: t.showing && activeSub?.kind !== 'external' && activeSub?.kind !== 'ass', detail: '内嵌 · ' + (t.language || '') })).join('')}${external.map(t => button(t.label, 'external-subtitle', t.id, { selected: activeSub?.id === t.id, detail: '外挂 · ' + (t.codec || '') })).join('')}${!native.length && !external.length ? '<p>此片源暂未提供可用字幕，可尝试外挂或在线字幕。</p>' : ''}${button('字幕调整', 'open', 'subtitleStyle', { disabled: !tracks?.setStyle })}${external.length ? button('外挂字幕编码', 'open', 'encoding', { detail: encLabel }) : ''}${button('优先字幕语言', 'open', 'language')}${button('搜索在线字幕', 'open', 'online')}${external.length ? button('管理外挂字幕', 'open', 'manage') : ''}`;
      }
      if (S.page === 'encoding') {
        const currentEnc = S.preferences.subtitle.encoding || 'auto';
        return `<h2>外挂字幕编码</h2><p>出现乱码或无法识别时，可手动切换字符编码。</p>${ENCODINGS.map(([code, label]) => button(label, 'encoding', code, { selected: currentEnc === code })).join('')}`;
      }
      if (S.page === 'subtitleStyle') {
        const style = S.preferences.subtitle, ass = stateTracks().selectedSubtitle?.kind === 'ass';
        const transparent = style.opacity === 0;
        return `<h2>字幕调整</h2><p>延迟 ${Number(style.offset).toFixed(2)} 秒 · 正值延后</p>${ass ? '<p>ASS 保留脚本样式；普通文本的字号、颜色和位置不覆盖 ASS。</p>' : ''}<div class="po-grid">${button('提前 0.5 秒', 'offset', '-0.5')}${button('提前 50 毫秒', 'offset', '-0.05')}${button('延后 50 毫秒', 'offset', '0.05')}${button('延后 0.5 秒', 'offset', '0.5')}</div><h3>字号</h3><div class="po-grid">${[75,100,125,150,200].map(n => button(n + '%', 'size', n, { selected: style.size === n, disabled: ass })).join('')}</div><h3>颜色</h3><div class="po-grid">${Object.entries(COLORS).map(([c,n]) => button(n, 'color', c, { selected: !transparent && style.color === c, disabled: ass })).join('')}${button('透明', 'transparent', '0', { selected: transparent, disabled: ass })}</div><h3>底框与描边</h3><div class="po-grid">${BACKGROUNDS.map(([bg, label]) => button(label, 'background', bg, { selected: Number(style.background ?? 0) === bg, disabled: ass })).join('')}${button(style.outline === false ? '文字描边：关' : '文字描边：开', 'outline', style.outline === false ? '1' : '0', { selected: style.outline !== false, disabled: ass })}</div><h3>位置</h3><div class="po-grid">${[[10,'顶部'],[50,'居中'],[90,'底部']].map(([n,label]) => button(label, 'position', n, { selected: style.position === n, disabled: ass })).join('')}</div>${button('恢复默认', 'subtitle-reset', '', { disabled: ass })}`;
      }
      if (S.page === 'rate') return `<h2>播放速度</h2><div class="po-grid">${RATES.map(rate => button(rate + '×', 'rate', rate, { selected: video.playbackRate === rate })).join('')}</div>`;
      if (S.page === 'mode') return `<h2>播放模式</h2>${Object.entries(MODES).map(([mode,label]) => button(label, 'mode', mode, { selected: S.preferences.mode === mode })).join('')}`;
      if (S.page === 'fit') return `<h2>画面比例</h2>${Object.entries(FITS).map(([fit,label]) => button(label, 'fit', fit, { selected: S.preferences.fit === fit })).join('')}`;
      if (S.page === 'language') return `<h2>优先字幕语言</h2><p>优先使用所选语言；片源没有该语言时，保留当前字幕。</p>${[['zh','中文'],['en','English'],['ja','日本語'],['ko','한국어']].map(([code,label]) => button(label, 'language', code, { selected: S.preferences.subtitle.language === code })).join('')}`;
      if (S.page === 'online') {
        const pager = S.onlinePages > 1 ? `<div class="po-grid">${button('上一页', 'online-page', String(S.onlinePage - 1), { disabled: S.onlinePage <= 1 })}${button('下一页', 'online-page', String(S.onlinePage + 1), { disabled: S.onlinePage >= S.onlinePages })}</div>` : '';
        return `<h2>在线字幕</h2><form data-po-search><label>片名<input aria-label="搜索字幕片名" value="${esc(S.query || p?.title || '')}" maxlength="200"></label><button type="submit" ${S.busy ? 'disabled' : ''}>搜索</button></form>${(S.results || []).map(item => button('下载并使用 · ' + item.label, 'online-download', item.id, { detail: [item.language, item.downloads ? `${item.downloads}次下载` : ''].filter(Boolean).join(' · ') })).join('')}${pager}`;
      }
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
      const result = await api('/api/play/options?id=' + encodeURIComponent(S.id), undefined, S.abort?.signal, current()?.connection);
      if (!same(generation)) return;
      S.options = result; if (result.preferences && !current()?.preferencesChanged) { S.preferences = { ...S.preferences, ...result.preferences, subtitle: { ...S.preferences.subtitle, ...result.preferences.subtitle } }; }
    }
    async function open(page = 'settings', { backToPlayer = false } = {}) {
      const p = current(); if (!p || !host()) return;
      resetPlayback(p); abort();
      S.active = true; S.page = page; S.returnToPlayerPage = backToPlayer ? page : null; S.focusTarget = null; S.message = ''; S.abort = new AbortController(); const generation = S.generation; render();
      if (['quality','subtitles','manage'].includes(page) && !S.options) {
        S.busy = true; S.message = '正在读取可用选项…'; render();
        let loaded = false;
        try { await ensureOptions(generation); if (same(generation)) { loaded = true; S.message = ''; } }
        catch (error) { if (same(generation)) S.message = '读取失败：' + error.message; }
        finally {
          if (same(generation)) {
            S.busy = false; render();
            // Loading leaves only Back enabled. Its old numeric position must
            // not select a different quality when the NAS list arrives.
            if (loaded && S.page === 'quality') focus(find('[data-po-action="quality"][aria-pressed="true"]:not(:disabled)') || find('[data-po-action="quality"]:not(:disabled)'));
          }
        }
      }
    }
    async function run(action, value) {
      if (!S.active || S.busy) return; if (action === 'open') return open(value); if (action === 'reload') { S.options = null; return open(S.page, { backToPlayer: S.returnToPlayerPage === S.page }); }
      if (action === 'confirm-delete') { S.deleteItem = S.options?.subtitles?.find(s => s.id === value && s.kind === 'external'); if (S.deleteItem) return open('confirmDelete'); return; }
      const generation = S.generation; S.focusTarget = { page: S.page, action, value }; S.busy = true; S.message = ''; render();
      try {
        if (action === 'quality') {
          const conn = current()?.connection;
          const selected = S.options?.qualities?.find(q => q.id === value) || (value === 'original' ? { id: value, label: '原画' } : null); if (!selected) throw new Error('这个画质不在 NAS 提供的列表中');
          S.message = '正在准备 ' + selected.label + '…'; render();
          const response = await api('/api/play/quality', { id: S.id, qualityId: value, preferH264: true }, S.abort?.signal, conn);
          if (!same(generation)) { if (response?.candidateId) api('/api/play/quality', { id: response.id, candidateId: response.candidateId, action: 'discard' }, undefined, conn).catch(() => {}); return; }
          if (typeof response?.stream !== 'string' || !response.stream) throw new Error('NAS 尚未提供可用播放地址');
          const sourceUrl = asset(response.stream); if (!sourceUrl) throw new Error('播放地址无效');
          await onSourceSwitch(response, { id: S.id, playback: current(), sourceUrl, position: video.currentTime, paused: video.paused, signal: S.abort.signal, isCurrent: () => same(generation) });
          if (!same(generation)) return; S.qualityId = value; close(); return;
        }
        if (action === 'audio') { const options = audioOptions(), choice = options.find(t => t.id === value); if (!choice) throw new Error('电视未提供这个音轨'); if (tracks?.selectAudio) tracks.selectAudio(value); else { const runtime = list(video.audioTracks); runtime[choice.index].enabled = true; runtime.forEach((t,i) => { if (i !== choice.index && t.enabled) t.enabled = false; }); if (!runtime[choice.index].enabled) throw new Error('电视没有接受音轨切换'); } await persist({ audio: { label: choice.label, language: choice.language, index: choice.index } }, generation); }
        if (action === 'native-subtitle') { const choice = subtitleOptions().find(t => t.id === value); if (!choice) throw new Error('电视未提供这个字幕'); if (tracks?.selectText) tracks.selectText(value); else list(video.textTracks).filter(t => !['metadata','chapters'].includes(t.kind)).forEach((t,i) => t.mode = i === choice.index ? 'showing' : 'disabled'); S.subtitleOff = false; await persist({ subtitle: { selection: { kind: 'native', label: choice.label, language: choice.language, index: choice.index } } }, generation); }
        if (action === 'subtitle-off') { if (tracks?.off) tracks.off(); else list(video.textTracks).forEach(t => t.mode = 'disabled'); S.subtitleOff = true; await persist({ subtitle: { selection: { kind: 'off' } } }, generation); }
        if (action === 'external-subtitle') { await applyExternal(value, generation); if (same(generation)) S.subtitleOff = false; }
        if (action === 'encoding') {
          S.preferences.subtitle.encoding = value; saveLocal();
          const activeId = stateTracks().selectedSubtitle?.kind === 'external' ? stateTracks().selectedSubtitle.id : (S.activeExternalId || S.options?.subtitles?.find(s => s.kind === 'external')?.id);
          if (activeId && tracks?.selectExternal) {
            await applyExternal(activeId, generation);
            if (same(generation)) { S.subtitleOff = false; S.message = '已使用 ' + (ENCODINGS.find(([c]) => c === value)?.[1] || value) + ' 重新加载字幕'; }
          }
        }
        if (action === 'rate') { const rate = Number(value); if (!RATES.includes(rate)) throw new Error('无效的播放速度'); if (tracks?.setRate) tracks.setRate(rate, { passthrough: Boolean(current()?.passthrough) }); else { if (current()?.passthrough && rate !== 1) throw new Error('音频直通仅支持正常速度'); video.playbackRate = rate; if (video.playbackRate !== rate) throw new Error('电视没有接受这个倍速'); } await persist({ rate }, generation); }
        if (action === 'mode') { if (!MODES[value]) throw new Error('无效的播放模式'); await persist({ mode: value }, generation); }
        if (action === 'skip') { const p = current(); if (!p?.skips) throw new Error('片头片尾设置尚未读取'); const enabled = !p.skips.enabled; await api('/api/play/preferences', { id: S.id, action: 'skip', enabled }, S.abort?.signal, p?.connection); if (same(generation)) p.skips.enabled = enabled; }
        if (action === 'fit') { if (!FITS[value]) throw new Error('无效的画面比例'); if (tracks?.setFit) tracks.setFit(value); else video.style.objectFit = value; await persist({ fit: value }, generation); }
        if (['offset','size','color','transparent','background','outline','position','subtitle-reset'].includes(action)) {
          if (!tracks?.setStyle || !tracks?.setOffset) throw new Error('字幕调整暂不可用');
          const patch = action === 'subtitle-reset'
            ? { offset: 0, size: 100, color: '#FFFFFF', opacity: 1, background: 0, outline: true, position: 90 }
            : action === 'transparent' ? { opacity: 0 }
            : action === 'color' ? { color: value, opacity: 1 }
            : action === 'background' ? { background: Number(value) }
            : action === 'outline' ? { outline: value === '1' }
            : { [action === 'offset' ? 'offset' : action]: Number(value) + (action === 'offset' ? Number(S.preferences.subtitle.offset) : 0) };
          let applied;
          if ('offset' in patch) applied = tracks.setOffset(patch.offset);
          if (Object.keys(patch).some(k => k !== 'offset')) applied = tracks.setStyle(Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'offset')));
          const saved = await persist({ subtitle: patch }, generation);
          if (same(generation) && applied?.applied === false) S.message = (saved ? '已保存偏好；' : '播放偏好未保存；') + (applied.reason || '当前字幕尚未提供可调整的文本。');
        }
        if (action === 'language') { const applied = tracks?.selectLanguage?.('subtitle', value), saved = await persist({ subtitle: { language: value } }, generation); if (same(generation) && (applied?.applied === false || !tracks?.selectLanguage)) S.message = (saved ? '已保存语言偏好；' : '语言偏好未保存；') + '当前没有对应的可用轨道。'; }
        if (action === 'online-page') {
          const nextPage = Math.max(1, Number(value) || 1);
          const result = await api('/api/play/subtitle', { id: S.id, action: 'search', query: S.query || current()?.title || '', language: S.preferences.subtitle.language || 'zh-cn', page: nextPage }, S.abort?.signal, current()?.connection);
          if (same(generation)) { S.results = result.items || []; S.onlinePage = result.page || nextPage; S.onlinePages = result.pages || S.onlinePages; S.message = S.results.length ? '' : '没有找到更多字幕'; }
        }
        if (action === 'online-download') { const result = await api('/api/play/subtitle', { id: S.id, action: 'download', resultId: value }, S.abort?.signal, current()?.connection); if (same(generation)) { if (result.subtitle?.id) { S.options ||= { subtitles: [] }; S.options.subtitles ||= []; S.options.subtitles.push(result.subtitle); await applyExternal(result.subtitle.id, generation); } else S.message = '下载请求已提交，请稍后重新读取字幕。'; } }
        if (action === 'delete') { await api('/api/play/subtitle', { id: S.id, action: 'delete', subtitleId: value }, S.abort?.signal, current()?.connection); if (same(generation)) { S.options = null; await open('manage'); return; } }
      } catch (error) { if (same(generation)) { S.message = error.message || '操作失败'; toast(S.message); } }
      finally { if (same(generation)) { S.busy = false; render(); } }
    }
    async function applyExternal(id, generation) {
      const option = S.options?.subtitles?.find(s => s.id === id);
      if (!tracks?.selectExternal) throw new Error('外挂字幕播放暂不可用');
      S.activeExternalId = id;
      const options = { descriptor: option, encoding: S.preferences.subtitle.encoding || 'auto', isCurrent: () => same(generation) };
      const result = await (/^(ass|ssa)$/i.test(option?.codec || '') && tracks?.state?.().assAvailable && tracks?.selectAss ? tracks.selectAss(id, options) : tracks.selectExternal(id, options));
      if (!same(generation) || result?.cancelled) return;
      if (typeof option?.label !== 'string' || !option.label.trim() || option.label.length > 240 || /[\x00-\x1f/\\?&<>]/.test(option.label)) { S.message = '字幕已应用，未能保存选择'; return; }
      const selection = { kind: 'external', label: option.label };
      if (typeof option.language === 'string' && (option.language === '' || /^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})?$/.test(option.language))) selection.language = option.language;
      await persist({ subtitle: { selection } }, generation);
    }
    function bind() {
      S.element?.querySelectorAll('[data-po-action]').forEach(b => b.onclick = () => run(b.dataset.poAction, b.dataset.poValue));
      const backButton = find('[data-po-back]'); if (backButton) backButton.onclick = back;
      const form = find('[data-po-search]'); if (form) form.onsubmit = async event => {
        event.preventDefault(); if (S.busy) return; const generation = S.generation; const query = form.querySelector('input').value.trim(); if (!query) return; S.query = query; S.onlinePage = 1; S.onlinePages = 0; S.busy = true; S.message = '正在搜索…'; render();
        try { const result = await api('/api/play/subtitle', { id: S.id, action: 'search', query, language: S.preferences.subtitle.language || 'zh-cn', page: 1 }, S.abort?.signal, current()?.connection); if (same(generation)) { S.results = result.items || []; S.onlinePage = result.page || 1; S.onlinePages = result.pages || 0; S.message = S.results.length ? '' : '没有找到字幕'; } }
        catch (error) { if (same(generation)) S.message = error.message; }
        finally { if (same(generation)) { S.busy = false; render(); } }
      };
    }
    function back() { if (!S.active) return false; if (S.page === 'settings' || S.page === S.returnToPlayerPage) close(); else open(['subtitleStyle','encoding','language','online','manage'].includes(S.page) ? 'subtitles' : S.page === 'confirmDelete' ? 'manage' : 'settings'); return true; }
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
    function hydrate(result) { const p = current(); if (!p || !result) return; resetPlayback(p); S.options = result; if (result.preferences && !p.preferencesChanged) S.preferences = { ...S.preferences, ...result.preferences, subtitle: { ...S.preferences.subtitle, ...result.preferences.subtitle } }; }
    return { open, render, bind, close, back, key, hydrate, active: () => S.active, mode: () => S.preferences.mode, preferences: () => JSON.parse(JSON.stringify(S.preferences)), nextIndex(index, length) { if (!Number.isInteger(index) || !Number.isInteger(length) || length < 1 || index < 0 || index >= length) return null; if (S.preferences.mode === 'loop_single') return index; if (index + 1 < length) return index + 1; return S.preferences.mode === 'loop_list' ? 0 : null; } };
  };
})();
