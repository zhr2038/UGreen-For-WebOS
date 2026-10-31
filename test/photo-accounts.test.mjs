import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable,PassThrough} from 'node:stream';
import {Photos} from '../lib/photos.mjs';
import {UgOS} from '../lib/ugos.mjs';
import {AdaptiveNas} from '../lib/adaptive-nas.mjs';

const owner='same-tv-owner',raw={picture_id:8,file_name:'synthetic.jpg',real_ext_name:'jpg',width:4000,height:3000,livephoto_type:1};
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<100;i++){if(check())return;await turn();}throw Error('Offline condition timeout');}
function response(bytes=Buffer.from([1,2,3])){const stream=Readable.from([bytes]);stream.statusCode=200;stream.headers={'content-type':'image/jpeg'};return stream;}
function data(path){
  if(path.endsWith('picture/info'))return raw;
  if(path.endsWith('folder/list'))return{folders:[{path:'/synthetic-only',folder_name:'Synthetic folder',covers:[raw]}],files:[raw]};
  if(path.endsWith('music/check'))return{builtin_music:[{music_id:'same-track',name:'Synthetic track',available:true,resource_ticket:'synthetic-private-ticket'}],custom_music:[]};
  if(path.endsWith('album/recommend'))return{list:[{recommend_type:'event',name:'Synthetic memory',event_uuid:'synthetic-event',cover:raw}]};
  if(path.endsWith('figure/list'))return{list:[{uuid:'same-person',name:'Synthetic person',cover:raw}]};
  if(path.endsWith('album/list'))return{result:[{album_uuid:'same-album',album_type:2,album_name:'Synthetic album',cover:raw}],total:1};
  if(path.endsWith('/transcode/info'))return{resolution:'3840x2160',redir_link:'/ugreen/v2/stream/transcode/play?video_name=synthetic',transcode:[{name:'1080P',resolution:'1920x1080'}]};
  return{list:[raw],total:1};
}
class FakeNas{
  constructor(state,config={server:'https://nas.invalid',alias:'synthetic-a',username:'a',token:'synthetic-private-token-a'}){this.state=state;this.config={...config};this.id=state.next++;this.httpsAgent={destroy:()=>state.destroyed.add(this.id)};}
  snapshot(){return new FakeNas(this.state,this.config);}
  async request(path,options={}){this.state.calls.push({method:'request',path,options,id:this.id,token:this.config.token});const gate=this.state.hold?.(path,options,this);if(gate)await gate;return data(path);}
  async open(path,options={}){this.state.calls.push({method:'open',path,options,id:this.id,token:this.config.token});if(this.state.open)return this.state.open(path,options,this);return response();}
}
function fixture(t){const state={next:0,calls:[],destroyed:new Set()},nas=new FakeNas(state),photos=new Photos(nas);t.after(()=>photos.clear());return{state,nas,photos};}
const key=url=>url.split('/').pop();

test('all asynchronous photo and collection reads reject after clear and cannot repopulate retired maps',async t=>{
  for(const method of ['list','albums','categories','info','previewVisibility','folders','memories','music','memoryPictures'])await t.test(method,async t=>{
    const{state,photos}=fixture(t);let params=new URLSearchParams(),invoke=()=>photos[method](params,owner);
    if(method==='categories')params.set('kind','figure');
    if(method==='info'||method==='previewVisibility'){const p=photos.present(raw,owner);params.set('asset',key(p.view));if(method==='previewVisibility')invoke=()=>photos.previewVisibility({asset:key(p.view),show:true},owner);}
    if(method==='memoryPictures'){const memories=await photos.memories(params,owner);params.set('memory',memories.items[0].id);invoke=()=>photos.list(params,owner);}
    const gate=defer();state.hold=()=>gate.promise;const before=state.calls.length,oldAssets=photos.assets,oldHandles=photos.collections.handles,pending=invoke(),rejected=assert.rejects(pending,{status:410});await until(()=>state.calls.length>before);const signal=state.calls.at(-1).options.signal;
    await photos.clear();await rejected;assert.equal(signal.aborted,true);gate.resolve();await turn();assert.equal(oldAssets.size,0);assert.equal(oldHandles.size,0);assert.equal(photos.assets.size,0);
  });
});

