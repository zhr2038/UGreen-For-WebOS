import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativePhotoSession } from '../lib/native-photo-session.mjs';

const key = 'fake-owned-tv-key-1234567890';
const url = suffix => 'http://127.0.0.1:1234/photo-original/' + suffix.repeat(40) + '?client=fake-local-cap';
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
class Clock {
  constructor() { this.time = 1000; this.next = 0; this.pending = new Map(); }
  now = () => this.time;
  set = (callback, delay) => { const token = { id: ++this.next, unref() {} }; this.pending.set(token.id, { token, callback, at: this.time + delay }); return token; };
  clear = token => this.pending.delete(token.id);
  advance(ms) { this.time += ms; for (const job of [...this.pending.values()]) if (job.at <= this.time && this.pending.delete(job.token.id)) job.callback(); }
}
class Socket extends EventEmitter {
  constructor(onSend) { super(); this.readyState = 0; this.frames = []; this.onSend = onSend; }
  open() { this.readyState = 1; this.emit('open'); }
  send(raw) { const frame = JSON.parse(raw); this.frames.push(frame); this.onSend?.(frame, this); }
  reply(id, payload, type = 'response') { this.emit('message', JSON.stringify({ id, type, payload })); }
  close() { this.readyState = 3; this.emit('close'); }
}
function fixture(t, options = {}) {
  const clock = new Clock(), leases = [], saved = [], sockets = [], endpoints = []; let sessions = 0;
  const controller = new NativePhotoSession({
    keyStore: { load: async () => options.unpaired ? null : key, save: async value => saved.push(value) },
    createSocket: endpoint => {
      endpoints.push(endpoint);
      const socket = new Socket((frame, peer) => {
        if (frame.type === 'register' && !options.manualRegister) queueMicrotask(() => peer.reply(frame.id, { 'client-key': key }, 'registered'));
        if (frame.uri === 'ssap://media.viewer/close' && !options.manualClose) queueMicrotask(() => peer.reply(frame.id, { returnValue: true }));
        if (frame.uri === 'ssap://media.viewer/open' && !options.manualOpen) queueMicrotask(() => peer.reply(frame.id, { id: 'viewer', sessionId: 'owned-' + ++sessions }));
      });
      sockets.push(socket); queueMicrotask(() => socket.open()); return socket;
    },
    onLeaseChange: async lease => { leases.push(lease); if (options.failViewingLease && lease.phase === 'viewing') throw new Error('fake Activity failure'); },
    now: clock.now, setTimer: clock.set, clearTimer: clock.clear, connectTimeoutMs: 1000, pairingTimeoutMs: 2000, requestTimeoutMs: 1000, sessionTtlMs: 5000,
  });
  t.after(() => { controller.disconnect(); clock.pending.clear(); });
  return { controller, clock, leases, saved, sockets, endpoints };
}

test('native photo construction performs no IO and first pairing requires explicit user intent', async t => {
  const { controller, sockets } = fixture(t, { unpaired: true });
  assert.equal(sockets.length, 0); await assert.rejects(controller.open(url('a'), { format: 'jpg' }), { code: 'PAIRING_REQUIRED' });
  assert.equal(sockets.length, 0, 'No registration or pairing prompt may be triggered implicitly');
  const bare = new NativePhotoSession(); await assert.rejects(bare.connect({ allowPairing: true }), { code: 'TRANSPORT_UNAVAILABLE' });
});

test('SSAP registration reuses only this app key store, uses loopback and requests minimal media permissions', async t => {
  const { controller, sockets, saved, endpoints } = fixture(t);
  await Promise.all([controller.connect(), controller.connect()]);
  assert.deepEqual(endpoints, ['wss://127.0.0.1:3001']); assert.equal(sockets.length, 1);
  const register = sockets[0].frames[0]; assert.equal(register.type, 'register'); assert.equal(register.payload['client-key'], key);
  assert.deepEqual(register.payload.manifest.permissions, ['LAUNCH', 'CONTROL_INPUT_MEDIA_PLAYBACK']); assert.deepEqual(saved, [key]);
  assert.equal(JSON.stringify(controller.snapshot()).includes(key), false);
});

test('pairing timeout cancels its socket without sending an open or a global media command', async t => {
  const { controller, sockets, clock } = fixture(t, { unpaired: true, manualRegister: true });
  const connection = controller.connect({ allowPairing: true }); const rejected = assert.rejects(connection, { code: 'PAIRING_TIMEOUT' }); await flush();
  const register = sockets[0].frames[0]; sockets[0].reply(register.id, { pairingType: 'PROMPT' }); assert.equal(controller.snapshot().state, 'pairing');
  clock.advance(2001); await rejected;
  assert.equal(sockets[0].readyState, 3); assert.equal(sockets[0].frames.some(frame => frame.uri), false); assert.equal(clock.pending.size, 0);
});

test('native open sends the original URL and close is restricted to exactly the returned id/sessionId', async t => {
  const { controller, sockets, leases } = fixture(t);
  const opened = await controller.open(url('a'), { format: 'jpg', name: '测试照片' }); assert.equal(opened.state, 'viewing');
  const open = sockets[0].frames.find(frame => frame.uri?.endsWith('/open')); assert.equal(open.payload.target, url('a')); assert.equal(open.payload.mimeType, 'image/jpeg');
  assert.deepEqual(Object.keys(open.payload).sort(), ['description', 'iconSrc', 'mimeType', 'target', 'title']);
  await controller.close();
  const close = sockets[0].frames.find(frame => frame.uri?.endsWith('/close')); assert.deepEqual(close.payload, { id: 'viewer', sessionId: 'owned-1' });
  assert.deepEqual(leases.map(lease => lease.phase || lease.reason), ['opening', 'viewing', 'user']);
  assert.equal(controller.request, undefined); assert.equal(controller.wire, undefined);
  assert.equal(sockets[0].frames.some(frame => frame.uri && !['ssap://media.viewer/open', 'ssap://media.viewer/close'].includes(frame.uri)), false);
});

