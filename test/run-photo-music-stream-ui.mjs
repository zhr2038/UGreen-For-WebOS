// Real browser / real MP3 regression. All GainNodes remain zero throughout.
import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..'),session='photo-music-stream-'+process.pid;
const encoded=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=198','-ac','2','-c:a','libmp3lame','-b:a','96k','-f','mp3','pipe:1'],{maxBuffer:4*1024*1024,windowsHide:true});
if(encoded.status!==0)throw Error('Synthetic MP3 generation failed; ffmpeg with libmp3lame is required');
const longMp3=encoded.stdout,shortMp3=await readFile(join(root,'test/fixtures/audio/photo-music-tone.mp3'));
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<meta charset="utf-8"><button id="go">Silent MP3 stream test</button><script src="/photo-music.js"></script>');return;}
  if(url.pathname==='/photo-music.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(join(root,'app/photo-music.js')));return;}
  if(/^\/photo-music\/[a-f0-9]{40}$/.test(url.pathname)&&url.searchParams.get('client')==='synthetic-stream-client'){
    const body=url.pathname.endsWith('b'.repeat(40))?shortMp3:longMp3;
    res.writeHead(200,{'Content-Type':'audio/mpeg','Content-Length':body.length});res.end(body);return;
  }
  res.writeHead(404);res.end();
});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
const code=`async page=>{
  const base=${JSON.stringify(base)},cases=[];const assert=(value,message)=>{if(!value)throw Error(message);};const test=async(name,fn)=>{try{cases.push({name,ok:true,details:await fn()});}catch(error){cases.push({name,ok:false,error:error.message});}};
  async function boot(options={}){
    await page.goto(base);
    await page.evaluate(({base,options})=>{
      window.musicUrl=char=>base+'/photo-music/'+char.repeat(40)+'?client=synthetic-stream-client';window.contexts=[];window.gains=[];window.nativeDecodes=0;window.nonzeroPcm=false;window.maximumRetained=0;window.maximumQueue=0;window.rates=[];window.ownerOrigin=base;
      const createContext=()=>{const ctx=new AudioContext();contexts.push(ctx);const createGain=ctx.createGain.bind(ctx),createBufferSource=ctx.createBufferSource.bind(ctx);ctx.createGain=()=>{const node=createGain();node.gain.value=0;gains.push(node);return node;};ctx.decodeAudioData=()=>{nativeDecodes++;throw Error('No full-song decode allowed in streaming tests');};ctx.createBufferSource=()=>{const node=createBufferSource(),start=node.start.bind(node);node.start=(...args)=>{if(node.buffer){rates.push(node.buffer.sampleRate);const samples=node.buffer.getChannelData(0);for(let i=0;i<samples.length;i+=23)if(Math.abs(samples[i])>.001){nonzeroPcm=true;break;}}return start(...args);};return node;};return ctx;};
      window.music=createPhotoMusic({getGateway:()=>ownerOrigin,createContext,volume:0,timeoutMs:8000,...options});
      document.querySelector('#go').onclick=()=>{window.result=null;music.play(musicUrl('a'),{loop:true}).then(value=>result={ok:true,value},error=>result={ok:false,code:error.code});};
    },{base,options});
  }
  await test('198-second 48k stereo MP3 starts through actual AudioDecoder with bounded PCM and zero Gain',async()=>{
    await boot();await page.click('#go');await page.waitForFunction(()=>result);const value=await page.evaluate(()=>({result,state:music.state(),nativeDecodes,contexts:contexts.length,gains:gains.map(g=>g.gain.value),htmlAudio:document.querySelectorAll('audio').length,nonzeroPcm}));
    assert(value.result.ok&&value.state.mode==='mp3-stream'&&value.state.running,'MP3 stream did not start: '+JSON.stringify(value.result));assert(value.state.duration>197&&value.state.duration<199&&value.state.compressedBytes<4*1024*1024,'duration or compressed bytes');assert(value.nativeDecodes===0&&value.contexts===1&&value.htmlAudio===0&&value.gains.every(v=>v===0)&&value.nonzeroPcm,'full decode, media fallback, empty PCM or nonzero Gain');return{duration:value.state.duration,compressedBytes:value.state.compressedBytes,queueBytes:value.state.queueBytes,sampleRate:48000};
  });
  await test('actual context-clock playback recycles the PCM queue over multiple decoder batches',async()=>{
    const initial=await page.evaluate(()=>music.state().currentTime);let last;
    for(let i=0;i<12;i++){await page.waitForTimeout(100);last=await page.evaluate(()=>{const value=music.state();maximumRetained=Math.max(maximumRetained,value.peakQueueBytes);maximumQueue=Math.max(maximumQueue,value.queuedSeconds);return{...value,maximumRetained,maximumQueue};});}
    assert(last.running&&last.currentTime>initial+.8&&last.maximumRetained<2*1024*1024&&last.maximumQueue<=4.1&&last.decoderQueueSize<=8&&last.decoderOutputs>60,'queue not bounded/recycled');return{currentTime:last.currentTime,peakQueueBytes:last.maximumRetained,maximumQueuedSeconds:last.maximumQueue,outputs:last.decoderOutputs};
  });
  await test('real pause/resume preserves position and queued PCM without another request or decoder',async()=>{
    const paused=await page.evaluate(async()=>{await music.pause();return music.state();});await page.waitForTimeout(180);const before=await page.evaluate(()=>music.state());assert(before.paused&&Math.abs(before.currentTime-paused.currentTime)<.005,'pause drift');await page.evaluate(()=>music.resume());await page.waitForTimeout(220);const after=await page.evaluate(()=>music.state());assert(after.running&&after.currentTime>paused.currentTime+.12&&after.fetches===1&&after.decoderCount===1,'resume lost source or refetched');return{pausedAt:paused.currentTime,resumedAt:after.currentTime,fetches:after.fetches};
  });
  await test('real MP3 seek uses reservoir warmup and loop schedules a new decoder without a second fetch/context',async()=>{
    await page.evaluate(()=>music.play(musicUrl('a'),{position:197,loop:true}));await page.waitForTimeout(1600);const value=await page.evaluate(()=>({state:music.state(),nonzeroPcm,gains:gains.map(g=>g.gain.value),contexts:contexts.length}));assert(value.state.running&&value.state.currentTime<2&&value.state.decoderCount>=2&&value.state.fetches===1&&value.contexts===1&&value.nonzeroPcm&&value.gains.every(v=>v===0),'seek/loop failed');return{position:value.state.currentTime,decoderCount:value.state.decoderCount,queueBytes:value.state.queueBytes};
  });
  await test('stop/dispose release every stream resource and actual context',async()=>{
    const value=await page.evaluate(async()=>{await music.stop();const stopped=music.state();const disposed=await music.dispose();return{stopped,disposed};});assert(value.stopped.bufferBytes===0&&value.stopped.paused&&value.disposed.cleanupConfirmed&&value.disposed.contextState==='closed','stream cleanup failed');return{cleanupConfirmed:value.disposed.cleanupConfirmed};
  });
  await test('real MPEG2 22.05k MP3 loops under forced streaming and keeps Gain zero',async()=>{
    await boot({mp3Mode:'stream'});await page.evaluate(()=>document.querySelector('#go').onclick=()=>music.play(musicUrl('b'),{loop:true}).then(value=>window.shortResult={ok:true,value},error=>window.shortResult={ok:false,code:error.code}));await page.click('#go');await page.waitForFunction(()=>window.shortResult);await page.waitForTimeout(800);const value=await page.evaluate(()=>({result:shortResult,state:music.state(),rates:[...new Set(rates)],nativeDecodes,nonzeroPcm,gains:gains.map(g=>g.gain.value)}));assert(value.result.ok&&value.state.running&&value.state.decoderCount>=2&&value.rates.includes(22050)&&value.nativeDecodes===0&&value.nonzeroPcm&&value.gains.every(v=>v===0),'MPEG2 streaming failed: '+JSON.stringify(value));await page.evaluate(()=>music.dispose());return{duration:value.state.duration,rates:value.rates,decoderCount:value.state.decoderCount};
  });
  await test('natural stream end and an end-position seek settle without a timeout or active source',async()=>{
    await boot({mp3Mode:'stream'});await page.evaluate(()=>music.play(musicUrl('b'),{loop:false}));await page.waitForTimeout(750);const ended=await page.evaluate(()=>music.state());assert(ended.ended&&ended.paused&&!ended.running,'natural end missing');const end=await page.evaluate(async()=>{await music.play(musicUrl('b'),{position:999});return music.state();});assert(end.ended&&end.paused&&!end.loading&&end.fetches===1,'end seek timeout/refetch');await page.evaluate(()=>music.dispose());return{ended:ended.ended,endPositionSettled:true};
  });
  const report={passed:cases.filter(c=>c.ok).length,failed:cases.filter(c=>!c.ok).length,cases,audibleVerified:false};if(report.failed)throw Error(JSON.stringify(report));return report;
}`;
await mkdir(join(root,'.local'),{recursive:true});await mkdir(join(root,'output/playwright'),{recursive:true});const runtime=join(root,'.local/photo-parity-music-stream-runtime.js');await writeFile(runtime,code);let log='';
async function cli(args){const child=spawn(process.execPath,[join(root,'node_modules/@playwright/cli/playwright-cli.js'),'-s='+session,...args],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const[status]=await once(child,'exit');log+=output;return{status,output};}
try{const opened=await cli(['open','about:blank','--browser=chrome']);if(opened.status)throw Error(opened.output);const result=await cli(['run-code','--filename='+runtime]);const start=result.output.indexOf('### Result'),end=result.output.indexOf('### Ran Playwright code',start);console.log(start>=0?result.output.slice(start,end<0?undefined:end).trim():result.output);process.exitCode=result.status;}
finally{await cli(['close']);server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(join(root,'output/playwright/photo-music-stream-proof.log'),log);}
