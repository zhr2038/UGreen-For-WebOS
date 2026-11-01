import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {prepareNativeWorkerRuntime} from '../lib/native-runtime.mjs';
const project=dirname(dirname(fileURLToPath(import.meta.url))),posix=process.platform==='linux'&&process.getuid()>0;
test('real Linux runtime prepares all public assets twice with exec modes before refusing absent proprietary SDK',{skip:!posix},async t=>{
 const base=await fs.mkdtemp(join(tmpdir(),'cloudframe-native-runtime-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));await fs.chmod(base,0o700);const sdkDir=join(base,'native-sdk');await fs.mkdir(sdkDir,{mode:0o700});
 const runtimeManifest=JSON.parse(await fs.readFile(join(project,'third-party/AOSP-RUNTIME-PROVENANCE.json'),'utf8')),workerManifest=JSON.parse(await fs.readFile(join(project,'native/worker-manifest.json'),'utf8'));const dir=join(base,'native-runtime');
 const options={dir,assetDir:join(project,'assets/native-runtime-armv7'),workerDir:join(project,'assets/native-worker-armv7'),sdkDir,runtimeManifest,workerManifest};
 for(let attempt=0;attempt<2;attempt++){
  // PrivateState intentionally wraps missing source IO; public asset pins and modes below prove this reached the SDK boundary.
  assert.deepEqual(await fs.readdir(sdkDir),[]);await assert.rejects(prepareNativeWorkerRuntime(options),{code:'PRIVATE_STATE_IO'});
  assert.deepEqual((await fs.readdir(dir)).sort(),[...Object.keys(runtimeManifest.files),'p2p-connect-worker'].sort());assert.equal((await fs.stat(dir)).mode&0o777,0o700);
  for(const [name,pin]of [...Object.entries(runtimeManifest.files),['p2p-connect-worker',workerManifest]]){const bytes=await fs.readFile(join(dir,name)),stat=await fs.stat(join(dir,name));assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256);assert.equal(stat.uid,process.getuid());assert.equal(stat.nlink,1);assert.equal(stat.mode&0o777,['linker','p2p-connect-worker'].includes(name)?0o700:0o600);}
 }
});
