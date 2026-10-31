import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {NATIVE_RUNTIME_FILES,prepareNativeRuntime,_nativeRuntimeTesting} from '../tools/prepare-native-runtime.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const noticeName='NOTICE.AOSP.txt',provenanceName='AOSP-RUNTIME-PROVENANCE.json';
// No recursive deletion/moving. Only explicitly owned fixture directories are
// inspected, then their individual non-directory children and empty dirs removed.
async function removeFixture(base,dirs){
  const path=resolve(base),under=relative(resolve(tmpdir()),path);assert.ok(under&&!under.startsWith('..'+sep)&&!under.includes(sep)&&under.startsWith('native-runtime-build-'));
  for(const dir of dirs){let stat;try{stat=await fs.lstat(dir);}catch(error){if(error.code==='ENOENT')continue;throw error;}if(stat.isSymbolicLink()){await fs.unlink(dir);continue;}assert.ok(stat.isDirectory());for(const entry of await fs.readdir(dir,{withFileTypes:true})){assert.equal(entry.isDirectory(),false,'Cleanup never descends into an unexpected directory');await fs.unlink(join(dir,entry.name));}await fs.rmdir(dir);}
  await fs.rmdir(base);
}
async function fixture(t,{source=true}={}){
  const base=await fs.mkdtemp(join(tmpdir(),'native-runtime-build-')),sourceDir=join(base,'source'),assets=join(base,'assets'),targetDir=join(assets,'native-runtime-armv7'),outside=join(base,'outside');await fs.mkdir(assets);await fs.mkdir(outside);if(source)await fs.mkdir(sourceDir);
  t.after(()=>removeFixture(base,[targetDir,sourceDir,outside,assets]));
  const notice=Buffer.from('Synthetic complete notice\nAll associated terms preserved exactly.\n'),manifest={format:'cloudframe.aosp-runtime-provenance.v1',preciseSourceManifestVerified:false,proprietarySdkIncluded:false,files:{},selectedNoticeBytes:notice.length,selectedNoticeSha256:hash(notice)},bytes=new Map();
  for(const name of NATIVE_RUNTIME_FILES){const content=Buffer.from('SYNTHETIC_NOT_EXECUTABLE:'+name);bytes.set(name,content);manifest.files[name]={size:content.length,sha256:hash(content)};if(source)await fs.writeFile(join(sourceDir,name),content,{mode:0o640});}
  const internal={manifest,notice,targetDir,trustedRoot:base},prepare=options=>_nativeRuntimeTesting.prepare(options||{},internal);return{base,sourceDir,assets,targetDir,outside,notice,manifest,bytes,internal,prepare};
}

test('copies only seven pinned files and the complete notice/provenance without reading private extras or changing source modes',async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.sourceDir,'libugagentsdk.so'),'synthetic proprietary extra');await fs.writeFile(join(f.sourceDir,'identity.json'),'synthetic private extra');await fs.writeFile(join(f.sourceDir,'worker-5059'),'synthetic private extra');const modes=new Map(await Promise.all(NATIVE_RUNTIME_FILES.map(async name=>[name,(await fs.stat(join(f.sourceDir,name))).mode])));
  const result=await f.prepare({sourceDir:f.sourceDir});assert.equal(result.ready,true);assert.equal(result.runtimeFiles,7);assert.equal(result.sourceVerified,7);assert.equal(result.targetVerified,9);assert.equal(result.copied,9);assert.equal(result.downloaded,false);assert.equal(result.preciseSourceManifestVerified,false);assert.deepEqual((await fs.readdir(f.targetDir)).sort(),[...NATIVE_RUNTIME_FILES,noticeName,provenanceName].sort());
  for(const name of NATIVE_RUNTIME_FILES){const actual=await fs.readFile(join(f.targetDir,name));assert.deepEqual(actual,f.bytes.get(name));assert.equal(hash(actual),f.manifest.files[name].sha256);assert.equal((await fs.stat(join(f.sourceDir,name))).mode,modes.get(name));}
  assert.deepEqual(await fs.readFile(join(f.targetDir,noticeName)),f.notice);assert.deepEqual(JSON.parse(await fs.readFile(join(f.targetDir,provenanceName),'utf8')),f.manifest);assert.equal(JSON.stringify(result).includes(f.base),false);if(process.platform!=='win32')assert.equal((await fs.stat(join(f.targetDir,'linker'))).mode&0o777,0o755);
});

