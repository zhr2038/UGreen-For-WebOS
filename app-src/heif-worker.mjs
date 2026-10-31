import {decodeHeifRgba} from './heif-core.mjs';
let used=false;
const safeCodes=new Set(['HEIF_TOO_LARGE','HEIF_INVALID_SOURCE','HEIF_INVALID_OPTIONS','HEIF_MEMORY_LIMIT','HEIF_LIBRARY_MISMATCH','HEIF_DECODE_FAILED','HEIF_PRIMARY_MISSING','HEIF_DIMENSIONS_MISMATCH','HEIF_INVALID_PLANE']);
async function readWasm(url){
  const response=await fetch(url,{credentials:'omit',redirect:'error',cache:'force-cache'});
  if(!response.ok||!response.body||Number(response.headers.get('content-length'))>2*1024*1024)throw new Error('library read failed');
  const reader=response.body.getReader(),parts=[];let length=0;
  try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>2*1024*1024)throw new Error('library too large');parts.push(next.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return bytes.buffer;
}
self.onmessage=async({data:job})=>{
  if(used)return;used=true;let bitmap;
  try {
    if(!job||job.type!=='decode'||!(job.blob instanceof Blob))throw new Error('invalid job');
    if(typeof self.libheif!=='function'){if(!job.loaderUrl)throw new Error('missing loader');importScripts(job.loaderUrl);}
    let wasmBinary=job.wasmBinary;
    if(!wasmBinary)wasmBinary=await readWasm(job.wasmUrl);
    if(!(wasmBinary instanceof ArrayBuffer)||wasmBinary.byteLength<1024||wasmBinary.byteLength>2*1024*1024)throw new Error('invalid wasm');
    const module=await self.libheif({wasmBinary:new Uint8Array(wasmBinary),print(){},printErr(){}});
    const started=performance.now(),decoded=decodeHeifRgba(module,new Uint8Array(await job.blob.arrayBuffer()),job.options),{data,...metadata}=decoded;
    if(job.output!=='rgba'&&typeof createImageBitmap==='function'&&typeof ImageData==='function'){
      bitmap=await createImageBitmap(new ImageData(data,metadata.width,metadata.height,{colorSpace:'srgb'}));
      self.postMessage({type:'decoded',id:job.id,...metadata,decodeMs:performance.now()-started,bitmap},[bitmap]);bitmap=null;
    }else self.postMessage({type:'decoded',id:job.id,...metadata,decodeMs:performance.now()-started,rgba:data.buffer},[data.buffer]);
  }catch(error){bitmap?.close();self.postMessage({type:'error',id:job?.id,code:safeCodes.has(error?.code)?error.code:'HEIF_DECODE_FAILED'});}
  // The owner terminates this single-use worker after receiving a result, so
  // the entire WASM heap (including Emscripten's grown capacity) is released.
};
