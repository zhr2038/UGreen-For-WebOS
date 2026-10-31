import { negotiateTransport, safeNegotiationSummary, validateRelayOrigin, networkReadiness } from './negotiation.mjs';
import { UgAgentDriver } from './ug-agent.mjs';
const SAFE_ERRORS = new Set(['NATIVE_ENGINE_NOT_INSTALLED', 'NATIVE_ENGINE_ABI_MISMATCH', 'NATIVE_ENGINE_API_MISMATCH', 'NATIVE_ENGINE_CONNECT_NOT_READY', 'NATIVE_CLOUD_CONFIG_REQUIRED', 'NATIVE_CLOUD_CONFIG_INVALID', 'NATIVE_LOG_PATH_REQUIRED', 'NATIVE_CONNECT_BUSY', 'NAS_IDENTITY_REQUIRED', 'NATIVE_CONNECT_TIMEOUT', 'NATIVE_STAGE_TIMEOUT', 'NATIVE_STOP_TIMEOUT', 'NATIVE_INIT_FAILED', 'NATIVE_START_FAILED', 'INVALID_NATIVE_EVENT', 'NETWORK_ERROR', 'TARGET_UNAVAILABLE', 'NATIVE_ERROR', 'NO_USABLE_LINK', 'UNKNOWN_LINK_TYPE']);
export { negotiateTransport, safeNegotiationSummary, networkReadiness, isGlobalIpv6 } from './negotiation.mjs';
export { UgAgentDriver, decodeAgentEvent, nativeBindingCapability, createAgentBaseConfig } from './ug-agent.mjs';

export class NativeTransport {
  constructor({ nas, alias, relayOrigin, driver = new UgAgentDriver(), verifyRoute }) {
    this.nas = nas; this.alias = alias; this.relayOrigin = validateRelayOrigin(relayOrigin, alias); this.driver = driver; this.verifyRoute = verifyRoute; this.generation = 0; this.routeRevision = 0;
    this.route = { origin: this.relayOrigin, mode: 'ugreenlink-relay', p2p: false };
    this.state = { phase: 'idle', mode: 'ugreenlink-relay', nativeP2p: false, nativeAvailable: driver.capability().available, reason: null };
  }
  summary() { return { ...this.state }; }
  currentRoute() { return { ...this.route }; }
  async connect({ nasToken, nasPublicRsa, signal } = {}) {
    const generation = ++this.generation;
    this.route = { origin: this.relayOrigin, mode: 'ugreenlink-relay', p2p: false };
    this.state = { ...this.state, phase: 'negotiating', mode: 'ugreenlink-relay', nativeP2p: false, reason: null };
    try {
      await this.driver.stop();
      const info = await negotiateTransport(this.nas, { signal });
      if (generation !== this.generation || signal?.aborted) return this.currentRoute();
      this.state.negotiated = safeNegotiationSummary(info);
      if (!info.online) return this.fallback('NAS_TUNNEL_OFFLINE');
      if (info.type !== 'uglinkAgent') return this.fallback('UNSUPPORTED_NATIVE_BACKEND');
      const capability = this.driver.capability(); this.state.nativeAvailable = capability.available;
      if (!capability.available) return this.fallback(capability.reason);
      if (!this.verifyRoute) return this.fallback('DATA_PATH_VERIFIER_REQUIRED');
      // Native selection is provisional until the authenticated NAS identity
      // travels through that data path. Config or a listening proxy is not P2P.
      let listening = false, latest;
      const route = await this.driver.connect({ alias: this.alias, relayOrigin: this.relayOrigin, nasToken, nasPublicRsa, signal, onState: state => {
        if (generation !== this.generation) return;
        if (state.state === 'selected') { latest = state; if (listening) this.acceptRoute(state, generation, signal).catch(() => { if (generation === this.generation) this.fallback('DATA_PATH_FAILED'); }); }
        else if (['failed', 'unavailable'].includes(state.state)) { latest = state; this.fallback(state.reason); }
        else if (state.state === 'relay-node-changed') { latest = state; this.relayOrigin = state.origin; this.fallback('RELAY_NODE_CHANGED'); }
      } });
      const first = latest || route;
      if (first.state === 'selected') await this.acceptRoute(first, generation, signal);
      listening = true;
      if (latest && latest !== first && latest.state === 'selected') await this.acceptRoute(latest, generation, signal);
      return this.currentRoute();
    } catch (error) {
      if (generation !== this.generation) return this.currentRoute();
      await this.driver.stop().catch(() => {});
      return this.fallback(error.name === 'AbortError' ? 'CANCELLED' : SAFE_ERRORS.has(error.code) ? error.code : 'NATIVE_CONNECT_FAILED');
    }
  }
  async acceptRoute(route, generation, signal) {
    const revision = ++this.routeRevision;
    let proof;
    try { proof = await this.verifyRoute(route, { signal }); }
    catch { if (generation === this.generation && revision === this.routeRevision) this.fallback('DATA_PATH_FAILED'); return; }
    if (generation !== this.generation || revision !== this.routeRevision || signal?.aborted) return;
    if (proof?.authenticated !== true || String(proof.alias).toLowerCase() !== this.alias.toLowerCase()) { await this.driver.stop(); this.fallback('NAS_IDENTITY_NOT_VERIFIED'); return; }
    this.route = route;
    this.state = { ...this.state, phase: 'ready', mode: route.mode, nativeP2p: route.p2p === true, reason: null };
  }
  fallback(reason) {
    this.routeRevision++;
    this.route = { origin: this.relayOrigin, mode: 'ugreenlink-relay', p2p: false };
    this.state = { ...this.state, phase: 'ready', mode: 'ugreenlink-relay', nativeP2p: false, reason };
    return this.currentRoute();
  }
  async stop() { this.generation++; try { await this.driver.stop(); } finally { this.fallback('STOPPED'); this.state.phase = 'idle'; } }
}
