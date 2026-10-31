import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { PhotoVideoSession, PhotoVideoSessions } from '../lib/photo-video.mjs';

const info = { resolution: '3840x2160', redir_link: '/ugreen/v2/stream/transcode/play?video_name=photo-task&token=private', transcode: [{ name: '1080P', resolution: '1920x1080', bitrate: 8000000 }] };
test('photo video uses the official source 5 picture ID protocol and never movie file/subtitle APIs', async () => {
  const calls = [], nas = { config: { server: 'https://nas.invalid' }, request: async (path, options) => { calls.push({ path, ...options }); return info; }, open: async (path, options) => { calls.push({ path, ...options }); const stream = Readable.from([Buffer.from('#EXTM3U\n#EXTINF:2,\nphoto.ts?task_id=owned&token=secret\n')]); stream.statusCode = 200; return stream; } };
  const session = new PhotoVideoSession(nas, { id: '42', source_album_uuid: 'album-one', source_album_type: 2 }, { now: () => 1234, taskId: 'owned' });
  const options = await session.describe({ external: true }); assert.equal(options.qualities.length, 2); assert.equal(calls[0].path, 'v2/stream/transcode/info');
  const first = calls[0]; assert.equal(first.body.src_type, 5); assert.equal(first.body.video_path_id, 42); assert.equal(first.body.path_type, 1); assert.equal(Object.hasOwn(first.body, 'video_path'), false);
  assert.deepEqual(JSON.parse(Buffer.from(first.query.transcode_custom_query, 'base64')), { source_album_uuid: 'album-one', source_album_type: 2 });
  const selected = await session.selectQuality('1080P@1920x1080'); assert.equal(selected.kind, 'hls'); assert.equal(calls[1].query.m3u8_file, 'photo-task_1920x1080.m3u8'); assert.equal(calls[1].query.src_type, 5);
  const manifest = await session.manifest(key => '/safe/' + key); assert.match(manifest.body, /\/safe\/[0-9a-f]{32}/); assert.equal(manifest.body.includes('secret'), false);
  const resourceId = manifest.body.match(/\/safe\/([0-9a-f]{32})/)[1]; const resource = session.resource(resourceId); assert.equal(resource.query.src_type, 5); assert.equal(resource.query.task_id, 'owned'); assert.equal(resource.query.token, undefined);
  await session.selectQuality('original'); assert.equal(calls.at(-1).path, 'v2/stream/transcode/close');
  await session.selectQuality('1080P@1920x1080'); assert.equal(calls.at(-2).path, 'v2/stream/transcode/info');
  await session.close(); assert.equal(calls.at(-1).query.task_id, 'owned'); assert.equal(calls.every(call => !/pre_info|create|subtitle|skipper|media_tracks/.test(call.path)), true);
  for (const source of [{ id: '../movie' }, { id: '0' }, { id: '9007199254740993' }]) assert.throws(() => new PhotoVideoSession(nas, source), { status: 400 });
});

test('album video quality rejects foreign resources and non-allowlisted NAS profiles', async () => {
  const nas = { config: { server: 'https://nas.invalid' }, request: async () => info };
  const session = new PhotoVideoSession(nas, { id: '8' }); await session.describe();
  await assert.rejects(session.selectQuality('file:///etc/passwd'), { status: 400 });
  assert.throws(() => session.registerResource('https://foreign.invalid/ugreen/v2/stream/transcode/private.ts', ROOT), { status: 502 });
  assert.throws(() => session.registerResource('/ugreen/v2/stream/transcode/private.ts?task_id=other', ROOT), { status: 502 });
  await session.close();
});
const ROOT = '/ugreen/v2/stream/transcode/m3u8';

test('photo video tasks are owner bound, bounded, expire and are closed on account reset', async () => {
  let clock = 0, closed = 0; const timers = new Set();
  const photos = { nas: {}, get(key, owner) { if (key !== 'authorized' || owner !== 'one') throw Object.assign(new Error('not owned'), { status: 404 }); return { kind: 'video', source: { id: '8' } }; } };
  const videos = new PhotoVideoSessions(photos, { maximum: 1, ttlMs: 100, now: () => clock, setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn), createSession: () => ({ describe: async () => ({ qualities: [{ id: 'q' }] }), selectQuality: async () => ({ kind: 'hls', quality: { id: 'q' } }), close: async () => { closed++; } }) });
  await assert.rejects(videos.start({ asset: 'authorized' }, 'two'), { status: 404 });
  const started = await videos.start({ asset: 'authorized' }, 'one'); assert.equal(started.original, '/photo-video/authorized'); assert.throws(() => videos.get(started.id, 'two'), { status: 404 });
  await assert.rejects(videos.start({ asset: 'authorized' }, 'one'), { status: 429 });
  const quality = await videos.quality({ id: started.id, quality: 'q' }, 'one'); assert.equal(quality.url, `/photo-hls/${quality.candidate}/master`);
  clock = 101; await videos.reap(); assert.equal(videos.candidates.size, 0); assert.equal(timers.size, 0); assert.throws(() => videos.get(started.id, 'one'), { status: 404 });
  const next = await videos.start({ asset: 'authorized' }, 'one'); const before = closed; await videos.clear(); assert.equal(closed, before); assert.equal(videos.sessions.size, 0); assert.equal(timers.size, 0); assert.throws(() => videos.get(next.id, 'one'), { status: 404 });
});

