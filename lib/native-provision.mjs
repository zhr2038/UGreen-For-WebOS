import https from 'node:https';
import * as filesystem from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {basename,join} from 'node:path';
import {createPrivateState,PrivateStateError} from './private-state.mjs';

const metadataUrl='https://api-zh.ugnas.com/api/system/v1/ua/temp/link?appType=client&id=657';
const host='dl-cn.ugnas.com',apkPath='/appVer/android/4421/Tv121044211027cir.apk',apkBytes=135984880,apkMd5='9a6a6091c710073d4910c4edbce2b7aa';
const entries=Object.freeze([
  Object.freeze({entry:'lib/armeabi-v7a/libugagentsdk.so',name:'libugagentsdk.so',bytes:4060832,compressedBytes:4060832,compression:0,localHeaderOffset:86667404,headerBytes:3956,crc32:3254080413,headerSha256:'90b76ce4ebc4be237c3fd988b0bb1e70d69c9917fb788d091df827cfd3429332',sha256:'ff124cd20c40c0b8f462615214f9ab2c7087b09dac8fb70be95238969ba45fc0'}),
  Object.freeze({entry:'lib/armeabi-v7a/libpgJniTunnel.so',name:'libpgJniTunnel.so',bytes:1306764,compressedBytes:1306764,compression:0,localHeaderOffset:85355440,headerBytes:5200,crc32:726231474,headerSha256:'5eb69635884d70d0caa0a44a789f6c98dabfff0e8ab28b1c7c041c920bd9bdc0',sha256:'cb951e736079ad5f8cf5d30732ae2659ae2fc9ecda1c1040c37a3702ebb9c0b9'}),
]);
export const NATIVE_SDK_SOURCE=Object.freeze({metadataUrl,host,path:apkPath,apkBytes,apkMd5,apkSha256:'f7888f6bb170d4725943a7bb5d95839459d45bfba63544516332c3c7a733f28a',entries});
const flights=new Map(),states=new Map(),hash=value=>createHash('sha256').update(value).digest('hex');
export class NativeProvisionError extends Error{constructor(code){super('官方原生组件未准备完成，现有连接可继续使用');this.name='NativeProvisionError';this.code=code;this.status=503;}}
const fail=code=>new NativeProvisionError(code),cancelled=()=>Object.assign(fail('NATIVE_PROVISION_CANCELLED'),{name:'AbortError'});
function active(signal){if(signal?.aborted)throw signal.reason?.code==='NATIVE_PROVISION_TIMEOUT'?fail('NATIVE_PROVISION_TIMEOUT'):cancelled();}
function pinned(list){
  if(!Array.isArray(list)||list.length!==2)throw fail('NATIVE_PROVISION_OPTIONS');
  return list.map((value,i)=>{const original=entries[i];if(!value||typeof value!=='object'||value.entry!==original.entry||value.name!==original.name||![value.bytes,value.compressedBytes,value.localHeaderOffset,value.headerBytes,value.crc32].every(Number.isSafeInteger)||value.bytes<1||value.bytes>8*1024*1024||value.compressedBytes<1||value.compressedBytes>8*1024*1024||value.headerBytes<30+Buffer.byteLength(value.entry)||value.headerBytes>8192||value.localHeaderOffset<0||value.localHeaderOffset+value.headerBytes+value.compressedBytes>apkBytes||value.crc32<0||value.crc32>0xffffffff||![0,8].includes(value.compression)||!/^([a-f0-9]{64})$/.test(value.sha256)||!/^([a-f0-9]{64})$/.test(value.headerSha256))throw fail('NATIVE_PROVISION_OPTIONS');return Object.freeze({...value});});
}
function downloadUrl(value){
  let url;try{url=new URL(value);}catch{throw fail('NATIVE_SOURCE_CHANGED');}
  if(url.protocol!=='https:'||url.hostname!==host||url.port&&url.port!=='443'||url.pathname!==apkPath||url.username||url.password||url.hash||[...url.searchParams.keys()].some(k=>!['timestamp','signature'].includes(k))||url.searchParams.getAll('timestamp').length!==1||url.searchParams.getAll('signature').length!==1||!/^\d{1,20}$/.test(url.searchParams.get('timestamp')||'')||!/^[A-Za-z0-9+/_=-]{16,1024}$/.test(url.searchParams.get('signature')||''))throw fail('NATIVE_SOURCE_CHANGED');return url;
}
function requestHttps({url,headers,signal,timeout}){
  return new Promise((resolve,reject)=>{
    const request=https.request(url,{method:'GET',headers,signal,rejectUnauthorized:true},resolve);
    request.setTimeout(timeout,()=>request.destroy(fail('NATIVE_PROVISION_TIMEOUT')));request.once('error',()=>reject(signal.aborted?cancelled():fail('NATIVE_PROVISION_NETWORK')));request.end();
  });
}
function guardedRequest(request,options){
  const signal=options.signal;return new Promise((resolve,reject)=>{
    let done=false;const finish=(error,response)=>{if(done){response?.destroy?.();return;}done=true;signal.removeEventListener('abort',abort);error?reject(error):resolve(response);};
    const abort=()=>{let error;try{active(signal);}catch(value){error=value;}finish(error||cancelled());};signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
    Promise.resolve().then(()=>request(options)).then(response=>finish(null,response),error=>finish(error));
  });
}
async function body(response,limit,signal,progress){
  const chunks=[];let bytes=0;const abort=()=>response.destroy?.();signal.addEventListener('abort',abort,{once:true});
  try{for await(const value of response){active(signal);const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);bytes+=chunk.length;if(bytes>limit)throw fail('NATIVE_PROVISION_RESPONSE_LIMIT');chunks.push(chunk);progress(chunk.length);}return Buffer.concat(chunks,bytes);}
  finally{signal.removeEventListener('abort',abort);response.destroy?.();}
}
/** Internal ZIP primitive; production prepare always uses the immutable pins. */
export function decodeNativeZipEntry(bytes,pin){
  if(!Buffer.isBuffer(bytes)||bytes.length!==pin.headerBytes+pin.compressedBytes||bytes.length<30)throw fail('NATIVE_SOURCE_CHANGED');
  const length=bytes.readUInt16LE(26),extra=bytes.readUInt16LE(28),end=30+length+extra;
  if(bytes.readUInt32LE(0)!==0x04034b50||bytes.readUInt16LE(6)!==0||bytes.readUInt16LE(8)!==pin.compression||bytes.readUInt32LE(14)!==pin.crc32||bytes.readUInt32LE(18)!==pin.compressedBytes||bytes.readUInt32LE(22)!==pin.bytes||end!==pin.headerBytes||bytes.subarray(30,30+length).toString('utf8')!==pin.entry||hash(bytes.subarray(0,end))!==pin.headerSha256)throw fail('NATIVE_SOURCE_CHANGED');
  let decoded;try{decoded=pin.compression===0?bytes.subarray(end):inflateRawSync(bytes.subarray(end),{maxOutputLength:pin.bytes});}catch{throw fail('NATIVE_PROVISION_INFLATE_LIMIT');}
  if(decoded.length!==pin.bytes||hash(decoded)!==pin.sha256)throw fail('NATIVE_PROVISION_HASH_MISMATCH');return decoded;
}
function prepared(dir,list,cached){const value={ready:true,files:list.length,bytes:list.reduce((n,item)=>n+item.bytes,0),cached};Object.defineProperty(value,'paths',{value:Object.freeze({ugAgent:join(dir,list[0].name),pgTunnel:join(dir,list[1].name)})});return value;}

