import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaTrackController, parseVttCues, OFFICIAL_TV_RATES, nextPlaybackIndex, normalizeTrackLanguage } from '../lib/playback-tracks.mjs';

class List extends EventTarget {
  constructor(items) { super(); this.items = items; this.sync(); }
  sync() { this.items.forEach((item, index) => this[index] = item); this.length = this.items.length; }
  add(item) { this.items.push(item); this.sync(); this.dispatchEvent(new Event('addtrack')); }
}
class TextTrack extends EventTarget {
  constructor(label = '', language = '') { super(); this.label = label; this.language = language; this.kind = 'subtitles'; this.mode = 'disabled'; this.cues = []; }
  addCue(cue) { this.cues.push(cue); }
  removeCue(cue) { this.cues.splice(this.cues.indexOf(cue), 1); }
}
class Video extends EventTarget {
  constructor() { super(); this.audioTracks = new List([{ enabled: true, language: 'en', label: 'English' }, { enabled: false, language: 'zh', label: 'Chinese' }]); this.textTracks = new List([new TextTrack('English', 'en'), new TextTrack('Chinese', 'zh')]); this.style = {}; this.playbackRate = 1; this.id = 'video'; this.nodes = []; this.ownerDocument = { createElement: () => ({ style: {}, remove() { this.removed = true; } }), head: { appendChild: node => this.nodes.push(node) } }; }
  addTextTrack(kind, label, language) { const t = new TextTrack(label, language); t.kind = kind; this.textTracks.add(t); return t; }
}
const body = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n第一句\n\n00:00:03.000 --> 00:00:05.000\nSecond\n';
const createCue = (start, end, text) => ({ startTime: start, endTime: end, text });
function fixture(options = {}) { const video = new Video(), controller = new MediaTrackController(video, { createCue, loadSubtitle: async () => body, ...options }); controller.setSource('accountHash:movie:1'); return { video, controller }; }

test('runtime audio lists bound the actual switch and never use NAS PID values as decoder indices', () => {
  const { video, controller } = fixture(); controller.metadata.audio = Array.from({ length: 4 }, (_, i) => ({ label: 'NAS ' + i, nasId: 4352 + i }));
  assert.equal(controller.audioOptions().length, 2); assert.equal(controller.audioOptions()[1].label, 'Chinese');
  assert.throws(() => controller.selectAudio('audio:4352'), /没有被电视/);
  const result = controller.selectAudio(controller.audioOptions()[1].id); assert.equal(video.audioTracks[1].enabled, true); assert.equal(video.audioTracks[0].enabled, false); assert.equal(result.audibleVerified, false);
  const stale = controller.audioOptions()[1].id; controller.setSource('accountHash:movie:2'); assert.throws(() => controller.selectAudio(stale), /没有被电视/); controller.dispose();
});

test('absent native tracks are not manufactured from server metadata', () => {
  const { video, controller } = fixture(); video.audioTracks = new List([]); video.textTracks = new List([]);
  controller.metadata = { audio: [{ label: 'Unexposed' }], subtitles: [{ label: 'Unexposed' }] };
  assert.equal(controller.state().nativeAudioAvailable, false); assert.equal(controller.state().nativeSubtitleAvailable, false); controller.dispose();
});

test('language selection maps known ISO aliases only to tracks the runtime actually exposed', () => {
  const { video, controller } = fixture(); assert.equal(normalizeTrackLanguage('chi'), 'zh'); assert.equal(normalizeTrackLanguage('zh-Hans'), 'zh'); controller.selectLanguage('audio', 'zho'); assert.equal(video.audioTracks[1].enabled, true);
  assert.equal(controller.selectLanguage('subtitle', 'jpn').applied, false); controller.dispose();
});

test('native subtitles are selected through actual TextTrack modes and external rendering remains a separate track', async () => {
  const { video, controller } = fixture(); const result = controller.selectText(controller.textOptions()[1].id);
  assert.equal(video.textTracks[1].mode, 'showing'); assert.equal(result.visibleVerified, false);
  await controller.selectExternal('external:opaque'); assert.equal(video.textTracks[1].mode, 'disabled'); assert.equal(video.textTracks.length, 3); assert.equal(controller.textOptions().length, 2);
  controller.off(); assert.equal(video.textTracks[2].mode, 'disabled'); assert.equal(video.textTracks[2].cues.length, 0); controller.dispose();
});

test('late external subtitle fetch cannot render after off or a source change', async () => {
  let resolve; const pending = new Promise(r => resolve = r); const { video, controller } = fixture({ loadSubtitle: async () => pending });
  const result = controller.selectExternal('external:opaque'); controller.off(); resolve(body);
  assert.deepEqual(await result, { cancelled: true }); assert.equal(video.textTracks.length, 2); controller.dispose();
});

test('one reusable renderer track prevents accumulation across subtitle switches and controller disposal', async () => {
  const { video, controller } = fixture(); await controller.selectExternal('first'); await controller.selectExternal('second'); assert.equal(video.textTracks.length, 3); assert.equal(video.textTracks[2].cues.length, 2); controller.dispose();
  const next = new MediaTrackController(video, { createCue, loadSubtitle: async () => body }); next.setSource('accountHash:movie:1'); await next.selectExternal('third'); assert.equal(video.textTracks.length, 3); assert.equal(video.textTracks[2].cues.length, 2); next.dispose();
});

