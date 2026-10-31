import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { Photos } from '../lib/photos.mjs';
import { createPhotoHttpHandler } from '../lib/photo-http.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), NAS_A = 'fake-nas-private-token-A-12345', NAS_B = 'fake-nas-private-token-B-12345', STATIC = 'fake-persistent-nas-token-12345';
const owner = token => createHash('sha256').update(token).digest('hex');
const ROOT = '/ugreen/v2/stream/transcode/';
const fetchBlockedEphemeral = new Set([1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
const aborted = () => new DOMException('Fake operation cancelled', 'AbortError');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(condition) { const end = Date.now() + 3000; while (!condition()) { if (Date.now() > end) throw new Error('fake condition timed out'); await tick(); } }
class FakeNas {
  constructor(state, config = { server: 'https://nas.invalid', token: NAS_A, staticToken: STATIC }) { this.state = state; this.config = { ...config }; this.id = state.counter++; this.httpsAgent = { destroy: () => state.destroyed.add(this.id) }; }
  snapshot() { return new FakeNas(this.state, this.config); }
  async request(path, options = {}) {
    this.state.calls.push({ method: 'request', path, options, token: this.config.token, client: this.id });
    if (this.state.request) { const result = await this.state.request(path, options, this); if (result !== undefined) return result; }
    if (options.signal?.aborted) throw aborted();
    if (path.endsWith('/info')) return { resolution: '3840x2160', redir_link: ROOT + 'play?video_name=fake-photo&token=' + this.config.token, transcode: [{ name: '1080P', resolution: '1920x1080' }] };
    return {};
  }
  async open(path, options = {}) {
    this.state.calls.push({ method: 'open', path, options, token: this.config.token, client: this.id });
    if (this.state.open) { const result = await this.state.open(path, options, this); if (result) return result; }
    if (options.signal?.aborted) throw aborted();
    let text;
    if (path === ROOT + 'm3u8') text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nlevels/child.m3u8?token=' + this.config.token + '&ugk=' + STATIC + '&client=drop-me\n';
    if (path === ROOT + 'levels/child.m3u8') text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n../grandchild.m3u8?token=' + this.config.token + '\n';
    if (path === ROOT + 'grandchild.m3u8') text = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?token=' + this.config.token + '"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?ugk=' + STATIC + '"\n#EXTINF:2,\nsegment.ts?token=' + this.config.token + '\n#EXT-X-ENDLIST\n';
    if (text) return response(text, 200, { 'content-type': 'application/vnd.apple.mpegurl' });
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), range = options.headers?.Range;
    let start = 0, end = bytes.length - 1, status = 200;
    if (range) { const match = /^bytes=(\d+)-(\d*)$/.exec(range); start = Number(match?.[1]); end = match?.[2] ? Number(match[2]) : end; status = 206; }
    if (start >= bytes.length) return response('{"token":"' + this.config.token + '"}', 416, { 'content-range': 'bytes */10', 'content-type': 'application/json' });
    return response(bytes.subarray(start, end + 1), status, { 'content-type': path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.bin') ? 'application/octet-stream' : 'video/mp2t', 'accept-ranges': 'bytes', ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/10` } : {}), etag: '"fake-etag"', 'last-modified': 'Sat, 31 Oct 2026 00:00:00 GMT', 'set-cookie': 'NAS=' + this.config.token, location: 'https://nas.invalid/?token=' + this.config.token });
  }
}
function response(body, statusCode = 200, headers = {}) { const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body), stream = Readable.from([bytes]); stream.statusCode = statusCode; stream.headers = { 'content-length': String(bytes.length), ...headers }; return stream; }
async function fixture(t, options = {}) {
  const state = { calls: [], destroyed: new Set(), counter: 0, proxyCalls: 0 }, nas = new FakeNas(state), photos = new Photos(nas);
  const present = photos.present({ picture_id: 42, show_type: 1, file_name: 'synthetic.mp4', real_ext_name: 'mp4' }, owner(A));
  const asset = present.stream.split('/').pop();
  const proxy = options.useProxy ? async (req, res, path, query, kind, client) => {
    state.proxyCalls++; assert.equal(kind, 'photoHls');
    const stream = await client.open(path, { query, method: 'GET', headers: req.headers.range ? { Range: req.headers.range, 'If-Range': req.headers['if-range'] } : {} });
    res.writeHead(stream.statusCode, stream.headers);
    if (req.method === 'HEAD') { stream.destroy(); res.end(); } else await pipeline(stream, res);
  } : undefined;
  const handler = createPhotoHttpHandler({ photos, ...(proxy ? { proxy } : {}), ...options.handler });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), credential = req.headers.authorization?.replace(/^Bearer /i, '') || url.searchParams.get('client');
    const context = options.fixed ? {} : { url, owner: [A, B].includes(credential) ? owner(credential) : undefined, urlContext: { client: credential, ...(options.urlContext || {}) }, ...(options.signal ? { signal: options.signal } : {}) };
    if (!await handler(req, res, context)) { res.writeHead(404); res.end(); }
  });
  do { server.listen(0, '127.0.0.1'); await once(server, 'listening'); if (!fetchBlockedEphemeral.has(server.address().port)) break; await new Promise(resolve => server.close(resolve)); } while (true);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await handler.dispose(); await photos.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (path, { token = A, body, method = body ? 'POST' : 'GET', headers = {}, signal } = {}) => fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
  const api = async (action, body, settings) => { const result = await request('/api/photos/video/' + action, { body, ...settings }); return { status: result.status, body: await result.json() }; };
  const start = async () => { const result = await api('start', { asset }); assert.equal(result.status, 200); return result.body; };
  const select = async id => { const result = await api('quality', { id, quality: '1080P@1920x1080', request: 'test-quality' }); assert.equal(result.status, 200); return result.body; };
  return { state, nas, photos, handler, server, base, asset, request, api, start, select };
}
const onlyURI = text => text.split('\n').find(line => line && !line.startsWith('#'));
const urls = text => [...text.matchAll(/URI="([^"]+)"/g)].map(match => match[1]).concat(text.split('\n').filter(line => line && !line.startsWith('#')));

