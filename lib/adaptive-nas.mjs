import {isNativeRouteFailure,isNativeIntegrityFailure,isCallerAbort} from './native-client.mjs';
import {nativeSummaryReason,nativeSummaryStage,nativeWorkerFailureSnapshot} from './native-manager.mjs';
import {randomUUID} from 'node:crypto';
import { UgOS } from './ugos.mjs';
import { selectTrustedLan, createTrustedLanClient } from './transport/trusted-lan.mjs';

const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
const networkFailure = error => networkCodes.has(error?.code) || (!error?.code && typeof error?.message==='string' && /timed out|socket hang up/i.test(error.message));
const stages = new Set(['DISCOVERY', 'RELAY_HANDSHAKE', 'DNS', 'LAN_HANDSHAKE', 'ACCOUNT_VERIFY', 'IDLE']);
const reasons = new Set(['UNTRUSTED_RELAY_ORIGIN', 'DISCOVERY_UNAVAILABLE', 'NO_SMARTDNS_CANDIDATE', 'NO_VERIFIED_LAN', 'CANCELLED', 'TIMED_OUT', 'LAN_VERIFICATION_FAILED', 'DNS_FAILED', 'TLS_FAILED', 'NAS_IDENTITY_MISMATCH', 'ACCOUNT_IDENTITY_MISMATCH', 'NO_PRIVATE_ADDRESS']);
const cancelled = () => Object.assign(new Error('NAS connection changed'), { name: 'AbortError' });

export class AdaptiveNas {
  constructor(config, { relay = new UgOS(config), select = selectTrustedLan, createProbe = value => new UgOS(value), now = Date.now, automaticRetry = true, nativeFactory = null, preferNative = false } = {}) {
    this.nativeFactory=nativeFactory;this.preferNative=preferNative===true;this.visible=!nativeFactory;this.ownerScope=randomUUID();
    this.now = now; this.automaticRetry = automaticRetry; this.retryAt = 0; this.attempts = 0; this.reason = 'NOT_PROBED'; this.probeStage = 'IDLE'; this.probeError = null; this.probeElapsedMs = 0;
    this.config = config; this.relay = relay; this.selector = select; this.createProbe = createProbe; this.generation = 0; this.route = null;
    this.httpsAgent = { destroy: () => this.close() }; this.config.linkMode = 'ugreenlink-relay';
  }
  reset() {
    this.nativeReason=null;this.nativePreferenceAttempted=false;this.ownerScope=randomUUID();clearTimeout(this.visibilityTimer);this.native?.close();this.native=null;this.visible=!this.nativeFactory;
    this.generation++; this.pending = null; this.retryAt = 0; this.reason = 'NOT_PROBED'; this.probeStage = 'IDLE'; this.probeError = null; this.probeElapsedMs = 0; this.attempts = 0; this.selectAbort?.abort(); this.selectAbort = null;
    this.route?.close(); this.route = null; this.relay.httpsAgent.destroy(); this.config.linkMode = 'ugreenlink-relay';
  }
  close() { this.reset(); }
  visibilityScope(){return this.ownerScope;}
  setVisibility({scope,visible}){if(scope!==this.ownerScope||typeof visible!=='boolean')return false;clearTimeout(this.visibilityTimer);this.visible=visible;this.native?.setVisible(visible);if(visible){this.visibilityTimer=setTimeout(()=>{if(scope!==this.ownerScope)return;this.visible=false;this.native?.setVisible(false);this.summary();},90000);this.visibilityTimer.unref?.();if(!this.route||this.preferNative&&this.route.kind==='lan'&&!this.nativePreferenceAttempted)this.select().catch(()=>{});}this.summary();return true;}

