import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveNas } from '../lib/adaptive-nas.mjs';
function fixture(select) {
  const calls = [], config = { alias: 'example', server: 'https://example.zh9.ug.link', token: 'private-token' };
  const relay = { config, httpsAgent: { destroy() {} }, async request(path) { calls.push('relay:' + path); return 'relay'; } };
  const lan = { async request(path) { calls.push('lan:' + path); return 'lan'; } };
  const route = { client: lan, close() { calls.push('close'); } };
  const nas = new AdaptiveNas(config, { relay, select: select || (async () => route), createProbe: value => ({ config: value, httpsAgent: { destroy() {} } }) });
  return { calls, config, nas, lan, route };
}
test('only a completed verified selection activates LAN and keeps the canonical saved relay', async () => {
  const f = fixture(); assert.equal(await f.nas.request('home'), 'relay'); await f.nas.select(); assert.equal(await f.nas.request('home'), 'lan');
  assert.equal(f.config.server, 'https://example.zh9.ug.link'); assert.deepEqual(f.nas.summary(), { mode: 'lan-https', verified: true, p2p: false }); f.nas.close();
});
test('a failed LAN read falls back once while a POST with unknown outcome is never repeated', async () => {
  for (const method of ['GET', 'POST']) {
    const f = fixture(); f.lan.request = async () => { throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }); }; await f.nas.select();
    if (method === 'GET') assert.equal(await f.nas.request('progress', { method }), 'relay');
    else { await assert.rejects(f.nas.request('progress', { method }), /connection lost/); assert.equal(f.calls.some(c => c.startsWith('relay:')), false); }
    assert.equal(f.nas.summary().mode, 'ugreenlink-relay');
  }
});
test('a cancelled selection cannot install an old account route', async () => {
  let finish; const f = fixture(() => new Promise(resolve => finish = resolve)); const selected = f.nas.select(); f.nas.reset(); f.config.token = 'new-token'; finish(f.route); await selected;
  assert.equal(f.nas.summary().mode, 'ugreenlink-relay'); assert.ok(f.calls.includes('close'));
});
test('an old account request cannot be retried using the new account after reset', async () => {
  let fail; const f = fixture(); f.lan.request = () => new Promise((resolve, reject) => fail = reject); await f.nas.select(); const pending = f.nas.request('old-file'); f.nas.reset(); f.config.token = 'new-token'; fail(Object.assign(new Error('closed'), { code: 'ECONNRESET' }));
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(f.calls.some(c => c.startsWith('relay:')), false);
});
test('a playback snapshot keeps the original account and remains independently cloneable after close', () => {
  const f = fixture(), snapshot = f.nas.snapshot(); f.config.token = 'new-account-token'; f.config.alias = 'another-device';
  assert.equal(snapshot.config.token, 'private-token'); assert.equal(snapshot.config.alias, 'example');
  assert.throws(() => { snapshot.config.token = 'wrong-account'; }); snapshot.close();
  const second = snapshot.snapshot(); assert.equal(second.config.token, 'private-token'); assert.equal(second.config.server, 'https://example.zh9.ug.link'); second.close();
});