test('master and every nested HLS manifest carry the same client capability without NAS tokens', async t => {
  const f = await fixture(t), started = await f.start(), selected = await f.select(started.id);
  assert.equal(new URL(started.original, f.base).searchParams.get('client'), A); assert.equal(new URL(selected.url, f.base).searchParams.get('client'), A);
  assert.equal(new URL(selected.url, f.base).pathname.endsWith('/playlist.m3u8'), true, 'LG native HLS auto-detection needs an explicit suffix');
  let path = selected.url, final;
  for (let depth = 0; depth < 3; depth++) {
    const res = await f.request(path, { token: null }); assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /mpegurl/);
    const text = await res.text(); assert.equal(text.includes(NAS_A), false); assert.equal(text.includes(STATIC), false); assert.equal(text.includes('nas.invalid'), false);
    for (const value of urls(text)) { const local = new URL(value, f.base); assert.equal(local.origin, f.base); assert.equal(local.searchParams.get('client'), A); assert.deepEqual([...local.searchParams.keys()], ['client']); }
    path = onlyURI(text); final = text;
    if (depth < 2) assert.equal(new URL(path, f.base).pathname.endsWith('.m3u8'), true, 'Nested playlists must retain the explicit extension');
  }
  assert.equal(urls(final).length, 3); for (const value of urls(final)) { const res = await f.request(value, { token: null }); assert.equal(res.status, 200); await res.arrayBuffer(); }
  const upstream = f.state.calls.filter(call => call.method === 'open'); assert.equal(upstream.every(call => call.client !== f.nas.id), true); assert.equal(upstream.every(call => !call.options.query?.client && !call.options.headers?.Authorization), true);
  const committed = await f.api('commit', { id: started.id, candidate: selected.candidate }); assert.equal(committed.status, 200);
  const closed = await f.api('close', { id: started.id }); assert.equal(closed.status, 200); assert.equal(f.photos.videos.sessions.size, 0); assert.equal(f.photos.videos.candidates.size, 0); assert.equal(f.state.destroyed.has(f.nas.id), false);
});

