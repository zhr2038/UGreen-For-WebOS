import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from '../lib/bridge.mjs';

const cap='bridge-playback-primary-cap', other='bridge-playback-other-cap';
const configA={server:'https://account-a.invalid',alias:'account-a',token:'PRIVATE_FAKE_ACCOUNT_A',username:'viewer-a',clientId:'a'};
const configB={server:'https://account-b.invalid',alias:'account-b',token:'PRIVATE_FAKE_ACCOUNT_B',username:'viewer-b',clientId:'b'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await delay(2);}throw new Error('test state timeout');}
function stream(body,type='application/octet-stream',status=200,extra={}){const bytes=Buffer.from(body),result=Readable.from([bytes]);result.headers={'content-type':type,'content-length':String(bytes.length),...extra};result.statusCode=status;return result;}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'bridge-movie-')),config={...configA},tracker={clients:[],requests:[],writes:[]};
  await writeFile(join(dir,'clients.json'),JSON.stringify({[createHash('sha256').update(other).digest('hex')]:{expires:Number.MAX_SAFE_INTEGER}}));
  function client(value,shared=false){const nas={config:shared?value:{...value},httpsAgent:{destroy(){nas.destroyed=true;}},snapshot(){return client(nas.config);},
    async request(path,options={}){
      if(nas.destroyed)throw new Error('Closed progress snapshot');tracker.requests.push({nas,path,options,token:nas.config.token});
      if(path.endsWith('/getMovie')){if(tracker.detailGate)await tracker.detailGate.promise;return{video_info:{ug_video_info_id:1,media_lib_set_id:1,category_id:'category-1',type:1,name:'Example',duration:3600,file_path:['/private/movie.mkv']},file_information:[{path:'/private/movie.mkv',duration:3600}],play_status:{recently_played_file_path:'/private/movie.mkv',current_play_time:12}};}
      if(path.endsWith('/pre_info')||path.endsWith('/info'))return{resolution:'1920x1080',transcode:[{name:'720P',resolution:'1280x720'}],audios:[],subtitle:[],redir_link:'/ugreen/v2/stream/transcode/play?video_name=example.mp4'};
      if(path.endsWith('/subtitle/list'))return{result:[]};
      if(path.endsWith('/recently_played/create')){if(tracker.progressError)throw new Error('NAS error '+nas.config.token+' /private/movie.mkv');tracker.writes.push({nas,token:nas.config.token,body:options.body});if(tracker.progressGate)await tracker.progressGate.promise;return{};}
      return{};
    },async open(path,options={}){
      if(nas.destroyed)throw new Error('Closed stream snapshot');tracker.requests.push({nas,path,options,token:nas.config.token});
      if(path.endsWith('/m3u8'))return stream('#EXTM3U\n#EXTINF:5,\nget/segment.ts?task_id='+options.query.task_id+'\n','application/vnd.apple.mpegurl');
      const bytes=Buffer.alloc(path.endsWith('/raw/get')?1024:376,0x47),range=options.headers?.Range;
      if(range){const [start,end]=range.slice(6).split('-').map(Number);return stream(bytes.subarray(start,end+1),path.endsWith('/raw/get')?'video/x-matroska':'video/mp2t',206,{'content-range':`bytes ${start}-${end}/${bytes.length}`,'accept-ranges':'bytes'});}
      return stream(bytes,'video/x-matroska');
    }};tracker.clients.push(nas);return nas;}
  const nas=client(config,true),bridge=await createBridge({dir,config,nasClient:nas,thumbnails:{make(){throw new Error('thumbnail not requested');}},host:'127.0.0.1',port:0,clientToken:cap});
  const base='http://127.0.0.1:'+bridge.server.address().port;
  t.after(async()=>{tracker.detailGate?.resolve();tracker.progressGate?.resolve();await bridge.reset();bridge.server.closeAllConnections();await new Promise(r=>bridge.server.close(r));await until(()=>nas.destroyed);await rm(dir,{recursive:true,force:true});});
  const request=(path,options={})=>fetch(base+path,{...options,headers:{Authorization:'Bearer '+cap,...options.headers}});
  const post=(path,body,options={})=>request(path,{method:'POST',body:JSON.stringify(body),...options,headers:{'Content-Type':'application/json',...options.headers}});
  const play=async()=>{const result=await post('/api/play',{id:1,type:1,library:1});assert.equal(result.status,200);return result.json();};
  return{bridge,base,tracker,config,nas,request,post,play};
}

