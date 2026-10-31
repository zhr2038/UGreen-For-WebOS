/* One WebAudio graph for photo BGM, including silent UHD video slides. */
(() => {
  'use strict';
  const messages={MUSIC_URL_INVALID:'背景音乐链接无效',MUSIC_UNAVAILABLE:'电视没有提供 WebAudio 背景音乐能力',MUSIC_READ_FAILED:'背景音乐读取失败',MUSIC_TOO_LARGE:'背景音乐超过电视解码上限',MUSIC_STREAM_UNAVAILABLE:'电视暂不支持这首长音乐的分段解码',MUSIC_DECODE_FAILED:'电视暂时无法解码这首背景音乐',MUSIC_TIMEOUT:'背景音乐处理超时',MUSIC_SUSPENDED:'背景音乐等待音频上下文恢复',MUSIC_NOT_READY:'背景音乐尚未准备好',MUSIC_DISPOSED:'背景音乐播放器已关闭',MUSIC_OPTIONS_INVALID:'背景音乐参数无效'};
  const fail=code=>Object.assign(new Error(messages[code]||messages.MUSIC_DECODE_FAILED),{name:'PhotoMusicError',code});
  const aborted=()=>new DOMException('Photo music cancelled','AbortError');
  const fileMaximum=16*1024*1024,bufferMaximum=64*1024*1024;
  // MP3 bitrate may change between frames, but rate/channel layout may not.
  // Keep an offset table instead of one JS object or PCM buffer per full song.
  function mp3Index(bytes){
    const data=new DataView(bytes),length=bytes.byteLength;
    function header(at){
      if(at+4>length||data.getUint8(at)!==255||(data.getUint8(at+1)&224)!==224)return null;
      const a=data.getUint8(at+1),b=data.getUint8(at+2),version=(a>>>3)&3,layer=(a>>>1)&3,index=b>>>4,frequency=(b>>>2)&3;
      if(version===1||layer!==1||index<1||index>14||frequency===3)return null;
      const rate=[44100,48000,32000][frequency]/(version===3?1:version===2?2:4),bitrate=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[index];
      return{length:Math.floor((version===3?144000:72000)*bitrate/rate)+((b>>>1)&1),rate,samples:version===3?1152:576,channels:(data.getUint8(at+3)>>>6)===3?1:2};
    }
    let at=0;
    if(length>=10&&data.getUint8(0)===73&&data.getUint8(1)===68&&data.getUint8(2)===51){let size=0;for(let i=6;i<10;i++){const value=data.getUint8(i);if(value&128)return null;size=size*128+value;}at=10+size+((data.getUint8(5)&16)?10:0);}
    let first=-1;
    for(let i=at;i<Math.min(length-4,at+65536);i++){const frame=header(i);if(frame&&i+frame.length<=length&&(i+frame.length===length||header(i+frame.length))){first=i;break;}}
    if(first<0)return null;
    const format=header(first),frameSeconds=format.samples/format.rate;
    // At most 100k frames / 400 KiB index, even for tiny low-bitrate frames.
    let count=0;at=first;
    while(at+4<=length){const frame=header(at);if(!frame||at+frame.length>length)break;if(frame.rate!==format.rate||frame.channels!==format.channels||frame.samples!==format.samples)throw fail('MUSIC_DECODE_FAILED');if(++count>100000)throw fail('MUSIC_TOO_LARGE');at+=frame.length;}
    const end=at;
    if(end!==length&&!(length-end===128&&data.getUint8(end)===84&&data.getUint8(end+1)===65&&data.getUint8(end+2)===71))throw fail('MUSIC_DECODE_FAILED');
    const offsets=new Uint32Array(count+1);at=first;
    for(let i=0;i<count;i++){offsets[i]=at;at+=header(at).length;}offsets[count]=at;
    return{...format,frameSeconds,count,offsets,duration:count*frameSeconds,indexBytes:offsets.byteLength};
  }
  function bounded(operation,timeout,signal){
    return new Promise((resolve,reject)=>{let done=false;const finish=(callback,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);callback(value);};const abort=()=>finish(reject,aborted()),timer=setTimeout(()=>finish(reject,fail('MUSIC_TIMEOUT')),timeout);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();Promise.resolve(operation).then(value=>finish(resolve,value),error=>finish(reject,error));});
  }
  // Bound common formats before native decode, including its resampling rate.
  function declaredPcmBytes(bytes,outputRate=48000){
    const data=new DataView(bytes),text=(at,n)=>String.fromCharCode(...new Uint8Array(bytes,at,n));
    if(bytes.byteLength>=12&&text(0,4)==='RIFF'&&text(8,4)==='WAVE'){
      let at=12,channels=0,alignment=0,pcmBytes=0,rate=0,format=0;
      while(at+8<=bytes.byteLength){const type=text(at,4),size=data.getUint32(at+4,true),start=at+8;if(start+size>bytes.byteLength)return null;if(type==='fmt '&&size>=16){format=data.getUint16(start,true);channels=data.getUint16(start+2,true);rate=data.getUint32(start+4,true);alignment=data.getUint16(start+12,true);}if(type==='data')pcmBytes+=size;at=start+size+(size&1);}
      return [1,3].includes(format)&&channels&&alignment&&rate?Math.ceil(pcmBytes/alignment*outputRate/rate)*channels*4:null;
    }
    if(bytes.byteLength>=42&&text(0,4)==='fLaC'&&(data.getUint8(4)&127)===0){const offset=8+10,high=data.getUint32(offset),low=data.getUint32(offset+4),channels=((high>>>9)&7)+1,samples=(high&15)*4294967296+low,rate=high>>>12;return rate?Math.ceil(samples*outputRate/rate)*channels*4:null;}
    return null;
  }
  window.createPhotoMusic=({getGateway,gateway,volume=1,maxFileBytes=fileMaximum,maxBufferBytes=bufferMaximum,timeoutMs=30000,controlTimeoutMs=3000,mp3Mode='auto',queueSeconds=4,fetch:fetcher=globalThis.fetch.bind(globalThis),createContext,AudioDecoder:Decoder=globalThis.AudioDecoder,EncodedAudioChunk:AudioChunk=globalThis.EncodedAudioChunk}={})=>{
    if(!Number.isFinite(volume)||volume<0||volume>1||!Number.isSafeInteger(maxFileBytes)||maxFileBytes<1||maxFileBytes>fileMaximum||!Number.isSafeInteger(maxBufferBytes)||maxBufferBytes<1||maxBufferBytes>bufferMaximum||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isFinite(controlTimeoutMs)||controlTimeoutMs<1||controlTimeoutMs>10000||typeof fetcher!=='function'||createContext!==undefined&&typeof createContext!=='function')throw fail('MUSIC_OPTIONS_INVALID');
    if(!['auto','stream'].includes(mp3Mode)||!Number.isFinite(queueSeconds)||queueSeconds<.5||queueSeconds>4)throw fail('MUSIC_OPTIONS_INVALID');
    let context,gain,buffer,source,stream,currentUrl='',offset=0,startedAt=0,loop=false,playing=false,ended=false,disposed=false,generation=0,activeJob,decodePending=false,loadTail=Promise.resolve(),lifetime,phase='idle',lastError='',lastContextState='uninitialized',closing;
    const counters={fetches:0,decodes:0,contexts:0,sources:0};
    function musicUrl(value){
      let origin,url;
      try{origin=new URL(typeof getGateway==='function'?getGateway():gateway||location.origin);url=new URL(value,origin);}catch{throw fail('MUSIC_URL_INVALID');}
      if(!['http:','https:'].includes(origin.protocol)||url.origin!==origin.origin||url.username||url.password||url.hash||!/^\/photo-music\/[a-f0-9]{40}$/.test(url.pathname))throw fail('MUSIC_URL_INVALID');
      if([...url.searchParams.keys()].some(key=>key!=='client')||url.searchParams.getAll('client').length!==1||!url.searchParams.get('client')||url.searchParams.get('client').length>2048||/[\x00-\x20\x7f]/.test(url.searchParams.get('client')))throw fail('MUSIC_URL_INVALID');
      return url.href;
    }
    const bufferBytes=()=>stream?stream.queueBytes:buffer?buffer.length*buffer.numberOfChannels*4:0;
    function currentTime(){if(stream)return stream.time();if(!buffer)return 0;const position=offset+(source&&playing?Math.max(0,context.currentTime-startedAt):0);return loop?position%buffer.duration:Math.min(buffer.duration,position);}
    function state(){const hasSource=Boolean(source||stream?.running),result={backend:'webaudio',mode:stream?'mp3-stream':'buffer',phase:hasSource&&playing?(context?.state==='running'?'playing':'suspended'):phase,loading:Boolean(activeJob),pendingDecode:decodePending||Boolean(stream?.pending),loaded:Boolean(buffer||stream?.ready),paused:!playing,ended,loop,volume,currentTime:currentTime(),duration:stream?.duration||buffer?.duration||0,bufferBytes:bufferBytes(),contextState:context?.state||lastContextState,running:Boolean(hasSource&&playing&&context?.state==='running'),audibleVerified:false,lastError,disposed,...counters,...(stream?stream.stats():{})};Object.defineProperty(result,'src',{value:currentUrl});return result;}
    function ensureContext(){
      if(disposed)throw fail('MUSIC_DISPOSED');if(context?.state==='closed')throw fail('MUSIC_UNAVAILABLE');
      if(!context){const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!createContext&&!Audio)throw fail('MUSIC_UNAVAILABLE');context=createContext?createContext():new Audio();counters.contexts++;gain=context.createGain();gain.gain.value=volume;gain.connect(context.destination);context.addEventListener?.('statechange',()=>{lastContextState=context?.state||lastContextState;});}
      return context;
    }
    function unlinkLifetime(){if(lifetime){lifetime.signal.removeEventListener('abort',lifetime.abort);lifetime=null;}}
    function linkLifetime(signal,epoch){unlinkLifetime();if(signal){const abort=()=>{if(epoch===generation)stop();};signal.addEventListener('abort',abort,{once:true});lifetime={signal,abort};if(signal.aborted)abort();}}
    function clearSource(){if(source){const old=source;source=null;old.onended=null;try{old.stop();}catch{}try{old.disconnect();}catch{}try{old.buffer=null;}catch{}}playing=false;}
    function releaseStream(){if(stream){const old=stream;stream=null;old.dispose();}}
    function finishJob(job,error,result){
      if(job.done)return;job.done=true;clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.abort);if(activeJob===job)activeJob=null;
      if(error){job.controller.abort();if(job.epoch===generation){lastError=error.name==='AbortError'?'':Object.hasOwn(messages,error.code)?error.code:'MUSIC_DECODE_FAILED';phase=error.name==='AbortError'?'stopped':'error';}job.reject(error.name==='AbortError'?error:fail(Object.hasOwn(messages,error.code)?error.code:'MUSIC_DECODE_FAILED'));}
      else job.resolve(result||state());
    }
    function cancelJob(){if(activeJob)finishJob(activeJob,aborted());}
    function suspend(){if(!context||context.state==='closed')return Promise.resolve(state());let operation;try{operation=context.suspend();}catch{return Promise.resolve(state());}return bounded(operation,controlTimeoutMs).catch(()=>{}).then(()=>state());}
    function start(epoch){
      if(disposed||epoch!==generation||!buffer)throw aborted();
      offset=loop?offset%buffer.duration:Math.min(offset,buffer.duration);ended=false;
      if(!loop&&offset>=buffer.duration){ended=true;playing=false;phase='ended';return state();}
      const ctx=ensureContext(),next=ctx.createBufferSource();next.buffer=buffer;next.loop=loop;next.connect(gain);source=next;counters.sources++;startedAt=ctx.currentTime;playing=true;phase=ctx.state==='running'?'playing':'suspended';
      next.onended=()=>{if(source!==next||epoch!==generation)return;source=null;playing=false;ended=true;offset=buffer?.duration||0;phase='ended';next.onended=null;try{next.disconnect();next.buffer=null;}catch{}};
      try{next.start(0,offset);}catch{clearSource();throw fail('MUSIC_DECODE_FAILED');}
      return state();
    }
    async function read(url,signal){
      let response;try{response=await fetcher(url,{signal,cache:'no-store',redirect:'error',credentials:'omit'});}catch(error){if(error.name==='AbortError')throw error;throw fail('MUSIC_READ_FAILED');}counters.fetches++;
      const mime=String(response.headers.get('content-type')||'').split(';')[0].toLowerCase();
      if(response.status!==200||!response.body||mime&&!mime.startsWith('audio/')&&!['application/octet-stream','application/flac','application/ogg'].includes(mime)){await response.body?.cancel().catch(()=>{});throw fail('MUSIC_READ_FAILED');}
      const rawLength=response.headers.get('content-length'),declared=rawLength===null?null:Number(rawLength);
      if(declared!==null&&(!Number.isSafeInteger(declared)||declared<1||declared>maxFileBytes)){await response.body.cancel().catch(()=>{});throw fail(declared>maxFileBytes?'MUSIC_TOO_LARGE':'MUSIC_READ_FAILED');}
      // A list of millions of one-byte chunks would exceed a byte-only cap.
      // Copy into a bounded geometric buffer, never retain an unbounded parts[] .
      const reader=response.body.getReader();let length=0,bytes=new Uint8Array(declared||Math.min(65536,maxFileBytes));
      try{for(;;){if(signal.aborted)throw aborted();const next=await reader.read();if(signal.aborted)throw aborted();if(next.done)break;if(!(next.value instanceof Uint8Array))throw fail('MUSIC_READ_FAILED');const size=length+next.value.byteLength;if(size>maxFileBytes)throw fail('MUSIC_TOO_LARGE');if(declared!==null&&size>declared)throw fail('MUSIC_READ_FAILED');if(size>bytes.byteLength){const grown=new Uint8Array(Math.min(maxFileBytes,Math.max(size,bytes.byteLength*2)));grown.set(bytes);bytes=grown;}bytes.set(next.value,length);length=size;}}
      catch(error){await reader.cancel().catch(()=>{});throw error.name==='AbortError'||error.code==='MUSIC_TOO_LARGE'?error:fail('MUSIC_READ_FAILED');}finally{reader.releaseLock();}
      if(!length||declared!==null&&length!==declared)throw fail('MUSIC_READ_FAILED');return length===bytes.byteLength?bytes.buffer:bytes.buffer.slice(0,length);
    }
    // Only a bounded compressed song is cached. WebCodecs sees at most eight
    // pending frames; WebAudio retains at most four seconds / eight MiB PCM.
    // No second HTML media element or full-song PCM allocation is used here.
    async function mp3Stream(bytes,index,epoch,job){
      if(typeof Decoder!=='function'||typeof Decoder.isConfigSupported!=='function'||typeof AudioChunk!=='function')throw fail('MUSIC_STREAM_UNAVAILABLE');
      const config={codec:'mp3',sampleRate:index.rate,numberOfChannels:index.channels};
      const support=await bounded(Decoder.isConfigSupported(config),Math.min(timeoutMs,3000),job.controller.signal);
      if(!support.supported)throw fail('MUSIC_STREAM_UNAVAILABLE');
      if(job.done||epoch!==generation||disposed)throw aborted();
      // Explicit application-owned budget, in addition to individual caps.
      // Browser codec/context internals are opaque and not a process-RAM claim.
      const ownedMaximum=32*1024*1024,codecReserve=1024*1024;
      const ctx=ensureContext(),queueMaximum=Math.min(maxBufferBytes,8*1024*1024,ownedMaximum-bytes.byteLength-index.indexBytes-codecReserve),frameBytes=index.samples*index.channels*4;
      if(frameBytes*2>queueMaximum)throw fail('MUSIC_TOO_LARGE');
      const horizon=Math.min(queueSeconds,queueMaximum/(index.rate*index.channels*4)-index.frameSeconds);
      let decoder,decoderGeneration=0,timer,closed=false,ready=false,running=false,flushing=false,eof=false;
      let position=loop?offset%index.duration:Math.min(offset,index.duration),clock=0,queueBytes=0,peakQueueBytes=0,inputs=0,outputs=0,decoderCount=0,lastProgress=Date.now();
      let cursor=Math.max(0,Math.floor(position/index.frameSeconds)-Math.ceil(2/index.frameSeconds)),cycle=0;
      let resolveReady,rejectReady;const readyPromise=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
      const segments=[],pendingFrames=[];
      const valid=()=>!closed&&!disposed&&epoch===generation&&stream===api;
      const absolute=()=>position+(running?Math.max(0,ctx.currentTime-clock):0);
      const publicTime=()=>{const value=absolute();return loop?value%index.duration:Math.min(index.duration,value);};
      function stopNode(segment){if(!segment.node)return;const node=segment.node;segment.node=null;node.onended=null;try{node.stop();}catch{}try{node.disconnect();node.buffer=null;}catch{}}
      function closeDecoder(){decoderGeneration++;if(decoder){const old=decoder;decoder=null;try{old.close();}catch{}}pendingFrames.length=0;flushing=false;}
      function cleanup(){if(closed)return;position=absolute();running=false;closed=true;clearTimeout(timer);timer=null;closeDecoder();for(const segment of segments){stopNode(segment);segment.buffer=null;}segments.length=0;queueBytes=0;bytes=null;rejectReady(aborted());}
      function error(reason){if(!valid())return;const code=Object.hasOwn(messages,reason?.code)?reason.code:'MUSIC_DECODE_FAILED';cleanup();playing=false;phase='error';lastError=code;if(activeJob===job)finishJob(job,fail(code));suspend();}
      function schedule(){
        if(!valid()||!running)return;
        const now=absolute();
        for(let i=segments.length-1;i>=0;i--){const segment=segments[i];if(segment.end<=now){stopNode(segment);queueBytes-=segment.bytes;segment.buffer=null;segments.splice(i,1);}}
        for(const segment of segments){
          if(segment.node||segment.end<=now)continue;
          const skip=Math.max(0,now-segment.start),when=Math.max(ctx.currentTime,clock+segment.start-position);
          if(skip>=segment.buffer.duration)continue;
          const node=ctx.createBufferSource();node.buffer=segment.buffer;node.connect(gain);segment.node=node;counters.sources++;
          node.onended=()=>{if(segment.node!==node)return;segment.node=null;node.onended=null;try{node.disconnect();node.buffer=null;}catch{}};
          try{node.start(when,skip);}catch{stopNode(segment);throw fail('MUSIC_DECODE_FAILED');}
        }
      }
      function start(){
        if(!valid()||!ready)throw aborted();
        if(!loop&&position>=index.duration){ended=true;playing=false;phase='ended';return;}
        running=true;playing=true;ended=false;clock=ctx.currentTime+.04;phase=ctx.state==='running'?'playing':'suspended';schedule();wake(0);
      }
      function maybeReady(){
        if(ready||!valid())return;
        const future=segments.reduce((total,segment)=>total+Math.max(0,segment.end-Math.max(position,segment.start)),0);
        if(future>=Math.min(.25,horizon/2,Math.max(index.frameSeconds,index.duration-position))||eof&&future>0){ready=true;start();resolveReady(api);}
      }
      function openDecoder(){
        const decoderEpoch=++decoderGeneration;
        const next=new Decoder({
          output(audio){
            try{
              if(!valid()||decoderEpoch!==decoderGeneration)return;
              lastProgress=Date.now();outputs++;
              const rate=audio.sampleRate,channels=audio.numberOfChannels,frames=audio.numberOfFrames;
              if(rate!==index.rate||channels!==index.channels||!Number.isSafeInteger(frames)||frames<1||frames>8192||!Number.isFinite(audio.timestamp))throw fail('MUSIC_DECODE_FAILED');
              const startTime=audio.timestamp/1000000,end=startTime+frames/rate,now=absolute();
              // decodeQueueSize alone excludes work already inside the codec.
              // Ack by output timestamp, including a skipped Xing/Info frame.
              while(pendingFrames.length&&pendingFrames[0]<=end+.000002)pendingFrames.shift();
              wake(0);
              if(end<=now)return;
              const size=frames*channels*4;
              if(queueBytes+size>queueMaximum||segments.length>=256)throw fail('MUSIC_TOO_LARGE');
              const pcm=ctx.createBuffer(channels,frames,rate);
              for(let channel=0;channel<channels;channel++)audio.copyTo(pcm.getChannelData(channel),{planeIndex:channel,format:'f32-planar'});
              segments.push({buffer:pcm,start:startTime,end,bytes:size,node:null});queueBytes+=size;peakQueueBytes=Math.max(peakQueueBytes,queueBytes);
              maybeReady();schedule();wake(0);
            }catch(reason){error(reason);}finally{try{audio.close();}catch{}}
          },
          error(){error(fail('MUSIC_DECODE_FAILED'));},
        });
        decoder=next;decoderCount++;counters.decodes++;
        next.configure(config);next.addEventListener?.('dequeue',()=>wake(0));
      }
      function wake(milliseconds=40){if(!valid()||timer!==undefined&&timer!==null)return;timer=setTimeout(()=>{timer=null;pump();},milliseconds);}
      function pump(){
        if(!valid())return;
        try{
          // Validate the current gateway on every continuation, before decoding.
          if(musicUrl(job.url)!==job.url)throw fail('MUSIC_URL_INVALID');
          schedule();
          if(!running&&ready)return;
          const now=absolute();
          if(eof&&!loop&&now>=index.duration){position=index.duration;running=false;playing=false;ended=true;phase='ended';closeDecoder();for(const segment of segments)stopNode(segment);return;}
          if((!ready||ctx.state==='running')&&Date.now()-lastProgress>timeoutMs&&(!segments.length||!ready))throw fail('MUSIC_TIMEOUT');
          if(!decoder&&!eof)openDecoder();
          let submitted=0;
          while(decoder&&!flushing&&!eof&&cursor<index.count&&decoder.decodeQueueSize<8&&pendingFrames.length<8&&submitted<8&&cycle*index.duration+cursor*index.frameSeconds<now+horizon){
            const timestamp=Math.round((cycle*index.duration+cursor*index.frameSeconds)*1000000),duration=Math.round(index.frameSeconds*1000000),start=index.offsets[cursor],end=index.offsets[cursor+1];
            pendingFrames.push((timestamp+duration)/1000000);
            decoder.decode(new AudioChunk({type:'key',timestamp,duration,data:new Uint8Array(bytes,start,end-start)}));cursor++;inputs++;submitted++;
          }
          if(decoder&&!flushing&&!eof&&cursor===index.count){
            const current=decoder;flushing=true;
            Promise.resolve(current.flush()).then(()=>{
              if(!valid()||current!==decoder)return;flushing=false;lastProgress=Date.now();
              if(loop){closeDecoder();cycle++;cursor=0;openDecoder();}else{eof=true;closeDecoder();maybeReady();}
              wake(0);
            },()=>{if(valid()&&current===decoder)error(fail('MUSIC_DECODE_FAILED'));});
          }
          wake(40);
        }catch(reason){error(reason);}
      }
      const api={
        get ready(){return ready&&!closed;},get running(){return running&&!closed&&segments.some(s=>s.node);},get pending(){return Boolean(pendingFrames.length||decoder?.decodeQueueSize||flushing);},get duration(){return index.duration;},get queueBytes(){return queueBytes;},time:publicTime,
        stats(){return{compressedBytes:bytes?.byteLength||0,indexBytes:index.indexBytes,queuedSeconds:segments.reduce((n,s)=>n+Math.max(0,s.end-Math.max(absolute(),s.start)),0),queueBytes,peakQueueBytes,retainedBytes:(bytes?.byteLength||0)+index.indexBytes+queueBytes,ownedBudgetBytes:ownedMaximum,decoderQueueSize:decoder?.decodeQueueSize||0,decoderInFlight:pendingFrames.length,decoderInputs:inputs,decoderOutputs:outputs,decoderCount,frameCount:index.count};},
        pause(){position=absolute();running=false;playing=false;clearTimeout(timer);timer=null;for(const segment of segments)stopNode(segment);},
        resume(){if(!valid()||!ready)throw fail('MUSIC_NOT_READY');start();},
        cache(){return{bytes,index};},dispose:cleanup,
      };
      stream=api;
      try{if(!loop&&position>=index.duration){ready=true;eof=true;ended=true;playing=false;phase='ended';resolveReady(api);}else{openDecoder();wake(0);}return await readyPromise;}catch(reason){cleanup();throw reason;}
    }
    function decode(ctx,bytes){
      counters.decodes++;decodePending=true;
      return new Promise((resolve,reject)=>{try{const operation=ctx.decodeAudioData(bytes,resolve,reject);if(operation?.then)operation.then(resolve,reject);}catch(error){reject(error);}}).finally(()=>{decodePending=false;});
    }
    function play(value,options={}){
      if(disposed)return Promise.reject(fail('MUSIC_DISPOSED'));let url;
      try{url=musicUrl(value);}catch(error){return Promise.reject(error);}
      const {signal,position,loop:requestedLoop=false}=options;if(position!==undefined&&(!Number.isFinite(position)||position<0)||typeof requestedLoop!=='boolean')return Promise.reject(fail('MUSIC_OPTIONS_INVALID'));if(signal?.aborted)return Promise.reject(aborted());
      if(activeJob?.url===url&&position===undefined&&loop===requestedLoop)return activeJob.promise;
      const same=currentUrl===url&&buffer,cached=currentUrl===url&&stream?.cache(),previousPosition=currentTime();cancelJob();unlinkLifetime();const epoch=++generation;
      if(same){offset=position??currentTime();clearSource();loop=requestedLoop;currentUrl=url;lastError='';ensureContext();try{Promise.resolve(context.resume()).catch(()=>{});const result=start(epoch);linkLifetime(signal,epoch);return Promise.resolve(result);}catch(error){return Promise.reject(error);}}
      releaseStream();clearSource();buffer=null;offset=position??(cached?ended?0:previousPosition:0);loop=requestedLoop;ended=false;currentUrl=url;phase='loading';lastError='';
      let ctx;try{ctx=ensureContext();Promise.resolve(ctx.resume()).catch(()=>{});}catch(error){phase='error';lastError=error.code;return Promise.reject(error);}
      const job={epoch,url,controller:new AbortController(),signal,done:false};job.promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});activeJob=job;
      job.abort=()=>{if(job.epoch===generation){generation++;releaseStream();clearSource();buffer=null;offset=0;currentUrl='';phase='stopped';}finishJob(job,aborted());};signal?.addEventListener('abort',job.abort,{once:true});job.timer=setTimeout(()=>{if(job.epoch===generation){releaseStream();clearSource();buffer=null;}finishJob(job,fail('MUSIC_TIMEOUT'));suspend();},timeoutMs);
      const valid=()=>!disposed&&!job.done&&generation===epoch&&!job.controller.signal.aborted&&musicUrl(job.url)===job.url;
      const work=loadTail.catch(()=>{}).then(async()=>{
        if(!valid())throw aborted();let bytes=cached?.bytes||await read(url,job.controller.signal);if(!valid())throw aborted();const index=cached?.index||mp3Index(bytes),declared=index?Math.ceil(index.duration*(ctx.sampleRate||48000))*index.channels*4:declaredPcmBytes(bytes,ctx.sampleRate||48000);
        if(index&&(mp3Mode==='stream'||declared>maxBufferBytes)){
          await mp3Stream(bytes,index,epoch,job);bytes=null;if(!valid())throw aborted();linkLifetime(signal,epoch);finishJob(job,null);return;
        }
        if(declared!==null&&declared>maxBufferBytes)throw fail('MUSIC_TOO_LARGE');
        let operation;try{operation=decode(ctx,bytes);}finally{bytes=null;}const decoded=await operation;
        if(!valid())throw aborted();const size=decoded.length*decoded.numberOfChannels*4;
        if(!Number.isFinite(decoded.duration)||decoded.duration<=0||!Number.isSafeInteger(decoded.length)||decoded.length<1||!Number.isInteger(decoded.numberOfChannels)||decoded.numberOfChannels<1||decoded.numberOfChannels>8||!Number.isSafeInteger(size)||size>maxBufferBytes)throw fail('MUSIC_TOO_LARGE');
        buffer=decoded;start(epoch);linkLifetime(signal,epoch);finishJob(job,null);
      }).catch(error=>{if(!job.done){if(job.epoch===generation){releaseStream();clearSource();buffer=null;}finishJob(job,error);suspend();}});loadTail=work;
      return job.promise;
    }
    function pause(){if(disposed)return Promise.resolve(state());offset=currentTime();cancelJob();if(stream?.ready)stream.pause();else releaseStream();clearSource();phase=buffer||stream?.ready?'paused':'stopped';return suspend();}
    function resume({signal}={}){
      if(disposed)return Promise.reject(fail('MUSIC_DISPOSED'));if(!buffer&&!stream?.ready)return Promise.reject(fail('MUSIC_NOT_READY'));if(signal?.aborted)return Promise.reject(aborted());
      if(stream){
        try{musicUrl(currentUrl);const ctx=ensureContext(),epoch=generation;if(!playing)stream.resume();if(signal)linkLifetime(signal,epoch);return bounded(ctx.resume(),controlTimeoutMs,signal).then(()=>{if(disposed||epoch!==generation||!stream?.ready)throw aborted();phase=ctx.state==='running'?'playing':'suspended';return state();},error=>{if(error.name==='AbortError')throw error;if(epoch!==generation||!stream?.ready)throw aborted();phase='suspended';throw fail('MUSIC_SUSPENDED');});}catch(error){if(error.code==='MUSIC_URL_INVALID')stop();return Promise.reject(error);}
      }
      try{musicUrl(currentUrl);const ctx=ensureContext(),epoch=generation;if(!source)start(epoch);if(signal)linkLifetime(signal,epoch);const operation=ctx.resume();return bounded(operation,controlTimeoutMs,signal).then(()=>{if(disposed||epoch!==generation||!buffer||!source)throw aborted();phase=ctx.state==='running'?'playing':'suspended';return state();},error=>{if(error.name==='AbortError')throw error;if(epoch!==generation||!buffer||!source)throw aborted();phase='suspended';throw fail('MUSIC_SUSPENDED');});}catch(error){if(error.code==='MUSIC_URL_INVALID')stop();return Promise.reject(error);}
    }
    function stop(){if(disposed)return Promise.resolve(state());generation++;cancelJob();unlinkLifetime();releaseStream();clearSource();buffer=null;offset=0;currentUrl='';ended=false;phase='stopped';lastError='';return suspend();}
    function setVolume(value){if(disposed)throw fail('MUSIC_DISPOSED');if(!Number.isFinite(value)||value<0||value>1)throw fail('MUSIC_OPTIONS_INVALID');volume=value;if(gain)gain.gain.setValueAtTime?gain.gain.setValueAtTime(value,context.currentTime):gain.gain.value=value;return state();}
    function dispose(){
      if(closing)return closing;stop();disposed=true;phase='disposed';const ctx=context;try{gain?.disconnect();}catch{}gain=null;
      let operation;try{operation=ctx?.close();}catch{operation=Promise.reject(fail('MUSIC_UNAVAILABLE'));}
      closing=bounded(operation,controlTimeoutMs).then(()=>{lastContextState=ctx?.state||'closed';context=null;return{...state(),cleanupConfirmed:!decodePending&&(!ctx||lastContextState==='closed')};},()=>{lastContextState=ctx?.state||'unknown';context=null;return{...state(),cleanupConfirmed:false};});return closing;
    }
    return{play,pause,resume,stop,setVolume,state,dispose};
  };
})();
