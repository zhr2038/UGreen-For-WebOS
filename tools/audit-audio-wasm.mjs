import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const hash = b => createHash('sha256').update(b).digest('hex');
const normalizeLf = b => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');

export async function auditAudioWasm() {
  const provenancePath = join(root, 'assets/audio-compat/AUDIO-WASM-PROVENANCE.json');
  const wasmPath = join(root, 'assets/audio-compat/audio-compat.wasm');
  const sourcePath = join(root, 'native/audio-compat.c');
  const scriptPath = join(root, 'native/build-audio-wasm.sh');
  const lgplPath = join(root, 'third-party/FFMPEG-LGPL-2.1.txt');
  const noticePath = join(root, 'third-party/AUDIO-COMPAT-NOTICES.md');

  const [provenanceRaw, wasm, source, script, lgpl, notice] = await Promise.all([
    readFile(provenancePath, 'utf8'),
    readFile(wasmPath),
    readFile(sourcePath),
    readFile(scriptPath),
    readFile(lgplPath, 'utf8'),
    readFile(noticePath, 'utf8'),
  ]);

  const provenance = JSON.parse(provenanceRaw);
  if (provenance.format !== 'cloudframe.audio-compat-wasm.v1') throw new Error('AUDIO_WASM_PROVENANCE_FORMAT');
  if (provenance.license !== 'LGPL-2.1' || provenance.gplEnabled !== false || provenance.nonfreeEnabled !== false) {
    throw new Error('AUDIO_WASM_LICENSE_VIOLATION');
  }
  if (!wasm.subarray(0, 8).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))) {
    throw new Error('AUDIO_WASM_MAGIC_INVALID');
  }
  if (wasm.length !== provenance.wasmBytes || hash(wasm) !== provenance.wasmSha256) {
    throw new Error('AUDIO_WASM_HASH_MISMATCH');
  }
  const sourceHash = hash(source), sourceLfHash = hash(normalizeLf(source));
  if (provenance.sourceSha256 !== sourceHash && provenance.sourceSha256 !== sourceLfHash) {
    throw new Error('AUDIO_WASM_SOURCE_MISMATCH');
  }
  const scriptHash = hash(script), scriptLfHash = hash(normalizeLf(script));
  if (provenance.buildScriptSha256 !== scriptHash && provenance.buildScriptSha256 !== scriptLfHash) {
    throw new Error('AUDIO_WASM_SCRIPT_MISMATCH');
  }
  if (!lgpl.includes('GNU LESSER GENERAL PUBLIC LICENSE') || !notice.includes('LGPL-2.1')) {
    throw new Error('AUDIO_WASM_NOTICE_INVALID');
  }
  const mod = new WebAssembly.Module(wasm);
  if (!WebAssembly.Module.exports(mod).some(e => e.name === 'ca_transcode_gop' && e.kind === 'function')) {
    throw new Error('AUDIO_WASM_EXPORT_MISSING');
  }
  return provenance;
}

if (process.argv[1] && resolve(process.argv[1]) === join(root, 'tools/audit-audio-wasm.mjs')) {
  console.log(JSON.stringify(await auditAudioWasm()));
}
