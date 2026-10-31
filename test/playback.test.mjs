import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { PlaybackSession, playbackOptions, rewriteHls, subtitleToVtt, decodeSubtitle } from '../lib/playback.mjs';

const play = { file: { path: '/private/movie.mkv' }, item: { id: 1, type: 1, name: 'Example' } };
function fixture(overrides = {}) {
  const calls = [];
  const info = { resolution: '1920x1080', duration: 120000000, name: '1080P', hdr: true, dolby: 0, framerate: 24, redir_link: '/ugreen/v2/stream/transcode/play?video_name=opaque_video.mp4&token=NAS-SECRET', transcode: [{ name: '720P', cname: '高清', resolution: '1280x720', framerate: 24 }], audios: [{ id: 4352, name: 'aac', language: 'English', raw_language: 'eng', channels: 2 }], subtitle: [{ id: 6144, name: 'subrip', language: 'Chinese', raw_language: 'chi', title: 'Simplified' }] };
  const nas = {
    config: { server: 'https://nas.example.test' },
    async request(path, options) {
      calls.push({ path, options });
      if (path.endsWith('/pre_info') || path.endsWith('/info')) return info;
      if (path.endsWith('/subtitle/list')) return { result: ['/private/movie.en.srt'] };
      return {};
    },
    async open(path, options) {
      calls.push({ path, options, binary: true });
      const body = path.endsWith('/subtitle') ? '1\n00:00:01,000 --> 00:00:02,500\nHello\n' : `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="get/key.bin?token=NAS-SECRET&task_id=own-task"\n#EXTINF:4,\nget/video/00001.ts?token=NAS-SECRET&task_id=own-task&timestamp=10\n#EXT-X-ENDLIST\n`;
      return Object.assign(Readable.from([Buffer.from(body)]), { statusCode: 200, headers: {} });
    },
    ...overrides,
  };
  return { nas, info, calls, session: new PlaybackSession(nas, play, { taskId: 'own-task', now: () => 12345 }) };
}

test('quality and track menus contain only NAS-declared variants and expose no NAS paths or tokens', () => {
  const { info } = fixture(); info.transcode.push({ name: 'Invalid', resolution: 'not-a-size' }, { ...info.transcode[0] });
  const options = playbackOptions(info);
  assert.deepEqual(options.qualities.map(q => q.id), ['original', '720P@1280x720']);
  assert.equal(options.audio[0].nasId, 4352); assert.equal(options.audio[0].index, 0); assert.equal(options.subtitles[0].kind, 'embedded');
  assert.equal(options.source.durationUs, 120000000);
  assert.equal(JSON.stringify(options).includes('NAS-SECRET'), false);
  assert.equal(JSON.stringify(options).includes('video_name'), false);
});

test('metadata and external subtitle discovery do not create a transcoder and use the official camelCase subtitle body', async () => {
  const { session, calls } = fixture(); const options = await session.describe();
  const external = options.subtitles.find(s => s.kind === 'external');
  assert.equal(external.label, 'movie.en.srt'); assert.equal(JSON.stringify(options).includes('/private/'), false);
  const body = calls.find(c => c.path.endsWith('/subtitle/list')).options.body;
  assert.equal(body.videoPath, play.file.path); assert.equal(body.video_path, undefined); assert.equal(body.ignore_filter, true);
  assert.equal(calls.some(c => c.path.endsWith('/create')), false);
  await session.close(); assert.equal(calls.at(-1).options.query.task_id, 'own-task');
});

test('selecting a real quality follows create, info, play and scopes every request to the owned UUID', async () => {
  const { session, calls } = fixture(); await session.describe({ external: false });
  const result = await session.selectQuality('720P@1280x720'); assert.equal(result.kind, 'hls');
  assert.deepEqual(calls.slice(1).map(c => c.path.split('/').pop()), ['create', 'info', 'play']);
  const start = calls.find(c => c.path.endsWith('/play')).options.query;
  assert.equal(start.m3u8_file, 'opaque_video.mp4_1280x720.m3u8'); assert.equal(start.task_id, 'own-task'); assert.equal(start.timestamp, '12345'); assert.equal(start.prefer_h264, true);
  assert.equal((await session.selectQuality('original')).kind, 'original'); assert.equal(session.created, false);
  await session.close(); assert.equal(calls.filter(c => c.path.endsWith('/close')).length, 1);
});

