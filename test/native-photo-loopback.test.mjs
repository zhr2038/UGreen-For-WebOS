import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep, parse } from 'node:path';
import { NativePhotoLoopback, NATIVE_PHOTO_LOOPBACK_ENDPOINT } from '../lib/native-photo-loopback.mjs';

const CERT_A = Buffer.from('synthetic-test-leaf-certificate-A');
const CERT_B = Buffer.from('synthetic-test-leaf-certificate-B');
const KEY_A = 'fake-private-app-key-A-1234567890';
const KEY_B = 'fake-private-app-key-B-1234567890';
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() > deadline) throw new Error('fake transport condition timed out'); await tick(); } }

class FakeTls extends EventEmitter {
  constructor(cert, options) { super(); this.cert = cert; this.options = options; this.remoteAddress = '127.0.0.1'; this.remotePort = 3001; this.encrypted = true; this.destroyed = false; }
  getPeerCertificate() { return { raw: this.cert }; }
  secure() { this.emit('secureConnect'); }
  disableRenegotiation() { this.renegotiationDisabled = true; }
  destroy() { this.destroyed = true; }
}
function transport({ cert = CERT_A, key = KEY_A, uuid = 'synthetic-tv-A', autoTls = true, autoHello = true, autoRegister = true } = {}) {
  const sockets = [], tlsSockets = [];
  const tlsConnect = options => { const socket = new FakeTls(cert, options); tlsSockets.push(socket); return socket; };
  class WebSocket extends EventEmitter {
    constructor(endpoint, options) {
      super(); this.endpoint = endpoint; this.options = options; this.frames = []; this.readyState = 0; this.terminated = false;
      this.tls = options.createConnection({ host: 'ignored-remote.invalid', port: 443 }); sockets.push(this);
      queueMicrotask(() => { if (autoTls) { this.tls.secure(); this.open(); } });
    }
    open() { if (this.terminated) return; this.readyState = 1; this.emit('open'); }
    send(value) {
      const message = JSON.parse(value); this.frames.push(message);
      if (message.type === 'hello' && autoHello) queueMicrotask(() => this.reply({ type: 'hello', id: message.id, payload: { deviceUUID: uuid } }));
      if (message.type === 'register' && autoRegister) queueMicrotask(() => this.reply({ type: 'registered', id: message.id, payload: { 'client-key': key } }));
      if (message.uri === 'ssap://media.viewer/close') queueMicrotask(() => this.reply({ type: 'response', id: message.id, payload: { returnValue: true } }));
    }
    reply(message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
    terminate() { if (this.terminated) return; this.terminated = true; this.readyState = 3; this.emit('close'); }
  }
  return { WebSocket, tlsConnect, sockets, tlsSockets };
}
async function fixture(t, options = {}, directory) {
  const base = resolve('.local'); await mkdir(base, { recursive: true });
  const ownDirectory = directory || await mkdtemp(join(base, 'photo-loopback-test-'));
  const wire = transport(options), controller = new NativePhotoLoopback({ directory: ownDirectory, WebSocket: wire.WebSocket, tlsConnect: wire.tlsConnect, helloTimeoutMs: 1000 });
  t.after(async () => {
    await controller.dispose();
    if (!directory) { assert.ok(ownDirectory.startsWith(base + sep) && ownDirectory.includes('photo-loopback-test-')); await rm(ownDirectory, { recursive: true, force: true }); }
  });
  return { ...wire, controller, directory: ownDirectory, identity: () => readFile(join(ownDirectory, 'identity.json'), 'utf8').then(JSON.parse) };
}

test('loopback construction does no IO; implicit pairing and external credential/host overrides are rejected', async t => {
  const f = await fixture(t); assert.equal(f.sockets.length, 0); assert.deepEqual(await readdir(f.directory), []);
  await assert.rejects(f.controller.connect(), { code: 'PAIRING_REQUIRED' }); assert.equal(f.sockets.length, 0); await assert.rejects(f.identity(), { code: 'ENOENT' });
  for (const override of [{ clientKey: KEY_A }, { keyStore: {} }, { fingerprint: fingerprint(CERT_A) }, { host: '192.0.2.1' }, { port: 3000 }, { endpoint: 'wss://127.0.0.1:3001/path' }, { url: 'wss://127.0.0.1:443' }]) assert.throws(() => new NativePhotoLoopback({ directory: f.directory, WebSocket: f.WebSocket, ...override }), { code: 'EXTERNAL_IDENTITY_REJECTED' });
  assert.throws(() => new NativePhotoLoopback({ directory: 'relative/path', WebSocket: f.WebSocket }), { code: 'PRIVATE_DIRECTORY_REQUIRED' });
  assert.throws(() => new NativePhotoLoopback({ directory: parse(f.directory).root, WebSocket: f.WebSocket }), { code: 'PRIVATE_DIRECTORY_REQUIRED' });
});

test('TLS pin is completed before hello/open/register and only owned credentials are atomically persisted', async t => {
  const f = await fixture(t, { autoTls: false, autoHello: false });
  const connected = f.controller.connect({ allowPairing: true }); await until(() => f.sockets.length === 1); const raw = f.sockets[0];
  raw.open(); await tick(); assert.equal(raw.frames.length, 0, 'raw WS open cannot bypass TLS verification');
  raw.tls.secure(); await until(() => raw.frames.length === 1);
  assert.equal(raw.frames[0].type, 'hello'); assert.equal(raw.frames.some(frame => frame.type === 'register'), false);
  const pinned = await f.identity(); assert.equal(pinned.fingerprint, fingerprint(CERT_A)); assert.equal(pinned.clientKey, null);
  raw.reply({ type: 'hello', id: raw.frames[0].id, payload: { deviceUUID: 'synthetic-tv-A' } });
  const result = await connected; assert.equal(result.paired, true); assert.equal(result.tlsVerified, true); assert.equal(JSON.stringify(result).includes(KEY_A), false); assert.equal(JSON.stringify(f.controller).includes(KEY_A), false);
  const registration = raw.frames.find(frame => frame.type === 'register'); assert.equal(Object.hasOwn(registration.payload, 'client-key'), false); assert.deepEqual(registration.payload.manifest.permissions, ['LAUNCH', 'CONTROL_INPUT_MEDIA_PLAYBACK']);
  const saved = await f.identity(); assert.equal(saved.clientKey, KEY_A); assert.equal(saved.deviceUuid, 'synthetic-tv-A'); assert.equal(saved.fingerprint, fingerprint(CERT_A));
  assert.deepEqual((await readdir(f.directory)).sort(), ['identity.json']);
  if (process.platform !== 'win32') { assert.equal((await stat(f.directory)).mode & 0o777, 0o700); assert.equal((await stat(join(f.directory, 'identity.json'))).mode & 0o777, 0o600); }
  assert.equal(raw.endpoint, NATIVE_PHOTO_LOOPBACK_ENDPOINT); assert.equal(raw.options.agent, null); assert.equal(raw.options.followRedirects, false); assert.equal(raw.options.maxPayload, 65536); assert.equal(raw.tls.options.host, '127.0.0.1'); assert.equal(raw.tls.options.port, 3001); assert.equal(raw.tls.options.minVersion, 'TLSv1.2');
  assert.equal(raw.tls.renegotiationDisabled, true);
});

test('a changed leaf certificate never receives hello/register/key even with explicit pairing intent', async t => {
  const first = await fixture(t); await first.controller.connect({ allowPairing: true }); await first.controller.dispose();
  const changed = await fixture(t, { cert: CERT_B, key: KEY_B }, first.directory);
  await assert.rejects(changed.controller.connect({ allowPairing: true }), { code: 'TV_CERTIFICATE_CHANGED' });
  assert.equal(changed.sockets[0].frames.length, 0); assert.equal(changed.sockets[0].terminated, true); assert.equal(changed.tlsSockets[0].destroyed, true);
  const saved = await first.identity(); assert.equal(saved.fingerprint, fingerprint(CERT_A)); assert.equal(saved.clientKey, KEY_A); assert.equal(changed.controller.snapshot().tlsVerified, false);
});

test('a saved key is sent only after matching TLS and hello UUID, and is never exposed by status', async t => {
  const first = await fixture(t); await first.controller.connect({ allowPairing: true }); await first.controller.dispose();
  const resumed = await fixture(t, {}, first.directory); const result = await resumed.controller.connect();
  assert.equal(result.paired, true); const registration = resumed.sockets[0].frames.find(frame => frame.type === 'register'); assert.equal(registration.payload['client-key'], KEY_A); assert.equal(JSON.stringify(result).includes(KEY_A), false);
  await resumed.controller.dispose();
  const wrongUuid = await fixture(t, { uuid: 'synthetic-other-TV' }, first.directory);
  await assert.rejects(wrongUuid.controller.connect(), { code: 'TV_IDENTITY_CHANGED' }); assert.equal(wrongUuid.sockets[0].frames.some(frame => frame.type === 'register'), false); assert.equal((await first.identity()).clientKey, KEY_A);
});

test('concurrent same-instance calls cannot escalate pairing intent or start duplicate TLS sessions', async t => {
  const f = await fixture(t);
  const first = f.controller.connect(), second = f.controller.connect({ allowPairing: true }); assert.equal(first, second);
  await assert.rejects(first, { code: 'PAIRING_REQUIRED' }); assert.equal(f.sockets.length, 0);
  await Promise.all([f.controller.connect({ allowPairing: true }), f.controller.connect({ allowPairing: true })]); assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].frames.filter(frame => frame.type === 'register').length, 1);
});

