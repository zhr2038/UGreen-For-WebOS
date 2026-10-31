import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createMoviePlaybackService, validateMoviePreferences } from '../lib/movie-playback-service.mjs';

const configA={server:'https://account-a.zh.ug.link',alias:'account-a',username:'viewer',token:'PRIVATE_NAS_TOKEN_A',clientId:'client-a'};
const play={file:{path:'/private/film-a.mkv',duration:3600},item:{id:1,categoryId:'category-a',libraryId:1,type:1,name:'Example'}};
const variants=[{id:'original',label:'原画',original:true},{id:'720P@1280x720',label:'720P',resolution:'1280x720'},{id:'480P@720x400',label:'480P',resolution:'720x400'}];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
class FakeNas {
  constructor(config,tracker,parent=null){this.config={...config};this.tracker=tracker;this.parent=parent;this.closed=false;this.httpsAgent={destroy:()=>{this.closed=true;}};tracker.clients.push(this);}
  snapshot(){return new FakeNas(this.tracker.badDerived||this.config,this.tracker,this);}
  async request(path,options){if(this.closed)throw new Error('closed connection');this.tracker.requests.push({path,options,config:{...this.config}});return{};}
  async open(path,options){return this.request(path,options);}
}
class FakeSession {
  constructor(nas,play,tracker){this.nas=nas;this.play=play;this.tracker=tracker;this.id='task-'+tracker.sessions.length;tracker.sessions.push(this);this.closed=false;}
  async describe(){if(this.tracker.describeGate)await this.tracker.describeGate.promise;if(this.closed)throw new Error('session closed');await this.nas.request('pre_info');return{qualities:variants,subtitles:[{id:'external:one',kind:'external',codec:'srt',label:'subtitle.srt'}],audio:[],source:{resolution:'1920x1080'},selected:'original'};}
  async selectQuality(id){this.quality=id;await this.nas.request('create',{task_id:this.id});if(this.tracker.selectGate)await this.tracker.selectGate.promise;if(this.closed)throw new Error('cancelled session');return{kind:'hls',quality:variants.find(q=>q.id===id)};}
  async manifest(map){if(this.closed)throw new Error('session closed');await this.nas.request('m3u8');return{body:'#EXTM3U\n'+map('segment-one')+'\n',contentType:'application/vnd.apple.mpegurl'};}
  resource(id){if(id!=='segment-one')throw new Error('unknown segment');return{path:'/ugreen/v2/stream/transcode/get/private-segment.ts',query:{task_id:this.id},manifest:false};}
  async subtitle(){return{body:'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nExample\n',contentType:'text/vtt'};}
  async searchSubtitles(){return{items:[{id:'result-one',label:'Example',language:'en'}]};}
  async downloadSubtitle(){this.tracker.writes.push('download');return{status:2,subtitle:{id:'external:downloaded',codec:'srt',kind:'external',label:'downloaded.srt'}};}
  async deleteSubtitle(){this.tracker.writes.push('delete');return{ok:true};}
  async setSkipEnabled(enabled){this.tracker.writes.push({skip:enabled});return{enabled};}
  async skips(){return{enabled:false,ranges:[]};}
  async close(){if(this.closing)return this.closing;this.closed=true;this.closing=(async()=>{this.tracker.closes.push(this.id);if(this.tracker.failClose.has(this.id))throw new Error('PRIVATE_NAS_TOKEN_A private server error');if(this.tracker.hangClose.has(this.id))await new Promise(()=>{});await this.nas.request('close',{task_id:this.id});})();return this.closing;}
}
function fixture(options={}){
  const tracker={clients:[],sessions:[],requests:[],closes:[],writes:[],failClose:new Set(),hangClose:new Set()};const upstream=new FakeNas(configA,tracker);
  const service=createMoviePlaybackService({makeUrl:(v,context)=>'/movie/'+v.id+'/'+v.sourceId+(v.resourceId?'/'+v.resourceId:'')+'?client='+encodeURIComponent(context?.client||'LOCAL_CAP'),createSession:(nas,play)=>new FakeSession(nas,play,tracker),...options});
  return{tracker,upstream,service};
}
async function register(f,id='play-a',owner='owner-a'){return f.service.register(id,owner,f.upstream,play);}

