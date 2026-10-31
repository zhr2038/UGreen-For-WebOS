import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTransport, UgAgentDriver, decodeAgentEvent, negotiateTransport, safeNegotiationSummary, nativeBindingCapability, networkReadiness, createAgentBaseConfig } from '../lib/transport/index.mjs';
import { inspectElf, elfCompatibility } from '../lib/transport/elf.mjs';

const alias = 'example', relayOrigin = 'https://example.zh9.ug.link';
const rawInfo = () => ({ tunnel: { tunnelType: 'uglinkAgent', tunnelStatus: 1, clientId: 'private-id', extInfo: { account: 'private-account', password: 'private-password' } }, token: 'private-token', agent: { authKey: 'private-key', p2pId: 'private-peer', stunServerHost: 'stun.example.test', stunServerPort: 3478 }, supportTunnels: null });
const nas = () => ({ async request(path, options) { assert.equal(path, 'v1/connect/uglink/glinfo'); assert.equal(options.query.clientVersion, '1.21.0'); return rawInfo(); } });
const directEvent = { state: 'selected', mode: 'native-p2p', p2p: true, origin: 'http://127.0.0.1:17001', nativeType: 4, engine: 'ugreen' };
const immediate = () => new Promise(resolve => setImmediate(resolve));
const sdkBase = () => createAgentBaseConfig({ cloudApiOrigin: 'https://sdk.cloud.example.test:8443/', logPath: './sdk-log' });

test('official negotiation treats supported SDK configuration as capability, not an established P2P tunnel', async () => {
  const info = await negotiateTransport(nas());
  assert.equal(info.type, 'uglinkAgent'); assert.equal(info.online, true); assert.equal(info.hasAgentConfig, true);
  assert.ok(info.privateConfig.agent.authKey);
  const safe = JSON.stringify(safeNegotiationSummary(info));
  for (const secret of ['private-password', 'private-token', 'private-key', 'private-peer', 'private-account']) assert.equal(safe.includes(secret), false);
  assert.equal(safe.includes('nativeP2p'), false);
});

test('official SDK events distinguish proxy ready, cloud relay and both native P2P engines', () => {
  const options = { relayOrigin, alias };
  assert.deepEqual(decodeAgentEvent(0, { port: 17001 }, options), { state: 'proxy-ready', p2p: false });
  assert.equal(decodeAgentEvent(6, { type: 2, host: 'ignored.example', port: 443 }, options).p2p, false);
  assert.deepEqual(decodeAgentEvent(6, JSON.stringify({ type: 4, host: 'untrusted.example', port: 17001 }), options), directEvent);
  assert.equal(decodeAgentEvent(6, { type: 5, port: 17002 }, options).engine, 'peergine');
  assert.equal(decodeAgentEvent(6, { type: 0 }, options).state, 'unavailable');
  assert.throws(() => decodeAgentEvent(6, { type: 4, port: 65536 }, options));
  assert.throws(() => decodeAgentEvent(7, { location: 'https://example.ug.link.attacker.test/' }, options));
  assert.throws(() => decodeAgentEvent(7, { location: 'https://other.zh8.ug.link/' }, options));
  assert.equal(decodeAgentEvent(7, { location: 'https://example.zh8.ug.link/path?token=private' }, options).origin, 'https://example.zh8.ug.link');
});

test('missing native engine stays on HTTPS relay without claiming P2P or returning negotiation secrets', async () => {
  const transport = new NativeTransport({ nas: nas(), alias, relayOrigin });
  const route = await transport.connect({ nasToken: 'private-token', nasPublicRsa: 'private-public-key' });
  assert.equal(route.origin, relayOrigin); assert.equal(route.p2p, false);
  const status = transport.summary(); assert.equal(status.nativeP2p, false); assert.equal(status.reason, 'NATIVE_ENGINE_NOT_INSTALLED');
  assert.equal(JSON.stringify(status).includes('private-'), false);
});

