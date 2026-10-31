import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { DirectConnection } from '../lib/direct.mjs';
import { UgOS } from '../lib/ugos.mjs';
import { createBridge } from '../lib/bridge.mjs';
import { NativeThumbnails } from '../lib/native-images.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cinema-direct-')); const config = {}; const calls = [];
  const createNas = candidate => ({
    httpsAgent: { destroy() {} },
    async login(username, password) { calls.push({ login: username }); assert.equal(password, 'test-password-only'); candidate.token = 'private-native-token'; return { name: 'Family NAS', model: 'Example' }; },
    async request(path, options) { calls.push({ path, mode: candidate.authMode, clientId: candidate.clientId, options }); return {}; },
  });
  const control = new DirectConnection({ dir, config, createNas, link: { cancel() {}, resolve: async () => ({ alias: 'example', server: 'https://example.zh9.ug.link' }) }, ...options });
  t.after(async () => { control.cancel(); await rm(dir, { recursive: true, force: true }); });
  await control.load(); return { dir, config, calls, control };
}

test('UGREENlink account login persists only the verified native session and keeps passwords out of status and disk', async t => {
  const { dir, config, control, calls } = await fixture(t);
  const data = { alias: 'example', username: 'viewer', password: 'test-password-only' };
  const result = await control.handle('/api/direct/login', 'POST', data);
  assert.equal(result.connected, true); assert.equal(data.password, ''); assert.equal(config.token, 'private-native-token');
  assert.equal(calls[1].path, 'v1/video/homepage/media_list');
  const saved = await readFile(join(dir, 'session.json'), 'utf8'); assert.equal(saved.includes('test-password-only'), false); assert.equal(JSON.stringify(result).includes('private-native-token'), false);
  const restored = new DirectConnection({ dir, config: {}, link: { resolve: async () => ({alias:'example',server:'https://example.zh9.ug.link'}) } }); await restored.load(); assert.equal(restored.status().connected, true);
  assert.equal(restored.deviceId, control.deviceId);
});

test('TV background QR polling survives the scanned state, retains the QR client ID and selects persistent UGK authentication', async t => {
  const { control, config, calls } = await fixture(t);
  let polls = 0;
  control.link.createQr = async () => ({ url: 'https://www.ugnas.com/example', expiresAt: Date.now() + 10000 });
  control.link.pollQr = async () => ++polls === 1 ? { state: 'scanned' } : { state: 'authorized', device: { alias: 'example', token: 'short-token', staticToken: 'persistent-key', authMode: 'ugk', clientId: 'qr-device-id', fromQr: true } };
  await control.handle('/api/direct/qr/create', 'POST', {});
  await control.advanceQr(control.generation); assert.equal(control.qrState.state, 'scanned'); assert.ok(control.qrTimer);
  await control.advanceQr(control.generation); assert.equal(control.qrState.state, 'connected'); assert.equal(config.clientId, 'qr-device-id'); assert.equal(config.authMode, 'ugk');
  assert.equal(calls[0].mode, 'ugk'); assert.equal(calls[1].path, 'v1/verify/qrcode/login/record');
});

test('leaving during NAS session verification cancels the pending login without saving it', async t => {
  let release; const gate = new Promise(r => release = r);
  const { control, dir, config } = await fixture(t, { createNas: candidate => ({ httpsAgent: { destroy() {} }, async login() { candidate.token = 'late-token'; return {}; }, async request() { await gate; } }) });
  const pending = control.handle('/api/direct/login', 'POST', { alias: 'example', username: 'viewer', password: 'test-password-only' });
  await new Promise(r => setImmediate(r)); await control.handle('/api/direct/cancel', 'POST', {}); release();
  await assert.rejects(pending, /取消/); assert.equal(config.token, undefined); await assert.rejects(readFile(join(dir, 'session.json')));
});

test('decrypted QR sessions follow the NAS login check before reading media and recording the login', async t => {
  const { control, calls } = await fixture(t);
  await control.commit({ alias: 'example', server: 'https://example.zh9.ug.link', token: 'decrypted-session', staticToken: 'optional-key', authMode: 'token', clientId: 'qr-device', fromQr: true }, control.generation);
  assert.deepEqual(calls.map(call => call.path), ['v1/verify/is_login', 'v1/video/homepage/media_list', 'v1/verify/qrcode/login/record']);
});

test('on-TV loopback mode exposes authenticated photo previews without enabling a static web server', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cinema-loopback-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHAAAAABJRU5ErkJggg==', 'base64');
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/ugreen/v5/photo/picture/stream')) { res.setHeader('Content-Type', 'image/png'); res.end(png); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: { list: [{ picture_id: '1', file_name: 'sample.png', show_type: 0 }], total: 1 } }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const { server } = await createBridge({ dir, config: { server: `http://127.0.0.1:${upstream.address().port}`, token: 'private-session', clientId: 'sample' }, thumbnails: new NativeThumbnails(), host: '127.0.0.1', port: 0, clientToken: 'on-device-capability' });
  t.after(async () => { await new Promise(r => server.close(r)); await new Promise(r => upstream.close(r)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: 'Bearer on-device-capability' };
  assert.equal((await fetch(base + '/api/photos/list')).status, 401);
  const response = await fetch(base + '/api/photos/list', { headers }); assert.equal(response.status, 200);
  const list = await response.json(); const image = await fetch(base + list.items[0].thumb, { headers }); assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await fetch(base + '/')).status, 404);
});

test('NAS transport uses ugk for persistent scan sessions and token for ordinary sessions, including Range requests', async t => {
  const requests = [];
  const server = http.createServer((req, res) => { const url = new URL(req.url, 'http://localhost'); requests.push({ token: url.searchParams.get('token'), ugk: url.searchParams.get('ugk'), range: req.headers.range }); res.end('{"code":200,"data":{}}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  const config = { server: `http://127.0.0.1:${server.address().port}`, token: 'short-token', staticToken: 'persistent-key', clientId: 'example' }; const nas = new UgOS(config);
  t.after(() => nas.httpsAgent.destroy());
  await nas.request('v1/video/homepage/media_list'); config.authMode = 'ugk'; await nas.request('v1/video/homepage/media_list', { headers: { Range: 'bytes=0-31' } });
  assert.deepEqual(requests, [{ token: 'short-token', ugk: null, range: undefined }, { token: null, ugk: 'persistent-key', range: 'bytes=0-31' }]);
});