test('all playback APIs enforce owner binding and private transport descriptors cannot serialize NAS credentials or paths',async t=>{
  const f=fixture();t.after(()=>f.service.reset());const original=await register(f);assert.equal(original.kind,'original');
  assert.throws(()=>f.service.raw('play-a','other'),/不存在/);await assert.rejects(f.service.options('play-a','other'),/不存在/);await assert.rejects(f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'other'),/不存在/);
  await assert.rejects(f.service.preferences({id:'play-a',preferences:{rate:1.5}},'other'),/不存在/);await assert.rejects(f.service.subtitle({id:'play-a',subtitleId:'external:one'},'other'),/不存在/);
  const descriptor=f.service.raw('play-a','owner-a');assert.equal(descriptor.path,play.file.path?'/'+'ugreen/v1/stream/transcode/raw/get':'');assert.equal(descriptor.query.video_path,play.file.path);assert.equal(descriptor.nas.config.token,configA.token);
  const client=JSON.stringify([original,descriptor,await f.service.options('play-a','owner-a')]);assert.equal(client.includes(configA.token),false);assert.equal(client.includes(play.file.path),false);
});

test('candidate connections derive from the initial account snapshot after the global account has changed',async t=>{
  const f=fixture();t.after(()=>f.service.reset());await register(f);f.upstream.config={...configA,server:'https://other.zh.ug.link',alias:'other',username:'other',token:'TOKEN_B'};
  const candidate=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a');assert.ok(candidate.candidateId);
  await f.service.manifest({id:'play-a',sourceId:candidate.sourceId},'owner-a');assert.ok(f.tracker.requests.length);assert.ok(f.tracker.requests.every(r=>r.config.token===configA.token));assert.equal(f.service.raw('play-a','owner-a').nas.config.token,configA.token);
  assert.equal(f.upstream.closed,false);
});