test('native selection requires authenticated matching NAS identity before it becomes the active route', async () => {
  const driver = { capability: () => ({ available: true }), async connect() { return directEvent; }, async stop() {} };
  const rejected = new NativeTransport({ nas: nas(), alias, relayOrigin, driver, verifyRoute: async () => ({ authenticated: true, alias: 'different-nas' }) });
  assert.equal((await rejected.connect()).p2p, false); assert.equal(rejected.summary().reason, 'NAS_IDENTITY_NOT_VERIFIED');
  const accepted = new NativeTransport({ nas: nas(), alias, relayOrigin, driver, verifyRoute: async route => { assert.equal(route.origin, directEvent.origin); return { authenticated: true, alias }; } });
  assert.equal((await accepted.connect()).p2p, true); assert.equal(accepted.summary().nativeP2p, true);
});

test('a late native route verification cannot reactivate P2P after stop', async () => {
  let release; const gate = new Promise(resolve => release = resolve);
  const driver = { capability: () => ({ available: true }), async connect() { return directEvent; }, async stop() {} };
  const transport = new NativeTransport({ nas: nas(), alias, relayOrigin, driver, verifyRoute: async () => { await gate; return { authenticated: true, alias }; } });
  const connecting = transport.connect(); await immediate(); await transport.stop(); release(); await connecting;
  assert.equal(transport.currentRoute().p2p, false); assert.equal(transport.summary().phase, 'idle');
});

test('a P2P selection during relay verification is checked and a later outage immediately restores relay', async () => {
  let listener, release; const gate = new Promise(resolve => release = resolve); let probes = 0;
  const relay = decodeAgentEvent(6, { type: 2 }, { alias, relayOrigin });
  const driver = { capability: () => ({ available: true }), async connect(options) { listener = options.onState; return relay; }, async stop() {} };
  const transport = new NativeTransport({ nas: nas(), alias, relayOrigin, driver, verifyRoute: async () => { if (++probes === 1) await gate; return { authenticated: true, alias }; } });
  const pending = transport.connect(); await immediate(); listener(directEvent); release(); await pending;
  assert.equal(transport.currentRoute().p2p, true); assert.equal(probes, 2);
  listener({ state: 'failed', p2p: false, reason: 'NETWORK_ERROR' });
  assert.equal(transport.currentRoute().p2p, false); assert.equal(transport.currentRoute().origin, relayOrigin);
});

test('an SDK outage while identity verification is pending cannot leave a stale P2P status', async () => {
  let listener, release; const gate = new Promise(resolve => release = resolve);
  const driver = { capability: () => ({ available: true }), async connect(options) { listener = options.onState; return directEvent; }, async stop() {} };
  const transport = new NativeTransport({ nas: nas(), alias, relayOrigin, driver, verifyRoute: async () => { await gate; return { authenticated: true, alias }; } });
  const pending = transport.connect(); await immediate(); listener({ state: 'unavailable', reason: 'NO_USABLE_LINK' }); release(); await pending;
  assert.equal(transport.summary().nativeP2p, false); assert.equal(transport.summary().reason, 'NO_USABLE_LINK');
});

test('native SDK driver starts with observed official options, does not accept READY as a connected route, and releases its listener', async () => {
  let listener, disposed = false, stopped = 0, startOptions;
  const binding = { metadata: { apiVersion: 1, platform: 'linux', arch: 'arm', abi: 'glibc', name: 'test-only-sdk', version: 'fake' },
    subscribe(fn) { listener = fn; return () => disposed = true; },
    async init(json) { const config = JSON.parse(json); assert.deepEqual(config.cloudServer, { serverHost: 'sdk.cloud.example.test', serverPort: 8443 }); assert.equal(config.aesSize, 256); assert.equal(config.logPath, './sdk-log'); assert.equal(config.uploadPeriod, 120000); assert.equal(Object.hasOwn(config, 'clientType'), false); return 0; },
    async startAgent(json) { startOptions = JSON.parse(json); listener(0, '{}'); return 0; },
    async stopAgent() { stopped++; return 0; },
  };
  const driver = new UgAgentDriver({ binding, baseConfig: sdkBase(), platform: 'linux', arch: 'arm', timeout: 2000 });
  let finished = false; const connecting = driver.connect({ alias, relayOrigin, nasToken: 'private-token', nasPublicRsa: 'private-public-key' }).then(route => { finished = true; return route; });
  await immediate(); assert.equal(finished, false); assert.equal(startOptions.uglinkAgent, true); assert.equal(startOptions.p2pAgent, false); assert.equal(startOptions.nasToken, 'private-token');
  listener(6, '{"type":4,"port":17001}'); assert.equal((await connecting).p2p, true);
  await driver.stop(); assert.equal(disposed, true); assert.equal(stopped, 1);
});