test('segment HEAD/Range/MIME/validators are preserved through root proxy using the candidate account snapshot', async t => {
  const f = await fixture(t, { useProxy: true }), started = await f.start();
  const selected = await f.select(started.id); let text = await (await f.request(selected.url)).text(); text = await (await f.request(onlyURI(text))).text(); text = await (await f.request(onlyURI(text))).text();
  const segment = onlyURI(text), ranged = await f.request(segment, { headers: { Range: 'bytes=1-3', 'If-Range': '"fake-etag"' } });
  assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('content-range'), 'bytes 1-3/10'); assert.equal(ranged.headers.get('accept-ranges'), 'bytes'); assert.equal(ranged.headers.get('content-type'), 'video/mp2t'); assert.equal(ranged.headers.get('etag'), '"fake-etag"'); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), Buffer.from([1, 2, 3])); assert.equal(ranged.headers.get('set-cookie'), null); assert.equal(ranged.headers.get('location'), null);
  const head = await f.request(segment, { method: 'HEAD', headers: { Range: 'bytes=2-5' } }); assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '4'); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const invalid = await f.request(segment, { headers: { Range: 'bytes=99-' } }); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), 'bytes */10'); assert.equal(await invalid.text(), '');
  assert.equal(f.state.proxyCalls, 3); const segments = f.state.calls.filter(call => call.method === 'open' && call.path.endsWith('segment.ts')); assert.equal(segments.every(call => call.token === NAS_A), true); assert.equal(segments.every(call => call.options.method === 'GET'), true); assert.equal(segments[0].options.headers['If-Range'], '"fake-etag"');
  const headManifest = await f.request(selected.url, { method: 'HEAD' }); assert.equal(headManifest.status, 200); assert.ok(Number(headManifest.headers.get('content-length')) > 0); assert.equal(await headManifest.text(), '');
});

test('cross-owner access, conflicting capabilities, invalid actions and untrusted URL mappers never reach NAS', async t => {
  const f = await fixture(t), started = await f.start(), selected = await f.select(started.id); const before = f.state.calls.length;
  assert.equal((await f.request(selected.url, { token: B })).status, 401, 'header B cannot override query A');
  const foreign = new URL(selected.url, f.base); foreign.searchParams.set('client', B); assert.equal((await f.request(foreign.pathname + foreign.search, { token: null })).status, 404);
  assert.equal((await f.api('quality', { id: started.id, quality: '1080P@1920x1080' }, { token: B })).status, 404); assert.equal(f.state.calls.length, before);
  assert.equal((await f.api('start', { asset: f.asset, owner: owner(B) })).status, 400); assert.equal((await f.request('/api/photos/video/close')).status, 405);
  const bad = await fixture(t, { urlContext: { makeURL: path => 'https://outside.invalid' + path + '?client=' + A } }); const result = await bad.api('start', { asset: bad.asset }); assert.equal(result.status, 502); assert.equal(bad.photos.videos.sessions.size, 0);
});

test('fixed-client and authorize modes work without root context and never echo provider errors or header secrets', async t => {
  const fixed = await fixture(t, { fixed: true, handler: { clientToken: A } }); assert.equal((await fixed.api('start', { asset: fixed.asset })).status, 200); assert.equal((await fixed.api('start', { asset: fixed.asset }, { token: B })).status, 401);
  const auth = await fixture(t, { fixed: true, handler: { authorize: req => { const token = req.headers.authorization?.replace(/^Bearer /i, ''); return token === A ? { owner: owner(A), client: A } : null; } } }); assert.equal((await auth.api('start', { asset: auth.asset })).status, 200);
  auth.state.request = async path => { if (path.endsWith('/info')) throw new Error('https://nas.invalid/private?token=' + NAS_A); };
  const failed = await auth.api('start', { asset: auth.asset }); assert.equal(failed.status, 502); assert.equal(JSON.stringify(failed).includes(NAS_A), false); assert.equal(JSON.stringify(failed).includes('nas.invalid'), false);
});