test('a no-clear account mutation rejects a late result before it can publish an old capability',async t=>{
  const{state,nas,photos}=fixture(t),gate=defer();state.hold=()=>gate.promise;const pending=photos.list(new URLSearchParams(),owner);await until(()=>state.calls.length===1);nas.config.token='synthetic-private-token-b';const rejected=assert.rejects(pending,{status:410});gate.resolve();await rejected;assert.equal(photos.assets.size,0);assert.equal(state.calls.some(call=>call.token.endsWith('-b')),false);assert.ok(state.destroyed.has(1));assert.equal(state.destroyed.has(nas.id),false);
});

test('same owner and NAS IDs cannot reuse capabilities, groups or folder handles across account or same-account clears',async t=>{
  const{nas,photos}=fixture(t);
  async function capture(){const p=photos.present(raw,owner),groups=await photos.categories(new URLSearchParams(),owner),folders=await photos.folders(new URLSearchParams(),owner),music=await photos.music(new URLSearchParams(),owner);return{original:p.original,view:p.view,group:groups.items[0].id,folder:folders.folders[0].id,music:music.items[0].stream};}
  const first=await capture();await photos.clear();const second=await capture();for(const field of Object.keys(first))assert.notEqual(first[field],second[field],field);assert.throws(()=>photos.get(key(first.original),owner),{status:404});
  nas.config.alias='synthetic-b';nas.config.username='b';const third=await capture();for(const field of Object.keys(second))assert.notEqual(second[field],third[field],field);assert.throws(()=>photos.get(key(second.original),owner),{status:404});assert.throws(()=>photos.get(key(third.original),'other-tv-owner'),{status:404});
});

test('original, motion, music and image descriptors retain private immutable account transport with no credential JSON',async t=>{
  const{state,nas,photos}=fixture(t),p=photos.present(raw,owner),music=await photos.music(new URLSearchParams(),owner);
  const assets=[p.original,p.motion,p.view,music.items[0].stream].map(url=>photos.get(key(url),owner));
  for(const asset of assets){const stream=photos.stream(asset);assert.ok(stream.nas);assert.notEqual(stream.nas.config,nas.config);assert.notEqual(stream.nas.httpsAgent,nas.httpsAgent);assert.equal(stream.nas.config.token,'synthetic-private-token-a');assert.throws(()=>{stream.nas.config.token='wrong';});assert.equal(Object.keys(stream).includes('nas'),false);assert.equal(JSON.stringify(stream).includes('synthetic-private'),false);assert.equal(JSON.stringify(asset).includes('synthetic-private'),false);assert.equal(JSON.stringify(photos).includes('synthetic-private'),false);}
  const image=await photos.image(assets[2]);assert.deepEqual(image,Buffer.from([1,2,3]));assert.equal(state.calls.at(-1).id,1);assert.equal(state.calls.at(-1).token,'synthetic-private-token-a');assert.equal(photos.nas,nas);
  const old=photos.stream(assets[0]);nas.config.token='synthetic-private-token-b';await assert.rejects(async()=>old.nas.open(old.path,{query:old.query}),{status:410});assert.throws(()=>photos.stream(assets[0]),{status:404});assert.equal(state.calls.some(call=>call.token==='wrong'||call.token.endsWith('-b')),false);
});

test('clear destroys active photo streams and a late open is destroyed without returning bytes',async t=>{
  const{state,photos}=fixture(t),p=photos.present(raw,owner),asset=photos.get(key(p.view),owner),gate=defer();let late;
  state.open=async()=>{await gate.promise;return late=response();};const pending=photos.image(asset),rejected=assert.rejects(pending,{status:410});await until(()=>state.calls.length===1);await photos.clear();await rejected;gate.resolve();await turn();assert.equal(late.destroyed,true);
  const fresh=photos.present(raw,owner),freshAsset=photos.get(key(fresh.view),owner),body=new PassThrough();body.statusCode=200;state.open=async()=>body;const reading=photos.image(freshAsset),stopped=assert.rejects(reading,{status:410});await until(()=>state.calls.length===2);body.write(Buffer.from([1]));await turn();await photos.clear();await stopped;assert.equal(body.destroyed,true);
});