test('a broken snapshot implementation cannot silently move an existing play to a new account',async t=>{
  const f=fixture();t.after(()=>f.service.reset());await register(f);f.tracker.badDerived={...configA,token:'OTHER_ACCOUNT_TOKEN'};
  await assert.rejects(f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a'),/账户发生变化/);assert.equal(f.tracker.requests.length,0);assert.equal(f.service.active('play-a','owner-a').kind,'original');
});

test('prepare does not close the old source; decoder failure discard rolls back without disrupting it',async t=>{
  const f=fixture();t.after(()=>f.service.reset());await register(f);
  const first=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a');await f.service.commitQuality({id:'play-a',candidateId:first.candidateId},'owner-a');
  const old=f.tracker.sessions.find(s=>s.quality==='720P@1280x720');const second=await f.service.prepareQuality({id:'play-a',qualityId:'480P@720x400'},'owner-a');
  assert.equal(old.closed,false);assert.equal(f.service.active('play-a','owner-a').sourceId,first.sourceId);await f.service.discardQuality({id:'play-a',candidateId:second.candidateId},'owner-a');
  assert.equal(old.closed,false);assert.equal(f.service.active('play-a','owner-a').sourceId,first.sourceId);assert.equal(f.tracker.sessions.find(s=>s.quality==='480P@720x400').closed,true);
});

test('commit promotes the new source even when old close fails, returning a sanitized warning rather than false cleanup success',async t=>{
  const f=fixture();t.after(()=>f.service.reset());await register(f);const a=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a');await f.service.commitQuality({id:'play-a',candidateId:a.candidateId},'owner-a');
  const old=f.tracker.sessions.find(s=>s.quality==='720P@1280x720');f.tracker.failClose.add(old.id);const b=await f.service.prepareQuality({id:'play-a',qualityId:'480P@720x400'},'owner-a');const result=await f.service.commitQuality({id:'play-a',candidateId:b.candidateId},'owner-a');
  assert.equal(result.sourceId,b.sourceId);assert.equal(result.warnings[0].code,'OLD_SOURCE_CLEANUP_UNCONFIRMED');assert.equal(JSON.stringify(result).includes(configA.token),false);assert.equal(old.nas.config.token,configA.token);
  assert.equal((await f.service.options('play-a','owner-a')).selected,'480P@720x400');
});

test('candidate expiry is an absolute deadline capped at two minutes and GETs do not extend it',async t=>{
  let now=0;const f=fixture({now:()=>now,candidateTtlMs:999999});t.after(()=>f.service.reset());await register(f);const c=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a');assert.equal(c.expiresAt,120000);
  now=100000;await f.service.manifest({id:'play-a',sourceId:c.sourceId},'owner-a');f.service.resource({id:'play-a',sourceId:c.sourceId,resourceId:'segment-one'},'owner-a');
  now=120001;await assert.rejects(f.service.manifest({id:'play-a',sourceId:c.sourceId},'owner-a'),/取消|不存在/);assert.equal(f.service.active('play-a','owner-a').kind,'original');
});

test('cancelled preparation and late NAS results cannot become an active or accessible source',async t=>{
  const f=fixture();t.after(()=>f.service.reset());await register(f);f.tracker.selectGate=deferred();const abort=new AbortController();
  const pending=f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a',{signal:abort.signal});await new Promise(r=>setImmediate(r));assert.equal(f.tracker.sessions.filter(s=>s.quality).length,1);
  abort.abort();f.tracker.selectGate.resolve();await assert.rejects(pending,/取消|cancelled/);assert.equal(f.service.active('play-a','owner-a').kind,'original');assert.equal(f.service.get('play-a','owner-a').candidates.size,0);
});

test('a newer candidate supersedes only the older candidate, never the active source',async t=>{
  const f=fixture();t.after(()=>f.service.reset());await register(f);const a=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a');const b=await f.service.prepareQuality({id:'play-a',qualityId:'480P@720x400'},'owner-a');
  await assert.rejects(f.service.commitQuality({id:'play-a',candidateId:a.candidateId},'owner-a'),/不存在/);assert.equal(f.service.active('play-a','owner-a').kind,'original');assert.ok(b.candidateId);
});

test('HLS local URLs are mapped with the caller context while backend resource descriptors remain private',async t=>{
  const f=fixture();t.after(()=>f.service.reset());await register(f);const c=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a',{urlContext:{client:'cap with spaces'}});
  assert.ok(c.stream.includes('client=cap%20with%20spaces'));const manifest=await f.service.manifest({id:'play-a',sourceId:c.sourceId},'owner-a',{urlContext:{client:'own-cap'}});assert.ok(manifest.body.includes('client=own-cap'));
  const resource=f.service.resource({id:'play-a',sourceId:c.sourceId,resourceId:'segment-one'},'owner-a');assert.ok(resource.path.includes('/transcode/get/'));assert.equal(JSON.stringify(resource).includes('private-segment'),false);
});

test('preferences use an atomic opaque-account/item store, reject unsafe fields and isolate accounts',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'movie-prefs-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=fixture({dir});t.after(()=>f.service.reset());await register(f);
  await Promise.all([f.service.preferences({id:'play-a',preferences:{mode:'loop_list'}},'owner-a'),f.service.preferences({id:'play-a',preferences:{rate:1.5,subtitle:{offset:.05,color:'#FFFF00'}}},'owner-a')]);
  const value=(await f.service.options('play-a','owner-a')).preferences;assert.equal(value.mode,'loop_list');assert.equal(value.rate,1.5);assert.equal(value.subtitle.offset,.05);
  const raw=await readFile(join(dir,'movie-preferences.json'),'utf8');assert.equal(raw.includes(configA.token),false);assert.equal(raw.includes(play.file.path),false);assert.ok(Object.keys(JSON.parse(raw)).every(k=>/^[a-f0-9]{64}$/.test(k)));
  for(const preferences of [{rate:3},{mode:'random'},{subtitle:{offset:601}},{subtitle:{color:'red;url(evil)'}},{token:'bad'},{audio:{label:configA.token}},{audio:{label:play.file.path}}])await assert.rejects(f.service.preferences({id:'play-a',preferences},'owner-a'));
  f.upstream.config={...configA,username:'other',token:'TOKEN_B'};await register(f,'play-b','owner-b');assert.equal((await f.service.options('play-b','owner-b')).preferences.mode,'sort_list');
});

test('subtitle write operations and skip setting only execute after explicit actions and remain owner-scoped',async t=>{
  const f=fixture();t.after(()=>f.service.reset());await register(f);await f.service.options('play-a','owner-a');await f.service.subtitle({id:'play-a',subtitleId:'external:one'},'owner-a');assert.deepEqual(f.tracker.writes,[]);
  await assert.rejects(f.service.subtitle({id:'play-a',action:'delete',subtitleId:'external:one'},'wrong'),/不存在/);await f.service.subtitle({id:'play-a',action:'download',resultId:'result-one'},'owner-a');await f.service.subtitle({id:'play-a',action:'delete',subtitleId:'external:one'},'owner-a');await f.service.preferences({id:'play-a',action:'skip',enabled:true},'owner-a');assert.deepEqual(f.tracker.writes,['download','delete',{skip:true}]);
});

