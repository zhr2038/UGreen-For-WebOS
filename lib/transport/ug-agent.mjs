import { validateRelayOrigin } from './negotiation.mjs';

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
  if (!metadata || metadata.platform !== platform || metadata.arch !== arch || metadata.abi !== 'glibc' || metadata.apiVersion !== 1) return { available: false, reason: 'NATIVE_ENGINE_ABI_MISMATCH', platform, arch };
  if (!['init', 'startAgent', 'stopAgent', 'subscribe'].every(name => typeof binding[name] === 'function')) return { available: false, reason: 'NATIVE_ENGINE_API_MISMATCH', platform, arch };
  return { available: true, reason: null, platform, arch, engine: String(metadata.name || 'UGAgent'), version: String(metadata.version || '') };
}

// The binding is an owner-supplied, LG-compatible wrapper, never an object from
// an HTTP request. Its JSON init/start payloads mirror the observed official
// Java wrapper. No Android library or invented wire protocol is bundled here.
export class UgAgentDriver {
  constructor({ binding, platform, arch, timeout = 15000 } = {}) {
    this.binding = binding; this.platform = platform; this.arch = arch; this.timeout = timeout; this.generation = 0; this.cleanup = null; this.running = false;
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
      const initialized = await stage(this.binding.init(JSON.stringify({ cloudServer: { serverHost: 'api.ugnas.com', serverPort: 443 }, clientType: 'TV', logConsole: false, uploadPeriod: 0 })));
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
