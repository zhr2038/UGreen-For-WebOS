import { UgOS } from './ugos.mjs';
import { selectTrustedLan } from './transport/trusted-lan.mjs';

const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
const networkFailure = error => networkCodes.has(error.code) || (!error.code && /timed out|socket hang up/i.test(error.message));
const cancelled = () => Object.assign(new Error('NAS connection changed'), { name: 'AbortError' });

export class AdaptiveNas {
  constructor(config, { relay = new UgOS(config), select = selectTrustedLan, createProbe = value => new UgOS(value) } = {}) {
    this.config = config; this.relay = relay; this.selector = select; this.createProbe = createProbe; this.generation = 0; this.route = null;
    this.httpsAgent = { destroy: () => this.close() }; this.config.linkMode = 'ugreenlink-relay';
  }
  reset() {
    this.generation++; this.selectAbort?.abort(); this.selectAbort = null;
    this.route?.close(); this.route = null; this.relay.httpsAgent.destroy(); this.config.linkMode = 'ugreenlink-relay';
  }
  close() { this.reset(); }
  async select() {
    this.selectAbort?.abort(); const controller = new AbortController(); this.selectAbort = controller;
    const generation = this.generation;
    if (!this.config.token || !this.config.alias) return this.summary();
    const probe = this.createProbe({ ...this.config });
    let result;
    try {
      result = await this.selector({ relayNas: probe, alias: this.config.alias, signal: controller.signal, timeout: 2500 });
      if (controller.signal.aborted || generation !== this.generation) { result.close(); return this.summary(); }
      this.route?.close(); this.route = result.client ? result : null; this.config.linkMode = this.route ? 'lan-https' : 'ugreenlink-relay';
    } catch { result?.close(); }
    finally { probe.httpsAgent.destroy(); if (this.selectAbort === controller) this.selectAbort = null; }
    return this.summary();
  }
  summary() { return { mode: this.route ? 'lan-https' : 'ugreenlink-relay', verified: Boolean(this.route), p2p: false }; }
  async call(method, path, options) {
    const generation = this.generation, route = this.route, client = route?.client || this.relay;
    try {
      const result = await client[method](path, options);
      if (generation !== this.generation) { if (method === 'open') result.destroy(); throw cancelled(); }
      return result;
    } catch (error) {
      if (generation !== this.generation) throw cancelled();
      if (!route || route !== this.route || !networkFailure(error)) throw error;
      route.close(); this.route = null; this.config.linkMode = 'ugreenlink-relay';
      // A POST may already have reached the NAS. Never retry it after an
      // unknown outcome; only reads can automatically fall back to relay.
      if ((options?.method || 'GET') !== 'GET') throw error;
      return this.call(method, path, options);
    }
  }
  request(path, options) { return this.call('request', path, options); }
  open(path, options) { return this.call('open', path, options); }
}