/** The second argument is dependency injection for local tests, never HTTP/UI input. */
export function createNativeProvision({dir,trustedDir,timeoutMs=60000}={},internals={}){
  if(typeof dir!=='string'||basename(dir)!=='native-sdk'||trustedDir!==dir||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw fail('NATIVE_PROVISION_OPTIONS');
  const list=pinned(internals.entries||entries),io=internals.fs||filesystem,request=internals.request||requestHttps;
  if(typeof request!=='function')throw fail('NATIVE_PROVISION_OPTIONS');
  const store=createPrivateState({dir,trustedDir,files:list.map(item=>item.name),fs:io}),key=store.key,owned=new Set();let disposed=false;
  if(!states.has(key))states.set(key,{ready:false,files:0,bytes:0,active:0,receivedBytes:0,failures:0});const status=states.get(key);
  async function existing(root,pin){
    const entry=await store.openEntry(root,pin.name);if(!entry)return false;
    try{if(entry.identity.size!==BigInt(pin.bytes))throw fail('NATIVE_PROVISION_EXISTING_INVALID');const value=await store.readOpened(root,pin.name,entry,pin.bytes);if(hash(value.bytes)!==pin.sha256)throw fail('NATIVE_PROVISION_EXISTING_INVALID');return true;}finally{await entry.handle.close().catch(()=>{});}
  }
  async function publish(root,pin,bytes,signal){
    const temporary='.'+pin.name+'-'+randomUUID()+'.tmp';let handle,identity;
    try{
      active(signal);handle=await io.open(store.entryPath(root,temporary),constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|(store.posix?constants.O_NOFOLLOW|constants.O_NONBLOCK:0),0o600);let stat=await handle.stat({bigint:true});identity={dev:stat.dev,ino:stat.ino};store.file(stat);if(store.posix)await handle.chmod(0o600);
      for(let at=0;at<bytes.length;){active(signal);const result=await handle.write(bytes,at,Math.min(65536,bytes.length-at),at);if(!result.bytesWritten)throw fail('NATIVE_PROVISION_WRITE_FAILED');at+=result.bytesWritten;}
      await handle.sync();active(signal);await store.checkRoot(root);stat=await handle.stat({bigint:true});store.file(stat);if(store.posix&&(stat.mode&0o7777n)!==0o600n)throw fail('NATIVE_PROVISION_PRIVATE_UNSAFE');const visible=await store.stat(store.entryPath(root,temporary));if(visible.dev!==stat.dev||visible.ino!==stat.ino)throw fail('NATIVE_PROVISION_PRIVATE_UNSAFE');
      // link() is atomic and refuses an existing destination; rename() could
      // silently replace a concurrently-created damaged SDK. No partial bytes
      // are published. The owned temporary link is removed immediately.
      try{await io.link(store.entryPath(root,temporary),store.entryPath(root,pin.name));}catch(error){if(error.code!=='EEXIST')throw error;if(!await existing(root,pin))throw fail('NATIVE_PROVISION_EXISTING_INVALID');}
      if(!await store.unlinkOwned(root,temporary,identity))throw fail('NATIVE_PROVISION_PRIVATE_UNSAFE');
      await store.checkRoot(root);if(!await existing(root,pin))throw fail('NATIVE_PROVISION_WRITE_FAILED');if(store.posix)await root.handle.sync();
    }finally{await handle?.close().catch(()=>{});if(identity)await store.unlinkOwned(root,temporary,identity);}
  }
  async function work(signal){
    status.active=1;status.ready=false;status.files=0;status.bytes=0;status.receivedBytes=0;
    try{
      const output=await store.serialized(async root=>{
        try{
          active(signal);const present=[];for(const pin of list)present.push(await existing(root,pin));
          if(present.every(Boolean))return{value:prepared(dir,list,true)};
          const metadata=await guardedRequest(request,{url:new URL(metadataUrl),headers:{Accept:'application/json','Accept-Encoding':'identity'},signal,timeout:Math.min(timeoutMs,15000)});
          if(metadata.statusCode!==200||String(metadata.headers?.['content-encoding']||'identity')!=='identity'||Number(metadata.headers?.['content-length']||0)>65536){metadata.destroy?.();throw fail('NATIVE_PROVISION_METADATA_INVALID');}
          let result;try{result=JSON.parse((await body(metadata,65536,signal,n=>status.receivedBytes+=n)).toString('utf8'));}catch(error){if(error instanceof NativeProvisionError)throw error;throw fail('NATIVE_PROVISION_METADATA_INVALID');}
          if(result?.code!==200)throw fail('NATIVE_PROVISION_METADATA_INVALID');const url=downloadUrl(result?.data?.linkData?.tempUrl);
          for(let i=0;i<list.length;i++)if(!present[i]){
            active(signal);const pin=list[i],start=pin.localHeaderOffset,end=start+pin.headerBytes+pin.compressedBytes-1,length=end-start+1;
            const response=await guardedRequest(request,{url,headers:{Range:`bytes=${start}-${end}`,'If-Match':'"'+apkMd5+'"','Accept-Encoding':'identity'},signal,timeout:Math.min(timeoutMs,30000)});
            const etag=String(response.headers?.etag||'');
            if(response.statusCode!==206||response.headers?.['content-range']!==`bytes ${start}-${end}/${apkBytes}`||String(response.headers?.['content-length'])!==String(length)||String(response.headers?.['content-encoding']||'identity')!=='identity'||!/^"[a-f0-9]{32}"$/i.test(etag)||etag.toLowerCase()!=='"'+apkMd5+'"'){response.destroy?.();throw fail('NATIVE_SOURCE_CHANGED');}
            const data=decodeNativeZipEntry(await body(response,length,signal,n=>status.receivedBytes+=n),pin);active(signal);await publish(root,pin,data,signal);
          }
          active(signal);for(const pin of list)if(!await existing(root,pin))throw fail('NATIVE_PROVISION_WRITE_FAILED');return{value:prepared(dir,list,false)};
        }catch(error){return{error};}
      });
      if(output.error)throw output.error;active(signal);status.ready=true;status.files=list.length;status.bytes=list.reduce((n,p)=>n+p.bytes,0);return output.value;
    }catch(error){status.failures++;if(signal.aborted)active(signal);if(error instanceof NativeProvisionError)throw error;if(error instanceof PrivateStateError)throw fail('NATIVE_PROVISION_PRIVATE_UNSAFE');throw fail('NATIVE_PROVISION_FAILED');}
    finally{status.active=0;}
  }
  function prepare({signal}={}){
    if(disposed)return Promise.reject(fail('NATIVE_PROVISION_DISPOSED'));if(signal?.aborted)return Promise.reject(cancelled());
    let job=flights.get(key);if(!job){const controller=new AbortController();job={controller,subscribers:new Set(),settled:false};job.timer=setTimeout(()=>controller.abort(fail('NATIVE_PROVISION_TIMEOUT')),timeoutMs);job.promise=work(controller.signal).finally(()=>{clearTimeout(job.timer);job.settled=true;if(flights.get(key)===job)flights.delete(key);});flights.set(key,job);}
    return new Promise((resolve,reject)=>{
      const subscriber={job,done:false};owned.add(subscriber);job.subscribers.add(subscriber);
      const finish=(error,value)=>{if(subscriber.done)return;subscriber.done=true;signal?.removeEventListener('abort',subscriber.abort);job.controller.signal.removeEventListener('abort',subscriber.internalAbort);job.subscribers.delete(subscriber);owned.delete(subscriber);if(!job.subscribers.size&&!job.settled)job.controller.abort();error?reject(error):resolve(value);};
      subscriber.abort=()=>finish(cancelled());subscriber.internalAbort=()=>{let error;try{active(job.controller.signal);}catch(value){error=value;}finish(error||cancelled());};subscriber.cancel=subscriber.abort;signal?.addEventListener('abort',subscriber.abort,{once:true});job.controller.signal.addEventListener('abort',subscriber.internalAbort,{once:true});job.promise.then(value=>finish(null,value),error=>finish(error));if(signal?.aborted)subscriber.abort();else if(job.controller.signal.aborted)subscriber.internalAbort();
    });
  }
  return{prepare,status:()=>({...status}),cancel(){for(const subscriber of [...owned])subscriber.cancel();},dispose(){disposed=true;for(const subscriber of [...owned])subscriber.cancel();}};
}