test('close/reset clear pending, active and metadata tasks and owned agents; close is idempotent',async()=>{
  const f=fixture();await register(f);await f.service.options('play-a','owner-a');const c=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a');await f.service.commitQuality({id:'play-a',candidateId:c.candidateId},'owner-a');await f.service.prepareQuality({id:'play-a',qualityId:'480P@720x400'},'owner-a');
  const result=await f.service.close('play-a','owner-a');assert.equal(result.cleanupConfirmed,true);assert.equal((await f.service.close('play-a','owner-a')).closed,true);assert.ok(f.tracker.sessions.every(s=>s.closed));assert.ok(f.tracker.clients.filter(c=>c!==f.upstream).every(c=>c.closed));assert.equal(f.upstream.closed,false);assert.equal((await f.service.reset()).closed,0);
});

test('hung cleanup is bounded, destroys its transport and reports uncertainty',async()=>{
  const f=fixture({cleanupTimeoutMs:10});await register(f);const c=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a');const session=f.tracker.sessions.find(s=>s.quality);f.tracker.hangClose.add(session.id);
  const result=await f.service.discardQuality({id:'play-a',candidateId:c.candidateId},'owner-a');assert.ok(result.warnings.length);await assert.rejects(session.nas.request('late-request'),/取消/);await f.service.reset();
});

test('preference validation accepts only finite bounded fields and plain objects',()=>{
  for(const value of [null,[],{rate:Infinity},{audio:{index:-1}},{subtitle:{position:100}},{subtitle:{selection:{kind:'off',path:'/private'}}},Object.create({rate:1})])assert.throws(()=>validateMoviePreferences(value));
  assert.deepEqual(validateMoviePreferences({fit:'contain',subtitle:{selection:{kind:'off'},opacity:.8}}),{fit:'contain',subtitle:{selection:{kind:'off'},opacity:.8}});
});

test('snapshot aliases are rejected without destroying the upstream or active transport',async t=>{
  const f=fixture();t.after(()=>f.service.reset());const snapshot=f.upstream.snapshot;
  f.upstream.snapshot=()=>f.upstream;
  assert.throws(()=>f.service.register('bad','owner-a',f.upstream,play),/独立/);assert.equal(f.upstream.closed,false);
  f.upstream.snapshot=()=>({config:{...f.upstream.config},httpsAgent:f.upstream.httpsAgent,request(){},open(){}});
  assert.throws(()=>f.service.register('bad','owner-a',f.upstream,play),/独立/);assert.equal(f.upstream.closed,false);
  f.upstream.snapshot=snapshot;await register(f);
  const seed=f.tracker.clients[1];seed.snapshot=()=>seed;
  await assert.rejects(f.service.prepareQuality({id:'play-a',qualityId:'original'},'owner-a'),/独立/);assert.equal(seed.closed,false);
  assert.equal(f.service.raw('play-a','owner-a').nas.config.token,configA.token);
});

test('queued preferences from a closed registration cannot cross into a reused playback ID',async t=>{
  const f=fixture();t.after(()=>f.service.reset());await register(f);
  const gate=deferred();f.service.writeTail=gate.promise;
  const pending=f.service.preferences({id:'play-a',preferences:{rate:2}},'owner-a');
  await f.service.close('play-a','owner-a');await register(f);gate.resolve();
  await assert.rejects(pending,/取消/);assert.equal((await f.service.options('play-a','owner-a')).preferences.rate,1);
});

test('a superseded commit cannot return its stale source after another commit has won',async t=>{
  const f=fixture();t.after(()=>f.service.reset());await register(f);
  const old=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a');await f.service.commitQuality({id:'play-a',candidateId:old.candidateId},'owner-a');
  const session=f.tracker.sessions.find(s=>s.quality==='720P@1280x720'),gate=deferred();session.close=()=>gate.promise;
  const a=await f.service.prepareQuality({id:'play-a',qualityId:'480P@720x400'},'owner-a');
  const stale=f.service.commitQuality({id:'play-a',candidateId:a.candidateId},'owner-a');
  const b=await f.service.prepareQuality({id:'play-a',qualityId:'original'},'owner-a');await f.service.commitQuality({id:'play-a',candidateId:b.candidateId},'owner-a');
  gate.resolve();await assert.rejects(stale,/取消/);assert.equal(f.service.active('play-a','owner-a').sourceId,b.sourceId);
});