test('concurrent different peers sharing one private store cannot mix pins and client keys', async t => {
  const first = await fixture(t, { key: KEY_A }), second = await fixture(t, { cert: CERT_B, key: KEY_B, uuid: 'synthetic-tv-B' }, first.directory);
  const results = await Promise.allSettled([first.controller.connect({ allowPairing: true }), second.controller.connect({ allowPairing: true })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const saved = await first.identity(), winningA = saved.fingerprint === fingerprint(CERT_A);
  assert.equal(saved.clientKey, winningA ? KEY_A : KEY_B); const loser = winningA ? second : first; assert.equal(loser.sockets[0].frames.some(frame => frame.type === 'register'), false);
  assert.deepEqual((await readdir(first.directory)).sort(), ['identity.json']);
});

test('independent adapters and directories retain separate authentication state during concurrent initialization', async t => {
  const first = await fixture(t, { key: KEY_A }), second = await fixture(t, { cert: CERT_B, key: KEY_B, uuid: 'synthetic-tv-B' });
  await Promise.all([first.controller.connect({ allowPairing: true }), second.controller.connect({ allowPairing: true })]);
  assert.equal((await first.identity()).clientKey, KEY_A); assert.equal((await second.identity()).clientKey, KEY_B); assert.equal((await first.identity()).fingerprint, fingerprint(CERT_A)); assert.equal((await second.identity()).fingerprint, fingerprint(CERT_B));
});

test('cancel before TLS or dispose during hello terminates sockets and ignores late authentication messages', async t => {
  const first = await fixture(t, { autoTls: false }); const connecting = first.controller.connect({ allowPairing: true }); const rejected = assert.rejects(connecting, { code: 'CANCELLED' }); await until(() => first.sockets.length === 1);
  const raw = first.sockets[0]; raw.open(); await first.controller.close(); raw.tls.secure(); raw.reply({ type: 'registered', payload: { 'client-key': KEY_B } }); await rejected;
  assert.equal(raw.frames.length, 0); assert.equal(raw.terminated, true); assert.equal(raw.tls.destroyed, true); await assert.rejects(first.identity(), { code: 'ENOENT' });
  const second = await fixture(t, { autoHello: false }); const pending = second.controller.connect({ allowPairing: true }); const discarded = assert.rejects(pending, { code: 'CANCELLED' }); await until(() => second.sockets[0]?.frames.length === 1);
  await second.controller.dispose(); const peer = second.sockets[0]; peer.reply({ type: 'hello', id: peer.frames[0].id, payload: { deviceUUID: 'late-tv' } }); peer.reply({ type: 'registered', payload: { 'client-key': KEY_B } }); await discarded;
  assert.equal(peer.frames.length, 1); assert.equal(peer.terminated, true); assert.equal((await second.identity()).clientKey, null); await assert.rejects(second.controller.connect({ allowPairing: true }), { code: 'DISPOSED' });
});

test('foreign key files and non-loopback TLS peers fail before register and cannot import developer-PC credentials', async t => {
  const first = await fixture(t); await writeFile(join(first.directory, 'identity.json'), JSON.stringify({ clientKey: KEY_A, ip: '192.0.2.1' }), { mode: 0o600 });
  await assert.rejects(first.controller.connect({ allowPairing: true }), { code: 'PRIVATE_STORE_INVALID' }); assert.equal(first.sockets.length, 0);
  const second = await fixture(t, { autoTls: false }); const pending = second.controller.connect({ allowPairing: true }); const rejected = assert.rejects(pending, { code: 'ENDPOINT_LOCKED' }); await until(() => second.sockets.length === 1);
  second.tlsSockets[0].remoteAddress = '192.0.2.1'; second.sockets[0].open(); second.tlsSockets[0].secure(); await rejected; assert.equal(second.sockets[0].frames.length, 0);
});

test('native open is unavailable without a real finite Activity integration', async t => {
  const f = await fixture(t); await assert.rejects(f.controller.open('http://127.0.0.1/photo-original/' + 'a'.repeat(40), { format: 'jpg' }, { allowPairing: true }), { code: 'ACTIVITY_REQUIRED' }); assert.equal(f.sockets.length, 0);
});

test('a missing hello reply reaches its bounded deadline and releases the unregistered TLS/WS connection', async t => {
  const f = await fixture(t, { autoHello: false });
  const keepTestAlive = setTimeout(() => {}, 1500);
  try { await assert.rejects(f.controller.connect({ allowPairing: true }), { code: 'TV_HELLO_TIMEOUT' }); }
  finally { clearTimeout(keepTestAlive); }
  assert.equal(f.sockets[0].frames.some(frame => frame.type === 'register'), false); assert.equal(f.sockets[0].terminated, true); assert.equal(f.tlsSockets[0].destroyed, true); assert.equal(f.controller.snapshot().tlsVerified, false);
});