  snapshot() {
    const config = { ...this.config };
    for (const key of ['alias', 'server', 'token', 'staticToken', 'clientId', 'username', 'uid', 'authMode', 'tlsFingerprint', 'nasPublicRsa']) if (key in config) Object.defineProperty(config, key, { value: config[key], enumerable: true, writable: false, configurable: false });
    const copy = new AdaptiveNas(config, { select: this.selector, createProbe: this.createProbe, now: this.now, automaticRetry: false });
    const nativeHandle=this.route?.kind==='native'?this.route.handle:this.snapshotNativeHandle;
    if(nativeHandle){copy.snapshotNativeHandle=nativeHandle;try{const release=nativeHandle.retain();copy.route={kind:'native',client:nativeHandle.client,handle:nativeHandle,close:release};copy.config.linkMode='native-p2p';}catch{}return copy;}
    const route = this.route?.route || this.snapshotRoute;
    if (route) {
      const descriptor = { ...route }, client = createTrustedLanClient(config, descriptor);
      copy.route = { client, route: descriptor, close() { client.httpsAgent.destroy(); } };
      copy.snapshotRoute = descriptor; copy.config.linkMode = 'lan-https';
    }
    return copy;
  }
  select() {
    if (!this.automaticRetry || this.route&&!(this.preferNative&&this.visible&&this.route.kind==='lan'&&!this.nativePreferenceAttempted) || !this.config.token || !this.config.alias) return Promise.resolve(this.summary());
    if (this.pending) return this.pending;
    const task = this.runSelection(); this.pending = task;
    const done = () => { if (this.pending === task) this.pending = null; };
    task.then(done, done);
    return task;
  }
  foreground(method = 'GET') {
    if (['GET', 'HEAD'].includes(String(method).toUpperCase()) && this.automaticRetry && !this.route && this.now() >= this.retryAt) this.select().catch(() => {});
  }
  async runSelection() {
    const controller = new AbortController(); this.selectAbort = controller;
    const generation = this.generation, started = this.now(); this.attempts++; this.probeStartedAt = started;
    this.probeStage = 'DISCOVERY'; this.probeError = null;
    let probe, result;
    try {
      if(this.preferNative&&this.visible&&this.route?.kind==='lan')result=this.route;
      else{probe = this.createProbe({ ...this.config });
      result = await this.selector({ relayNas: probe, alias: this.config.alias, signal: controller.signal, timeout: 8000,
        onStage: stage => { if (generation === this.generation && stages.has(stage)) this.probeStage = stage; } });}
      if (controller.signal.aborted || generation !== this.generation) { result?.close(); return this.summary(); }
      this.route = result.client ? {...result,kind:'lan'} : null;
      if(this.nativeFactory&&this.visible&&(!this.route||this.preferNative&&!this.nativePreferenceAttempted)){
        if(this.preferNative)this.nativePreferenceAttempted=true;
        this.probeStage='NATIVE_SELECTION';
        if(!this.native)this.native=this.nativeFactory({...this.config});
        const candidate=await this.native.select({signal:controller.signal});
        if(controller.signal.aborted||generation!==this.generation){candidate?.close?.();return this.summary();}
        if(candidate.client&&candidate.summary?.current&&candidate.summary?.authenticated&&[4,5].includes(candidate.route?.type)){this.route?.close();this.route={kind:'native',client:candidate.client,handle:candidate,close:()=>candidate.close()};this.nativeReason=null;}
        else this.nativeReason=nativeSummaryReason(candidate.summary?.reason);
      }
      this.config.linkMode=this.route?.kind==='native'?'native-p2p':this.route?'lan-https':'ugreenlink-relay';
      this.reason = this.route ? null : this.nativeReason|| (reasons.has(result.summary?.reason) ? result.summary.reason : 'LAN_VERIFICATION_FAILED');
      this.probeError = this.reason;
    } catch { result?.close(); if (generation === this.generation) { this.reason = 'LAN_VERIFICATION_FAILED'; this.probeError = this.reason; } }
    finally {
      probe?.httpsAgent.destroy();
      if (this.selectAbort === controller) { this.selectAbort = null; this.probeElapsedMs = Math.max(0, this.now() - started); this.retryAt = this.route ? 0 : this.now() + 30000; }
    }
    return this.summary();
  }
  summary() {if(this.route?.kind==='native'&&!this.route.handle.summary.current){this.route.close();this.route=null;this.reason='NATIVE_ROUTE_CHANGED';}this.config.linkMode=this.route?.kind==='native'?'native-p2p':this.route?'lan-https':'ugreenlink-relay';const native=this.route?.kind==='native'?this.route.handle.summary:null;return { mode: this.config.linkMode, verified: Boolean(this.route), p2p: Boolean(native?.p2p), authenticated:Boolean(native?.authenticated),mediaReadVerified:Boolean(native?.mediaReadVerified),wanTraversalVerified:false,nativeEnabled:Boolean(this.nativeFactory&&(this.nativeFactory.enabled??true)),nativeReason:this.nativeReason||(this.native?.summary?.().reason?nativeSummaryReason(this.native.summary().reason):null),nativeStage:nativeSummaryStage(this.native?.summary?.().nativeStage),nativeHttpStatus:Number.isInteger(this.native?.summary?.().nativeHttpStatus)&&this.native.summary().nativeHttpStatus>=100&&this.native.summary().nativeHttpStatus<=599?this.native.summary().nativeHttpStatus:null,lastWorkerFailure:this.native?.summary?.().lastWorkerFailure?nativeWorkerFailureSnapshot(this.native.summary().lastWorkerFailure):null,
    reason: this.reason, probing: Boolean(this.selectAbort), probeStage: this.probeStage, probeError: this.probeError,
    probeElapsedMs: this.selectAbort ? Math.max(0, this.now() - this.probeStartedAt) : this.probeElapsedMs, attempts: this.attempts, retryAfterMs: Math.max(0, this.retryAt - this.now()), automaticRetry: this.automaticRetry }; }
  async call(method, path, options) {
    this.foreground(options?.method || 'GET');
    this.summary();const read=['GET','HEAD'].includes(String(options?.method||'GET').toUpperCase());
    const generation = this.generation, route = this.route, client = route?.kind==='native'&&!read?this.relay:route?.client || this.relay;
    try {
      const result = await client[method](path, options);
      if (generation !== this.generation) { if (method === 'open') result.destroy(); throw cancelled(); }
      return result;
    } catch (error) {
      if (generation !== this.generation) throw cancelled();
      if(route?.kind==='native'&&client===this.relay)throw error;
      if(route?.kind==='native'&&!isNativeIntegrityFailure(error?.code)&&(isCallerAbort(error)||options?.signal?.aborted))throw Object.assign(new Error('读取已取消'),{name:'AbortError',code:'ABORT_ERR'});
      if(route?.kind==='native'&&error?.code==='NATIVE_CONNECTION_LIMIT'&&read){let result;try{result=await this.relay[method](path,options);}catch(fallbackError){if(generation!==this.generation)throw cancelled();throw fallbackError;}if(generation!==this.generation){if(method==='open')result.destroy();throw cancelled();}return result;}
      if (!route || route !== this.route || !(networkFailure(error)||route.kind==='native'&&isNativeRouteFailure(error?.code))) throw error;
      route.close(); this.route = null; this.reason = route.kind==='native'?'NATIVE_ROUTE_CHANGED':'LAN_DISCONNECTED'; this.probeError = this.reason; this.retryAt = this.now() + 30000; this.config.linkMode = 'ugreenlink-relay';
      // A POST may already have reached the NAS. Never retry it after an
      // unknown outcome; only reads can automatically fall back to relay.
      if (!['GET', 'HEAD'].includes(String(options?.method || 'GET').toUpperCase())||options?.signal?.aborted) throw error;
      return this.call(method, path, options);
    }
  }
  request(path, options) { return this.call('request', path, options); }
  open(path, options) { return this.call('open', path, options); }
}