test('retiring an account closes only its independent photo video tasks and never the replacement or global Agent',async t=>{
  const{state,nas,photos}=fixture(t),p=photos.present({...raw,show_type:1,real_ext_name:'mp4'},owner),oldVideos=photos.videos;
  const started=await oldVideos.start({asset:key(p.stream)},owner),candidate=await oldVideos.quality({id:started.id,quality:'1080P@1920x1080'},owner);await oldVideos.commit({id:started.id,candidate:candidate.candidate},owner);
  nas.config.token='synthetic-private-token-b';const next=photos.present(raw,owner),before=state.next-1;assert.ok(photos.get(key(next.original),owner));await photos.clear();
  const closes=state.calls.filter(call=>call.path.endsWith('/close'));assert.ok(closes.length>=2);assert.ok(closes.every(call=>call.token==='synthetic-private-token-a'));assert.equal(oldVideos.sessions.size,0);assert.equal(oldVideos.candidates.size,0);assert.equal(state.destroyed.has(nas.id),false);assert.ok(state.destroyed.has(before));
});

test('a retained old videos object cannot publish a description after an account change without clear',async t=>{
  const{state,nas,photos}=fixture(t),p=photos.present({...raw,show_type:1,real_ext_name:'mp4'},owner),videos=photos.videos,gate=defer();state.hold=path=>path.endsWith('/transcode/info')?gate.promise:null;const pending=videos.start({asset:key(p.stream)},owner);await until(()=>state.calls.some(call=>call.path.endsWith('/info')));nas.config.token='synthetic-private-token-b';const rejected=assert.rejects(pending,{status:410});gate.resolve();await rejected;await photos.clear();assert.equal(videos.sessions.size,0);assert.ok(state.calls.filter(call=>call.path.endsWith('/close')).every(call=>call.token==='synthetic-private-token-a'));
});

test('an original stream stops at the next chunk after an unannounced account change without borrowing new credentials',async t=>{
  const{state,nas,photos}=fixture(t),p=photos.present(raw,owner),asset=photos.get(key(p.original),owner),body=new PassThrough();body.statusCode=206;body.headers={'content-type':'image/heif','content-range':'bytes 0-5/6'};state.open=async()=>body;
  const descriptor=photos.stream(asset),stream=await descriptor.nas.open(descriptor.path,{query:descriptor.query});assert.equal(stream.statusCode,206);assert.equal(stream.headers['content-range'],'bytes 0-5/6');
  const received=[];const reading=(async()=>{for await(const chunk of stream)received.push(chunk);})(),rejected=assert.rejects(reading,{status:410});body.write(Buffer.from([1,2,3]));await turn();nas.config.username='different-account';body.write(Buffer.from([4,5,6]));await rejected;assert.deepEqual(Buffer.concat(received),Buffer.from([1,2,3]));assert.equal(body.destroyed,true);assert.ok(state.calls.every(call=>call.token==='synthetic-private-token-a'));
});

test('production UgOS and AdaptiveNas accounts own config and Agents and preserve independently pinned LAN routes',async t=>{
  const direct=new UgOS({server:'https://nas.invalid',token:'synthetic-a'}),photos=new Photos(direct);t.after(async()=>{await photos.clear();direct.httpsAgent.destroy();});const p=photos.present(raw,owner),stream=photos.stream(photos.get(key(p.original),owner));assert.notEqual(stream.nas.httpsAgent,direct.httpsAgent);assert.notEqual(stream.nas.config,direct.config);assert.throws(()=>{stream.nas.config.server='https://other.invalid';});
  const adaptive=new AdaptiveNas({server:'https://synthetic.zh9.ug.link',alias:'synthetic',token:'synthetic-a'});const route={origin:'https://synthetic.lan.ug.link:9443',hostname:'synthetic.lan.ug.link',address:'192.168.2.9',family:4};adaptive.snapshotRoute=route;const second=new Photos(adaptive);t.after(async()=>{await second.clear();adaptive.close();});const q=second.present(raw,owner),captured=second.stream(second.get(key(q.original),owner)).nas.snapshot();assert.notEqual(captured.httpsAgent,adaptive.httpsAgent);assert.equal(captured.route.route.address,route.address);assert.notEqual(captured.route.client.httpsAgent,adaptive.route?.client?.httpsAgent);captured.close();
});
