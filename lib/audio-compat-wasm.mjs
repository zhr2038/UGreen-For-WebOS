import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomFillSync } from 'node:crypto';

const moduleDir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const MAX_OUTPUT_BYTES = 192 * 1024 * 1024;
const aborted = () => Object.assign(new DOMException('Audio transcode cancelled', 'AbortError'), { status: 410 });

function findWasmPath() {
  const candidates = [
    join(moduleDir, 'audio-compat.wasm'),
    join(moduleDir, 'assets/audio-compat/audio-compat.wasm'),
    resolve(moduleDir, '../assets/audio-compat/audio-compat.wasm'),
    resolve(process.cwd(), 'assets/audio-compat/audio-compat.wasm'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw Object.assign(new Error('内置兼容音轨解码模块缺失'), { code: 'AUDIO_COMPAT_WASM_MISSING', status: 503 });
}

let compiledModulePromise = null;
async function getCompiledModule() {
  if (!compiledModulePromise) {
    compiledModulePromise = readFile(findWasmPath())
      .then(bytes => WebAssembly.compile(bytes))
      .catch(error => { compiledModulePromise = null; throw error; });
  }
  return compiledModulePromise;
}

function makeInstance(mod, activeIo) {
  let memory = null;
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);

  const wasi = {
    args_get: () => 0,
    args_sizes_get: (argc, argvBufSize) => { view().setUint32(argc, 0, true); view().setUint32(argvBufSize, 0, true); return 0; },
    environ_get: () => 0,
    environ_sizes_get: (count, bufSize) => { view().setUint32(count, 0, true); view().setUint32(bufSize, 0, true); return 0; },
    clock_time_get: (_id, _precision, timePtr) => { view().setBigUint64(timePtr, BigInt(Date.now()) * 1_000_000n, true); return 0; },
    fd_close: () => 0,
    fd_fdstat_get: (_fd, buf) => { bytes().fill(0, buf, buf + 24); return 0; },
    fd_read: (_fd, _iovs, _iovsLen, nread) => { view().setUint32(nread, 0, true); return 0; },
    fd_seek: (_fd, _offset, _whence, newoffset) => { view().setBigUint64(newoffset, 0n, true); return 0; },
    fd_write: (_fd, iovs, iovsLen, nwritten) => {
      const dv = view();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) total += dv.getUint32(iovs + i * 8 + 4, true);
      dv.setUint32(nwritten, total, true);
      return 0;
    },
    random_get: (buf, bufLen) => { randomFillSync(new Uint8Array(memory.buffer, buf, bufLen)); return 0; },
    proc_exit: code => { throw Object.assign(new Error('WASM process exited: ' + code), { exitCode: code }); },
  };

  const env = {
    emscripten_notify_memory_growth: () => {},
    host_read: (ptr, size) => activeIo.read(bytes(), ptr, size),
    host_write: (ptr, size) => activeIo.write(bytes(), ptr, size),
  };

  const imports = {};
  for (const entry of WebAssembly.Module.imports(mod)) {
    imports[entry.module] ||= {};
    if (entry.module === 'wasi_snapshot_preview1' && wasi[entry.name]) imports[entry.module][entry.name] = wasi[entry.name];
    else if (entry.module === 'env' && env[entry.name]) imports[entry.module][entry.name] = env[entry.name];
    else if (entry.kind === 'function') imports[entry.module][entry.name] = () => (entry.name.startsWith('__syscall_') ? -38 : 0);
  }

  return WebAssembly.instantiate(mod, imports).then(instance => {
    memory = instance.exports.memory;
    if (typeof instance.exports._initialize === 'function') instance.exports._initialize();
    return instance;
  });
}

let queueTail = Promise.resolve();

export function isAudioCompatAvailable() {
  try { findWasmPath(); return true; } catch { return false; }
}

/** Transcode one Matroska GOP `[initSegment + clusterBytes]` to an MPEG-TS Buffer via WASM. */
export function transcodeMkvGopToTs({ initSegment, clusterBytes, startMs, endMs, audioTrackIndex = -1, signal } = {}) {
  if (!Buffer.isBuffer(initSegment) || !Buffer.isBuffer(clusterBytes)) throw new TypeError('initSegment and clusterBytes must be Buffers');
  if (signal?.aborted) return Promise.reject(aborted());

  const run = async () => {
    if (signal?.aborted) throw aborted();
    const mod = await getCompiledModule();
    if (signal?.aborted) throw aborted();

    const parts = [initSegment, clusterBytes];
    let partIndex = 0, partOffset = 0;
    const output = [];
    let outputBytes = 0;

    const io = {
      read(memBytes, ptr, size) {
        if (signal?.aborted) return -1;
        let written = 0;
        while (written < size && partIndex < parts.length) {
          const src = parts[partIndex];
          const avail = src.length - partOffset;
          if (avail <= 0) { partIndex++; partOffset = 0; continue; }
          const n = Math.min(avail, size - written);
          memBytes.set(src.subarray(partOffset, partOffset + n), ptr + written);
          written += n;
          partOffset += n;
          if (partOffset >= src.length) { partIndex++; partOffset = 0; }
        }
        return written;
      },
      write(memBytes, ptr, size) {
        if (signal?.aborted || size < 0 || outputBytes + size > MAX_OUTPUT_BYTES) return -1;
        if (size === 0) return 0;
        output.push(Buffer.from(memBytes.subarray(ptr, ptr + size)));
        outputBytes += size;
        return size;
      },
    };

    const instance = await makeInstance(mod, io);
    const fn = instance.exports.ca_transcode_gop;
    if (typeof fn !== 'function') throw Object.assign(new Error('兼容音轨模块入口异常'), { status: 500 });
    const rc = fn(BigInt(Math.max(0, Math.trunc(startMs || 0))), BigInt(Math.max(0, Math.trunc(endMs || 0))), Math.trunc(audioTrackIndex));
    if (signal?.aborted) throw aborted();
    if (rc !== 0 || !outputBytes) throw Object.assign(new Error('电视内置音轨转换未能生成有效分片 (' + rc + ')'), { status: 502 });
    return Buffer.concat(output, outputBytes);
  };

  const task = queueTail.catch(() => {}).then(run);
  queueTail = task.catch(() => {});
  return task;
}
