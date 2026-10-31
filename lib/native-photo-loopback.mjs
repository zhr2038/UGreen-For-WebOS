import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve, parse } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { NativePhotoSession } from './native-photo-session.mjs';

export const NATIVE_PHOTO_LOOPBACK_ENDPOINT = 'wss://127.0.0.1:3001';
const FORMAT = 'cloudframe.native-photo-identity.v1';
const APP_ID = 'top.hrhome.nascinema';
const serial = new Map();
const noop = () => {};
const validKey = value => typeof value === 'string' && /^[\x21-\x7e]{16,256}$/.test(value);
const validUuid = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
export class NativePhotoLoopbackError extends Error {
  constructor(code, message) { super(message); this.name = 'NativePhotoLoopbackError'; this.code = code; }
}
const fail = (code, message) => new NativePhotoLoopbackError(code, message);
function active(attempt) { if (attempt.cancelled) throw fail('CANCELLED', '本机电视连接已取消'); }
async function serialized(key, task) {
  const previous = serial.get(key) || Promise.resolve();
  const current = previous.catch(noop).then(task); serial.set(key, current);
  try { return await current; } finally { if (serial.get(key) === current) serial.delete(key); }
}

/** Private per-installation store; never exported or returned to an API caller. */
class IdentityStore {
  constructor(directory, appId) { this.directory = directory; this.appId = appId; this.file = join(directory, 'identity.json'); }
  async directoryReady() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw fail('PRIVATE_DIRECTORY_INVALID', '原生照片授权目录不可用');
    await fs.chmod(this.directory, 0o700);
    return fs.realpath(this.directory);
  }
  async locked(operation) {
    const canonical = await this.directoryReady();
    return serialized(process.platform === 'win32' ? canonical.toLowerCase() : canonical, async () => {
      const lockPath = join(this.directory, '.identity.lock'); let lock;
      const deadline = Date.now() + 3000;
      while (!lock) {
        try { lock = await fs.open(lockPath, 'wx', 0o600); }
        catch (error) {
          if (error.code !== 'EEXIST') throw fail('PRIVATE_STORE_FAILED', '无法锁定原生照片授权文件');
          if (Date.now() >= deadline) throw fail('PRIVATE_STORE_BUSY', '原生照片授权文件正在使用中');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      try { await lock.chmod(0o600); return await operation(); }
      finally { await lock.close().catch(noop); await fs.unlink(lockPath).catch(noop); }
    });
  }
  async read() {
    let handle;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192 || typeof process.getuid === 'function' && stat.uid !== process.getuid() || process.platform !== 'win32' && (stat.mode & 0o077)) throw fail('PRIVATE_STORE_INVALID', '原生照片授权文件不满足私有文件要求');
      handle = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat(); if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 8192) throw fail('PRIVATE_STORE_CHANGED', '原生照片授权文件已变化');
      const record = JSON.parse(await handle.readFile('utf8'));
      if (record?.format !== FORMAT || record.endpoint !== NATIVE_PHOTO_LOOPBACK_ENDPOINT || record.appId !== this.appId || !/^[0-9a-f]{64}$/.test(record.fingerprint || '') || !Number.isSafeInteger(record.revision) || record.revision < 1 || record.clientKey != null && !validKey(record.clientKey) || record.deviceUuid != null && !validUuid(record.deviceUuid)) throw fail('PRIVATE_STORE_INVALID', '原生照片授权格式不匹配');
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof NativePhotoLoopbackError) throw error;
      throw fail('PRIVATE_STORE_INVALID', '无法读取原生照片授权');
    } finally { await handle?.close().catch(noop); }
  }
  async write(record, attempt) {
    active(attempt); const temporary = join(this.directory, '.identity-' + randomUUID() + '.tmp'); let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(record) + '\n', 'utf8'); await handle.sync(); await handle.close(); handle = null;
      active(attempt); await fs.rename(temporary, this.file);
      // POSIX directory sync makes the atomic rename durable. Windows cannot
      // express the target webOS POSIX permission/directory-fsync guarantees.
      if (process.platform !== 'win32') { const directory = await fs.open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    } catch (error) {
      if (error instanceof NativePhotoLoopbackError) throw error;
      throw fail('PRIVATE_STORE_FAILED', '无法保存原生照片授权');
    } finally { await handle?.close().catch(noop); await fs.unlink(temporary).catch(noop); }
  }
  async load(attempt) {
    return this.locked(async () => { active(attempt); attempt.record = await this.read(); active(attempt); return attempt.record?.clientKey || null; });
  }
  async mutate(attempt, operation) {
    return this.locked(async () => {
      active(attempt); const current = await this.read();
      if ((current?.revision || 0) !== (attempt.record?.revision || 0)) throw fail('PRIVATE_STORE_CHANGED', '另一个本机授权操作已更新凭据，请重新连接');
      const next = operation(current);
      if (next !== current) { next.revision = (current?.revision || 0) + 1; await this.write(next, attempt); }
      active(attempt); attempt.record = next; return next;
    });
  }
  async trust(attempt, fingerprint) {
    await this.mutate(attempt, current => {
      if (current && current.fingerprint !== fingerprint) throw fail('TV_CERTIFICATE_CHANGED', '本机电视证书已改变，未发送授权凭据');
      if (current) return current;
      if (attempt.allowPairing !== true) throw fail('PAIRING_REQUIRED', '首次信任本机电视需要明确授权');
      return { format: FORMAT, endpoint: NATIVE_PHOTO_LOOPBACK_ENDPOINT, appId: this.appId, fingerprint, clientKey: null, deviceUuid: null };
    });
    attempt.fingerprint = fingerprint; attempt.tlsVerified = true;
  }
  async identify(attempt, deviceUuid) {
    await this.mutate(attempt, current => {
      if (!current || current.fingerprint !== attempt.fingerprint) throw fail('TV_IDENTITY_CHANGED', '本机电视身份不匹配');
      if (current.deviceUuid && current.deviceUuid !== deviceUuid) throw fail('TV_IDENTITY_CHANGED', '本机电视标识已改变，未发送授权凭据');
      return current.deviceUuid ? current : { ...current, deviceUuid };
    });
  }
  async save(attempt, clientKey) {
    if (!attempt.tlsVerified || !attempt.helloVerified || !validKey(clientKey)) throw fail('TV_IDENTITY_UNVERIFIED', '不能为未验证的电视保存凭据');
    await this.mutate(attempt, current => {
      if (!current || current.fingerprint !== attempt.fingerprint) throw fail('TV_IDENTITY_CHANGED', '本机电视身份不匹配');
      return current.clientKey === clientKey ? current : { ...current, clientKey };
    });
  }
}

