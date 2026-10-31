import {createHash, randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const project = resolve(import.meta.dirname, '..');
export const NATIVE_RUNTIME_FILES = Object.freeze(['linker', 'libc.so', 'libdl.so', 'libm.so', 'liblog.so', 'libz.so', 'libstdc++.so']);
const noticeName = 'NOTICE.AOSP.txt', provenanceName = 'AOSP-RUNTIME-PROVENANCE.json';
const outputNames = Object.freeze([...NATIVE_RUNTIME_FILES, noticeName, provenanceName]);
const maximumFile = 8 * 1024 * 1024, maximumTotal = 16 * 1024 * 1024;
const fail = (code, file) => Object.assign(new Error(code), {code, ...(file && outputNames.includes(file) ? {file} : {})});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const pathEqual = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

function manifestEntries(manifest, notice, provenance) {
  if (!plain(manifest) || manifest.format !== 'cloudframe.aosp-runtime-provenance.v1' || manifest.preciseSourceManifestVerified !== false || manifest.proprietarySdkIncluded !== false || !plain(manifest.files) || Object.keys(manifest.files).length !== NATIVE_RUNTIME_FILES.length || Object.keys(manifest.files).some(name => !NATIVE_RUNTIME_FILES.includes(name))) throw fail('NATIVE_RUNTIME_MANIFEST_INVALID');
  const pins = NATIVE_RUNTIME_FILES.map(name => {
    const pin = manifest.files[name];
    if (!plain(pin) || !Number.isSafeInteger(pin.size) || pin.size < 1 || pin.size > maximumFile || !/^[a-f0-9]{64}$/.test(pin.sha256 || '')) throw fail('NATIVE_RUNTIME_MANIFEST_INVALID');
    return {name, size: pin.size, sha256: pin.sha256};
  });
  if (pins.reduce((size, pin) => size + pin.size, 0) > maximumTotal || !Number.isSafeInteger(manifest.selectedNoticeBytes) || manifest.selectedNoticeBytes < 1 || manifest.selectedNoticeBytes > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(manifest.selectedNoticeSha256 || '')) throw fail('NATIVE_RUNTIME_MANIFEST_INVALID');
  if (notice.length !== manifest.selectedNoticeBytes || hash(notice) !== manifest.selectedNoticeSha256) throw fail('NATIVE_RUNTIME_NOTICE_MISMATCH', noticeName);
  return [...pins, {name: noticeName, size: notice.length, sha256: hash(notice), bytes: notice}, {name: provenanceName, size: provenance.length, sha256: hash(provenance), bytes: provenance}];
}

async function regularBytes(path, {size, sha256, name}, {target = false, maximum = maximumFile} = {}) {
  let before;
  try { before = await fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || target && before.nlink !== 1) throw fail('NATIVE_RUNTIME_FILE_UNSAFE', name);
  if (before.size !== size || size > maximum) throw fail('NATIVE_RUNTIME_SIZE_MISMATCH', name);
  let file;
  try {
    file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== size || target && opened.nlink !== 1) throw fail('NATIVE_RUNTIME_FILE_UNSAFE', name);
    const bytes = Buffer.alloc(size + 1); let length = 0;
    while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length !== size || (await file.stat()).size !== size) throw fail('NATIVE_RUNTIME_SIZE_MISMATCH', name);
    const result = bytes.subarray(0, size);
    if (sha256 != null && hash(result) !== sha256) throw fail('NATIVE_RUNTIME_HASH_MISMATCH', name);
    return result;
  } finally { await file?.close(); }
}

async function metadata(path, maximum) {
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) throw fail('NATIVE_RUNTIME_METADATA_INVALID');
  return regularBytes(path, {name: '', size: stat.size}, {maximum});
}

async function directory(path) {
  let stat; try { stat = await fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !pathEqual(await fs.realpath(path), path)) throw fail('NATIVE_RUNTIME_DIRECTORY_UNSAFE');
  return true;
}

function contained(parent, child) { const path = relative(parent, child); return path && !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep); }