test('a prior unconfirmed old-task cleanup remains visible in final close',async()=>{
  const f=fixture();await register(f);const a=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a');await f.service.commitQuality({id:'play-a',candidateId:a.candidateId},'owner-a');
  f.tracker.failClose.add(f.tracker.sessions.find(s=>s.quality).id);
  const b=await f.service.prepareQuality({id:'play-a',qualityId:'original'},'owner-a');await f.service.commitQuality({id:'play-a',candidateId:b.candidateId},'owner-a');
  const closed=await f.service.close('play-a','owner-a');assert.equal(closed.cleanupConfirmed,false);assert.equal(closed.warnings[0].code,'OLD_SOURCE_CLEANUP_UNCONFIRMED');
});

test('commit URL validation fails before the active source is replaced',async t=>{
  const f=fixture({makeUrl:(v,context)=>context?.bad?'https://external.invalid/':'/source/'+v.sourceId});t.after(()=>f.service.reset());await register(f);
  const original=f.service.active('play-a','owner-a');const candidate=await f.service.prepareQuality({id:'play-a',qualityId:'720P@1280x720'},'owner-a');
  await assert.rejects(f.service.commitQuality({id:'play-a',candidateId:candidate.candidateId},'owner-a',{urlContext:{bad:true}}),/地址无效/);
  assert.equal(f.service.active('play-a','owner-a').sourceId,original.sourceId);assert.ok(f.service.get('play-a','owner-a').candidates.has(candidate.candidateId));
});

test('real PlaybackSession integration rewrites HLS, isolates task IDs and sanitizes provider failure details',async()=>{
  const requests=[],agents=[];let listFails=true;
  function client(config){
    const nas={config:{...config},httpsAgent:{destroy(){agents.push(nas);}},snapshot(){return client(nas.config);},
      async request(path,options={}){
        requests.push({path,options,token:nas.config.token});
        if(path.endsWith('/pre_info')||path.endsWith('/info'))return{resolution:'1920x1080',transcode:[{name:'720P',resolution:'1280x720'}],audios:[],subtitle:[],redir_link:'/ugreen/v2/stream/transcode/play?video_name=test.mp4'};
        if(path.endsWith('/subtitle/list')){if(listFails)throw Object.assign(new Error(configA.token+' '+play.file.path),{code:1301});return{result:['/private/subtitle.srt']};}
        return{};
      },
      async open(path,options={}){
        requests.push({path,options,token:nas.config.token});
        const response=Readable.from([Buffer.from('#EXTM3U\n#EXTINF:5,\n/ugreen/v2/stream/transcode/get/test-001.ts?task_id='+options.query.task_id+'\n')]);response.statusCode=200;return response;
      }};return nas;
  }
  const upstream=client(configA),service=createMoviePlaybackService({makeUrl:(value,context)=>'/hls/'+value.sourceId+(value.resourceId?'/'+value.resourceId:'')+'?client='+context?.client});
  service.register('real','owner',upstream,play);const info=await service.options('real','owner');assert.equal(info.warnings[0].message,'NAS 播放请求失败（错误码 1301）');assert.equal(JSON.stringify(info).includes(configA.token),false);assert.equal(JSON.stringify(info).includes(play.file.path),false);
  const a=await service.prepareQuality({id:'real',qualityId:'720P@1280x720'},'owner',{urlContext:{client:'cap-a'}});const manifest=await service.manifest({id:'real',sourceId:a.sourceId},'owner',{urlContext:{client:'cap-a'}});
  assert.ok(manifest.body.includes('?client=cap-a'));assert.equal(manifest.body.includes('test-001'),false);assert.equal(manifest.body.includes('task_id'),false);
  const create=requests.find(r=>r.path.endsWith('/create'));assert.equal(create.options.body.video_path,play.file.path);assert.equal(create.options.body.src_type,2);
  const read=requests.find(r=>r.path.endsWith('/m3u8'));assert.equal(read.options.query.task_id,create.options.body.task_id);
  await service.discardQuality({id:'real',candidateId:a.candidateId},'owner');assert.ok(requests.some(r=>r.path.endsWith('/close')&&r.options.query.task_id===create.options.body.task_id));
  assert.equal(service.active('real','owner').kind,'original');await service.close('real','owner');assert.equal(agents.length,4);assert.ok(requests.every(r=>r.token===configA.token));
});
