import { nativePhotoRequest } from './photo-output.mjs';

export class NativePhotoError extends Error {
  constructor(code, message) { super(message); this.name = 'NativePhotoError'; this.code = code; }
}
const failure = (code, message) => new NativePhotoError(code, message);
const validKey = value => typeof value === 'string' && value.length >= 16 && value.length <= 256;
const validSession = payload => payload && typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= 256 && typeof payload.sessionId === 'string' && payload.sessionId.length > 0 && payload.sessionId.length <= 256;

// SSAP has a separate identity from UGOS. No developer-PC key, NAS token or
// global media-control command is accepted here. Socket/TLS and private key
// persistence are injected by the on-device owner. Constructing this class does
// nothing; first registration requires explicit allowPairing:true.
export class NativePhotoSession {
  constructor({ createSocket, keyStore = {}, onState = () => {}, onLeaseChange = async () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, connectTimeoutMs = 10000, pairingTimeoutMs = 60000, requestTimeoutMs = 15000, sessionTtlMs = 300000 } = {}) {
    for (const [value, max] of [[connectTimeoutMs, 30000], [pairingTimeoutMs, 120000], [requestTimeoutMs, 30000], [sessionTtlMs, 600000]]) if (!Number.isFinite(value) || value < 1000 || value > max) throw failure('INVALID_TIMEOUT', '原生照片会话超时配置无效');
    this.createSocket = createSocket; this.keyStore = keyStore; this.onState = onState; this.onLeaseChange = onLeaseChange; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    Object.assign(this, { connectTimeoutMs, pairingTimeoutMs, requestTimeoutMs, sessionTtlMs });
    this.socket = null; this.state = 'disconnected'; this.key = null; this.authenticated = false; this.session = null; this.pending = new Map(); this.serial = 0; this.generation = 0; this.connectionGeneration = 0; this.connecting = null; this.connectTask = null; this.opening = null; this.closing = null; this.openSent = false; this.disposed = false; this.leaseActive = false;
  }
  snapshot() { return { state: this.state, paired: this.authenticated && validKey(this.key), hasSavedKey: validKey(this.key), session: this.session ? { id: this.session.id, sessionId: this.session.sessionId, expiresAt: this.session.expiresAt } : null }; }
  stateChange(state) { this.state = state; try { this.onState(this.snapshot()); } catch {} }
  timer(callback, delay) { const timer = this.setTimer(callback, delay); timer?.unref?.(); return timer; }
  clear(name) { if (this[name] != null) this.clearTimer(this[name]); this[name] = null; }
  #wire(message) { if (!this.socket || this.socket.readyState !== 1) throw failure('NOT_CONNECTED', '尚未连接电视照片服务'); this.socket.send(JSON.stringify(message)); }
  listen(socket, event, callback) { if (typeof socket.addEventListener === 'function') socket.addEventListener(event, callback); else socket.on(event, callback); }
  async deadline(operation, delay, error) {
    let timer;
    try { return await Promise.race([Promise.resolve(operation), new Promise((resolve, reject) => { timer = this.timer(() => reject(error), delay); })]); }
    finally { if (timer != null) this.clearTimer(timer); }
  }
  async lease(value) { try { await this.deadline(this.onLeaseChange(value), this.requestTimeoutMs, failure('LEASE_TIMEOUT', '照片读取会话响应超时')); this.leaseActive = value.active; } catch { throw failure('LEASE_FAILED', '无法保持原生照片读取会话'); } }
  async endLease(reason) { this.clear('leaseTimer'); if (!this.leaseActive) return; try { await this.lease({ active: false, reason }); } catch {} finally { this.leaseActive = false; } }
  connect(options = {}) {
    if (this.connectTask) return this.connectTask;
    const generation = this.connectionGeneration;
    this.connectTask = Promise.resolve().then(() => this.establish(options, generation)).finally(() => { this.connectTask = null; });
    return this.connectTask;
  }
  async establish({ allowPairing = false } = {}, connectionGeneration = this.connectionGeneration) {
    if (this.disposed) throw failure('DISPOSED', '照片会话已关闭');
    if (connectionGeneration !== this.connectionGeneration) throw failure('CANCELLED', '原生照片连接已取消');
    if (this.authenticated && (this.state === 'ready' || this.state === 'viewing')) return this.snapshot();
    if (this.connecting) return this.connecting;
    if (typeof this.createSocket !== 'function') throw failure('TRANSPORT_UNAVAILABLE', '当前安装包尚未提供本机电视连接适配器');
    if (!this.key) {
      let saved;
      try { saved = await this.deadline(Promise.resolve().then(() => this.keyStore.load?.()), this.connectTimeoutMs, failure('KEY_STORAGE_TIMEOUT', '读取本机电视授权超时')); }
      catch (error) { throw error instanceof NativePhotoError ? error : failure('KEY_STORAGE_FAILED', '无法读取本机电视授权'); }
      if (validKey(saved)) this.key = saved;
    }
    if (connectionGeneration !== this.connectionGeneration) throw failure('CANCELLED', '原生照片连接已取消');
    if (!validKey(this.key) && !allowPairing) throw failure('PAIRING_REQUIRED', '请先明确授权本机电视的原生照片查看');
    this.allowPairing = allowPairing; this.stateChange('connecting');
    this.connecting = new Promise((resolve, reject) => { this.connectResolve = resolve; this.connectReject = reject; });
    const pending = this.connecting;
    try {
      // The factory must validate/pin this loopback TV TLS peer. This controller
      // never disables TLS verification or permits a user-supplied remote host.
      const socket = this.createSocket('wss://127.0.0.1:3001'); this.socket = socket;
      this.listen(socket, 'open', () => this.socket === socket && this.register());
      this.listen(socket, 'message', event => { if (this.socket === socket) this.receive(event?.data ?? event); });
      this.listen(socket, 'error', () => { if (this.socket === socket) this.disconnect(failure('CONNECTION_FAILED', '本机电视连接失败')); });
      this.listen(socket, 'close', () => { if (this.socket === socket) this.disconnect(failure('CONNECTION_CLOSED', '本机电视连接已关闭')); });
      this.connectTimer = this.timer(() => this.disconnect(failure('CONNECTION_TIMEOUT', '连接电视照片服务超时')), this.connectTimeoutMs);
      if (socket.readyState === 1) queueMicrotask(() => { if (this.socket === socket) this.register(); });
    } catch { this.disconnect(failure('CONNECTION_FAILED', '本机电视连接失败')); }
    return pending;
  }
  register() {
    if (!this.connecting || this.registerId) return;
    this.registerId = 'photo-register-' + ++this.serial; this.stateChange('registering');
    try { this.#wire({ type: 'register', id: this.registerId, payload: { manifest: { manifestVersion: 1, permissions: ['LAUNCH', 'CONTROL_INPUT_MEDIA_PLAYBACK'] }, ...(this.key ? { 'client-key': this.key } : {}) } }); }
    catch { this.disconnect(failure('REGISTRATION_FAILED', '无法发起电视授权')); }
  }
  receive(raw) {
    let message;
    try { const value = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'); if (value.length > 65536) throw new Error('oversize'); message = JSON.parse(value); if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid shape'); }
    catch { this.disconnect(failure('INVALID_RESPONSE', '电视返回了无效数据')); return; }
    const id = String(message.id ?? '');
    if (this.connecting && (id === this.registerId || message.type === 'registered')) {
      if (message.type === 'error') { this.disconnect(failure('PAIRING_REJECTED', '电视未批准原生照片授权')); return; }
      if (message.type === 'response' && message.payload?.pairingType) {
        if (!this.allowPairing) { this.disconnect(failure('PAIRING_REQUIRED', '已有电视授权已失效，请重新授权')); return; }
        this.stateChange('pairing'); this.clear('connectTimer'); this.connectTimer = this.timer(() => this.disconnect(failure('PAIRING_TIMEOUT', '等待电视授权超时')), this.pairingTimeoutMs); return;
      }
      if (message.type === 'registered') {
        const key = message.payload?.['client-key'] || this.key;
        if (!validKey(key)) { this.disconnect(failure('INVALID_KEY', '电视未返回有效的本机授权')); return; }
        this.deadline(Promise.resolve().then(() => this.keyStore.save?.(key)), this.connectTimeoutMs, failure('KEY_STORAGE_TIMEOUT', '保存本机电视授权超时')).then(() => {
          if (!this.connecting) return;
          this.key = key; this.authenticated = true; this.clear('connectTimer'); this.registerId = null;
          const resolve = this.connectResolve; this.connecting = null; this.connectResolve = this.connectReject = null; this.stateChange('ready'); resolve(this.snapshot());
        }).catch(() => this.disconnect(failure('KEY_STORAGE_FAILED', '无法保存本机电视授权')));
        return;
      }
    }
    const pending = this.pending.get(id); if (!pending) return;
    if (message.type !== 'response' && message.type !== 'error') return;
    this.pending.delete(id); this.clearTimer(pending.timer);
    if (message.type === 'error' || message.payload?.returnValue === false) pending.reject(failure('REQUEST_REJECTED', '电视拒绝了原生照片请求'));
    else pending.resolve(message.payload || {});
  }
  #request(uri, payload) {
    if (!['ssap://media.viewer/open', 'ssap://media.viewer/close'].includes(uri)) return Promise.reject(failure('URI_REJECTED', '不支持的照片控制请求'));
    if (this.pending.size >= 8) return Promise.reject(failure('BUSY', '电视照片请求正在处理中'));
    const id = 'photo-request-' + ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = this.timer(() => { this.pending.delete(id); reject(failure('REQUEST_TIMEOUT', '电视照片请求超时')); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#wire({ type: 'request', id, uri, payload }); } catch (error) { this.pending.delete(id); this.clearTimer(timer); reject(error); }
    });
  }
  async #closeWire(session) { return this.#request('ssap://media.viewer/close', { id: session.id, sessionId: session.sessionId }); }
  async open(url, photo, { allowPairing = false } = {}) {
    if (this.opening || this.closing) throw failure('BUSY', '另一项原生照片操作正在进行');
    const command = nativePhotoRequest(url, photo), generation = ++this.generation;
    const operation = (async () => {
      if (this.session) { const previous = this.session; try { await this.#closeWire(previous); } finally { this.session = null; await this.endLease('replace'); } }
      await this.connect({ allowPairing });
      if (generation !== this.generation) throw failure('CANCELLED', '原生照片查看已取消');
      this.stateChange('opening'); await this.lease({ active: true, phase: 'opening', expiresAt: this.now() + this.requestTimeoutMs });
      if (generation !== this.generation) throw failure('CANCELLED', '原生照片查看已取消');
      this.openSent = true;
      const response = await this.#request(command.uri, command.payload);
      if (!validSession(response)) throw failure('UNCONTROLLED_SESSION', '电视未返回可控的照片会话，请使用电视返回键退出');
      const session = { id: response.id, sessionId: response.sessionId, expiresAt: this.now() + this.sessionTtlMs };
      if (generation !== this.generation) { await this.#closeWire(session); throw failure('CANCELLED', '原生照片查看已取消'); }
      this.session = session;
      try { await this.lease({ active: true, phase: 'viewing', ...session }); }
      catch (error) { try { await this.#closeWire(session); } catch {} this.session = null; await this.endLease('lease-failed'); throw error; }
      this.leaseTimer = this.timer(() => { if (this.session === session && this.now() >= session.expiresAt) this.close('expired').catch(() => {}); }, this.sessionTtlMs);
      this.stateChange('viewing'); return this.snapshot();
    })();
    this.opening = operation;
    try { return await operation; }
    catch (error) { if (!this.session) await this.endLease('open-failed'); this.stateChange(this.authenticated && this.socket?.readyState === 1 ? 'ready' : 'error'); throw error; }
    finally { if (this.opening === operation) this.opening = null; this.openSent = false; }
  }
  async close(reason = 'user') {
    if (this.closing) return this.closing;
    ++this.generation;
    this.closing = (async () => {
      if (!this.opening && (this.connectTask || this.connecting)) this.disconnect(failure('CANCELLED', '原生照片连接已取消'));
      if (this.opening) {
        if (!this.openSent) this.disconnect(failure('CANCELLED', '原生照片查看已取消'));
        await this.opening.catch(() => {});
      }
      const session = this.session; this.clear('leaseTimer');
      try { if (session) { this.stateChange('closing'); await this.#closeWire(session); } }
      finally { this.session = null; await this.endLease(reason); this.stateChange(this.authenticated && this.socket?.readyState === 1 ? 'ready' : 'disconnected'); }
      return this.snapshot();
    })();
    try { return await this.closing; } finally { this.closing = null; }
  }
  disconnect(error = failure('CONNECTION_CLOSED', '本机电视连接已关闭')) {
    ++this.connectionGeneration;
    this.authenticated = false;
    this.clear('connectTimer'); this.registerId = null;
    const socket = this.socket; this.socket = null;
    if (this.connecting) { const reject = this.connectReject; this.connecting = null; this.connectResolve = this.connectReject = null; reject(error); }
    for (const item of this.pending.values()) { this.clearTimer(item.timer); item.reject(error); } this.pending.clear();
    try { socket?.close(); socket?.terminate?.(); } catch {}
    this.stateChange('disconnected');
    // A lost socket does not prove the native viewer closed. The finite lease
    // remains until expiry or explicit close; no global stop or auto-reconnect.
  }
  async dispose() { try { await this.close('dispose'); } finally { this.disposed = true; this.disconnect(); } }
}
