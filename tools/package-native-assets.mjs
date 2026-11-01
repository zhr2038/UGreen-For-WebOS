import {mkdir,copyFile,readFile,readdir,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareNativeRuntime,NATIVE_RUNTIME_FILES} from './prepare-native-runtime.mjs';
const root=resolve(import.meta.dirname,'..'),hash=b=>createHash('sha256').update(b).digest('hex');
/** Build-time only. Proprietary SDK files are forbidden in the package. */
export async function packageNativeAssets(serviceDir){
 await prepareNativeRuntime({verifyOnly:true});
 const manifest=JSON.parse(await readFile(join(root,'native/worker-manifest.json'),'utf8'));
 const source=await readFile(join(root,'native/worker.c')),header=await readFile(join(root,'native/worker-got.h'));
 const worker=await readFile(join(root,'assets/native-worker-armv7/p2p-connect-worker'));
 if(manifest.format!=='cloudframe.native-worker.v1'||manifest.protocol!=='CFUGW002'||manifest.size!==worker.length||manifest.sha256!==hash(worker)||manifest.sourceSha256!==hash(source)||manifest.headerSha256!==hash(header)||worker.readUInt32LE(0)!==0x464c457f||worker[4]!==1||worker.readUInt16LE(18)!==40)throw new Error('NATIVE_WORKER_BUILD_MISMATCH');
 const target=join(serviceDir,'native-assets');await mkdir(target,{recursive:true});
 const allowed=[...NATIVE_RUNTIME_FILES,'NOTICE.AOSP.txt','AOSP-RUNTIME-PROVENANCE.json','p2p-connect-worker','worker-manifest.json'];
 if((await readdir(target)).some(name=>!allowed.includes(name)))throw new Error('NATIVE_PACKAGE_UNEXPECTED_FILE');
 for(const name of [...NATIVE_RUNTIME_FILES,'NOTICE.AOSP.txt','AOSP-RUNTIME-PROVENANCE.json'])await copyFile(join(root,'assets/native-runtime-armv7',name),join(target,name));
 await copyFile(join(root,'assets/native-worker-armv7/p2p-connect-worker'),join(target,'p2p-connect-worker'));
 await copyFile(join(root,'native/worker-manifest.json'),join(target,'worker-manifest.json'));
 for(const name of allowed){const stat=await lstat(join(target,name));if(!stat.isFile()||stat.isSymbolicLink())throw new Error('NATIVE_PACKAGE_UNSAFE_FILE');}
 return {files:allowed.length,workerSha256:manifest.sha256,proprietarySdkIncluded:false};
}