async function prepare({sourceDir, verifyOnly = false}, {targetDir, trustedRoot, entries}) {
  if (typeof verifyOnly !== 'boolean' || sourceDir !== undefined && (typeof sourceDir !== 'string' || !sourceDir.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(sourceDir))) throw fail('NATIVE_RUNTIME_OPTIONS_INVALID');
  const root = resolve(await fs.realpath(trustedRoot)), target = resolve(targetDir), parent = dirname(target);
  if (!contained(root, target) || !contained(root, parent) || !await directory(parent)) throw fail('NATIVE_RUNTIME_DIRECTORY_UNSAFE');
  const present = await directory(target);
  if (present && (await fs.readdir(target)).some(name => !outputNames.includes(name))) throw fail('NATIVE_RUNTIME_TARGET_UNEXPECTED');
  const existing = new Map();
  // Reject every damaged/unsafe target before copying anything. No overwrite.
  for (const entry of entries) existing.set(entry.name, present ? await regularBytes(join(target, entry.name), entry, {target: true}) : null);
  let source;
  if (sourceDir !== undefined) {
    source = resolve(sourceDir);
    if (!await directory(source)) throw fail('NATIVE_RUNTIME_SOURCE_REQUIRED');
  }
  let sourceVerified = 0;
  for (const entry of entries) {
    if (!NATIVE_RUNTIME_FILES.includes(entry.name)) continue;
    if (source) {
      const bytes = await regularBytes(join(source, entry.name), entry);
      if (!bytes) throw fail('NATIVE_RUNTIME_SOURCE_MISSING', entry.name);
      entry.bytes = bytes; sourceVerified++;
    } else if (!existing.get(entry.name)) throw fail('NATIVE_RUNTIME_SOURCE_REQUIRED', entry.name);
  }
  if (verifyOnly && entries.some(entry => !existing.get(entry.name))) throw fail('NATIVE_RUNTIME_TARGET_MISSING');
  let copied = 0;
  if (!verifyOnly) {
    if (!present) { try { await fs.mkdir(target, {mode: 0o755}); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    if (!await directory(target)) throw fail('NATIVE_RUNTIME_DIRECTORY_UNSAFE');
    for (const entry of entries) {
      if (existing.get(entry.name)) continue;
      const temporary = join(parent, '.native-runtime-' + randomBytes(16).toString('hex') + '-' + entry.name + '.tmp');
      let file, ownsTemporary = false;
      try {
        file = await fs.open(temporary, 'wx', entry.name === 'linker' ? 0o755 : 0o644); ownsTemporary = true;
        await file.writeFile(entry.bytes); await file.chmod(entry.name === 'linker' ? 0o755 : 0o644); await file.sync(); await file.close(); file = null;
        await regularBytes(temporary, entry, {target: true});
        try { await fs.link(temporary, join(target, entry.name)); copied++; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally { await file?.close(); if (ownsTemporary) await fs.unlink(temporary); }
      await regularBytes(join(target, entry.name), entry, {target: true});
    }
  }
  // Verify every final file, not merely the source or completed write calls.
  for (const entry of entries) if (!await regularBytes(join(target, entry.name), entry, {target: true})) throw fail('NATIVE_RUNTIME_TARGET_MISSING', entry.name);
  if ((await fs.readdir(target)).some(name => !outputNames.includes(name))) throw fail('NATIVE_RUNTIME_TARGET_UNEXPECTED');
  const result = {ready: true, runtimeFiles: NATIVE_RUNTIME_FILES.length, runtimeBytes: entries.filter(entry => NATIVE_RUNTIME_FILES.includes(entry.name)).reduce((sum, entry) => sum + entry.size, 0), copied, cached: entries.length - copied, sourceVerified, targetVerified: entries.length, downloaded: false, preciseSourceManifestVerified: false, files: entries.map(({name, size, sha256}) => ({name, size, sha256}))};
  Object.defineProperty(result, 'directory', {value: target}); return result;
}

/** Public build API. No destination, manifest, hash, URL, or download override. */
export async function prepareNativeRuntime(options = {}) {
  if (!plain(options) || Object.keys(options).some(key => !['sourceDir', 'verifyOnly'].includes(key))) throw fail('NATIVE_RUNTIME_OPTIONS_INVALID');
  const provenance = await metadata(join(project, 'third-party', provenanceName), 64 * 1024);
  let manifest; try { manifest = JSON.parse(provenance.toString('utf8')); } catch { throw fail('NATIVE_RUNTIME_MANIFEST_INVALID'); }
  const notice = await metadata(join(project, 'third-party', 'AOSP-RUNTIME-NOTICES.txt'), 2 * 1024 * 1024);
  const entries = manifestEntries(manifest, notice, provenance);
  return prepare({...options, sourceDir: Object.hasOwn(options, 'sourceDir') ? options.sourceDir : process.env.CF_NATIVE_RUNTIME_SOURCE}, {targetDir: join(project, 'assets', 'native-runtime-armv7'), trustedRoot: project, entries});
}

// Only the Node test process can inject synthetic tiny pins and a temporary
// output. The production function and CLI never accept these inputs.
export const _nativeRuntimeTesting = Object.freeze({
  async prepare(options, {manifest, notice, targetDir, trustedRoot}) {
    if (!process.env.NODE_TEST_CONTEXT) throw fail('NATIVE_RUNTIME_TEST_CONTEXT_REQUIRED');
    const provenance = Buffer.from(JSON.stringify(manifest));
    return prepare(options, {targetDir, trustedRoot, entries: manifestEntries(manifest, notice, provenance)});
  },
});

function cliOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source-dir' && !Object.hasOwn(options, 'sourceDir') && args[i + 1] && !args[i + 1].startsWith('--')) options.sourceDir = args[++i];
    else if (args[i] === '--verify' && !options.verifyOnly) options.verifyOnly = true;
    else throw fail('NATIVE_RUNTIME_OPTIONS_INVALID');
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') console.log('Usage: node tools/prepare-native-runtime.mjs [--source-dir <local-directory>] [--verify]\nMissing runtime files require --source-dir or CF_NATIVE_RUNTIME_SOURCE. No downloads or binary execution.');
  else try { console.log(JSON.stringify(await prepareNativeRuntime(cliOptions(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ready: false, code: error.code?.startsWith('NATIVE_RUNTIME_') ? error.code : 'NATIVE_RUNTIME_IO_FAILED', ...(outputNames.includes(error.file) ? {file: error.file} : {})})); process.exitCode = 1; }
}