test('finite viewer lease expires once and stale timers cannot close a newer image session', async t => {
  const { controller, sockets, clock } = fixture(t);
  await controller.open(url('a'), { format: 'jpg' }); const stale = [...clock.pending.values()][0].callback;
  clock.advance(1000); await controller.open(url('b'), { format: 'png' });
  const closesBefore = sockets[0].frames.filter(frame => frame.uri?.endsWith('/close')).length;
  clock.time = 6001; stale(); await flush(); assert.equal(controller.snapshot().session.sessionId, 'owned-2');
  assert.equal(sockets[0].frames.filter(frame => frame.uri?.endsWith('/close')).length, closesBefore);
  clock.advance(1001); await flush(); assert.equal(controller.snapshot().session, null); assert.equal(clock.pending.size, 0);
  assert.deepEqual(sockets[0].frames.filter(frame => frame.uri?.endsWith('/close')).at(-1).payload, { id: 'viewer', sessionId: 'owned-2' });
});

test('cancelled in-flight open closes only the late returned session and never launches another app', async t => {
  const { controller, sockets } = fixture(t, { manualOpen: true }); await controller.connect();
  const opening = controller.open(url('a'), { format: 'jpg' }); const rejected = assert.rejects(opening, { code: 'CANCELLED' }); await flush();
  const open = sockets[0].frames.find(frame => frame.uri?.endsWith('/open')); const closing = controller.close();
  sockets[0].reply(open.id, { id: 'viewer', sessionId: 'late-owned' }); await rejected; await closing;
  assert.deepEqual(sockets[0].frames.filter(frame => frame.uri?.endsWith('/close')).map(frame => frame.payload), [{ id: 'viewer', sessionId: 'late-owned' }]);
  assert.equal(sockets[0].frames.some(frame => frame.uri?.includes('launcher')), false);
});

test('a missing session identifier never falls back to closing all media', async t => {
  const { controller, sockets, leases } = fixture(t, { manualOpen: true }); await controller.connect();
  const opening = controller.open(url('a'), { format: 'jpg' }); const rejected = assert.rejects(opening, { code: 'UNCONTROLLED_SESSION' }); await flush();
  const open = sockets[0].frames.find(frame => frame.uri?.endsWith('/open')); sockets[0].reply(open.id, { returnValue: true, id: 'viewer' }); await rejected;
  assert.equal(sockets[0].frames.some(frame => frame.uri?.endsWith('/close')), false); assert.equal(leases.at(-1).active, false);
});

test('failed Activity confirmation closes the just-opened viewer and releases its finite lease', async t => {
  const { controller, sockets, leases, clock } = fixture(t, { failViewingLease: true });
  await assert.rejects(controller.open(url('a'), { format: 'jpg' }), { code: 'LEASE_FAILED' });
  assert.equal(controller.snapshot().session, null); assert.equal(clock.pending.size, 0); assert.equal(leases.at(-1).active, false);
  assert.deepEqual(sockets[0].frames.find(frame => frame.uri?.endsWith('/close')).payload, { id: 'viewer', sessionId: 'owned-1' });
});

test('cancel before connection starts cannot trigger a delayed pairing prompt', async t => {
  const { controller, sockets } = fixture(t, { unpaired: true });
  const opening = controller.open(url('a'), { format: 'jpg' }, { allowPairing: true }); const rejected = assert.rejects(opening, { code: 'CANCELLED' });
  await controller.close(); await rejected; assert.equal(sockets.length, 0);
});

test('invalid TV frames reject the pending operation without trusting a saved key as live authorization', async t => {
  const { controller, sockets, clock } = fixture(t, { manualOpen: true }); await controller.connect();
  const opening = controller.open(url('a'), { format: 'jpg' }); const rejected = assert.rejects(opening, { code: 'INVALID_RESPONSE' }); await flush(); sockets[0].emit('message', 'null'); await rejected;
  assert.equal(controller.snapshot().paired, false); assert.equal(controller.snapshot().hasSavedKey, true); assert.equal(clock.pending.size, 0);
});

test('synchronous private-key storage errors are contained and do not open a viewer', async t => {
  const { controller, sockets } = fixture(t); controller.keyStore.load = () => { throw new Error('fake private filesystem path'); };
  await assert.rejects(controller.open(url('a'), { format: 'jpg' }), { code: 'KEY_STORAGE_FAILED', message: '无法读取本机电视授权' }); assert.equal(sockets.length, 0);
});

test('cancelling standalone pairing does not leave a late registration active', async t => {
  const { controller, sockets } = fixture(t, { unpaired: true, manualRegister: true });
  const connecting = controller.connect({ allowPairing: true }); const rejected = assert.rejects(connecting, { code: 'CANCELLED' }); await flush();
  await controller.close(); await rejected; sockets[0].reply('old-register', { 'client-key': key }, 'registered'); await flush();
  assert.equal(controller.snapshot().paired, false); assert.equal(controller.snapshot().state, 'disconnected'); assert.equal(sockets[0].frames.some(frame => frame.uri), false);
});
