// Browser-safe runtime controls. No Node imports and no speculative Luna calls.
export const OFFICIAL_TV_RATES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2]);
export const SUBTITLE_COLORS = Object.freeze(['#FFFFFF', '#FFFF00', '#FF0000', '#00FF00', '#0000FF', '#000000']);
export const OFFICIAL_PLAY_MODES = Object.freeze(['sort_list', 'loop_list', 'loop_single']);
export function nextPlaybackIndex(mode, index, length) {
  if (!OFFICIAL_PLAY_MODES.includes(mode) || !Number.isInteger(index) || !Number.isInteger(length) || length < 1 || index < 0 || index >= length) throw new RangeError('无效的播放列表状态');
  if (mode === 'loop_single') return index;
  if (index + 1 < length) return index + 1;
  return mode === 'loop_list' ? 0 : null;
}
const ownedTracks = new WeakMap();
const invalid = message => Object.assign(new Error(message), { code: 'UNAVAILABLE' });
const array = list => list ? Array.from({ length: Number(list.length) || 0 }, (_, index) => list[index]).filter(Boolean) : [];
const norm = value => String(value || '').trim().toLowerCase();
export function normalizeTrackLanguage(value) { const language = norm(value).split(/[-_]/)[0]; return ({ chi: 'zh', zho: 'zh', cmn: 'zh', eng: 'en', jpn: 'ja', kor: 'ko', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', und: '' })[language] ?? language; }
const defaults = { color: '#FFFFFF', size: 100, position: 90, opacity: 1, background: 0, outline: true };
const clock = value => value.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);

export function parseVttCues(body, { maximum = 20000 } = {}) {
  if (typeof body !== 'string' || body.length > 8 * 1024 * 1024 || !body.replace(/^\uFEFF/, '').startsWith('WEBVTT')) throw invalid('字幕不是有效 WebVTT');
  const cues = [];
  for (const block of body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n'), at = lines.findIndex(line => line.includes('-->'));
    if (at < 0) continue;
    const match = lines[at].match(/^\s*((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})(?:\s+.*)?$/);
    if (!match) continue;
    const start = clock(match[1]), end = clock(match[2]);
    if (Number.isFinite(start) && end > start) cues.push({ start, end, text: lines.slice(at + 1).join('\n') });
    if (cues.length > maximum) throw invalid('字幕条目超过限制');
  }
  return cues;
}

export class MediaTrackController {
  constructor(video, { loadSubtitle, loadAss, createAssRenderer, assContainer, createCue = (start, end, text) => new globalThis.VTTCue(start, end, text), store, onChange = () => {} } = {}) {
    if (!video || typeof video.addEventListener !== 'function') throw new TypeError('A video element is required');
    this.video = video; this.loadSubtitle = loadSubtitle; this.loadAss = loadAss; this.createAssRenderer = createAssRenderer; this.assContainer = assContainer; this.createCue = createCue; this.store = store; this.onChange = onChange;
    this.epoch = 0; this.generation = 0; this.scope = ''; this.metadata = { audio: [], subtitles: [] }; this.selected = null; this.offset = 0; this.style = { ...defaults }; this.baseTimes = new Map(); this.disposed = false;
    this.originalFit = video.style?.objectFit || '';
    this.refreshHandler = () => { if (!this.disposed) { this.restorePreference(); this.publish(); } };
    this.changeHandler = () => { if (!this.disposed) this.publish(); };
    this.emptyHandler = () => this.reset({ preserveScope: true });
    video.addEventListener('loadedmetadata', this.refreshHandler); video.addEventListener('emptied', this.emptyHandler);
    video.audioTracks?.addEventListener?.('addtrack', this.refreshHandler); video.audioTracks?.addEventListener?.('change', this.changeHandler);
    video.textTracks?.addEventListener?.('addtrack', this.refreshHandler); video.textTracks?.addEventListener?.('change', this.changeHandler);
  }
  setSource(scope, metadata = {}) {
    this.assertActive();
    if (typeof scope !== 'string' || !/^[a-zA-Z0-9:_-]{1,180}$/.test(scope)) throw new TypeError('Use an opaque account/item preference scope, never a URL or token');
    this.reset(); this.scope = scope; this.metadata = { audio: Array.isArray(metadata.audio) ? metadata.audio : [], subtitles: (Array.isArray(metadata.subtitles) ? metadata.subtitles : []).filter(s => s.kind === 'embedded') }; this.style = { ...defaults }; this.applyStyle(); this.publish();
  }
  reset({ preserveScope = false } = {}) {
    const scope = this.scope;
    this.epoch++; this.generation++; this.fetchAbort?.abort(); this.fetchAbort = null;
    if (this.selected?.kind === 'native') { try { this.activeText().mode = 'disabled'; } catch {} }
    this.watchTrack(null); this.destroyAss(); this.restoreTimes(); this.clearOwned(); this.selected = null; this.offset = 0; this.audioExplicit = false; this.textExplicit = false; this.scope = preserveScope ? scope : '';
  }
  audioOptions() {
    const runtime = array(this.video.audioTracks), labels = runtime.length === this.metadata.audio.length ? this.metadata.audio : [];
    return runtime.map((track, index) => ({ id: `audio:${this.epoch}:${index}`, index, label: track.label || labels[index]?.label || track.language || `音轨 ${index + 1}`, language: track.language || labels[index]?.language || '', enabled: Boolean(track.enabled), runtime: true }));
  }
  textOptions() {
    const own = ownedTracks.get(this.video), runtime = array(this.video.textTracks).filter(track => track !== own && !['metadata', 'chapters'].includes(track.kind));
    const labels = runtime.length === this.metadata.subtitles.length ? this.metadata.subtitles : [];
    return runtime.map((track, index) => ({ id: `text:${this.epoch}:${index}`, index, label: track.label || labels[index]?.label || track.language || `字幕 ${index + 1}`, language: track.language || labels[index]?.language || '', showing: track.mode === 'showing', runtime: true }));
  }
  state() { return { audio: this.audioOptions(), subtitles: this.textOptions(), selectedSubtitle: this.selected, offset: this.offset, style: { ...this.style }, nativeAudioAvailable: this.audioOptions().length > 0, nativeSubtitleAvailable: this.textOptions().length > 0, externalSubtitleAvailable: typeof this.loadSubtitle === 'function' && typeof this.video.addTextTrack === 'function', assAvailable: typeof this.loadAss === 'function' && typeof this.createAssRenderer === 'function' && Boolean(this.assContainer) }; }
  publish() { this.onChange(this.state()); }
  assertActive() { if (this.disposed) throw invalid('播放器轨道控制器已关闭'); }
  preference() { if (!this.scope || !this.store) return {}; try { return JSON.parse(this.store.get('tracks.' + this.scope, '{}') || '{}'); } catch { return {}; } }
  save(part) { if (!this.scope || !this.store) return; const current = this.preference(); this.store.set('tracks.' + this.scope, JSON.stringify({ ...current, ...part })); }
  remember(kind, option, count) { return { [kind]: { label: option.label, language: option.language, index: option.index, count } }; }
  selectAudio(id, { remember = true } = {}) {
    this.assertActive(); const options = this.audioOptions(), choice = options.find(option => option.id === id);
    if (!choice) throw invalid('这个音轨没有被电视解码器提供');
    const tracks = array(this.video.audioTracks), previous = tracks.map(t => t.enabled);
    try {
      // The runtime list, not NAS's PID/stream IDs, bounds the selection.
      tracks[choice.index].enabled = true;
      for (let i = 0; i < tracks.length; i++) if (i !== choice.index && tracks[i].enabled) tracks[i].enabled = false;
      if (!tracks[choice.index].enabled) throw invalid('电视没有接受音轨切换');
    } catch (error) { tracks.forEach((t, i) => { try { t.enabled = previous[i]; } catch {} }); throw error; }
    this.audioExplicit = true; if (remember) this.save(this.remember('audio', choice, options.length)); this.publish();
    return { requested: choice.id, enabled: true, audibleVerified: false };
  }
  selectLanguage(kind, language) {
    this.assertActive();
    if (!['audio', 'subtitle'].includes(kind) || typeof language !== 'string' || !normalizeTrackLanguage(language)) throw new RangeError('无效的轨道语言');
    const options = kind === 'audio' ? this.audioOptions() : this.textOptions();
    const choice = options.find(o => norm(o.language) === norm(language)) || options.find(o => normalizeTrackLanguage(o.language) === normalizeTrackLanguage(language));
    if (!choice) return { applied: false, reason: '电视没有提供这个语言的轨道' };
    return kind === 'audio' ? this.selectAudio(choice.id) : this.selectText(choice.id);
  }
  nativeTextTracks() { const own = ownedTracks.get(this.video); return array(this.video.textTracks).filter(track => track !== own && !['metadata', 'chapters'].includes(track.kind)); }
  selectText(id, { remember = true } = {}) {
    this.assertActive(); const options = this.textOptions(), choice = options.find(option => option.id === id);
    if (!choice) throw invalid('这个内嵌字幕没有被电视解码器提供');
    const tracks = this.nativeTextTracks(), previous = tracks.map(t => t.mode);
    this.generation++; this.fetchAbort?.abort();
    try { tracks.forEach((track, i) => track.mode = i === choice.index ? 'showing' : 'disabled'); if (tracks[choice.index].mode !== 'showing') throw invalid('电视没有接受字幕切换'); }
    catch (error) { tracks.forEach((t, i) => { try { t.mode = previous[i]; } catch {} }); throw error; }
    this.destroyAss(); this.clearOwned(); this.restoreTimes();
    this.selected = { kind: 'native', id: choice.id, index: choice.index }; this.textExplicit = true;
    if (remember) this.save(this.remember('subtitle', choice, options.length));
    this.watchTrack(tracks[choice.index]); this.applyOffset(); this.applyStyle(); this.publish(); return { requested: choice.id, mode: 'showing', visibleVerified: false };
  }
  async selectExternal(id) {
    this.assertActive(); if (typeof this.loadSubtitle !== 'function') throw invalid('外挂字幕读取尚未接入');
    const generation = ++this.generation, epoch = this.epoch; this.fetchAbort?.abort(); const abort = new AbortController(); this.fetchAbort = abort;
    let response;
    try { response = await this.loadSubtitle(id, { signal: abort.signal }); }
    catch (error) { if (generation !== this.generation || epoch !== this.epoch || this.disposed) return { cancelled: true }; throw error; }
    if (generation !== this.generation || epoch !== this.epoch || this.disposed) return { cancelled: true };
    const cues = parseVttCues(typeof response === 'string' ? response : response.body);
    const prepared = cues.map(item => ({ cue: this.createCue(item.start, item.end, item.text), item }));
    let own = ownedTracks.get(this.video);
    if (!own) { own = this.video.addTextTrack('subtitles', '云映字幕', ''); ownedTracks.set(this.video, own); }
    this.destroyAss(); this.restoreTimes(); this.clearOwned(); this.nativeTextTracks().forEach(track => track.mode = 'disabled'); own.mode = 'hidden';
    try { for (const { cue, item } of prepared) { own.addCue(cue); this.baseTimes.set(cue, { start: item.start, end: item.end }); } }
    catch (error) { this.clearOwned(); throw error; }
    this.selected = { kind: 'external', id }; this.textExplicit = true; this.watchTrack(own); this.applyOffset(); own.mode = 'showing'; this.applyStyle(); this.publish();
    return { requested: id, cues: cues.length, mode: 'showing', visibleVerified: false };
  }
  async selectAss(id) {
    this.assertActive(); if (!this.state().assAvailable) throw invalid('ASS 完整样式渲染器尚未接入');
    const generation = ++this.generation, epoch = this.epoch; this.fetchAbort?.abort(); const abort = new AbortController(); this.fetchAbort = abort;
    let content;
    try { content = await this.loadAss(id, { signal: abort.signal }); } catch (error) { if (generation !== this.generation || epoch !== this.epoch || this.disposed) return { cancelled: true }; throw error; }
    if (generation !== this.generation || epoch !== this.epoch || this.disposed) return { cancelled: true };
    if (typeof content !== 'string' || content.length > 8 * 1024 * 1024 || !/^\s*\[(?:Script Info|V4\+? Styles)\]/im.test(content)) throw invalid('ASS 字幕内容无效');
    const slot = this.video.ownerDocument.createElement('div'); slot.style.visibility = 'hidden'; this.assContainer.appendChild(slot); let renderer;
    try {
      renderer = await this.createAssRenderer(content, this.video, slot);
      if (!renderer || typeof renderer.destroy !== 'function' || typeof renderer.show !== 'function') throw invalid('ASS 渲染器接口无效');
      if (generation !== this.generation || epoch !== this.epoch || this.disposed) { renderer.destroy(); slot.remove(); return { cancelled: true }; }
      this.destroyAss(); this.watchTrack(null); this.restoreTimes(); this.clearOwned(); this.nativeTextTracks().forEach(t => t.mode = 'disabled');
      this.ass = renderer; this.assSlot = slot; this.selected = { kind: 'ass', id }; this.textExplicit = true;
      renderer.delay = this.offset; slot.style.visibility = 'visible'; renderer.show(); this.publish();
      return { requested: id, renderer: 'ass', visibleVerified: false };
    } catch (error) { if (this.ass === renderer) { this.ass = null; this.assSlot = null; this.selected = { kind: 'off' }; } try { renderer?.destroy?.(); } finally { slot.remove(); } throw error; }
  }
  destroyAss() { if (this.ass) { try { this.ass.destroy(); } finally { this.ass = null; this.assSlot?.remove(); this.assSlot = null; } } }
  off({ remember = true } = {}) {
    this.assertActive(); this.generation++; this.fetchAbort?.abort(); this.watchTrack(null); this.destroyAss(); this.restoreTimes(); this.clearOwned(); this.nativeTextTracks().forEach(t => t.mode = 'disabled');
    this.selected = { kind: 'off' }; this.textExplicit = true; if (remember) this.save({ subtitle: { off: true } }); this.publish();
  }
  clearOwned() { const track = ownedTracks.get(this.video); if (track) { track.mode = 'disabled'; for (const cue of array(track.cues)) track.removeCue(cue); } }
  restoreTimes() { for (const [cue, original] of this.baseTimes) { try { cue.startTime = original.start; cue.endTime = original.end; } catch {} } this.baseTimes.clear(); }
  activeText() { if (this.selected?.kind === 'external') return ownedTracks.get(this.video); if (this.selected?.kind === 'native') return this.nativeTextTracks()[this.selected.index]; }
  watchTrack(track) {
    this.watchedTrack?.removeEventListener?.('cuechange', this.cueHandler);
    this.watchedTrack = track;
    this.cueHandler = () => { if (!this.disposed) { this.applyOffset(); this.applyStyle(); } };
    track?.addEventListener?.('cuechange', this.cueHandler);
  }
  setOffset(seconds) { this.assertActive(); if (!Number.isFinite(seconds) || Math.abs(seconds) > 600) throw new RangeError('字幕延迟范围为 -600 至 600 秒'); this.offset = seconds; const result = this.applyOffset(); this.save({ subtitleOffset: seconds }); this.publish(); return result; }
  applyOffset() {
    if (this.selected?.kind === 'ass' && this.ass) { this.ass.delay = this.offset; return { applied: this.ass.delay === this.offset, renderer: 'ass', visibleVerified: false }; }
    const track = this.activeText(); if (!track?.cues) return { applied: false, reason: '当前字幕未提供可调整的文本 cue' };
    for (const cue of array(track.cues)) {
      if (!this.baseTimes.has(cue)) this.baseTimes.set(cue, { start: cue.startTime, end: cue.endTime });
      const original = this.baseTimes.get(cue), start = Math.max(0, original.start + this.offset), end = Math.max(start + .001, original.end + this.offset);
      if (cue.startTime !== start) cue.startTime = start; if (cue.endTime !== end) cue.endTime = end;
    }
    return { applied: true, cues: track.cues.length, visibleVerified: false };
  }
  setStyle(update, { remember = true } = {}) {
    this.assertActive(); const style = { ...this.style, ...update };
    if (!/^#[0-9a-f]{6}$/i.test(style.color) || !Number.isFinite(style.size) || style.size < 50 || style.size > 200 || !Number.isFinite(style.position) || style.position < 5 || style.position > 95 || !Number.isFinite(style.opacity) || style.opacity < 0 || style.opacity > 1 || !Number.isFinite(style.background) || style.background < 0 || style.background > 1 || typeof style.outline !== 'boolean') throw new RangeError('无效的字幕样式');
    this.style = style; this.applyStyle(); if (remember) this.save({ subtitleStyle: style }); this.publish(); return { requested: { ...style }, applied: this.selected?.kind !== 'ass', ...(this.selected?.kind === 'ass' ? { reason: 'ASS 使用字幕脚本样式，普通文本样式不覆盖脚本' } : {}), visibleVerified: false };
  }
  applyStyle() {
    const doc = this.video.ownerDocument, style = this.style;
    if (doc?.createElement) {
      if (!this.styleNode) { this.styleNode = doc.createElement('style'); doc.head.appendChild(this.styleNode); }
      const selector = /^[a-zA-Z][\w-]*$/.test(this.video.id || '') ? '#' + this.video.id : 'video';
      const rgb = style.color.slice(1).match(/../g).map(n => parseInt(n, 16)).join(',');
      this.styleNode.textContent = `${selector}::cue{color:rgba(${rgb},${style.opacity});font-size:${style.size * .04}vh;background-color:rgba(0,0,0,${style.background});text-shadow:${style.outline ? '1px 1px 2px #000,-1px -1px 2px #000' : 'none'};}`;
    }
    for (const cue of array(this.activeText()?.cues)) { try { cue.snapToLines = false; cue.line = style.position; cue.align = 'center'; } catch {} }
  }
  restorePreference() {
    const pref = this.preference();
    const choose = (options, selection) => options.find(o => selection?.label && norm(o.label) === norm(selection.label) && (!selection.language || norm(o.language) === norm(selection.language))) || options.find(o => selection?.language && norm(o.language) === norm(selection.language)) || (selection?.count === options.length ? options[selection.index] : undefined);
    if (!this.audioExplicit && pref.audio) { const pick = choose(this.audioOptions(), pref.audio); if (pick) { try { this.selectAudio(pick.id, { remember: false }); } catch {} } }
    if (!this.textExplicit && pref.subtitle) { if (pref.subtitle.off) this.off({ remember: false }); else { const pick = choose(this.textOptions(), pref.subtitle); if (pick) { try { this.selectText(pick.id, { remember: false }); } catch {} } } }
    if (Number.isFinite(pref.subtitleOffset)) { this.offset = Math.max(-600, Math.min(600, pref.subtitleOffset)); this.applyOffset(); }
    if (pref.subtitleStyle) { try { this.setStyle(pref.subtitleStyle, { remember: false }); } catch {} }
  }
  setRate(rate, { passthrough = false } = {}) {
    this.assertActive(); if (!OFFICIAL_TV_RATES.includes(rate)) throw new RangeError('不支持的电视播放倍速'); if (passthrough && rate !== 1) throw invalid('音频直通仅支持正常倍速');
    this.video.playbackRate = rate; if (this.video.playbackRate !== rate) throw invalid('电视没有接受该倍速'); return { requested: rate, reported: this.video.playbackRate, audibleVerified: false };
  }
  setFit(fit) { this.assertActive(); if (!['contain', 'cover', 'fill'].includes(fit)) throw new RangeError('无效的画面比例模式'); this.video.style.objectFit = fit; return { requested: fit, visibleVerified: false }; }
  dispose() {
    if (this.disposed) return; this.reset(); this.disposed = true;
    this.video.removeEventListener('loadedmetadata', this.refreshHandler); this.video.removeEventListener('emptied', this.emptyHandler);
    this.video.audioTracks?.removeEventListener?.('addtrack', this.refreshHandler); this.video.audioTracks?.removeEventListener?.('change', this.changeHandler);
    this.video.textTracks?.removeEventListener?.('addtrack', this.refreshHandler); this.video.textTracks?.removeEventListener?.('change', this.changeHandler);
    this.styleNode?.remove(); if (this.video.style) this.video.style.objectFit = this.originalFit;
  }
}
