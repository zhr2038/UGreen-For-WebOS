import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
const script=await readFile(new URL('../app/photo-music.js',import.meta.url),'utf8'),url='http://gateway.test/photo-music/'+ 'a'.repeat(40)+'?client=PRIVATE_LOCAL_TEST_CAP';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(predicate){
  // The stream pump advances in 40ms batches. Reaching >100 outputs or several
  // loops takes hundreds of ms; 100 nominal 1ms polls only passed on Windows
  // because its timer granularity accidentally extended that budget.
  const deadline=performance.now()+5000;
  while(!predicate()){if(performance.now()>=deadline)throw new Error('state timeout after 5000ms');await delay(5);}
}
function fixture(extra={}){
  const tracker={fetches:0,decodes:0,contexts:[],sources:[],gain:null,decodeActive:0,decodeMaximum:0};
  class Context extends EventTarget {
    constructor(){super();this.state='suspended';this.currentTime=0;this.destination={};tracker.contexts.push(this);}
    createGain(){const gain={gain:{value:1,setValueAtTime(v){this.value=v;}},connect(){},disconnect(){}};tracker.gain=gain;return gain;}
    createBufferSource(){const source={buffer:null,loop:false,connect(){},disconnect(){this.disconnected=true;},start(when,offset){this.offset=offset;this.started=true;},stop(){this.stopped=true;}};tracker.sources.push(source);return source;}
    resume(){if(tracker.resumeGate)return tracker.resumeGate.promise.then(()=>{this.state='running';});this.state='running';return Promise.resolve();}
    suspend(){this.state='suspended';return Promise.resolve();}
    close(){this.state='closed';return Promise.resolve();}
    async decodeAudioData(){tracker.decodes++;tracker.decodeActive++;tracker.decodeMaximum=Math.max(tracker.decodeMaximum,tracker.decodeActive);try{if(tracker.decodeGate)await tracker.decodeGate.promise;if(tracker.decodeError)throw new Error('private codec failure '+url);return tracker.decoded||{length:48000,numberOfChannels:2,duration:1};}finally{tracker.decodeActive--;}}
  }
  const window={},fetcher=async(value,options)=>{tracker.fetches++;tracker.signal=options.signal;if(tracker.fetchGate)await tracker.fetchGate.promise;if(tracker.fetchError)throw new Error('private network '+url);return new Response(tracker.body||new Uint8Array(128),{status:200,headers:{'content-type':tracker.mime||'audio/mpeg',...(tracker.declared?{'content-length':String(tracker.declared)}:{})}});};
  vm.runInNewContext(script,{window,fetch:fetcher,location:{origin:'http://gateway.test'},URL,DOMException,AbortController,setTimeout,clearTimeout,DataView,Uint8Array});
  const music=window.createPhotoMusic({getGateway:()=>tracker.gateway||'http://gateway.test',fetch:fetcher,createContext:()=>new Context(),volume:0,...extra});return{music,tracker};
}

test('factory is lazy and URL scope rejects external hosts, private NAS paths and unknown queries before starting audio',async()=>{
  const {music,tracker}=fixture();assert.equal(tracker.contexts.length,0);for(const value of ['https://other.test/photo-music/'+'a'.repeat(40)+'?client=x','http://gateway.test/media/x',url+'&path=/private/x',url+'#bad','http://gateway.test/photo-music/abc?client=x'])await assert.rejects(music.play(value),{code:'MUSIC_URL_INVALID'});assert.equal(tracker.contexts.length,0);assert.equal(tracker.fetches,0);await music.dispose();
});

