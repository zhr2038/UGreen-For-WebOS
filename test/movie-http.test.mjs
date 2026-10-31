import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createMoviePlaybackService } from '../lib/movie-playback-service.mjs';
import { createMovieHttpHandler, movieSourceUrl } from '../lib/movie-http.mjs';

const config = { server:'https://private-nas.invalid', alias:'nas-a', username:'viewer', token:'SECRET_NAS_TOKEN_NEVER_PUBLIC', clientId:'private-client' };
const play = { file:{path:'/private/movie.mkv',duration:3600}, item:{id:1,categoryId:'one',libraryId:1,type:1,name:'Example'} };
const caps = { 'cap-a':'owner-a', 'cap-a-fresh':'owner-a', 'cap-b':'owner-b' };
const gate = () => {let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(predicate) {for(let i=0;i<100;i++){if(predicate())return;await delay(2);}throw new Error('Timed out waiting for test state');}
function response(body, type, status=200, extra={}) {const bytes=Buffer.from(body);const stream=Readable.from([bytes]);stream.statusCode=status;stream.headers={'content-type':type,'content-length':String(bytes.length),...extra};return stream;}

async function fixture(t, options={}) {
  const tracker={requests:[],clients:[],writes:[],auth:0,raw:Buffer.alloc(4096,0x61)};
  function nas(value) {
    const result={config:{...value},httpsAgent:{destroy(){result.destroyed=true;}},snapshot(){return nas(result.config);},
      async request(path,opts={}) {
        tracker.requests.push({path,opts,token:result.config.token});
        if(path.endsWith('/pre_info')||path.endsWith('/info'))return{resolution:'1920x1080',duration:3600000000,transcode:[{name:'720P',resolution:'1280x720'}],audios:[],subtitle:[],redir_link:'/ugreen/v2/stream/transcode/play?video_name=example.mp4'};
        if(path.endsWith('/subtitle/list'))return{result:['/private/movie.srt']};
        if(path.endsWith('/create')&&tracker.createGate)await tracker.createGate.promise;
        if(path.endsWith('/close')&&tracker.closeGate)await tracker.closeGate.promise;
        if(path.endsWith('/media_tracks'))return{audio_tracks:{index:-99,language:''},subtitle_tracks:{index:-99,type:0,language:''}};
        if(path.endsWith('/skipper'))return{switch_type:1,skipper_params:[{type:'op',start:0,end:60},{type:'ed',start:30,end:0}]};
        if(path.endsWith('/skipper/switch')){tracker.writes.push('skip');return{};}
        if(path.endsWith('/subtitles/search'))return{data:[{file_id:123,file_name:'Example.srt',language:'en',status:0}],page:1};
        if(path.endsWith('/subtitles/download/status')){tracker.writes.push('download');return{status:2,file_path:'/private/downloaded.srt'};}
        if(path.endsWith('/subtitles/delete')){tracker.writes.push('delete');return{};}
        return{};
      },
      async open(path,opts={}) {
        tracker.requests.push({path,opts,token:result.config.token});
        const task=opts.query?.task_id;
        if(path.endsWith('/m3u8'))return response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nchild.m3u8?task_id='+task+'\n','application/vnd.apple.mpegurl');
        if(path.endsWith('/child.m3u8'))return response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?task_id='+task+'"\n#EXTINF:5,\nget/segment.ts?task_id='+task+'\n','application/vnd.apple.mpegurl');
        if(path.endsWith('/subtitle'))return response('1\n00:00:01,000 --> 00:00:02,000\nExample\n','text/plain');
        if(path.endsWith('/key.bin'))return response(Buffer.alloc(16,0x56),'application/octet-stream');
        if(tracker.slowRaw){const stream=new Readable({read(){}});stream.statusCode=200;stream.headers={'content-type':'video/x-matroska','content-length':'1024'};stream.push(Buffer.alloc(512,0x47));tracker.slowStream=stream;return stream;}
        if(tracker.mediaError)throw Object.assign(new Error(config.token+' '+play.file.path),tracker.mediaError);
        const content=path.endsWith('/raw/get')?tracker.raw:Buffer.alloc(376,0x47);
        if(tracker.badBody)return response(tracker.badBody,tracker.mediaType||'application/octet-stream');
        if(tracker.unsatisfied)return response('PRIVATE ERROR','application/json',416,{'content-range':'bytes */'+content.length});
        const range=opts.headers?.Range;
        if(range){const [a,b]=range.slice(6).split('-');const start=a?Number(a):Math.max(0,content.length-Number(b)),end=a?(b?Number(b):content.length-1):content.length-1;return response(content.subarray(start,end+1),tracker.mediaType||'application/octet-stream',206,{'content-range':`bytes ${start}-${end}/${content.length}`,'accept-ranges':'bytes'});}
        return response(content,tracker.mediaType||'application/octet-stream',200,{'accept-ranges':'bytes'});
      }};
    tracker.clients.push(result);return result;
  }
  const upstream=nas(config);
  const movies=createMoviePlaybackService({makeUrl:movieSourceUrl,cleanupTimeoutMs:100,...options.service});
  const initial=movies.register('play-a','owner-a',upstream,play,{urlContext:{client:'cap-a'}});
  const rootPlays=new Map([['play-a',{owner:'owner-a',expires:Date.now()+3600000}]]);
  const handler=createMovieHttpHandler({movies,
    authenticate(req,url){tracker.auth++;const value=req.headers.authorization?.replace(/^Bearer /i,'')||url.searchParams.get('client');if(!caps[value])throw Object.assign(new Error('private auth '+config.token),{status:401});return caps[value];},
    validatePlay(id,owner){const value=rootPlays.get(id);return Boolean(value&&value.owner===owner&&value.expires>Date.now());},
    ...options.handler,
  });
  const server=http.createServer(async(req,res)=>{
    const context=options.context?.(req)||{};
    if(await handler(req,res,context))return;
    res.writeHead(404,{'content-type':'text/plain'});res.end('root fallback');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{tracker.createGate?.resolve();tracker.closeGate?.resolve();await movies.reset();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const request=(path,opts={})=>fetch(base+path,{...opts,headers:{Authorization:'Bearer cap-a',...opts.headers}});
  const post=(path,body,opts={})=>request(path,{method:'POST',body:JSON.stringify(body),...opts,headers:{'Content-Type':'application/json',...opts.headers}});
  const prepare=async()=>{const res=await post('/api/play/quality',{id:'play-a',qualityId:'720P@1280x720',action:'prepare'});assert.equal(res.status,200);return res.json();};
  return{tracker,movies,upstream,initial,handler,server,base,rootPlays,request,post,prepare};
}

test('only owned movie routes are handled; authentication, method checks and the root TTL precede NAS access',async t=>{
  const f=await fixture(t);const fallback=await f.request('/api/play');assert.equal(fallback.status,404);assert.equal(await fallback.text(),'root fallback');assert.equal(f.tracker.auth,0);
  const missing=await fetch(f.base+'/api/play/options?id=play-a');assert.equal(missing.status,401);
  const wrong=await f.request('/api/play/options?id=play-a',{headers:{Authorization:'Bearer cap-b'}});assert.equal(wrong.status,404);
  const method=await f.post('/api/play/options',{id:'play-a'});assert.equal(method.status,405);assert.equal(method.headers.get('allow'),'GET, HEAD');
  f.rootPlays.get('play-a').expires=0;const expired=await f.request('/media/play-a');assert.equal(expired.status,404);assert.equal(f.tracker.requests.length,0);
});

test('read-only options, skip ranges and saved NAS track metadata remain separate from actual decoder capabilities',async t=>{
  const f=await fixture(t);const options=await(await f.request('/api/play/options?id=play-a')).json();assert.equal(options.selected,'original');assert.equal(options.qualities.length,2);
  const skipped=await(await f.request('/api/play/skips?id=play-a&duration=3600')).json();assert.deepEqual(skipped.ranges,[{start:0,end:60,type:'op'},{start:3570,end:3600,type:'ed'}]);
  const tracks=await(await f.request('/api/play/track-preferences?id=play-a')).json();assert.equal(tracks.audio.index,-99);assert.deepEqual(f.tracker.writes,[]);
  const head=await f.request('/api/play/options?id=play-a',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.ok(Number(head.headers.get('content-length'))>10);
});

test('prepare, active, commit and discard keep the old source until the caller explicitly commits',async t=>{
  const f=await fixture(t),candidate=await f.prepare();assert.ok(candidate.candidateId);assert.equal(new URL(candidate.stream,f.base).searchParams.get('client'),'cap-a');
  const active=await(await f.request('/api/play/active?id=play-a')).json();assert.equal(active.sourceId,f.initial.sourceId);assert.equal(active.quality.id,'original');
  const committed=await f.post('/api/play/quality',{id:'play-a',candidateId:candidate.candidateId,action:'commit'});assert.equal(committed.status,200);
  const selected=await(await f.request('/api/play/active?id=play-a')).json();assert.equal(selected.sourceId,candidate.sourceId);assert.equal(selected.quality.id,'720P@1280x720');assert.equal(selected.candidateId,undefined);
  const next=await f.post('/api/play/quality',{id:'play-a',qualityId:'original'});const candidate2=await next.json();await f.post('/api/play/quality',{id:'play-a',candidateId:candidate2.candidateId,action:'discard'});
  assert.equal((await(await f.request('/api/play/active?id=play-a')).json()).sourceId,candidate.sourceId);
});

test('active is owner-bound and reconciles a successful commit whose HTTP response was lost',async t=>{
  const f=await fixture(t),a=await f.prepare();await f.post('/api/play/quality',{id:'play-a',candidateId:a.candidateId,action:'commit'});
  const b=await(await f.post('/api/play/quality',{id:'play-a',qualityId:'original'})).json();f.tracker.closeGate=gate();
  const lost=http.request(f.base+'/api/play/quality',{method:'POST',headers:{Authorization:'Bearer cap-a','Content-Type':'application/json'}});lost.on('error',()=>{});lost.end(JSON.stringify({id:'play-a',candidateId:b.candidateId,action:'commit'}));
  await until(()=>f.movies.active('play-a','owner-a',{urlContext:{client:'cap-a'}}).sourceId===b.sourceId);lost.destroy();f.tracker.closeGate.resolve();
  const current=await(await f.request('/api/play/active?id=play-a',{headers:{Authorization:'Bearer cap-a-fresh'}})).json();assert.equal(current.sourceId,b.sourceId);assert.ok(current.stream.endsWith('client=cap-a-fresh'));
  const denied=await f.request('/api/play/active?id=play-a',{headers:{Authorization:'Bearer cap-b'}});assert.equal(denied.status,404);
});

test('every HLS playlist level and key uses the current request capability and opaque source resources',async t=>{
  const f=await fixture(t),candidate=await f.prepare();
  assert.match(new URL(candidate.stream,f.base).pathname,/\/playlist\.m3u8$/);
  const master=await f.request(candidate.stream,{headers:{Authorization:'Bearer cap-a-fresh'}});assert.match(master.headers.get('content-type'),/application\/vnd.apple.mpegurl/);
  const masterText=await master.text();assert.equal(masterText.includes('task_id'),false);assert.equal(masterText.includes('private'),false);
  const child=masterText.split('\n').find(line=>line.startsWith('/api/'));assert.ok(child.endsWith('client=cap-a-fresh'));assert.match(new URL(child,f.base).pathname,/\/[a-f0-9]{32}\.m3u8$/);
  const childRes=await f.request(child,{headers:{Authorization:'Bearer cap-a'}});const childText=await childRes.text();const segment=childText.split('\n').find(line=>line.startsWith('/api/'));const key=childText.match(/URI="([^"]+)"/)[1];
  assert.ok(segment.endsWith('client=cap-a'));assert.ok(key.endsWith('client=cap-a'));assert.equal(childText.includes('.ts'),false);assert.equal(childText.includes('task_id'),false);
  const bytes=await f.request(segment,{headers:{Range:'bytes=188-375','If-Range':'"opaque-etag"'}});assert.equal(bytes.status,206);assert.equal(bytes.headers.get('content-range'),'bytes 188-375/376');assert.equal(bytes.headers.get('content-type'),'video/mp2t');assert.equal((await bytes.arrayBuffer()).byteLength,188);
  const keyRes=await f.request(key);assert.equal(keyRes.headers.get('content-type'),'application/octet-stream');assert.equal((await keyRes.arrayBuffer()).byteLength,16);
  const segmentRequest=f.tracker.requests.find(v=>v.path.endsWith('/segment.ts'));assert.equal(segmentRequest.opts.headers['If-Range'],'"opaque-etag"');assert.equal(segmentRequest.token,config.token);
  const head=await f.request(child,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.ok(Number(head.headers.get('content-length'))>0);assert.equal(head.headers.get('accept-ranges'),'none');
});

test('explicit HLS extensions preserve old bare URLs, owner isolation and manifest HEAD/Range behavior',async t=>{
  const f=await fixture(t),candidate=await f.prepare(),bare=candidate.stream.replace('/playlist.m3u8','');
  assert.equal((await f.request(bare)).status,200);
  const head=await f.request(candidate.stream,{method:'HEAD',headers:{Range:'bytes=0-7'}});assert.equal(head.status,200);assert.match(head.headers.get('content-type'),/application\/vnd.apple.mpegurl/);assert.equal(head.headers.get('accept-ranges'),'none');assert.equal(await head.text(),'');assert.ok(Number(head.headers.get('content-length'))>0);
  assert.equal((await f.request(candidate.stream,{headers:{Authorization:'Bearer cap-b'}})).status,404);
  const master=await(await f.request(candidate.stream)).text(),child=master.split('\n').find(line=>line.startsWith('/api/'));
  const legacyChild=new URL(child,f.base);legacyChild.pathname=legacyChild.pathname.slice(0,-5);assert.equal((await f.request(legacyChild.pathname+legacyChild.search)).status,200);
  const nested=await(await f.request(child)).text(),segment=nested.split('\n').find(line=>line.startsWith('/api/'));const spoof=new URL(segment,f.base);spoof.pathname+='.m3u8';const before=f.tracker.requests.length;assert.equal((await f.request(spoof.pathname+spoof.search)).status,404);assert.equal(f.tracker.requests.length,before);
  const original=new URL(f.initial.stream,f.base);original.pathname+='/playlist.m3u8';assert.equal((await f.request(original.pathname+original.search)).status,404);
  await f.post('/api/play/quality',{id:'play-a',candidateId:candidate.candidateId,action:'commit'});const active=await(await f.request('/api/play/active?id=play-a')).json();assert.match(new URL(active.stream,f.base).pathname,/\/playlist\.m3u8$/);
});

test('legacy media and an original source use the saved NAS account, with GET-backed HEAD and byte ranges',async t=>{
  const f=await fixture(t);f.upstream.config.token='GLOBAL_CHANGED_TOKEN';
  const head=await f.request('/media/play-a',{method:'HEAD',headers:{Range:'bytes=0-127'}});assert.equal(head.status,206);assert.equal(head.headers.get('content-type'),'video/x-matroska');assert.equal(head.headers.get('content-length'),'128');assert.equal(await head.text(),'');
  const raw=await f.request(f.initial.stream,{headers:{Range:'bytes=-64'}});assert.equal(raw.status,206);assert.equal((await raw.arrayBuffer()).byteLength,64);
  const opens=f.tracker.requests.filter(v=>v.path.endsWith('/raw/get'));assert.equal(opens.length,2);assert.ok(opens.every(v=>v.token===config.token&&v.opts.method==='GET'));assert.equal(opens[0].opts.headers.Range,'bytes=0-127');
  const invalid=await f.request('/media/play-a',{headers:{Range:'bytes=999-1'}});assert.equal(invalid.status,416);assert.equal(f.tracker.requests.filter(v=>v.path.endsWith('/raw/get')).length,2);
});

test('NAS 416 responses preserve only safe range metadata and never relay private JSON bodies',async t=>{
  const f=await fixture(t);f.tracker.unsatisfied=true;const result=await f.request('/media/play-a',{headers:{Range:'bytes=9999-10000'}});assert.equal(result.status,416);assert.equal(result.headers.get('content-range'),'bytes */4096');assert.equal((await result.text()).includes('PRIVATE'),false);
});

test('subtitle read/search have no write side effects; download/delete and NAS skip require explicit POST actions',async t=>{
  const f=await fixture(t);const options=await(await f.request('/api/play/options?id=play-a')).json(),subtitleId=options.subtitles[0].id;
  const read=await(await f.post('/api/play/subtitle',{id:'play-a',subtitleId,format:'vtt'})).json();assert.match(read.body,/^WEBVTT/);assert.deepEqual(f.tracker.writes,[]);
  const search=await(await f.post('/api/play/subtitle',{id:'play-a',action:'search',query:'Example',language:'en',page:1})).json();assert.deepEqual(f.tracker.writes,[]);
  assert.equal((await f.post('/api/play/subtitle',{id:'play-a',action:'download',resultId:search.items[0].id})).status,200);
  assert.equal((await f.post('/api/play/subtitle',{id:'play-a',action:'delete',subtitleId})).status,200);
  assert.equal((await f.post('/api/play/preferences',{id:'play-a',action:'skip',enabled:true})).status,200);assert.deepEqual(f.tracker.writes,['download','delete','skip']);
});

test('ordinary preferences are validated and close ends tasks without deleting root progress metadata',async t=>{
  const f=await fixture(t);const saved=await f.post('/api/play/preferences',{id:'play-a',preferences:{rate:1.5,mode:'loop_single'}});assert.equal(saved.status,200);assert.equal((await saved.json()).preferences.rate,1.5);
  assert.equal((await f.post('/api/play/preferences',{id:'play-a',preferences:{path:'/private/x'}})).status,400);
  await f.prepare();const closed=await f.post('/api/play/close',{id:'play-a'});assert.equal(closed.status,200);assert.equal((await closed.json()).cleanupConfirmed,true);assert.ok(f.rootPlays.has('play-a'));assert.equal((await f.request('/media/play-a')).status,404);
});

test('API shapes, duplicate query parameters, path escapes and body limits fail before private NAS operations',async t=>{
  const f=await fixture(t);
  for(const path of ['/api/play/options?id=play-a&id=play-a','/api/play/skips?id=play-a&duration=NaN','/api/play/source/play-a/%2Fprivate','/media/%2Fprivate'])assert.equal((await f.request(path)).status,400);
  for(const body of [[],{id:'play-a',path:'/private/x'},{id:'play-a',qualityId:'original',preferH264:false}])assert.equal((await f.post('/api/play/quality',body)).status,400);
  assert.equal((await f.request('/api/play/quality',{method:'POST',body:'{'})).status,400);
  assert.equal((await f.post('/api/play/quality',{id:'play-a',qualityId:'x'.repeat(17000)})).status,413);assert.equal(f.tracker.requests.length,0);
});

test('provider and unexpected error details never expose tokens, paths or authenticated URLs',async t=>{
  const f=await fixture(t);f.tracker.mediaError={code:1010};let result=await f.request('/media/play-a');assert.equal(result.status,401);assert.equal((await result.json()).nasCode,1010);
  f.tracker.mediaError={status:418};result=await f.request('/media/play-a');assert.equal(result.status,502);let text=await result.text();assert.equal(text.includes(config.token),false);assert.equal(text.includes(play.file.path),false);
  f.tracker.mediaError=null;f.tracker.badBody=JSON.stringify({code:1301,msg:config.token+' '+play.file.path});result=await f.request('/media/play-a');assert.equal(result.status,502);text=await result.text();assert.equal(text.includes(config.token),false);assert.equal(text.includes(play.file.path),false);
  f.tracker.mediaType='text/html';f.tracker.badBody='<html>'+config.token+'</html>';result=await f.request('/media/play-a');assert.equal(result.status,502);
});

test('candidate GETs do not extend expiry through HTTP and expired resources cannot replace the old source',async t=>{
  let now=0;const f=await fixture(t,{service:{now:()=>now,candidateTtlMs:120000}}),candidate=await f.prepare();now=119999;assert.equal((await f.request(candidate.stream)).status,200);now=120001;
  assert.ok([404,410].includes((await f.request(candidate.stream)).status));assert.equal((await(await f.request('/api/play/active?id=play-a')).json()).sourceId,f.initial.sourceId);
});

test('disconnecting a preparation aborts and cleans the candidate while late NAS completion cannot activate it',async t=>{
  const f=await fixture(t);f.tracker.createGate=gate();
  const pending=http.request(f.base+'/api/play/quality',{method:'POST',headers:{Authorization:'Bearer cap-a','Content-Type':'application/json'}});pending.on('error',()=>{});pending.end(JSON.stringify({id:'play-a',qualityId:'720P@1280x720'}));
  await until(()=>f.tracker.requests.some(r=>r.path.endsWith('/create')));pending.destroy();await until(()=>f.movies.get('play-a','owner-a').candidates.size===0);f.tracker.createGate.resolve();
  await until(()=>f.tracker.requests.some(r=>r.path.endsWith('/close')));assert.equal(f.movies.active('play-a','owner-a',{urlContext:{client:'cap-a'}}).sourceId,f.initial.sourceId);
});

test('an injected bridge proxy receives the origin snapshot, original Range and lifecycle signal',async t=>{
  let captured;const f=await fixture(t,{handler:{proxy:async(req,res,path,query,kind,nas,options)=>{captured={path,query,kind,nas,options,range:req.headers.range};res.writeHead(206,{'Content-Type':'video/x-matroska','Content-Length':1,'Content-Range':'bytes 0-0/4096'});res.end('a');}}});f.upstream.config.token='OTHER_ACCOUNT_TOKEN';
  const result=await f.request('/media/play-a',{headers:{Range:'bytes=0-0'}});assert.equal(result.status,206);assert.equal(captured.nas.config.token,config.token);assert.equal(captured.range,'bytes=0-0');assert.equal(captured.options.signal.aborted,false);assert.equal(captured.options.urlContext.client,'cap-a');assert.equal(captured.query.video_path,play.file.path);
});

test('disconnecting a media response aborts its NAS request and destroys the upstream body',async t=>{
  const f=await fixture(t);f.tracker.slowRaw=true;
  const pending=http.get(f.base+'/media/play-a',{headers:{Authorization:'Bearer cap-a'}},res=>{res.on('error',()=>{});res.once('data',()=>pending.destroy());});pending.on('error',()=>{});
  await until(()=>f.tracker.slowStream?.destroyed);const opened=f.tracker.requests.find(v=>v.path.endsWith('/raw/get'));assert.equal(opened.opts.signal.aborted,true);
});

test('a preauthenticated bridge owner still rewrites children with the current request capability',async t=>{
  const f=await fixture(t,{context:()=>({owner:'owner-a',urlContext:{client:'STALE_CAP'}})}),candidate=await f.prepare();const result=await f.request(candidate.stream,{headers:{Authorization:'Bearer cap-a-fresh'}});const text=await result.text();assert.ok(text.includes('client=cap-a-fresh'));assert.equal(text.includes('STALE_CAP'),false);assert.equal(f.tracker.auth,0);
});