/** Hides raw WebSocket open until TLS pin + SSAP hello have both completed. */
class VerifiedSocket extends EventEmitter {
  constructor({ endpoint, WebSocket, tlsConnect, attempt, store, hello, helloTimeoutMs, onFailure }) {
    super(); this.readyState = 0; this.on('error', noop); this.attempt = attempt; this.handlers = []; this.onFailure = onFailure; this.store = store; this.hello = hello; this.helloTimeoutMs = helloTimeoutMs;
    if (endpoint !== NATIVE_PHOTO_LOOPBACK_ENDPOINT) throw fail('ENDPOINT_LOCKED', '原生照片连接只允许本机电视端口');
    this.helloId = 'cloudframe-photo-hello-' + randomUUID();
    try {
      active(attempt);
      this.raw = new WebSocket(NATIVE_PHOTO_LOOPBACK_ENDPOINT, {
        // Node uses the explicit createConnection path only without an Agent.
        // agent:false would create a one-shot default Agent and bypass it.
        agent: null, followRedirects: false, perMessageDeflate: false, maxPayload: 65536, handshakeTimeout: 10000,
        // This exception is local to this socket, replaced by strict leaf pin
        // verification before exposing open. No global TLS/NAS trust changes.
        rejectUnauthorized: false,
        createConnection: () => {
          active(attempt);
          const socket = tlsConnect({ host: '127.0.0.1', port: 3001, rejectUnauthorized: false, minVersion: 'TLSv1.2' }); this.tls = socket;
          this.listen(socket, 'secureConnect', () => this.verifyPeer());
          this.listen(socket, 'error', () => this.reject(fail('TV_TLS_FAILED', '本机电视 TLS 连接失败')));
          return socket;
        },
      });
      this.listen(this.raw, 'open', () => { this.rawOpen = true; this.beginHello(); });
      this.listen(this.raw, 'message', data => this.receive(data));
      this.listen(this.raw, 'error', () => this.reject(fail('TV_SOCKET_FAILED', '本机电视 WebSocket 连接失败')));
      this.listen(this.raw, 'close', () => this.shutdown());
    } catch (error) { queueMicrotask(() => this.reject(error instanceof NativePhotoLoopbackError ? error : fail('TV_SOCKET_FAILED', '无法创建本机电视连接'))); }
  }
  listen(target, name, handler) { target.on(name, handler); this.handlers.push([target, name, handler]); }
  async verifyPeer() {
    if (this.verifying || this.readyState === 3) return;
    this.verifying = true;
    try {
      active(this.attempt);
      if (this.tls?.encrypted !== true || !['127.0.0.1', '::ffff:127.0.0.1'].includes(this.tls.remoteAddress) || this.tls.remotePort !== 3001) throw fail('ENDPOINT_LOCKED', '电视 TLS 对端不是指定本机端口');
      const raw = this.tls.getPeerCertificate(true)?.raw;
      if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 128 * 1024) throw fail('TV_CERTIFICATE_MISSING', '电视未提供可校验的叶证书');
      this.tls.disableRenegotiation?.();
      await this.store.trust(this.attempt, createHash('sha256').update(raw).digest('hex'));
      active(this.attempt); if (this.readyState !== 3) this.beginHello();
    } catch (error) { this.reject(error); }
  }
  beginHello() {
    if (this.readyState === 3 || this.helloSent || !this.rawOpen || !this.attempt.tlsVerified) return;
    try {
      active(this.attempt); this.helloSent = true;
      this.helloTimer = setTimeout(() => this.reject(fail('TV_HELLO_TIMEOUT', '等待本机电视身份响应超时')), this.helloTimeoutMs); this.helloTimer.unref?.();
      this.raw.send(JSON.stringify({ type: 'hello', id: this.helloId, payload: this.hello }));
    } catch (error) { this.reject(error); }
  }
  async receive(data) {
    if (this.readyState === 3) return;
    if (this.readyState === 1) { this.emit('message', data); return; }
    try {
      active(this.attempt);
      if (!this.helloSent || this.identifying) return;
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (bytes.length > 65536) throw fail('TV_HELLO_INVALID', '电视身份响应超过限制');
      const message = JSON.parse(bytes.toString('utf8'));
      if (message.type !== 'hello' || message.id != null && String(message.id) !== this.helloId || !validUuid(message.payload?.deviceUUID)) throw fail('TV_HELLO_INVALID', '电视身份响应格式不匹配');
      this.identifying = true; await this.store.identify(this.attempt, message.payload.deviceUUID);
      active(this.attempt); if (this.readyState === 3) return;
      this.attempt.helloVerified = true; clearTimeout(this.helloTimer); this.readyState = 1; this.emit('open');
    } catch (error) { this.reject(error instanceof NativePhotoLoopbackError ? error : fail('TV_HELLO_INVALID', '电视身份响应无法识别')); }
  }
  send(value) {
    active(this.attempt);
    if (this.readyState !== 1 || !this.attempt.tlsVerified || !this.attempt.helloVerified) throw fail('TV_IDENTITY_UNVERIFIED', '电视身份尚未完成校验');
    this.raw.send(value);
  }
  reject(error) {
    if (this.readyState === 3) return;
    const sanitized = error instanceof NativePhotoLoopbackError ? error : fail('TV_CONNECTION_FAILED', '本机电视连接未完成');
    this.attempt.error = sanitized; this.onFailure(sanitized.code); this.emit('error', sanitized); this.shutdown();
  }
  shutdown() {
    if (this.readyState === 3) return;
    this.readyState = 3; clearTimeout(this.helloTimer);
    for (const [target, name, handler] of this.handlers) target.off(name, handler); this.handlers = [];
    // Terminated Node ws/TLS objects may emit a final error asynchronously.
    this.raw?.on('error', noop); this.tls?.on('error', noop);
    try { this.raw?.terminate(); } catch {} try { this.tls?.destroy(); } catch {}
    this.emit('close');
  }
  close() { this.shutdown(); }
  terminate() { this.shutdown(); }
}