test('one cached buffer supports precise loop pause/resume without creating a second context or decoding again',async()=>{
  const {music,tracker}=fixture();const started=await music.play(url,{position:.1,loop:true});assert.equal(started.loading,false);assert.equal(started.contextState,'running');assert.equal(started.audibleVerified,false);tracker.contexts[0].currentTime=2.45;assert.ok(Math.abs(music.state().currentTime-.55)<1e-9);
  const paused=music.pause();assert.equal(tracker.sources[0].stopped,true);const offset=music.state().currentTime;tracker.contexts[0].currentTime=8;await paused;assert.equal(music.state().currentTime,offset);await music.resume();assert.ok(Math.abs(tracker.sources[1].offset-.55)<1e-9);tracker.contexts[0].currentTime=8.1;assert.ok(Math.abs(music.state().currentTime-.65)<1e-8);assert.equal(tracker.contexts.length,1);assert.equal(tracker.decodes,1);assert.equal(tracker.fetches,1);await music.dispose();
});

test('volume, state privacy and source cleanup remain explicit',async()=>{
  const {music,tracker}=fixture();await music.play(url);music.setVolume(.25);assert.equal(tracker.gain.gain.value,.25);assert.equal(music.state().src,url);assert.equal(JSON.stringify(music.state()).includes('PRIVATE_LOCAL_TEST_CAP'),false);assert.throws(()=>music.setVolume(2),{code:'MUSIC_OPTIONS_INVALID'});await music.stop();assert.equal(music.state().bufferBytes,0);assert.equal(music.state().src,'');assert.equal(tracker.sources[0].buffer,null);await music.dispose();assert.equal(music.state().contextState,'closed');await assert.rejects(music.play(url),{code:'MUSIC_DISPOSED'});
});

test('late fetch after stop cannot decode or start a node',async()=>{
  const {music,tracker}=fixture();tracker.fetchGate=deferred();const pending=music.play(url).catch(e=>e);await until(()=>tracker.fetches===1);await music.stop();assert.equal((await pending).name,'AbortError');tracker.fetchGate.resolve();await delay(2);assert.equal(tracker.decodes,0);assert.equal(tracker.sources.length,0);assert.equal(music.state().loaded,false);await music.dispose();
});

test('cancelled native decoding stays serialized and its late buffer never replaces the next track',async()=>{
  const {music,tracker}=fixture();tracker.decodeGate=deferred();const first=music.play(url).catch(e=>e);await until(()=>tracker.decodeActive===1);await music.stop();const second=music.play(url.replace('/'+'a'.repeat(40),'/'+ 'b'.repeat(40)));await delay(2);assert.equal(tracker.fetches,1);assert.equal((await first).name,'AbortError');tracker.decodeGate.resolve();await second;assert.equal(tracker.fetches,2);assert.equal(tracker.decodeMaximum,1);assert.equal(tracker.sources.length,1);assert.ok(music.state().src.includes('b'.repeat(40)));await music.dispose();
});

test('timeout and disposal never claim that a still-pending native decode has been killed',async()=>{
  const {music,tracker}=fixture({timeoutMs:10});tracker.decodeGate=deferred();const pending=music.play(url);await assert.rejects(pending,{code:'MUSIC_TIMEOUT'});assert.equal(music.state().pendingDecode,true);assert.equal(music.state().bufferBytes,0);const disposed=await music.dispose();assert.equal(disposed.cleanupConfirmed,false);tracker.decodeGate.resolve();await until(()=>!music.state().pendingDecode);assert.equal(tracker.sources.length,0);
});

test('file/buffer caps and codec failures are static safe errors with no media fallback',async()=>{
  const a=fixture();a.tracker.declared=16*1024*1024+1;await assert.rejects(a.music.play(url),{code:'MUSIC_TOO_LARGE'});assert.equal(a.tracker.decodes,0);await a.music.dispose();
  const b=fixture();b.tracker.decoded={duration:1000,length:48000*1000,numberOfChannels:2};await assert.rejects(b.music.play(url),{code:'MUSIC_TOO_LARGE'});assert.equal(b.music.state().bufferBytes,0);await b.music.dispose();
  const c=fixture();c.tracker.decodeError=true;await assert.rejects(c.music.play(url),error=>error.code==='MUSIC_DECODE_FAILED'&&!error.message.includes('PRIVATE_LOCAL'));assert.equal(c.tracker.sources.length,0);await c.music.dispose();
});