test('client cancellation aborts start metadata, closes its task, and leaves no root or snapshot agent', async t => {
  const f = await fixture(t); f.state.request = async (path, options) => { if (path.endsWith('/info')) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(aborted()), { once: true })); };
  const controller = new AbortController(), pending = f.request('/api/photos/video/start', { body: { asset: f.asset }, signal: controller.signal }); const rejected = assert.rejects(pending);
  await until(() => f.state.calls.some(call => call.path.endsWith('/info'))); controller.abort(); await rejected;
  await until(() => f.photos.videos.sessions.size === 0 && f.state.calls.some(call => call.path.endsWith('/close')));
  const metadata = f.state.calls.find(call => call.path.endsWith('/info'));
  assert.equal(metadata.options.signal.aborted, true); assert.equal(f.state.destroyed.has(metadata.client), true); assert.equal(f.state.destroyed.has(f.nas.id), false);
});

test('cancelled candidate metadata is discarded without closing the previously committed source', async t => {
  const f = await fixture(t), started = await f.start(), first = await f.select(started.id); await f.api('commit', { id: started.id, candidate: first.candidate });
  f.state.request = async (path, options) => { if (path.endsWith('/info')) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(aborted()), { once: true })); };
  const controller = new AbortController(), pending = f.request('/api/photos/video/quality', { body: { id: started.id, quality: '1080P@1920x1080', request: 'cancelled' }, signal: controller.signal }); const rejected = assert.rejects(pending);
  await until(() => f.photos.videos.candidates.size === 2); controller.abort(); await rejected; await until(() => f.photos.videos.candidates.size === 1);
  assert.equal(f.photos.videos.sessions.get(started.id).active, first.candidate); assert.equal(f.photos.videos.candidates.has(first.candidate), true);
});

test('reset aborts in-flight startup, closes owned tasks once and rejects late results without publishing URLs', async t => {
  let resolveInfo;
  const f = await fixture(t, { handler: { onReset: async () => { f.state.resetCalls = (f.state.resetCalls || 0) + 1; await f.photos.videos.clear(); } } });
  f.state.request = async path => { if (path.endsWith('/info')) return new Promise(resolve => { resolveInfo = resolve; }); };
  const pending = f.api('start', { asset: f.asset }); await until(() => resolveInfo);
  await Promise.all([f.handler.reset(), f.handler.reset()]); assert.equal(f.state.resetCalls, 1); resolveInfo({ resolution: '3840x2160', transcode: [] });
  const result = await pending; assert.equal(result.status, 410); assert.equal(result.body.id, undefined); assert.equal(f.photos.videos.sessions.size, 0); assert.equal(f.photos.videos.candidates.size, 0);
});

test('JSON/HTML segment errors and NAS-secret manifest metadata are rejected instead of passed through', async t => {
  const f = await fixture(t), started = await f.start(), selected = await f.select(started.id);
  let text = await (await f.request(selected.url)).text(); text = await (await f.request(onlyURI(text))).text(); text = await (await f.request(onlyURI(text))).text(); const segment = onlyURI(text);
  f.state.open = async path => path.endsWith('segment.ts') ? response('{"token":"' + NAS_A + '"}', 200, { 'content-type': 'application/json' }) : null;
  const denied = await f.request(segment); assert.equal(denied.status, 502); assert.equal((await denied.text()).includes(NAS_A), false);
  f.state.open = async path => path.endsWith('m3u8') ? response('#EXTM3U\n#private=' + NAS_A + '\n', 200, { 'content-type': 'application/vnd.apple.mpegurl' }) : null;
  const manifest = await f.request(selected.url); assert.equal(manifest.status, 502); assert.equal((await manifest.text()).includes(NAS_A), false);
});