/** Constructing this owner performs no filesystem or network IO. No client-key
 * import or raw session/keyStore is exposed. ws itself is injected by root. */
export class NativePhotoLoopback {
  #store; #WebSocket; #tlsConnect; #session; #attempt; #initializing; #disposed = false; #generation = 0; #options; #lastError;
  constructor(options = {}) {
    for (const key of ['clientKey', 'client-key', 'keyStore', 'fingerprint', 'host', 'port', 'url', 'endpoint']) if (Object.hasOwn(options, key)) throw fail('EXTERNAL_IDENTITY_REJECTED', '不能导入外部电视凭据或修改本机端点');
    const { directory, WebSocket, tlsConnect = connectTls, appId = APP_ID, appName = '云映', onState = noop, onLeaseChange, helloTimeoutMs = 5000, sessionOptions = {} } = options;
    if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0') || resolve(directory) === parse(resolve(directory)).root) throw fail('PRIVATE_DIRECTORY_REQUIRED', '请提供本 App 专用的绝对授权目录');
    if (typeof WebSocket !== 'function' || typeof tlsConnect !== 'function') throw fail('TRANSPORT_UNAVAILABLE', '当前安装包没有提供 Node WebSocket 适配器');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{2,127}$/.test(appId) || typeof appName !== 'string' || !appName || appName.length > 80 || /[\x00-\x1f\x7f]/.test(appName) || !Number.isFinite(helloTimeoutMs) || helloTimeoutMs < 1000 || helloTimeoutMs > 10000) throw fail('INVALID_OPTIONS', '本机电视连接参数无效');
    for (const key of ['createSocket', 'keyStore', 'onState', 'onLeaseChange']) if (Object.hasOwn(sessionOptions, key)) throw fail('EXTERNAL_IDENTITY_REJECTED', '不能覆盖本机电视身份适配');
    this.#store = new IdentityStore(resolve(directory), appId); this.#WebSocket = WebSocket; this.#tlsConnect = tlsConnect;
    this.#options = { hello: { appId, appName }, onState, onLeaseChange, helloTimeoutMs, sessionOptions };
  }
  snapshot() { return { ...(this.#session?.snapshot() || { state: 'disconnected', paired: false, hasSavedKey: false, session: null }), tlsVerified: Boolean(this.#attempt?.tlsVerified && this.#attempt.socket?.readyState === 1 && !this.#attempt.cancelled), ...(this.#lastError ? { errorCode: this.#lastError } : {}), disposed: this.#disposed }; }
  connect({ allowPairing = false } = {}) {
    if (this.#disposed) return Promise.reject(fail('DISPOSED', '本机照片适配器已销毁'));
    if (this.#initializing) return this.#initializing;
    if (this.#session?.snapshot().paired) return Promise.resolve(this.snapshot());
    if (this.#session?.snapshot().session) return Promise.reject(fail('VIEWER_STILL_OWNED', '请先结束本 App 已持有的照片会话'));
    const generation = this.#generation;
    const operation = (async () => {
      await this.#session?.dispose();
      if (this.#disposed || generation !== this.#generation) throw fail('CANCELLED', '本机电视连接已取消');
      const attempt = { allowPairing: allowPairing === true, cancelled: false, tlsVerified: false, helloVerified: false, record: null };
      this.#attempt = attempt; this.#lastError = null;
      const emit = () => { try { this.#options.onState(this.snapshot()); } catch {} };
      const storeOperation = async operation => {
        try { return await operation(); }
        catch (error) { const sanitized = error instanceof NativePhotoLoopbackError ? error : fail('PRIVATE_STORE_FAILED', '本机电视私有授权存储不可用'); attempt.error = sanitized; this.#lastError = sanitized.code; throw sanitized; }
      };
      const session = new NativePhotoSession({ ...this.#options.sessionOptions,
        onState: emit, onLeaseChange: this.#options.onLeaseChange,
        keyStore: { load: () => storeOperation(() => this.#store.load(attempt)), save: key => storeOperation(() => this.#store.save(attempt, key)) },
        createSocket: endpoint => {
          active(attempt);
          const socket = new VerifiedSocket({ endpoint, WebSocket: this.#WebSocket, tlsConnect: this.#tlsConnect, attempt, store: this.#store, hello: this.#options.hello, helloTimeoutMs: this.#options.helloTimeoutMs, onFailure: code => { this.#lastError = code; } }); attempt.socket = socket; return socket;
        },
      });
      this.#session = session;
      try { await session.connect({ allowPairing: attempt.allowPairing }); active(attempt); return this.snapshot(); }
      catch (error) { session.disconnect(); if (attempt.cancelled) throw fail('CANCELLED', '本机电视连接已取消'); throw attempt.error || error; }
    })();
    this.#initializing = operation;
    operation.finally(() => { if (this.#initializing === operation) this.#initializing = null; }).catch(noop);
    return operation;
  }
  async open(url, photo, { allowPairing = false } = {}) {
    if (typeof this.#options.onLeaseChange !== 'function') throw fail('ACTIVITY_REQUIRED', '系统查看前需接入有期限的照片代理 Activity');
    await this.connect({ allowPairing }); if (this.#disposed) throw fail('DISPOSED', '本机照片适配器已销毁');
    await this.#session.open(url, photo); return this.snapshot();
  }
  async close(reason = 'user') {
    if (this.#initializing) {
      ++this.#generation; if (this.#attempt) { this.#attempt.cancelled = true; this.#attempt.socket?.terminate(); }
      this.#session?.disconnect(); await this.#initializing.catch(noop); return this.snapshot();
    }
    await this.#session?.close(reason); return this.snapshot();
  }
  async dispose() {
    this.#disposed = true;
    try { await this.close('dispose'); await this.#session?.dispose(); }
    finally { ++this.#generation; if (this.#attempt) { this.#attempt.cancelled = true; this.#attempt.socket?.terminate(); } }
  }
}

export const createNativePhotoLoopback = options => new NativePhotoLoopback(options);