test('a late album video description is closed after the caller has left', async () => {
  let resolve, closed = 0; const photos = { nas: {}, get: () => ({ kind: 'video', source: { id: '9' } }) };
  const videos = new PhotoVideoSessions(photos, { createSession: () => ({ describe: () => new Promise(r => { resolve = r; }), close: async () => { closed++; } }) });
  const started = videos.start({ asset: 'key' }, 'one'); await new Promise(r => setImmediate(r)); await videos.clear(); resolve({ qualities: [] });
  await assert.rejects(started, { status: 410 }); assert.ok(closed >= 1); assert.equal(videos.sessions.size, 0);
});

test('account reset before describe cancels stale starts and old timers cannot close renewed sessions', async () => {
  let closed = 0, described = 0; const callbacks = [];
  const photos = { nas: {}, get: () => ({ kind: 'video', source: { id: '9' } }) };
  const videos = new PhotoVideoSessions(photos, { setTimer: callback => { callbacks.push(callback); return callback; }, clearTimer: () => {}, createSession: () => ({ describe: async () => { described++; return { qualities: [] }; }, close: async () => { closed++; } }) });
  const stale = videos.start({ asset: 'key' }, 'one'); await videos.clear(); await assert.rejects(stale, { status: 410 }); assert.equal(described, 0); assert.equal(closed, 1);
  const next = await videos.start({ asset: 'key' }, 'one'); const beforeOld = closed, oldTimer = callbacks.at(-1); videos.get(next.id, 'one'); oldTimer(); assert.equal(closed, beforeOld); assert.equal(videos.sessions.size, 1);
  const before = closed; callbacks.at(-1)(); await new Promise(r => setImmediate(r)); assert.equal(closed, before); assert.equal(videos.sessions.size, 0);
});

test('every album task uses its own immutable account snapshot and never destroys the global NAS agent', async () => {
  const events = []; const config = { server: 'https://nas.invalid', token: 'account-A' };
  const snapshot = value => ({ config: { ...value }, httpsAgent: { destroy() { events.push(['destroy', value.token]); } }, snapshot() { return snapshot({ ...this.config }); } });
  const nas = { config, snapshot() { return snapshot({ ...config }); }, httpsAgent: { destroy() { throw new Error('global Agent must stay open'); } } };
  const photos = { nas, get: () => ({ kind: 'video', source: { id: '7' } }) };
  const options = { qualities: [{ id: 'q' }] };
  const videos = new PhotoVideoSessions(photos, { createSession: captured => ({ describe: async () => { events.push(['describe', captured.config.token]); return options; }, selectQuality: async () => ({ kind: 'hls', quality: options.qualities[0] }), close: async () => { events.push(['close', captured.config.token]); } }) });
  const started = await videos.start({ asset: 'key' }, 'one'); config.token = 'account-B';
  const candidate = await videos.quality({ id: started.id, quality: 'q' }, 'one'); await videos.commit({ id: started.id, candidate: candidate.candidate }, 'one');
  await videos.clear(); assert.equal(events.filter(([type]) => type === 'close').every(([, token]) => token === 'account-A'), true); assert.equal(events.filter(([type]) => type === 'destroy').length, 2);
  assert.equal(events.filter(([type]) => type === 'describe').every(([, token]) => token === 'account-A'), true);
  const next = await videos.start({ asset: 'key' }, 'two'); await videos.close({ id: next.id }, 'two'); assert.deepEqual(events.at(-1), ['destroy', 'account-B']);
});

test('quality candidates preserve the playing task until commit and are closed when cancelled or late', async () => {
  const closed = [], waiting = new Map(); let counter = 0;
  const options = { qualities: [{ id: 'original', original: true }, { id: 'q' }] };
  const photos = { nas: { config: {} }, get: () => ({ kind: 'video', source: { id: '8' } }) };
  const videos = new PhotoVideoSessions(photos, { createSession: () => { const task = ++counter; return { describe: async () => options, selectQuality: async () => { if (task === 4) await new Promise(resolve => waiting.set(task, resolve)); return { kind: 'hls', quality: { id: 'q' } }; }, close: async () => { closed.push(task); } }; } });
  const root = await videos.start({ asset: 'key' }, 'one'); const first = await videos.quality({ id: root.id, quality: 'q', request: 'first' }, 'one'); await videos.commit({ id: root.id, candidate: first.candidate }, 'one'); assert.deepEqual(closed, [1]);
  const second = await videos.quality({ id: root.id, quality: 'q', request: 'second' }, 'one'); assert.equal(videos.candidates.has(first.candidate), true); await videos.discard({ id: root.id, candidate: second.candidate }, 'one'); assert.deepEqual(closed, [1, 3]); assert.equal(videos.candidates.has(first.candidate), true);
  const late = videos.quality({ id: root.id, quality: 'q', request: 'late' }, 'one'); await new Promise(r => setImmediate(r)); await videos.discard({ id: root.id, request: 'late' }, 'one'); waiting.get(4)(); await assert.rejects(late, { status: 410 }); assert.equal(closed.includes(4), true); assert.equal(closed.includes(2), false);
  const original = await videos.quality({ id: root.id, quality: 'original', request: 'original' }, 'one'); assert.equal(original.url, '/photo-video/key'); assert.equal(closed.includes(2), false); await videos.commit({ id: root.id, candidate: original.candidate }, 'one'); assert.equal(closed.includes(2), true); await videos.clear();
});