test('abort during NAS task startup propagates to play and closes only the new candidate', async t => {
  const f = await fixture(t), started = await f.start(), first = await f.select(started.id); await f.api('commit', { id: started.id, candidate: first.candidate });
  const oldTask = f.photos.videos.candidates.get(first.candidate).session.taskId;
  let pendingPlay;
  f.state.request = async (path, options) => { if (path.endsWith('/play')) { pendingPlay = options; return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(aborted()), { once: true })); } };
  const controller = new AbortController(), pending = f.request('/api/photos/video/quality', { body: { id: started.id, quality: '1080P@1920x1080', request: 'abort-play' }, signal: controller.signal }); const rejected = assert.rejects(pending);
  await until(() => pendingPlay); const task = pendingPlay.query.task_id; controller.abort(); await rejected;
  await until(() => f.photos.videos.candidates.size === 1 && f.state.calls.some(call => call.path.endsWith('/close') && call.options.query.task_id === task));
  assert.equal(pendingPlay.signal.aborted, true); assert.equal(f.photos.videos.sessions.get(started.id).active, first.candidate); assert.equal(f.state.calls.some(call => call.path.endsWith('/close') && call.options.query.task_id === oldTask), false);
});

test('duplicate in-flight quality request IDs cannot remove another request cancellation guard', async t => {
  const f = await fixture(t), started = await f.start();
  f.state.request = async (path, options) => { if (path.endsWith('/info')) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(aborted()), { once: true })); };
  const controller = new AbortController(), body = { id: started.id, quality: '1080P@1920x1080', request: 'same-request' };
  const first = f.request('/api/photos/video/quality', { body, signal: controller.signal }); const rejected = assert.rejects(first);
  await until(() => f.photos.videos.candidates.size === 1); const before = f.state.calls.length;
  assert.equal((await f.api('quality', body)).status, 409); assert.equal((await f.api('quality', body)).status, 409); assert.equal(f.state.calls.length, before);
  controller.abort(); await rejected; await until(() => f.photos.videos.candidates.size === 0);
});

test('root context signal abort is honored even while the HTTP client remains connected', async t => {
  const controller = new AbortController(), f = await fixture(t, { signal: controller.signal });
  f.state.request = async (path, options) => { if (path.endsWith('/info')) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(aborted()), { once: true })); };
  const pending = f.api('start', { asset: f.asset }); await until(() => f.state.calls.some(call => call.path.endsWith('/info'))); controller.abort();
  const result = await pending; assert.equal(result.status, 410); assert.equal(f.photos.videos.sessions.size, 0); assert.equal(f.state.calls.find(call => call.path.endsWith('/info')).options.signal.aborted, true);
});

test('an explicit authorize rejection cannot fall back to an otherwise valid root context', async t => {
  const f = await fixture(t, { handler: { authorize: () => null } }); const result = await f.api('start', { asset: f.asset }); assert.equal(result.status, 401); assert.equal(f.state.calls.length, 0);
});

test('legacy opaque HLS routes remain valid but a media segment cannot acquire a forged m3u8 alias', async t => {
  const f = await fixture(t), started = await f.start(), selected = await f.select(started.id);
  const master = new URL(selected.url, f.base), legacy = new URL(master); legacy.pathname = legacy.pathname.replace('/playlist.m3u8', '/master');
  const response = await f.request(legacy.pathname + legacy.search, { token: null }); assert.equal(response.status, 200); let text = await response.text();
  const child = new URL(onlyURI(text), f.base), childOpaque = new URL(child); childOpaque.pathname = childOpaque.pathname.replace(/\.m3u8$/, '');
  const oldChild = await f.request(childOpaque.pathname + childOpaque.search, { token: null }); assert.equal(oldChild.status, 200); text = await oldChild.text(); text = await (await f.request(onlyURI(text))).text();
  const segment = new URL(onlyURI(text), f.base); segment.pathname += '.m3u8'; const before = f.state.calls.length;
  assert.equal((await f.request(segment.pathname + segment.search, { token: null })).status, 404); assert.equal(f.state.calls.length, before, 'Wrong-kind aliases must fail before NAS access');
});