test('verified cached assets work without a source and a missing file is filled alone from an explicit source',async t=>{
  const f=await fixture(t);await f.prepare({sourceDir:f.sourceDir});const cached=await f.prepare();assert.equal(cached.copied,0);assert.equal(cached.cached,9);assert.equal(cached.sourceVerified,0);await fs.unlink(join(f.targetDir,'libm.so'));const missing=await f.prepare({sourceDir:f.sourceDir});assert.equal(missing.copied,1);assert.equal(missing.targetVerified,9);
});

test('a missing runtime requires an explicit local source and no output is created or downloaded',async t=>{
  const f=await fixture(t);await assert.rejects(f.prepare(),{code:'NATIVE_RUNTIME_SOURCE_REQUIRED'});await assert.rejects(fs.stat(f.targetDir),{code:'ENOENT'});for(const sourceDir of ['','https://example.invalid/runtime','file:///private/runtime',null])await assert.rejects(f.prepare({sourceDir}),{code:'NATIVE_RUNTIME_OPTIONS_INVALID'});
});

test('all source sizes and hashes are verified before publication, including a damaged last file',async t=>{
  for(const change of ['size','hash'])await t.test(change,async t=>{const f=await fixture(t),name=NATIVE_RUNTIME_FILES.at(-1),bytes=Buffer.from(f.bytes.get(name));if(change==='hash')bytes[0]^=1;await fs.writeFile(join(f.sourceDir,name),change==='size'?Buffer.concat([bytes,Buffer.from([0])]):bytes);await assert.rejects(f.prepare({sourceDir:f.sourceDir}),{code:change==='size'?'NATIVE_RUNTIME_SIZE_MISMATCH':'NATIVE_RUNTIME_HASH_MISMATCH',file:name});await assert.rejects(fs.stat(f.targetDir),{code:'ENOENT'});assert.deepEqual(await fs.readdir(f.assets),[]);});
});

test('bad existing runtime/notice files fail instead of being overwritten',async t=>{
  for(const name of ['libc.so',noticeName])await t.test(name,async t=>{const f=await fixture(t);await f.prepare({sourceDir:f.sourceDir});const path=join(f.targetDir,name),bytes=await fs.readFile(path);bytes[0]^=1;await fs.writeFile(path,bytes);await assert.rejects(f.prepare({sourceDir:f.sourceDir}),{code:'NATIVE_RUNTIME_HASH_MISMATCH',file:name});assert.deepEqual(await fs.readFile(path),bytes);});
});

test('the selected complete notice must match its recorded size/hash and unknown manifest paths are rejected',async t=>{
  const f=await fixture(t);await assert.rejects(_nativeRuntimeTesting.prepare({sourceDir:f.sourceDir},{...f.internal,notice:Buffer.from('truncated')}),{code:'NATIVE_RUNTIME_NOTICE_MISMATCH'});const extra=structuredClone(f.manifest);extra.files['../private.so']={size:1,sha256:'a'.repeat(64)};await assert.rejects(_nativeRuntimeTesting.prepare({sourceDir:f.sourceDir},{...f.internal,manifest:extra}),{code:'NATIVE_RUNTIME_MANIFEST_INVALID'});await assert.rejects(fs.stat(f.targetDir),{code:'ENOENT'});
});

test('source and destination junctions cannot redirect I/O outside the intended directories',async t=>{
  for(const kind of ['source','target'])await t.test(kind,async t=>{const f=await fixture(t,{source:kind!=='source'}),path=kind==='source'?f.sourceDir:f.targetDir;await fs.writeFile(join(f.outside,'marker'),'owned synthetic marker');await fs.symlink(f.outside,path,process.platform==='win32'?'junction':'dir');await assert.rejects(f.prepare({sourceDir:f.sourceDir}),{code:'NATIVE_RUNTIME_DIRECTORY_UNSAFE'});assert.deepEqual(await fs.readdir(f.outside),['marker']);});
});