test('lifetime abort stops a successfully loaded track, and a stale resume cannot revive a stopped source',async()=>{
  const {music,tracker}=fixture(),abort=new AbortController();await music.play(url,{signal:abort.signal});abort.abort();assert.equal(music.state().paused,true);assert.equal(music.state().bufferBytes,0);
  await music.play(url);await music.pause();tracker.resumeGate=deferred();const resumed=music.resume().catch(e=>e);await music.stop();tracker.resumeGate.resolve();assert.equal((await resumed).name,'AbortError');assert.equal(music.state().phase,'stopped');await music.dispose();
});

test('MP3 Layer III frame duration is budgeted at the output rate before native decode',async()=>{
  const {music,tracker}=fixture();const frames=10000,length=417,bytes=new Uint8Array(frames*length);for(let i=0;i<frames;i++)bytes.set([255,251,144,0],i*length);tracker.body=bytes;await assert.rejects(music.play(url),{code:'MUSIC_STREAM_UNAVAILABLE'});assert.equal(tracker.decodes,0);assert.equal(music.state().bufferBytes,0);await music.dispose();
});

function streamFixture(options={},controls={}){
  const tracker={decoders:[],chunks:[],outputs:[],sources:[],buffers:[],fetches:0,nativeDecodes:0,gain:null};
  class Context extends EventTarget{
    constructor(){super();this.state='suspended';this.sampleRate=48000;this.currentTime=0;this.destination={};tracker.context=this;}
    resume(){this.state='running';return Promise.resolve();}suspend(){this.state='suspended';return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
    createGain(){return tracker.gain={gain:{value:1,setValueAtTime(v){this.value=v;}},connect(){},disconnect(){}};}
    createBuffer(channels,length,rate){const planes=Array.from({length:channels},()=>new Float32Array(length)),result={length,numberOfChannels:channels,sampleRate:rate,duration:length/rate,getChannelData(channel){return planes[channel];}};tracker.buffers.push(result);return result;}
    createBufferSource(){const node={buffer:null,connect(){},disconnect(){this.disconnected=true;},start(when,offset){this.when=when;this.offset=offset;this.started=true;},stop(){this.stopped=true;}};tracker.sources.push(node);return node;}
    decodeAudioData(){tracker.nativeDecodes++;throw Error('Full-song native decoding forbidden');}
  }
  class AudioChunk{constructor(value){Object.assign(this,value);}}
  class Decoder extends EventTarget{
    static async isConfigSupported(config){if(controls.supportGate)await controls.supportGate.promise;return{supported:controls.supported!==false,config};}
    constructor(callbacks){super();this.callbacks=callbacks;this.decodeQueueSize=0;this.closed=false;this.pending=new Set();tracker.decoders.push(this);}
    configure(config){this.config=config;}
    decode(chunk){this.decodeQueueSize++;tracker.chunks.push(chunk);if(controls.dequeueEarly){this.decodeQueueSize--;this.dispatchEvent(new Event('dequeue'));}const operation=(async()=>{if(controls.outputGate)await controls.outputGate.promise;else await delay(1);if(!controls.dequeueEarly)this.decodeQueueSize--;const data={sampleRate:48000,numberOfChannels:2,numberOfFrames:controls.frames||1152,timestamp:chunk.timestamp,closed:false,copyTo(target){target.fill(.25);},close(){this.closed=true;}};tracker.outputs.push(data);if(!this.closed||controls.lateOutputs)this.callbacks.output(data);else data.close();this.dispatchEvent(new Event('dequeue'));})();this.pending.add(operation);operation.finally(()=>this.pending.delete(operation));}
    async flush(){await Promise.all([...this.pending]);}
    close(){this.closed=true;}
  }
  const frameCount=controls.frameCount||8250,length=384,body=new Uint8Array(frameCount*length);for(let i=0;i<frameCount;i++)body.set([255,251,148,0],i*length);
  const window={},fetcher=async(value,opts)=>{tracker.fetches++;tracker.signal=opts.signal;return new Response(body,{headers:{'content-type':'audio/mpeg','content-length':String(body.length)}});};
  vm.runInNewContext(script,{window,fetch:fetcher,location:{origin:'http://gateway.test'},URL,DOMException,AbortController,setTimeout,clearTimeout,DataView,Uint8Array});
  const music=window.createPhotoMusic({getGateway:()=>tracker.gateway||'http://gateway.test',createContext:()=>new Context(),fetch:fetcher,AudioDecoder:Decoder,EncodedAudioChunk:AudioChunk,volume:0,timeoutMs:1000,...options});
  return{music,tracker,controls};
}

test('a real-length MP3 uses bounded WebCodecs PCM instead of rejecting or decoding the entire song',async()=>{
  const {music,tracker}=streamFixture();try{
    const value=await music.play(url);assert.equal(value.mode,'mp3-stream');assert.equal(value.loading,false);assert.equal(value.duration,198);await until(()=>music.state().decoderOutputs>100);
    const state=music.state();assert.equal(tracker.fetches,1);assert.equal(tracker.nativeDecodes,0);assert.equal(state.contexts,1);assert.ok(state.queuedSeconds<=4.03);assert.ok(state.peakQueueBytes<2*1024*1024);assert.ok(state.decoderQueueSize<=8);assert.ok(tracker.outputs.every(item=>item.closed));assert.equal(tracker.gain.gain.value,0);assert.equal(JSON.stringify(state).includes('PRIVATE'),false);
    tracker.context.currentTime=20;await delay(90);assert.ok(music.state().currentTime>19);assert.ok(music.state().queueBytes<2*1024*1024);
  }finally{const result=await music.dispose();assert.equal(result.cleanupConfirmed,true);assert.ok(tracker.decoders.every(item=>item.closed));assert.ok(tracker.sources.every(item=>item.stopped||item.disconnected));}
});

test('stream pause stops every source synchronously, retains a small queue, and resume does not fetch/decode the song again',async()=>{
  const {music,tracker}=streamFixture();try{await music.play(url,{loop:true});await until(()=>music.state().decoderOutputs>100);tracker.context.currentTime=.4;const paused=music.pause();assert.ok(tracker.sources.every(item=>item.stopped));const position=music.state().currentTime,decoders=tracker.decoders.length;await paused;tracker.context.currentTime=10;assert.equal(music.state().currentTime,position);await music.resume();assert.equal(tracker.fetches,1);assert.equal(tracker.decoders.length,decoders);tracker.context.currentTime=10.3;assert.ok(Math.abs(music.state().currentTime-(position+.26))<.001);assert.equal(music.state().running,true);}finally{await music.dispose();}
});

test('MP3 loop rolls over with one decoder at a time, keeps scheduling ahead, and never retains whole-loop PCM',async()=>{
  const {music,tracker}=streamFixture({mp3Mode:'stream'},{frameCount:24});try{await music.play(url,{loop:true});await until(()=>tracker.decoders.length>=3);assert.equal(tracker.decoders.filter(item=>!item.closed).length,1);assert.ok(music.state().queuedSeconds<=4.03);tracker.context.currentTime=2;await delay(80);assert.ok(Math.abs(music.state().currentTime-(1.96%.576))<.001);assert.ok(music.state().decoderCount>=3);assert.equal(tracker.fetches,1);assert.equal(music.state().ended,false);}finally{await music.dispose();}
});

test('an explicit streamed seek keeps the compressed cache and warms MP3 frames before the requested position',async()=>{
  const {music,tracker}=streamFixture();try{await music.play(url);const before=tracker.chunks.length;await music.play(url,{position:140});const state=music.state();assert.equal(tracker.fetches,1);assert.ok(state.currentTime>=140&&state.currentTime<140.1);const tail=tracker.chunks.slice(before);assert.ok(tail.every(chunk=>chunk.timestamp>137000000));assert.ok(tracker.decoders.length>=2);assert.ok(tracker.decoders.slice(0,-1).every(item=>item.closed));assert.ok(state.peakQueueBytes<2*1024*1024);}finally{await music.dispose();}
});

test('late MP3 output after stop is closed without creating a source or reviving the next owner',async()=>{
  const controls={outputGate:deferred(),lateOutputs:true},{music,tracker}=streamFixture({},controls);try{const first=music.play(url).catch(e=>e);await until(()=>tracker.chunks.length>0);await music.stop();assert.equal((await first).name,'AbortError');const oldSourceCount=tracker.sources.length;controls.outputGate.resolve();await delay(10);assert.equal(tracker.sources.length,oldSourceCount);assert.ok(tracker.outputs.every(item=>item.closed));assert.equal(music.state().bufferBytes,0);assert.equal(music.state().src,'');}finally{await music.dispose();}
});

test('unsupported MP3 capability, queue budget and malformed output fail without native/full-media fallback',async()=>{
  const a=streamFixture({}, {supported:false});await assert.rejects(a.music.play(url),{code:'MUSIC_STREAM_UNAVAILABLE'});assert.equal(a.tracker.nativeDecodes,0);await a.music.dispose();
  const b=streamFixture({maxBufferBytes:1024});await assert.rejects(b.music.play(url),{code:'MUSIC_TOO_LARGE'});assert.equal(b.tracker.decoders.length,0);await b.music.dispose();
  const c=streamFixture({}, {frames:9000});await assert.rejects(c.music.play(url),{code:'MUSIC_DECODE_FAILED'});assert.ok(c.tracker.outputs.every(item=>item.closed));assert.ok(c.tracker.decoders.every(item=>item.closed));await c.music.dispose();
});

test('stream capability cancellation and initial decode timeout close decoders and do not report pending native allocations',async()=>{
  const controls={supportGate:deferred()},a=streamFixture({},controls),abort=new AbortController();const pending=a.music.play(url,{signal:abort.signal}).catch(e=>e);await until(()=>a.tracker.fetches===1);abort.abort();assert.equal((await pending).name,'AbortError');controls.supportGate.resolve();await delay(2);assert.equal(a.tracker.decoders.length,0);assert.equal((await a.music.dispose()).cleanupConfirmed,true);
  const gate=deferred(),b=streamFixture({timeoutMs:15},{outputGate:gate,lateOutputs:true});await assert.rejects(b.music.play(url),{code:'MUSIC_TIMEOUT'});assert.ok(b.tracker.decoders.every(item=>item.closed));assert.equal(b.music.state().pendingDecode,false);assert.equal((await b.music.dispose()).cleanupConfirmed,true);gate.resolve();await delay(5);assert.ok(b.tracker.outputs.every(item=>item.closed));
});

test('a gateway change fails the stream before another frame is submitted and stops every scheduled node',async()=>{
  const {music,tracker}=streamFixture();try{await music.play(url);tracker.gateway='http://next-account.test';await until(()=>music.state().lastError==='MUSIC_URL_INVALID');assert.equal(music.state().running,false);assert.ok(tracker.decoders.every(item=>item.closed));assert.ok(tracker.sources.every(item=>item.stopped||item.disconnected));assert.equal(music.state().compressedBytes,0);}finally{await music.dispose();}
});

test('the eight-frame bound includes work hidden behind decodeQueueSize, not only codec control messages',async()=>{
  const gate=deferred(),{music,tracker}=streamFixture({}, {outputGate:gate,dequeueEarly:true});try{const pending=music.play(url).catch(e=>e);await until(()=>tracker.chunks.length===8);await delay(100);assert.equal(tracker.decoders[0].decodeQueueSize,0);assert.equal(tracker.chunks.length,8);assert.equal(music.state().decoderInFlight,8);await music.stop();assert.equal((await pending).name,'AbortError');gate.resolve();await delay(2);}finally{await music.dispose();}
});
