/* Lazy, single-use HEIF workers. This file never fetches a photo or changes UI. */
(() => {
  'use strict';
  const base = document.currentScript?.src || document.baseURI;
  const errors = {
    HEIF_TOO_LARGE:'HEIF 原图超过电视解码上限',HEIF_INVALID_SOURCE:'无法识别 HEIF/HEIC 原图',HEIF_INVALID_OPTIONS:'HEIF 解码参数无效',
    HEIF_MEMORY_LIMIT:'HEIF 原图解码内存不足',HEIF_LIBRARY_MISMATCH:'HEIF 解码组件版本不匹配',HEIF_DECODE_FAILED:'HEIF 原图暂时无法解码',
    HEIF_PRIMARY_MISSING:'HEIF 文件没有有效主图',HEIF_DIMENSIONS_MISMATCH:'读取到的文件尺寸与原图不符',HEIF_INVALID_PLANE:'HEIF 解码像素无效',
    HEIF_TIMEOUT:'HEIF 原图处理超时',HEIF_UNAVAILABLE:'电视暂不支持 HEIF 解码组件',HEIF_DISPOSED:'HEIF 解码器已关闭',
  };
  const fail = code => Object.assign(new Error(errors[code] || errors.HEIF_DECODE_FAILED),{name:'HeifDecodeError',code});
  const aborted = () => new DOMException('HEIF decoding cancelled','AbortError');
  const validPixels = (w,h,max) => Number.isSafeInteger(w)&&Number.isSafeInteger(h)&&w>0&&h>0&&w<=20000&&h<=20000&&w*h<=max;
  const url = value => {const result=new URL(value,base);if(!['file:','http:','https:'].includes(result.protocol)||result.username||result.password||result.hash)throw fail('HEIF_INVALID_OPTIONS');return result.href;};
  function wasmBytes(assets) {
    if(assets.wasmBinary?.byteLength>2*1024*1024)throw fail('HEIF_INVALID_OPTIONS');
    if(assets.wasmBinary instanceof ArrayBuffer)return assets.wasmBinary.slice(0);
    if(ArrayBuffer.isView(assets.wasmBinary))return assets.wasmBinary.buffer.slice(assets.wasmBinary.byteOffset,assets.wasmBinary.byteOffset+assets.wasmBinary.byteLength);
    if(typeof assets.wasmBase64==='string'){
      if(assets.wasmBase64.length>2800000)throw fail('HEIF_INVALID_OPTIONS');const binary=atob(assets.wasmBase64),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes.buffer;
    }
    return undefined;
  }
  window.createPhotoHeifDecoder = (options={}) => {
    const settings={...(window.CloudFrameHeifConfig||{}),...options};
    const maxPixels=settings.maxPixels??16000000,memoryBytes=settings.memoryBytes??256*1024*1024,defaultTimeout=settings.timeoutMs??30000;
    if(!Number.isSafeInteger(maxPixels)||maxPixels<1||maxPixels>50000000||!Number.isSafeInteger(memoryBytes)||memoryBytes<64*1024*1024||memoryBytes>512*1024*1024||!Number.isFinite(defaultTimeout)||defaultTimeout<1||defaultTimeout>60000)throw fail('HEIF_INVALID_OPTIONS');
    const workerUrl=url(settings.workerUrl||'heif-worker.js'),loaderUrl=url(settings.loaderUrl||'vendor/libheif-1.23.5/libheif.js'),wasmUrl=url(settings.wasmUrl||'vendor/libheif-1.23.5/libheif.wasm');
    let active=null,sequence=0,disposed=false;
    const counters={workersStarted:0,workersTerminated:0,decoded:0,failed:0,cancelled:0,lastDecodeMs:0,lastWasmHeapBytes:0};
    function terminate(job) {
      if(job.worker){job.worker.onmessage=null;job.worker.onerror=null;job.worker.onmessageerror=null;job.worker.terminate();job.worker=null;counters.workersTerminated++;}
      if(job.objectUrl){URL.revokeObjectURL(job.objectUrl);job.objectUrl=null;}
    }
    function finish(job,error,result) {
      if(job.finished){result?.image?.close?.();return;}
      job.finished=true;clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.abort);terminate(job);job.controller.abort();job.blob=null;
      if(active===job)active=null;
      if(error){if(error.name==='AbortError')counters.cancelled++;else counters.failed++;job.reject(error);}
      else{counters.decoded++;counters.lastDecodeMs=result.decodeMs||0;counters.lastWasmHeapBytes=result.wasmHeapBytes||0;job.resolve(result);}
    }
    function cancel(){if(active)finish(active,aborted());}
    function current(job){return active===job&&!job.finished&&!disposed&&!job.signal?.aborted;}
    async function receive(job,message) {
      if(!current(job)||message?.id!==job.id){message?.bitmap?.close?.();return;}
      if(message.type==='error'){finish(job,fail(Object.hasOwn(errors,message.code)?message.code:'HEIF_DECODE_FAILED'));return;}
      if(message.type!=='decoded')return;
      terminate(job);let image=message.bitmap;
      try {
        if(!message.originalDecoded||message.orientationApplied!==true||!validPixels(message.sourceWidth,message.sourceHeight,maxPixels)||!validPixels(message.width,message.height,3840*2160)||message.width>job.targetWidth||message.height>job.targetHeight||message.width>message.sourceWidth||message.height>message.sourceHeight)throw fail('HEIF_INVALID_PLANE');
        if(!image){
          if(!(message.rgba instanceof ArrayBuffer)||message.rgba.byteLength!==message.width*message.height*4||typeof createImageBitmap!=='function')throw fail('HEIF_UNAVAILABLE');
          image=await createImageBitmap(new ImageData(new Uint8ClampedArray(message.rgba),message.width,message.height,{colorSpace:'srgb'}));
        }
        if(!current(job)){image.close?.();return;}
        if(image.width!==message.width||image.height!==message.height)throw fail('HEIF_INVALID_PLANE');
        const {bitmap,rgba,type,id,...metadata}=message;let closed=false;
        finish(job,null,{...metadata,image,scaled:message.width!==message.sourceWidth||message.height!==message.sourceHeight,close(){if(!closed){closed=true;image.close?.();}}});
      }catch(error){image?.close?.();finish(job,error?.name==='AbortError'?error:fail(Object.hasOwn(errors,error?.code)?error.code:'HEIF_DECODE_FAILED'));}
    }
    function decode(blob,{signal,expectedWidth,expectedHeight,targetWidth=3840,targetHeight=2160,timeoutMs=defaultTimeout}={}) {
      if(disposed)return Promise.reject(fail('HEIF_DISPOSED'));
      if(!(blob instanceof Blob)||blob.size<16||blob.size>32*1024*1024)return Promise.reject(fail('HEIF_TOO_LARGE'));
      if((expectedWidth!==undefined||expectedHeight!==undefined)&&!validPixels(expectedWidth,expectedHeight,maxPixels))return Promise.reject(fail('HEIF_TOO_LARGE'));
      if(!Number.isSafeInteger(targetWidth)||!Number.isSafeInteger(targetHeight)||targetWidth<1||targetHeight<1||targetWidth>3840||targetHeight>2160||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000)return Promise.reject(fail('HEIF_INVALID_OPTIONS'));
      if(signal?.aborted)return Promise.reject(aborted());
      cancel();
      return new Promise((resolve,reject)=>{
        const job={id:++sequence,blob,signal,targetWidth,targetHeight,resolve,reject,controller:new AbortController(),finished:false};active=job;
        job.abort=()=>finish(job,aborted());signal?.addEventListener('abort',job.abort,{once:true});
        job.timer=setTimeout(()=>finish(job,fail('HEIF_TIMEOUT')),timeoutMs);
        Promise.resolve().then(()=>settings.loadAssets?settings.loadAssets({signal:job.controller.signal}):settings).then(assets=>{
          if(!current(job))return;
          assets=assets||{};
          const binary=wasmBytes(assets);if(binary&&(binary.byteLength<1024||binary.byteLength>2*1024*1024))throw fail('HEIF_INVALID_OPTIONS');
          const source=typeof assets.workerSource==='string'?String(assets.loaderSource||'')+'\n'+assets.workerSource:'importScripts('+JSON.stringify(url(assets.workerUrl||workerUrl))+');';
          if(source.length>5000000)throw fail('HEIF_INVALID_OPTIONS');
          job.objectUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
          job.worker=settings.createWorker?settings.createWorker(job.objectUrl):new Worker(job.objectUrl);counters.workersStarted++;
          job.worker.onmessage=event=>{receive(job,event.data).catch(()=>finish(job,fail('HEIF_DECODE_FAILED')));};
          job.worker.onerror=event=>{event.preventDefault?.();finish(job,fail('HEIF_DECODE_FAILED'));};job.worker.onmessageerror=()=>finish(job,fail('HEIF_DECODE_FAILED'));
          job.worker.postMessage({type:'decode',id:job.id,blob:job.blob,loaderUrl:url(assets.loaderUrl||loaderUrl),wasmUrl:url(assets.wasmUrl||wasmUrl),wasmBinary:binary,output:settings.workerOutput==='rgba'?'rgba':'bitmap',options:{maxPixels,memoryBytes,maxWidth:targetWidth,maxHeight:targetHeight,expectedWidth,expectedHeight}},binary?[binary]:[]);
        }).catch(error=>{if(current(job))finish(job,error?.name==='AbortError'?error:fail(Object.hasOwn(errors,error?.code)?error.code:'HEIF_DECODE_FAILED'));});
      });
    }
    return{decode,cancel,dispose(){disposed=true;cancel();},stats:()=>({...counters,active:Boolean(active),disposed})};
  };
})();