test('destination hardlinks and unexpected private SDK/worker files are rejected without changing outside contents',async t=>{
  const f=await fixture(t);await f.prepare({sourceDir:f.sourceDir});await fs.unlink(join(f.targetDir,'libc.so'));await fs.link(join(f.sourceDir,'libc.so'),join(f.targetDir,'libc.so'));await assert.rejects(f.prepare({sourceDir:f.sourceDir}),{code:'NATIVE_RUNTIME_FILE_UNSAFE'});assert.deepEqual(await fs.readFile(join(f.sourceDir,'libc.so')),f.bytes.get('libc.so'));
  const g=await fixture(t);await g.prepare({sourceDir:g.sourceDir});await fs.writeFile(join(g.targetDir,'libugagentsdk.so'),'synthetic unapproved file');await assert.rejects(g.prepare(),{code:'NATIVE_RUNTIME_TARGET_UNEXPECTED'});assert.equal(await fs.readFile(join(g.targetDir,'libugagentsdk.so'),'utf8'),'synthetic unapproved file');
});

test('verify-only does not fill missing files or write a directory, and validates a complete cache',async t=>{
  const f=await fixture(t);await assert.rejects(f.prepare({sourceDir:f.sourceDir,verifyOnly:true}),{code:'NATIVE_RUNTIME_TARGET_MISSING'});await assert.rejects(fs.stat(f.targetDir),{code:'ENOENT'});await f.prepare({sourceDir:f.sourceDir});const before=(await fs.stat(join(f.targetDir,'linker'))).mtimeMs,result=await f.prepare({verifyOnly:true});assert.equal(result.copied,0);assert.equal((await fs.stat(join(f.targetDir,'linker'))).mtimeMs,before);
});

test('production API/CLI have no manifest, hash, URL or destination override; test injection cannot run in a normal Node process',async()=>{
  for(const options of [{manifest:{}},{targetDir:'somewhere'},{hash:'a'.repeat(64)},{sourceDir:null}])await assert.rejects(prepareNativeRuntime(options),{code:'NATIVE_RUNTIME_OPTIONS_INVALID'});
  const cli=fileURLToPath(new URL('../tools/prepare-native-runtime.mjs',import.meta.url));for(const flag of ['--manifest','--out-dir','--url','--sha256']){const result=spawnSync(process.execPath,[cli,flag,'SYNTHETIC_ONLY'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,1);assert.match(result.stderr,/NATIVE_RUNTIME_OPTIONS_INVALID/);}
  const env={...process.env};delete env.NODE_TEST_CONTEXT;const code="import { _nativeRuntimeTesting } from "+JSON.stringify(new URL('../tools/prepare-native-runtime.mjs',import.meta.url).href)+";try{await _nativeRuntimeTesting.prepare({},{});}catch(e){console.log(e.code);}";const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true,env});assert.equal(result.status,0);assert.match(result.stdout,/NATIVE_RUNTIME_TEST_CONTEXT_REQUIRED/);
});

test('bundled production assets verify offline and CF_NATIVE_RUNTIME_SOURCE is checked rather than used as a hash override',async t=>{
  const cli=fileURLToPath(new URL('../tools/prepare-native-runtime.mjs',import.meta.url)),env={...process.env};delete env.CF_NATIVE_RUNTIME_SOURCE;
  const cached=spawnSync(process.execPath,[cli,'--verify'],{encoding:'utf8',windowsHide:true,env});assert.equal(cached.status,0,cached.stderr);const report=JSON.parse(cached.stdout);assert.equal(report.runtimeFiles,7);assert.equal(report.targetVerified,9);assert.equal(report.sourceVerified,0);assert.equal(report.copied,0);assert.equal(report.downloaded,false);assert.equal(report.files.find(file=>file.name===noticeName).size,345480);
  const f=await fixture(t),changed=spawnSync(process.execPath,[cli,'--verify'],{encoding:'utf8',windowsHide:true,env:{...env,CF_NATIVE_RUNTIME_SOURCE:f.sourceDir}});assert.equal(changed.status,1);assert.match(changed.stderr,/NATIVE_RUNTIME_SIZE_MISMATCH/);assert.match(changed.stderr,/"file":"linker"/);
});