test('an uncommitted HLS candidate has an absolute deadline even when its stream is read', async () => {
  let now = 0, closed = 0;
  const photos = { nas: { config: {} }, get: () => ({ kind: 'video', source: { id: '8' } }) };
  const videos = new PhotoVideoSessions(photos, { now: () => now, ttlMs: 1000, candidateTtlMs: 100, setTimer: () => null, clearTimer: () => {}, createSession: () => ({ describe: async () => ({ qualities: [{ id: 'q' }] }), selectQuality: async () => ({ kind: 'hls', quality: { id: 'q' } }), close: async () => { closed++; } }) });
  const root = await videos.start({ asset: 'key' }, 'one'), candidate = await videos.quality({ id: root.id, quality: 'q' }, 'one');
  now = 80; videos.hls(candidate.candidate, 'one'); assert.equal(videos.candidates.get(candidate.candidate).expires, 100);
  now = 101; await assert.rejects(videos.commit({ id: root.id, candidate: candidate.candidate }, 'one'), { status: 404 }); assert.equal(videos.candidates.size, 0); assert.equal(closed, 2); await videos.clear();
});

test('old-task close failure reports uncertainty without rolling back a committed new quality', async () => {
  let task = 0;
  const photos = { nas: { config: {} }, get: () => ({ kind: 'video', source: { id: '8' } }) };
  const videos = new PhotoVideoSessions(photos, { createSession: () => { const id = ++task; return { describe: async () => ({ qualities: [{ id: 'q' }] }), selectQuality: async () => ({ kind: 'hls', quality: { id: 'q' } }), close: async () => { if (id === 2) throw new Error('unknown close result'); } }; } });
  const root = await videos.start({ asset: 'key' }, 'one'); const first = await videos.quality({ id: root.id, quality: 'q' }, 'one'); await videos.commit({ id: root.id, candidate: first.candidate }, 'one');
  const next = await videos.quality({ id: root.id, quality: 'q' }, 'one'); const result = await videos.commit({ id: root.id, candidate: next.candidate }, 'one');
  assert.equal(result.ok, true); assert.match(result.warning, /关闭未确认/); assert.match(videos.active({ id: root.id }, 'one').warning, /关闭未确认/); assert.equal(videos.sessions.get(root.id).active, next.candidate); assert.doesNotThrow(() => videos.hls(next.candidate, 'one')); await videos.clear();
});

test('active reconciles atomic promotion before old cleanup completes and retains original candidate identity without NAS writes', async()=>{
  let counter=0,release;const closed=[],gate=new Promise(resolve=>release=resolve),options={qualities:[{id:'original',label:'原画',original:true},{id:'q',label:'1080P'}]};
  const photos={nas:{config:{}},get:()=>({kind:'video',source:{id:'8'}})};
  const videos=new PhotoVideoSessions(photos,{createSession:()=>{const task=++counter;return{describe:async()=>options,selectQuality:async()=>({kind:'hls',quality:options.qualities[1]}),close:async()=>{closed.push(task);if(task===2)await gate;}};}});
  try{
    const root=await videos.start({asset:'authorized'},'one'),initial=videos.active({id:root.id},'one');assert.equal(initial.kind,'original');assert.equal(initial.candidate,null);assert.equal(initial.selected,'original');
    const first=await videos.quality({id:root.id,quality:'q'},'one');await videos.commit({id:root.id,candidate:first.candidate},'one');const second=await videos.quality({id:root.id,quality:'q'},'one'),pending=videos.commit({id:root.id,candidate:second.candidate},'one');
    const active=videos.active({id:root.id},'one');assert.equal(active.candidate,second.candidate);assert.equal(active.selected,'q');assert.equal(active.url,`/photo-hls/${second.candidate}/master`);assert.equal(active.kind,'hls');assert.throws(()=>videos.active({id:root.id},'other'),{status:404});assert.equal(counter,3,'A read-only state check must not prepare another NAS task');
    release();await pending;
    const original=await videos.quality({id:root.id,quality:'original'},'one');await videos.commit({id:root.id,candidate:original.candidate},'one');const restored=videos.active({id:root.id},'one');assert.equal(restored.candidate,original.candidate);assert.equal(restored.kind,'original');assert.equal(restored.selected,'original');assert.equal(restored.url,'/photo-video/authorized');assert.equal(videos.candidates.has(original.candidate),false);
    await videos.close({id:root.id},'one');assert.throws(()=>videos.active({id:root.id},'one'),{status:404});
  }finally{release();await videos.clear();}
});