test('HLS playlists rewrite segment and key URIs to opaque local resources and reuse their bounded registrations', async () => {
  const { session } = fixture(); await session.selectQuality('720P@1280x720');
  const manifest = await session.manifest(id => '/local/' + id);
  assert.ok(manifest.body.startsWith('#EXTM3U')); assert.equal(manifest.body.includes('NAS-SECRET'), false); assert.equal(manifest.body.includes('get/video'), false);
  const id = manifest.body.split('\n').find(line => line.startsWith('/local/')).slice('/local/'.length);
  const segment = session.resource(id); assert.equal(segment.path, '/ugreen/v2/stream/transcode/get/video/00001.ts'); assert.equal(segment.query.task_id, 'own-task'); assert.equal(segment.query.token, undefined);
  await session.manifest(id => '/local/' + id); assert.equal(session.resources.size, 2);
  await session.close(); assert.throws(() => session.resource(id), /已结束/);
});

test('foreign origins, unrelated tasks and paths outside the NAS transcoder are rejected before proxying', () => {
  const { session } = fixture();
  for (const uri of ['https://attacker.test/ugreen/v2/stream/transcode/get/x.ts', '/ugreen/v1/verify/login', 'get/x.ts?task_id=somebody-else', '../../filemgr/get?path=/etc/passwd']) assert.throws(() => session.registerResource(uri, '/ugreen/v2/stream/transcode/m3u8'));
});

test('a failed newly-created task is closed without accepting an unavailable quality or falsely reporting success', async () => {
  const f = fixture();
  const original = f.nas.request;
  f.nas.request = async (path, options) => { if (path.endsWith('/play')) throw new Error('storage unavailable'); return original(path, options); };
  await assert.rejects(f.session.selectQuality('4K@3840x2160'), /没有这个画质/); assert.equal(f.calls.some(c => c.path.endsWith('/create')), false);
  await assert.rejects(f.session.selectQuality('720P@1280x720'), /storage unavailable/);
  assert.equal(f.session.profile, null); assert.equal(f.calls.filter(c => c.path.endsWith('/close')).length, 1);
  await f.session.close();
});

test('cancelling an in-flight create closes only that task and prevents a late selectable source', async () => {
  const f = fixture(); const original = f.nas.request; let entered;
  const gate = new Promise(resolve => entered = resolve);
  f.nas.request = async (path, options) => {
    if (path.endsWith('/create')) { f.calls.push({ path, options }); entered(); await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })); }
    return original(path, options);
  };
  const pending = f.session.selectQuality('720P@1280x720'); await gate;
  const rejected = assert.rejects(pending, /cancelled/); await f.session.close(); await rejected;
  assert.equal(f.session.profile, null); const closed = f.calls.find(c => c.path.endsWith('/close')); assert.equal(closed.options.query.task_id, 'own-task');
});

test('external subtitle access uses server-listed capabilities and converts an actual SRT response to WebVTT', async () => {
  const { session, calls } = fixture(); const options = await session.describe();
  await assert.rejects(session.subtitle('/private/another.srt'), /不属于/);
  const selected = options.subtitles.find(s => s.kind === 'external'); const result = await session.subtitle(selected.id, { offset: .5 });
  assert.equal(result.contentType, 'text/vtt; charset=utf-8'); assert.match(result.body, /00:00:01\.500 --> 00:00:03\.000/);
  const request = calls.find(c => c.binary && c.path.endsWith('/subtitle')); assert.equal(request.options.query.subtitle_path, '/private/movie.en.srt');
  await session.close();
});

