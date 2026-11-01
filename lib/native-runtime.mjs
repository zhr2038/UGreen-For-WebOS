import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createPrivateState} from './private-state.mjs';
import {NATIVE_SDK_SOURCE} from './native-provision.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error('原生运行环境未通过检查'),{code});
const names=['linker','libc.so','libdl.so','libm.so','liblog.so','libz.so','libstdc++.so'];
async function sourceBytes(path,pin){
 const before=await fs.lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.size!==pin.size)throw fail('NATIVE_ASSET_UNSAFE');
 const handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{
  const item=await handle.stat();if(item.dev!==before.dev||item.ino!==before.ino||item.size!==pin.size)throw fail('NATIVE_ASSET_REPLACED');
  const bytes=await handle.readFile();if(bytes.length!==pin.size||hash(bytes)!==pin.sha256)throw fail('NATIVE_ASSET_HASH');return bytes;
 }finally{await handle.close();}
}
/** Inputs are owning-service paths, never HTTP/UI fields. No SDK download here. */
export async function prepareNativeWorkerRuntime({dir,assetDir,workerDir,sdkDir,runtimeManifest,workerManifest,signal,uid=process.getuid?.()}={}){
 if(process.platform!=='linux'||!Number.isInteger(uid)||uid<1||uid!==process.getuid()||dir!==resolve(dir)||basename(dir)!=='native-runtime'||![assetDir,workerDir,sdkDir].every(p=>typeof p==='string'&&p===resolve(p)))throw fail('NATIVE_RUNTIME_CONTEXT');
 if(!runtimeManifest?.files||workerManifest?.protocol!=='CFUGW002'||workerManifest?.name!=='p2p-connect-worker')throw fail('NATIVE_RUNTIME_MANIFEST');
 const files=[...names.map(name=>({name,...runtimeManifest.files[name],source:join(assetDir,name)})),{...workerManifest,source:join(workerDir,workerManifest.name)},...NATIVE_SDK_SOURCE.entries.map(pin=>({name:pin.name,size:pin.bytes,sha256:pin.sha256,source:join(sdkDir,pin.name)}))];
 if(files.some(p=>!Number.isSafeInteger(p.size)||p.size<1||p.size>8*1024*1024||!/^[a-f0-9]{64}$/.test(p.sha256||'')))throw fail('NATIVE_RUNTIME_MANIFEST');
 const store=createPrivateState({dir,trustedDir:dir,uid,files:files.map(p=>p.name)});
 const active=()=>{if(signal?.aborted)throw fail('NATIVE_CANCELLED');};
 return store.serialized(async root=>{
  const allowed=new Set(files.map(pin=>pin.name));if((await fs.readdir(root.anchor)).some(name=>!allowed.has(name)))throw fail('NATIVE_RUNTIME_UNEXPECTED_FILE');
  for(const pin of files){active();let entry=await store.openEntry(root,pin.name);
   if(!entry){
    const bytes=await sourceBytes(pin.source,pin);active();const temporary='.'+pin.name+'-'+randomUUID()+'.tmp';let handle,identity;
    try{
     handle=await fs.open(store.entryPath(root,temporary),constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
     const stat=await handle.stat({bigint:true});identity={dev:stat.dev,ino:stat.ino};store.file(stat);await handle.chmod(0o600);await handle.writeFile(bytes);await handle.sync();active();await store.checkRoot(root);await store.checkEntry(root,temporary,identity);
     await fs.link(store.entryPath(root,temporary),store.entryPath(root,pin.name));await store.unlinkOwned(root,temporary,identity);
    }finally{bytes.fill(0);await handle?.close();if(identity)await store.unlinkOwned(root,temporary,identity);}
    entry=await store.openEntry(root,pin.name);
   }
   if(!entry)throw fail('NATIVE_RUNTIME_MISSING');
   try{const value=await store.readOpened(root,pin.name,entry,pin.size);if(value.bytes.length!==pin.size||hash(value.bytes)!==pin.sha256)throw fail('NATIVE_RUNTIME_HASH');
    if(['linker','p2p-connect-worker'].includes(pin.name)){await entry.handle.chmod(0o700);const stat=await entry.handle.stat({bigint:true});if((stat.mode&0o7777n)!==0o700n)throw fail('NATIVE_RUNTIME_EXEC_MODE');}
   }finally{await entry.handle.close();}
  }
  active();await store.checkRoot(root);return Object.freeze({directory:dir,uid,workerSha256:workerManifest.sha256});
 });
}