test('active GET/HEAD is owner-bound, capability-complete and cannot become a POST or query injection endpoint',async t=>{
  const f=await fixture(t),started=await f.start(),path='/api/photos/video/active?id='+started.id;
  const initial=await f.request(path);assert.equal(initial.status,200);const before=await initial.json();assert.equal(before.candidate,null);assert.equal(before.kind,'original');assert.equal(new URL(before.url,f.base).searchParams.get('client'),A);
  const head=await f.request(path,{method:'HEAD'});assert.equal(head.status,200);assert.ok(Number(head.headers.get('content-length'))>0);assert.equal(await head.text(),'');assert.equal((await f.request(path,{token:B})).status,404);assert.equal((await f.request(path+'&id='+started.id)).status,400);assert.equal((await f.request(path+'&path=/private')).status,400);assert.equal((await f.request(path.replace(started.id,'invalid'))).status,400);assert.equal((await f.request(path,{method:'POST',body:{id:started.id}})).status,405);
  const candidate=await f.select(started.id);await f.api('commit',{id:started.id,candidate:candidate.candidate});const current=await(await f.request(path)).json();assert.equal(current.candidate,candidate.candidate);assert.equal(current.selected,'1080P@1920x1080');assert.equal(current.kind,'hls');assert.match(new URL(current.url,f.base).pathname,/\/playlist\.m3u8$/);assert.equal(new URL(current.url,f.base).searchParams.get('client'),A);assert.equal(JSON.stringify(current).includes(NAS_A),false);
});

test('a lost real HTTP commit response preserves the promoted source for active reconciliation until explicit close',async t=>{
  const f=await fixture(t),started=await f.start(),first=await f.select(started.id);await f.api('commit',{id:started.id,candidate:first.candidate});
  const oldTask=f.photos.videos.candidates.get(first.candidate).session.taskId,second=await f.select(started.id),newTask=f.photos.videos.candidates.get(second.candidate).session.taskId;let release;
  const gate=new Promise(resolve=>release=resolve);f.state.request=async(path,options)=>{if(path.endsWith('/close')&&options.query.task_id===oldTask)await gate;};
  try{
    const controller=new AbortController(),pending=f.request('/api/photos/video/commit',{body:{id:started.id,candidate:second.candidate},signal:controller.signal}),rejected=assert.rejects(pending);
    await until(()=>f.photos.videos.active({id:started.id},owner(A)).candidate===second.candidate&&f.state.calls.some(call=>call.path.endsWith('/close')&&call.options.query.task_id===oldTask));controller.abort();await rejected;await tick();
    const active=await f.request('/api/photos/video/active?id='+started.id);assert.equal(active.status,200);const current=await active.json();assert.equal(current.candidate,second.candidate);assert.equal(current.selected,'1080P@1920x1080');assert.equal((await f.request(current.url)).status,200);assert.equal(f.state.calls.some(call=>call.path.endsWith('/close')&&call.options.query.task_id===newTask),false,'Losing one response must not close the accepted candidate');
    release();await tick();const original=await f.api('quality',{id:started.id,quality:'original',request:'back-to-original'});assert.equal(original.status,200);await f.api('commit',{id:started.id,candidate:original.body.candidate});const restored=await(await f.request('/api/photos/video/active?id='+started.id)).json();assert.equal(restored.kind,'original');assert.equal(restored.candidate,original.body.candidate);assert.equal(new URL(restored.url,f.base).searchParams.get('client'),A);
    assert.equal((await f.api('close',{id:started.id})).status,200);assert.equal((await f.request('/api/photos/video/active?id='+started.id)).status,404);
  }finally{release();}
});