test('SRT, UTF-16 and ASS text cues retain time and line breaks, while unsupported data fails explicitly', () => {
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from('字幕', 'utf16le')]); assert.equal(decodeSubtitle(utf16), '字幕');
  const ass = '[Script Info]\nTitle: Example\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:03.20,0:00:05.50,Default,,0,0,0,,{\\an8}A, B\\N第二行';
  const vtt = subtitleToVtt(ass, { extension: 'ass', offset: -1 });
  assert.match(vtt, /00:00:02\.200 --> 00:00:04\.500/); assert.ok(vtt.includes('A, B\n第二行')); assert.equal(vtt.includes('an8'), false);
  assert.throws(() => subtitleToVtt('not a subtitle'), /无法转换/); assert.throws(() => subtitleToVtt('', { offset: 601 }), /超出/);
});

test('HLS rewriting handles URI-bearing tags without altering other playlist metadata', () => {
  const result = rewriteHls('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nsegment.ts\n', uri => 'local/' + uri);
  assert.equal(result, '#EXTM3U\n#EXT-X-MAP:URI="local/init.mp4"\n#EXTINF:4,\nlocal/segment.ts\n');
});

test('online subtitle downloads and deletion accept only capability IDs returned for the current movie', async () => {
  const f = fixture(); const base = f.nas.request;
  f.nas.request = async (path, options) => {
    if (path.endsWith('/subtitles/search')) { f.calls.push({ path, options }); return { page: 1, total_count: 1, total_pages: 1, data: [{ file_id: 12, feature_id: 34, file_name: 'example.zh.srt', language: 'zh-cn' }] }; }
    if (path.endsWith('/download/status')) { f.calls.push({ path, options }); return { status: 2, file_path: '/private/example.zh.srt' }; }
    return base(path, options);
  };
  const result = await f.session.searchSubtitles({ query: 'Example' });
  assert.equal(result.items[0].label, 'example.zh.srt'); assert.equal(JSON.stringify(result).includes('/private/'), false);
  await assert.rejects(f.session.downloadSubtitle('12'), /已过期/);
  const downloaded = await f.session.downloadSubtitle(result.items[0].id); assert.equal(downloaded.status, 2);
  const request = f.calls.find(c => c.path.endsWith('/download/status')); assert.deepEqual(request.options.body, { file_id: 12, feature_id: 34, language: 'zh-cn', video_path: play.file.path });
  await assert.rejects(f.session.deleteSubtitle('/private/arbitrary.srt'), /不属于/);
  await f.session.deleteSubtitle(downloaded.subtitle.id); const deleted = f.calls.find(c => c.path.endsWith('/subtitles/delete'));
  assert.equal(deleted.options.method, 'DELETE'); assert.equal(deleted.options.query.file_path, '/private/example.zh.srt');
  await f.session.close();
});

test('skipper metadata filters invalid ranges and does not synthesize intro positions when NAS has none', async () => {
  const f = fixture(); f.session.play = { ...play, item: { categoryId: 'movie-category' } };
  f.nas.request = async (path, options) => { f.calls.push({ path, options }); return { switch_type: 1, skipper_params: [{ type: 'op', start: 10, end: 30 }, { type: 'ed', start: 120, end: 0 }, { type: 'bad', start: -10, end: 20 }, { type: 'bad', start: 30, end: 20 }] }; };
  const value = await f.session.skips({duration:3600}); assert.deepEqual(value, { enabled: true, ranges: [{ start: 10, end: 30, type: 'op' },{start:3480,end:3600,type:'ed'}] });
  assert.equal(f.calls[0].options.query.path, play.file.path);
});

test('track preference metadata preserves the NAS unknown-track sentinel without claiming a selected decoder track', async () => {
  const f = fixture({ request: async () => ({ audio_tracks: { index: -99, language: '' }, subtitle_tracks: { type: 0, index: -99, subtitle_path: '/private/never-expose.srt' } }) });
  const value = await f.session.trackPreferences(); assert.equal(value.audio.index, -99); assert.equal(value.subtitle.index, -99); assert.equal(JSON.stringify(value).includes('/private/'), false);
});
