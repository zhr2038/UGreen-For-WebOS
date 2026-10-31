import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { selectTrustedLan, smartDnsCandidates, pinnedLanLookup, createTrustedLanClient } from '../lib/transport/trusted-lan.mjs';

const alias = 'example';
const config = { alias, server: 'https://example.zh9.ug.link', token: 'private-session', clientId: 'tv-client' };
const nodeInfo = { alias, netInfo: { smartdns: { lan: ['device.lan.ug.link'] }, httpsPort: 9443 } };
function response({ identity = 'same-nas', authorized = true, code = 200 } = {}) { const stream = Readable.from([Buffer.from(JSON.stringify({code,data:{}}))]); stream.statusCode = 200; stream.headers = { 'x-ugreen-id': identity }; stream.socket = { authorized }; return stream; }
function fixture({ candidateIdentity, authorized, accountAlias, resolve, requestGate, probeCode } = {}) {
  const calls = [], clients = [];
  const relayNas = { config, async open(path, options) { calls.push({ kind: 'relay', path, auth: options.auth }); return response({code:probeCode}); } };
  const createClient = (saved, route) => {
    const client = { config: { ...saved, server: route.origin, tlsFingerprint: undefined }, httpsAgent: { destroyed: false, destroy() { this.destroyed = true; } },
      async open(path, options) { calls.push({ kind: 'lan-handshake', path, auth: options.auth }); return response({ identity: candidateIdentity, authorized,code:probeCode }); },
      async request(path) { calls.push({ kind: 'lan-auth', path }); if (requestGate) await requestGate; return { uglink_id: accountAlias || alias }; },
    }; clients.push(client); return client;
  };
  return { calls, clients, options: { relayNas, alias, nodeInfo, createClient, resolve: resolve || (async () => [{ address: '192.168.1.50', family: 4 }]) } };
}

test('trusted LAN selection verifies CA and relay identity before sending an authenticated NAS request', async () => {
  const f = fixture(); const result = await selectTrustedLan(f.options);
  assert.equal(result.summary.mode, 'lan-https'); assert.equal(result.summary.p2p, false); assert.equal(result.summary.verified, true);
  assert.deepEqual(f.calls.map(c => c.kind), ['relay', 'lan-handshake', 'lan-auth']);
  assert.equal(f.calls[0].auth, false); assert.equal(f.calls[1].auth, false); assert.equal(f.calls[2].path, 'v1/user/priority_link');
  assert.equal(JSON.stringify(result.summary).includes('private-session'), false); assert.equal(JSON.stringify(result.summary).includes('192.168'), false);
  result.close(); assert.equal(f.clients[0].httpsAgent.destroyed, true);
});

test('untrusted TLS, a different NAS instance or wrong account identity preserve the relay', async () => {
  for (const options of [{ authorized: false }, { candidateIdentity: 'other-nas' }, { accountAlias: 'another-device' }]) {
    const f = fixture(options); const result = await selectTrustedLan(f.options);
    assert.equal(result.client, null); assert.equal(result.summary.mode, 'ugreenlink-relay'); assert.equal(f.clients[0].httpsAgent.destroyed, true);
    if (!options.accountAlias) assert.equal(f.calls.some(c => c.kind === 'lan-auth'), false);
  }
});

test('the actual unauthenticated UGOS 1010 response is a probe, never account-login success', async () => {
  const f = fixture({ probeCode: 1010 }); const result = await selectTrustedLan(f.options);
  assert.equal(result.summary.mode, 'lan-https'); assert.equal(f.calls.filter(c => c.kind === 'lan-auth').length, 1); result.close();
  const wrong = fixture({ probeCode: 1010, accountAlias: 'other' }); assert.equal((await selectTrustedLan(wrong.options)).client, null);
});

test('only official SmartDNS hostnames resolving to private LAN addresses are automatic candidates', async () => {
  assert.equal(smartDnsCandidates({ alias, netInfo: { smartdns: { lan: ['127.0.0.1', '192.168.1.1', 'attacker.test', 'device.lan.ug.link@attacker.test', 'device.lan.ug.link/path', 'device.lan.ug.link?token=x'] } } }, alias).length, 0);
  const f = fixture({ resolve: async () => [{ address: '203.0.113.1', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  const result = await selectTrustedLan(f.options); assert.equal(result.client, null); assert.equal(f.clients.length, 0);
});

test('the selected HTTPS client pins DNS and cannot inherit a private certificate exception', async () => {
  const client = createTrustedLanClient({ ...config, tlsFingerprint: 'private-self-signed-pin' }, { origin: 'https://device.lan.ug.link:9443', hostname: 'device.lan.ug.link', address: '192.168.1.50', family: 4 });
  assert.equal(client.config.tlsFingerprint, undefined);
  const lookup = client.httpsAgent.options.lookup;
  await new Promise((resolve, reject) => lookup('device.lan.ug.link', { all: true }, (error, records) => { if (error) return reject(error); assert.deepEqual(records, [{ address: '192.168.1.50', family: 4 }]); resolve(); }));
  await new Promise(resolve => lookup('another.lan.ug.link', {}, error => { assert.equal(error.code, 'ENOTFOUND'); resolve(); }));
  client.httpsAgent.destroy(); assert.throws(() => pinnedLanLookup('device.lan.ug.link', { address: '127.0.0.1', family: 4 }));
});

test('a timeout or cancellation never activates a late authenticated LAN result', async () => {
  let release; const gate = new Promise(resolve => release = resolve); const f = fixture({ requestGate: gate });
  const result = await selectTrustedLan({ ...f.options, timeout: 100 }); assert.equal(result.summary.reason, 'TIMED_OUT'); assert.equal(result.client, null); assert.equal(f.clients[0].httpsAgent.destroyed, true); release();
  const controller = new AbortController(); controller.abort(); const cancelled = await selectTrustedLan({ ...fixture().options, signal: controller.signal }); assert.equal(cancelled.summary.reason, 'CANCELLED');
});
