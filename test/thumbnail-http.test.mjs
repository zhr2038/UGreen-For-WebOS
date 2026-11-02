import test from 'node:test';import assert from 'node:assert/strict';import{PassThrough}from'node:stream';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join,dirname,resolve,basename}from'node:path';import sharp from'sharp';
import{createBridge}from'../lib/bridge.mjs';import{NativeThumbnails}from'../lib/native-images.mjs';import{Thumbnails}from'../lib/images.mjs';
const image=await sharp({create:{width:20,height:30,channels:3,background:'#234567'}}).png().toBuffer();
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
for(const Cache of[NativeThumbnails,Thumbnails])test(Cache.name+' a queued shared HTTP image survives the first client disconnect',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cinema-thumbnail-http-')),started=gate(),closed=gate();let release,loads=0;
 const movie=n=>({ug_video_info_id:n,media_lib_set_id:1,type:1,name:'Synthetic',poster_path:'/synthetic-'+n});
 const nas={config:{server:'https://synthetic.invalid',token:'synthetic-nas-session'},httpsAgent:{destroy(){}},async request(path){return path.endsWith('/homepage')?{recently_update_arr:{video_arr:[movie(1),movie(2)]}}:path.endsWith('/slider')?{random_list:[]}:{media_lib_info_list:[]}},async open(path,{query,signal}){
  loads++;const stream=new PassThrough();stream.statusCode=200;stream.headers={'content-type':'image/png','content-length':image.length};signal?.addEventListener('abort',()=>stream.destroy(signal.reason),{once:true});
  if(query.name==='/synthetic-1'){release=()=>stream.end(image);started.resolve()}else stream.end(image);return stream;
 }};
 const thumbnails=new Cache({concurrency:1}),bridge=await createBridge({dir,config:nas.config,nasClient:nas,thumbnails,host:'127.0.0.1',port:0,clientToken:'synthetic-thumbnail-client'});
 t.after(async()=>{release?.();bridge.server.closeAllConnections();await new Promise(r=>bridge.server.close(r));assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('cinema-thumbnail-http-'));await rm(dir,{recursive:true,force:true})});
 const base='http://127.0.0.1:'+bridge.server.address().port,headers={Authorization:'Bearer synthetic-thumbnail-client'},home=await(await fetch(base+'/api/home',{headers})).json();
 bridge.server.on('request',(req,res)=>{if(req.headers['x-test-consumer']==='first')res.once('close',()=>closed.resolve())});
 const blocker=fetch(base+home.updates[0].poster,{headers}).then(r=>r.arrayBuffer());await started.promise;
 const cancel=new AbortController(),a=fetch(base+home.updates[1].poster,{headers:{...headers,'x-test-consumer':'first'},signal:cancel.signal}),rejected=assert.rejects(a,{name:'AbortError'});
 let entered=0;const original=thumbnails.make.bind(thumbnails);thumbnails.make=(...args)=>{if(++entered===2)setImmediate(()=>cancel.abort());return original(...args)};
 const b=fetch(base+home.updates[1].poster,{headers});await rejected;await closed.promise;release();await blocker;const response=await b;
 assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>0);assert.equal(loads,2);
});