test('cancelling a native SDK connection closes it and does not start a late tunnel', async () => {
  let release, starts = 0; const gate = new Promise(resolve => release = resolve);
  const binding = { metadata: { apiVersion: 1, platform: 'linux', arch: 'arm', abi: 'glibc' }, subscribe() { return () => {}; }, async init() { await gate; return 0; }, async startAgent() { starts++; return 0; }, async stopAgent() {} };
  const driver = new UgAgentDriver({ binding, baseConfig: sdkBase(), platform: 'linux', arch: 'arm' });
  const pending = driver.connect({ alias, relayOrigin, nasToken: 'private-token', nasPublicRsa: 'public' });
  await immediate(); await driver.stop(); release(); await assert.rejects(pending, e => e.name === 'AbortError'); assert.equal(starts, 0);
  assert.equal(nativeBindingCapability({ metadata: { apiVersion: 1, platform: 'android', arch: 'arm', abi: 'bionic' } }, { platform: 'linux', arch: 'arm' }).available, false);
});

test('an unresponsive native initialization times out instead of freezing connection setup', async () => {
  const binding = { metadata: { apiVersion: 1, platform: 'linux', arch: 'arm', abi: 'glibc' }, subscribe() { return () => {}; }, init() { return new Promise(() => {}); }, startAgent() { throw new Error('Must not start'); }, async stopAgent() {} };
  const driver = new UgAgentDriver({ binding, baseConfig: sdkBase(), platform: 'linux', arch: 'arm', timeout: 20 });
  await assert.rejects(driver.connect({ alias, relayOrigin, nasToken: 'private-token', nasPublicRsa: 'public' }), e => ['NATIVE_CONNECT_TIMEOUT', 'NATIVE_STAGE_TIMEOUT'].includes(e.code));
});

test('aborting an established native session removes its selected route and closes the SDK listener', async () => {
  let listener, stopped = 0;
  const binding = { metadata: { apiVersion: 1, platform: 'linux', arch: 'arm', abi: 'glibc' }, subscribe(fn) { listener = fn; return () => listener = null; }, async init() { return 0; }, async startAgent() { listener(6, '{"type":4,"port":17001}'); return 0; }, async stopAgent() { stopped++; } };
  const driver = new UgAgentDriver({ binding, baseConfig: sdkBase(), platform: 'linux', arch: 'arm' });
  const controller = new AbortController();
  const transport = new NativeTransport({ nas: nas(), alias, relayOrigin, driver, verifyRoute: async () => ({ authenticated: true, alias }) });
  await transport.connect({ nasToken: 'private-token', nasPublicRsa: 'public', signal: controller.signal }); assert.equal(transport.currentRoute().p2p, true);
  controller.abort(); await immediate(); assert.equal(transport.currentRoute().p2p, false); assert.equal(stopped, 1); assert.equal(listener, null);
});

test('network prerequisites and an ELF header never serve as evidence of established native P2P', () => {
  const network = networkReadiness({ interfaces: { eth0: [{ address: 'fe80::1', internal: false }, { address: 'fd00::2', internal: false }] }, nasIpv6: ['fd00::3'] });
  assert.equal(network.clientPublicIpv6, false); assert.equal(network.nasPublicIpv6, false); assert.equal(network.nativeP2pEstablished, false);
  const elf = Buffer.alloc(64); elf.write('\x7fELF', 0, 'binary'); elf[4] = 1; elf[5] = 1; elf.writeUInt16LE(40, 18);
  const info = inspectElf(elf); assert.equal(info.architecture, 'arm'); assert.equal(info.bits, 32);
  assert.equal(elfCompatibility({ ...info, android: true }, { platform: 'linux', arch: 'arm' }).reason, 'ANDROID_ABI_REQUIRES_PORT');
  assert.equal(elfCompatibility({ ...info, bits: 64, architecture: 'arm64' }, { platform: 'linux', arch: 'arm' }).compatible, false);
  assert.throws(() => inspectElf(Buffer.from('not an ELF')));
});

