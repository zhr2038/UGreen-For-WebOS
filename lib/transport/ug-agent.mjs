import { validateRelayOrigin } from './negotiation.mjs';
import { isIP } from 'node:net';

const BASE_DEFAULTS = Object.freeze({ aesSize: 256, logLev: 2, logMaxDelay: 5, logMaxCount: 5, logConsole: false, uploadPeriod: 120000 });
const configError = code => Object.assign(new Error('原生连接需要明确配置官方云服务'), { code });
function cloudServer(value) {
  const host = value?.serverHost, port = value?.serverPort;
  if (typeof host !== 'string' || host.length > 253 || isIP(host) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw configError('NATIVE_CLOUD_CONFIG_INVALID');
  return { serverHost: host.toLowerCase(), serverPort: port };
}

// DeviceConnect -> manager/c.d() -> HttpUrl.G()/O() -> provider/i.i().
// The caller supplies that trusted cloud API origin; there is no guessed host.
export function createAgentBaseConfig({ cloudApiOrigin, logPath } = {}) {
  if (!cloudApiOrigin) throw configError('NATIVE_CLOUD_CONFIG_REQUIRED');
  let url;
  try { url = new URL(cloudApiOrigin); } catch { throw configError('NATIVE_CLOUD_CONFIG_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw configError('NATIVE_CLOUD_CONFIG_INVALID');
  const server = cloudServer({ serverHost: url.hostname, serverPort: Number(url.port || 443) });
  if (logPath === undefined) throw Object.assign(new Error('原生连接需要明确的私有运行目录日志路径'), { code: 'NATIVE_LOG_PATH_REQUIRED' });
  const result = { cloudServer: server, ...BASE_DEFAULTS };
  if (logPath !== undefined) {
    // A private worker may choose a relative log directory under its own cwd.
    if (typeof logPath !== 'string' || logPath !== '.' && !/^\.\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(logPath) || logPath.length > 200) throw configError('NATIVE_CLOUD_CONFIG_INVALID');
    result.logPath = logPath; result.logMaxSize = 128;
  }
  return result;
}

function explicitBaseConfig(value) {
  if (!value) throw configError('NATIVE_CLOUD_CONFIG_REQUIRED');
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['cloudServer', ...Object.keys(BASE_DEFAULTS), 'logPath', 'logMaxSize'].includes(key))
    || Object.entries(BASE_DEFAULTS).some(([key, expected]) => value[key] !== expected)) throw configError('NATIVE_CLOUD_CONFIG_INVALID');
  const server = cloudServer(value.cloudServer);
  const result = createAgentBaseConfig({ cloudApiOrigin: `https://${server.serverHost}:${server.serverPort}`, logPath: value.logPath });
  if (value.logMaxSize !== result.logMaxSize || Object.keys(value.cloudServer).some(key => !['serverHost', 'serverPort'].includes(key))) throw configError('NATIVE_CLOUD_CONFIG_INVALID');
  return result;
}

// Decoded from UGAgentEventListener and UgAgentWrapper in Android TV 1.21.0.
// READY (0) only means the local HTTP proxy is listening. LINK_SELECT (6)
// distinguishes cloud relay (2), UGREEN P2P (4), and PeerGine P2P (5).
export function decodeAgentEvent(event, payload, { relayOrigin, alias } = {}) {
  let data = payload;
  if (typeof data === 'string') { if (data.length > 65536) throw new Error('原生连接事件过大'); data = JSON.parse(data); }
  if (!data || typeof data !== 'object') throw new Error('原生连接事件格式无效');
  if (event === 0) return { state: 'proxy-ready', p2p: false };
  if (event === 7) {
    const origin = validateRelayOrigin(data.location, alias);
    return { state: 'relay-node-changed', mode: 'ugreenlink-relay', p2p: false, origin };
  }
  if (event < 0) return { state: 'failed', p2p: false, reason: event === -1 ? 'NETWORK_ERROR' : event === -2 ? 'TARGET_UNAVAILABLE' : 'NATIVE_ERROR' };
  if (event !== 6) return { state: 'informational', p2p: false };
  const type = Number(data.type);
  if (type === 0) return { state: 'unavailable', p2p: false, reason: 'NO_USABLE_LINK' };
  if (type === 2) return { state: 'selected', mode: 'native-relay', p2p: false, origin: validateRelayOrigin(relayOrigin, alias), nativeType: type };
  if (type === 4 || type === 5) {
    const port = Number(data.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('原生连接未返回有效的本机代理端口');
    return { state: 'selected', mode: 'native-p2p', p2p: true, origin: `http://127.0.0.1:${port}`, nativeType: type, engine: type === 4 ? 'ugreen' : 'peergine' };
  }
  return { state: 'unavailable', p2p: false, reason: 'UNKNOWN_LINK_TYPE' };
}

export function nativeBindingCapability(binding, { platform = process.platform, arch = process.arch } = {}) {
  const metadata = binding?.metadata;
  if (!binding) return { available: false, reason: 'NATIVE_ENGINE_NOT_INSTALLED', platform, arch };
  if (!metadata || metadata.platform !== platform || metadata.arch !== arch || metadata.apiVersion !== 1) return { available: false, reason: 'NATIVE_ENGINE_ABI_MISMATCH', platform, arch };
  if (metadata.abi === 'bionic') {
    // The Android core executes only in its own Bionic process/runtime. A
    // version/offline-init probe is not an authenticated-connect binding.
    if (platform !== 'linux' || arch !== 'arm' || metadata.execution !== 'isolated-process' || metadata.lifecycle !== 'single-session-worker'
      || metadata.workerProtocol !== 'cloudframe-ugagent-stdio-v1' || metadata.runtime?.abi !== 'bionic' || metadata.runtime?.arch !== arch || metadata.runtime?.apiLevel !== 24)
      return { available: false, reason: 'NATIVE_ENGINE_ABI_MISMATCH', platform, arch };
    if (metadata.capabilities?.authenticatedConnect !== true) return { available: false, reason: 'NATIVE_ENGINE_CONNECT_NOT_READY', platform, arch, abi: 'bionic', execution: 'isolated-process' };
  } else if (metadata.abi !== 'glibc') return { available: false, reason: 'NATIVE_ENGINE_ABI_MISMATCH', platform, arch };
  if (!['init', 'startAgent', 'stopAgent', 'subscribe'].every(name => typeof binding[name] === 'function')) return { available: false, reason: 'NATIVE_ENGINE_API_MISMATCH', platform, arch };
  return { available: true, reason: null, platform, arch, abi: metadata.abi, execution: metadata.abi === 'bionic' ? 'isolated-process' : 'native-binding', engine: String(metadata.name || 'UGAgent'), version: String(metadata.version || '') };
}

// The binding is an owner-supplied, LG-compatible wrapper, never an object from
// an HTTP request. Its JSON init/start payloads mirror the observed official
// Java wrapper. No Android library or invented wire protocol is bundled here.
export class UgAgentDriver {
  constructor({ binding, baseConfig, platform, arch, timeout = 15000 } = {}) {
    this.binding = binding; this.baseConfig = baseConfig; this.platform = platform; this.arch = arch; this.timeout = timeout; this.generation = 0; this.cleanup = null; this.running = false;
  }
  capability() { return nativeBindingCapability(this.binding, { platform: this.platform || process.platform, arch: this.arch || process.arch }); }
  async connect({ alias, relayOrigin, nasToken, nasPublicRsa, signal, onState = () => {} }) {
    if (this.connecting) throw Object.assign(new Error('原生连接仍在启动中'), { code: 'NATIVE_CONNECT_BUSY' });
    this.connecting = true;
    try { return await this.start({ alias, relayOrigin, nasToken, nasPublicRsa, signal, onState }); }
    finally { this.connecting = false; }
  }
  async start({ alias, relayOrigin, nasToken, nasPublicRsa, signal, onState }) {
    await this.stop();
    const capability = this.capability();
    if (!capability.available) throw Object.assign(new Error('当前安装包没有可运行的原生 P2P 引擎'), { code: capability.reason });
    const baseConfig = explicitBaseConfig(this.baseConfig);
    if (!nasToken || !nasPublicRsa) throw Object.assign(new Error('原生连接缺少 NAS 会话或公钥'), { code: 'NAS_IDENTITY_REQUIRED' });
    validateRelayOrigin(relayOrigin, alias);
    const generation = ++this.generation;
    let resolveRoute, rejectRoute, timer, settled = false;
    const selected = new Promise((resolve, reject) => { resolveRoute = resolve; rejectRoute = reject; });
    // init/start can fail before this promise is awaited; keep the rejection
    // handled without converting the eventual awaited failure into success.
    selected.catch(() => {});
    const failed = selected.then(() => new Promise(() => {})); failed.catch(() => {});
    const stage = async operation => {
      let stageTimer;
      try { return await Promise.race([operation, failed, new Promise((_, reject) => stageTimer = setTimeout(() => reject(Object.assign(new Error('原生连接调用超时'), { code: 'NATIVE_STAGE_TIMEOUT' })), this.timeout))]); }
      finally { clearTimeout(stageTimer); }
    };
    const rejectCancelled = () => { if (!settled) { settled = true; rejectRoute(Object.assign(new Error('连接已取消'), { name: 'AbortError' })); } };
    const abort = () => { rejectCancelled(); onState({ state: 'failed', p2p: false, reason: 'CANCELLED' }); this.stop().catch(() => {}); };
    const unsubscribe = this.binding.subscribe((event, payload) => {
      if (generation !== this.generation) return;
      try {
        const state = decodeAgentEvent(event, payload, { alias, relayOrigin }); onState(state);
        if (state.state === 'selected' && !settled) { settled = true; clearTimeout(timer); resolveRoute(state); }
        else if ((state.state === 'failed' || state.state === 'unavailable') && !settled) { settled = true; clearTimeout(timer); rejectRoute(Object.assign(new Error('原生连接暂时不可用'), { code: state.reason })); }
      } catch { onState({ state: 'failed', p2p: false, reason: 'INVALID_NATIVE_EVENT' }); if (!settled) { settled = true; clearTimeout(timer); rejectRoute(Object.assign(new Error('原生连接返回了无效的链路'), { code: 'INVALID_NATIVE_EVENT' })); } }
    });
    this.cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (typeof unsubscribe === 'function') unsubscribe(); rejectCancelled(); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { if (!settled) { settled = true; rejectRoute(Object.assign(new Error('原生连接超时'), { code: 'NATIVE_CONNECT_TIMEOUT' })); } }, this.timeout);
    try {
      if (signal?.aborted) abort();
      const initialized = await stage(this.binding.init(JSON.stringify(baseConfig)));
      if (generation !== this.generation || signal?.aborted) throw Object.assign(new Error('连接已取消'), { name: 'AbortError' });
      if (Number(initialized) < 0) throw Object.assign(new Error('原生连接初始化失败'), { code: 'NATIVE_INIT_FAILED' });
      this.running = true;
      const started = await stage(this.binding.startAgent(JSON.stringify({ address: alias, uglinkAgent: true, localAgent: false, ddnsAgent: false, p2pAgent: false, p2pdirect: false, nasToken, nasPublicRsa })));
      if (Number(started) < 0) throw Object.assign(new Error('原生连接启动失败'), { code: 'NATIVE_START_FAILED' });
      const route = await selected;
      if (generation !== this.generation || signal?.aborted) throw Object.assign(new Error('连接已取消'), { name: 'AbortError' });
      return route;
    } catch (error) { if (generation === this.generation) await this.stop(); throw error; }
  }
  async stop() {
    this.generation++; this.cleanup?.(); this.cleanup = null;
    if (this.running) {
      this.running = false; let timeout;
      try { await Promise.race([this.binding.stopAgent(), new Promise((_, reject) => timeout = setTimeout(() => reject(Object.assign(new Error('原生连接关闭未确认'), { code: 'NATIVE_STOP_TIMEOUT' })), this.timeout))]); }
      finally { clearTimeout(timeout); }
    }
  }
}