test('subtitle delay remains relative to original cue times and handles newly available native cues', async () => {
  const { video, controller } = fixture(); await controller.selectExternal('first'); controller.setOffset(.5); controller.setOffset(1);
  assert.equal(video.textTracks[2].cues[0].startTime, 2); controller.setOffset(-.5); assert.equal(video.textTracks[2].cues[0].startTime, .5);
  controller.selectText(controller.textOptions()[0].id); video.textTracks[0].addCue(createCue(10, 12, 'native')); video.textTracks[0].dispatchEvent(new Event('cuechange')); assert.equal(video.textTracks[0].cues[0].startTime, 9.5); controller.dispose(); assert.equal(video.textTracks[0].cues[0].startTime, 10);
});

test('subtitle style only emits validated CSS and updates text cue placement', async () => {
  const { video, controller } = fixture(); await controller.selectExternal('first'); controller.setStyle({ color: '#FFFF00', size: 125, position: 15, opacity: .8 });
  assert.match(video.nodes[0].textContent, /rgba\(255,255,0,0.8\)/); assert.equal(video.textTracks[2].cues[0].line, 15);
  assert.throws(() => controller.setStyle({ color: 'red;background:url(evil)' }), /无效/); controller.dispose(); assert.equal(video.nodes[0].removed, true);
});

test('account-scoped explicit off and audio preferences restore without overriding a newer manual choice', () => {
  const cache = new Map(), store = { get: (key, fallback) => cache.get(key) || fallback, set: (key, value) => cache.set(key, value) };
  const { video, controller } = fixture({ store }); controller.selectAudio(controller.audioOptions()[1].id); controller.off();
  controller.setSource('accountHash:movie:1'); video.dispatchEvent(new Event('loadedmetadata')); assert.equal(video.audioTracks[1].enabled, true); assert.equal(controller.selected.kind, 'off');
  controller.selectAudio(controller.audioOptions()[0].id); video.dispatchEvent(new Event('loadedmetadata')); assert.equal(video.audioTracks[0].enabled, true);
  controller.setSource('differentAccount:movie:1'); assert.equal(controller.preference().audio, undefined); assert.throws(() => controller.setSource('https://nas?token=secret'), /opaque/); controller.dispose();
});

test('load-related emptied events invalidate old work but preserve the intended preference scope', () => {
  const { video, controller } = fixture(); const old = controller.audioOptions()[0].id; video.dispatchEvent(new Event('emptied')); assert.equal(controller.scope, 'accountHash:movie:1'); assert.throws(() => controller.selectAudio(old), /没有被电视/); controller.dispose();
});

test('official TV rates, normal-speed passthrough constraint and list modes have deterministic behavior', () => {
  const { controller } = fixture(); assert.deepEqual(OFFICIAL_TV_RATES, [.5, .75, 1, 1.25, 1.5, 2]); assert.equal(controller.setRate(1.5).reported, 1.5); assert.throws(() => controller.setRate(1.5, { passthrough: true }), /直通/); assert.throws(() => controller.setRate(3), /不支持/);
  assert.equal(nextPlaybackIndex('sort_list', 2, 3), null); assert.equal(nextPlaybackIndex('loop_list', 2, 3), 0); assert.equal(nextPlaybackIndex('loop_single', 1, 3), 1); controller.dispose();
});

test('WebVTT parsing is bounded and does not claim non-WebVTT input can render', () => {
  assert.equal(parseVttCues(body).length, 2); assert.throws(() => parseVttCues('not subtitles'), /有效/); assert.throws(() => parseVttCues(body, { maximum: 1 }), /超过/);
});

test('ASS renderer injection uses an isolated overlay, applies delay and does not pretend ordinary cue CSS overrides ASS script styles', async () => {
  const slots = [], renderers = [];
  const { video, controller } = fixture({ assContainer: { appendChild: node => slots.push(node) }, loadAss: async () => '[Script Info]\nTitle: Test\n[Events]\n', createAssRenderer: async (content, element, slot) => { assert.equal(element, video); const renderer = { delay: 0, show() { this.shown = true; }, destroy() { this.destroyed = true; } }; renderers.push(renderer); return renderer; } });
  assert.equal(controller.state().assAvailable, true); await controller.selectAss('external:ass'); assert.equal(renderers[0].shown, true); assert.equal(slots[0].style.visibility, 'visible');
  controller.setOffset(.05); assert.equal(renderers[0].delay, .05); assert.equal(controller.setStyle({ size: 125 }).applied, false);
  controller.off(); assert.equal(renderers[0].destroyed, true); assert.equal(slots[0].removed, true); controller.dispose();
});

test('late ASS renderer initialization is destroyed rather than displayed after a source change', async () => {
  let release; const created = new Promise(r => release = r); let started;
  const gate = new Promise(r => started = r); const slots = [];
  const { controller } = fixture({ assContainer: { appendChild: node => slots.push(node) }, loadAss: async () => '[Script Info]\n[Events]\n', createAssRenderer: async () => { started(); return await created; } });
  const pending = controller.selectAss('external:ass'); await gate; controller.setSource('accountHash:movie:2');
  const renderer = { show() { this.shown = true; }, destroy() { this.destroyed = true; } }; release(renderer);
  assert.deepEqual(await pending, { cancelled: true }); assert.equal(renderer.destroyed, true); assert.equal(renderer.shown, undefined); assert.equal(slots[0].removed, true); controller.dispose();
});