test('SDK cloud configuration is explicitly injected from a parsed HTTPS origin, without a guessed hostname', () => {
  assert.throws(() => createAgentBaseConfig(), error => error.code === 'NATIVE_CLOUD_CONFIG_REQUIRED');
  for (const origin of ['http://sdk.example.test', 'https://user:password@sdk.example.test', 'https://127.0.0.1', 'https://sdk.example.test/?token=private'])
    assert.throws(() => createAgentBaseConfig({ cloudApiOrigin: origin }), error => error.code === 'NATIVE_CLOUD_CONFIG_INVALID');
  assert.throws(() => createAgentBaseConfig({ cloudApiOrigin: 'https://api.ugnas.com' }), error => error.code === 'NATIVE_LOG_PATH_REQUIRED');
  const config = createAgentBaseConfig({ cloudApiOrigin: 'https://api.ugnas.com', logPath: '.' });
  assert.deepEqual(config.cloudServer, { serverHost: 'api.ugnas.com', serverPort: 443 });
  assert.equal(config.uploadPeriod, 120000); assert.equal(config.logPath, '.'); assert.equal(config.logMaxSize, 128); assert.equal(Object.hasOwn(config, 'clientType'), false);
});

test('missing or credential-bearing base configuration fails before a native initialization call', async () => {
  let calls = 0;
  const binding = { metadata: { apiVersion: 1, platform: 'linux', arch: 'arm', abi: 'glibc' }, subscribe() {}, init() { calls++; }, startAgent() {}, stopAgent() {} };
  const options = { alias, relayOrigin, nasToken: 'private-token', nasPublicRsa: 'public' };
  await assert.rejects(new UgAgentDriver({ binding, platform: 'linux', arch: 'arm' }).connect(options), error => error.code === 'NATIVE_CLOUD_CONFIG_REQUIRED');
  await assert.rejects(new UgAgentDriver({ binding, baseConfig: { ...sdkBase(), nasToken: 'private-token' }, platform: 'linux', arch: 'arm' }).connect(options), error => error.code === 'NATIVE_CLOUD_CONFIG_INVALID');
  assert.equal(calls, 0);
});

test('a Bionic worker must declare process isolation and a full connect API; offline proof alone remains unavailable', () => {
  const metadata = { apiVersion: 1, platform: 'linux', arch: 'arm', abi: 'bionic', execution: 'isolated-process', lifecycle: 'single-session-worker', workerProtocol: 'cloudframe-ugagent-stdio-v1', runtime: { abi: 'bionic', arch: 'arm', apiLevel: 24 }, capabilities: { authenticatedConnect: false, offlineInit: true } };
  const binding = { metadata, init() {}, startAgent() {}, stopAgent() {}, subscribe() {} }, host = { platform: 'linux', arch: 'arm' };
  assert.equal(nativeBindingCapability(binding, host).reason, 'NATIVE_ENGINE_CONNECT_NOT_READY');
  assert.equal(nativeBindingCapability({ ...binding, metadata: { ...metadata, execution: 'in-process' } }, host).reason, 'NATIVE_ENGINE_ABI_MISMATCH');
  const fakeFullBinding = { ...binding, metadata: { ...metadata, capabilities: { authenticatedConnect: true } } };
  assert.equal(nativeBindingCapability(fakeFullBinding, host).execution, 'isolated-process');
  assert.equal(nativeBindingCapability(fakeFullBinding, host).available, true);
  assert.equal(nativeBindingCapability({ metadata: fakeFullBinding.metadata }, host).reason, 'NATIVE_ENGINE_API_MISMATCH');
});