test('createBridge handles original, prepare, manifest, commit, active, Range, progress and close as one HTTP flow',async t=>{
  const f=await fixture(t),play=await f.play();assert.equal(play.kind,'original');assert.equal(play.position,12);
  const raw=await f.request(play.stream,{method:'HEAD',headers:{Range:'bytes=0-127'}});assert.equal(raw.status,206);assert.equal(raw.headers.get('content-length'),'128');assert.equal(await raw.text(),'');
  const options=await(await f.request('/api/play/options?id='+play.id)).json();assert.equal(options.qualities.length,2);
  const c=await(await f.post('/api/play/quality',{id:play.id,qualityId:options.qualities[1].id})).json();assert.ok(c.candidateId);
  assert.equal((await(await f.request('/api/play/active?id='+play.id)).json()).sourceId,play.sourceId);
  const manifest=await(await f.request(c.stream)).text(),segment=manifest.split('\n').find(v=>v.startsWith('/api/'));assert.ok(segment.includes('client='+cap));
  assert.equal((await f.post('/api/play/quality',{id:play.id,candidateId:c.candidateId,action:'commit'})).status,200);
  const selected=await(await f.request('/api/play/active?id='+play.id)).json();assert.equal(selected.sourceId,c.sourceId);
  const part=await f.request(segment,{headers:{Range:'bytes=188-375'}});assert.equal(part.status,206);assert.equal((await part.arrayBuffer()).byteLength,188);
  assert.equal((await f.post('/api/progress',{id:play.id,position:80,duration:3600})).status,200);
  assert.equal((await f.post('/api/play/close',{id:play.id})).status,200);
  assert.equal((await f.post('/api/progress',{id:play.id,position:90,duration:3600})).status,200);
  assert.equal((await f.request(selected.stream)).status,404);assert.equal(f.tracker.writes.length,2);assert.ok(f.tracker.writes.every(v=>v.token===configA.token));assert.equal(f.tracker.writes[0].nas.destroyed,undefined);
});

test('old progress and media never use the new global account, including after a new play has begun',async t=>{
  const f=await fixture(t),a=await f.play();Object.assign(f.config,configB);const b=await f.play();
  assert.equal((await f.post('/api/progress',{id:a.id,position:10,duration:3600})).status,200);assert.equal((await f.post('/api/progress',{id:b.id,position:20,duration:3600})).status,200);
  assert.deepEqual(f.tracker.writes.map(v=>v.token),[configA.token,configB.token]);assert.equal((await f.request('/media/'+a.id,{headers:{Range:'bytes=0-15'}})).status,206);assert.equal(f.tracker.requests.at(-1).token,configA.token);
  const denied=await f.post('/api/progress',{id:a.id,position:30,duration:3600},{headers:{Authorization:'Bearer '+other}});assert.equal(denied.status,404);assert.equal(f.tracker.writes.length,2);
});

test('account reset closes old source tasks and rejects queued old IDs before a new account can receive progress',async t=>{
  const f=await fixture(t),a=await f.play();await f.request('/api/play/options?id='+a.id);await f.post('/api/play/quality',{id:a.id,qualityId:'720P@1280x720'});
  await f.bridge.reset();Object.assign(f.config,configB);
  assert.equal((await f.post('/api/progress',{id:a.id,position:30,duration:3600})).status,404);assert.equal((await f.request(a.stream)).status,404);
  const b=await f.play();assert.equal((await f.post('/api/progress',{id:b.id,position:40,duration:3600})).status,200);assert.deepEqual(f.tracker.writes.map(v=>v.token),[configB.token]);assert.equal(f.nas.destroyed,undefined);
  const closes=f.tracker.requests.filter(v=>v.path.endsWith('/close'));assert.ok(closes.length>=2);assert.ok(closes.every(v=>v.token===configA.token));
});

test('an in-flight play detail cancelled by reset returns 410 and releases its unregistered snapshot',async t=>{
  const f=await fixture(t);f.tracker.detailGate=deferred();const pending=f.post('/api/play',{id:1,type:1,library:1},{signal:AbortSignal.timeout(1000)});
  await until(()=>f.tracker.requests.some(v=>v.path.endsWith('/getMovie')));const detail=f.tracker.requests.find(v=>v.path.endsWith('/getMovie'));await f.bridge.reset();Object.assign(f.config,configB);f.tracker.detailGate.resolve();
  const result=await pending;assert.equal(result.status,410);await until(()=>detail.nas.destroyed);assert.equal(f.tracker.writes.length,0);
});

test('progress failures do not disclose private NAS paths or the original account token',async t=>{
  const f=await fixture(t),play=await f.play();f.tracker.progressError=true;const result=await f.post('/api/progress',{id:play.id,position:50,duration:3600}),body=await result.text();assert.equal(result.status,502);assert.equal(body.includes(configA.token),false);assert.equal(body.includes('/private/movie.mkv'),false);
});
