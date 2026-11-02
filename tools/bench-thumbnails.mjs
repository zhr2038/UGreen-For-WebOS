import { listenBrowser } from '../lib/browser-listen.mjs';
// Controlled HTTP benchmark: eight obsolete image requests followed by a new
// visible image. Synthetic JPEGs and credentials only; never connects to a NAS.
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createBridge} from '../lib/bridge.mjs';
import {NativeThumbnails} from '../lib/native-images.mjs';
import {Thumbnails} from '../lib/images.mjs';

const jpeg=await sharp({create:{width:32,height:48,channels:3,background:'#405070'}}).jpeg().toBuffer();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const records=Array.from({length:9},(_,i)=>({ug_video_info_id:i+1,media_lib_set_id:1,type:1,name:'Synthetic '+i,poster_path:'/art/'+i+'.jpg'}));
async function run(Cache,media){
 const stats={started:0,completed:0,aborted:0,active:0,peak:0},controllers=[],dir=await mkdtemp(join(tmpdir(),'cloudframe-thumbnail-bench-'));let bridge;
 const nas=http.createServer((req,res)=>{
  if(req.url.startsWith('/art/')||req.url.startsWith('/ugreen/v2/video/getImaStream')||req.url.startsWith('/ugreen/v5/photo/picture/stream')){
   stats.started++;stats.active++;stats.peak=Math.max(stats.peak,stats.active);let finished=false;
   const timer=setTimeout(()=>{finished=true;stats.completed++;res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':jpeg.length});res.end(jpeg)},350);
   res.once('close',()=>{clearTimeout(timer);stats.active--;if(!finished)stats.aborted++});return;
  }
  const path=new URL(req.url,'http://localhost').pathname;
  const data=path.endsWith('/timeline/list')?{list:records.map((r,i)=>({picture_id:i+1,file_name:'Synthetic.jpg',show_type:0,real_ext_name:'jpg',width:32,height:48})),total:9}:path.endsWith('/homepage')?{recently_update_arr:{video_arr:records}}:path.endsWith('/slider')?{random_list:[]}:{media_lib_info_list:[]};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data}));
 });await listenBrowser(nas);
 try{
  const token='synthetic-performance-client-123456';bridge=await createBridge({dir,config:{server:'http://127.0.0.1:'+nas.address().port,token:'synthetic-nas-session',clientId:'synthetic-device'},thumbnails:new Cache(),host:'127.0.0.1',port:0,clientToken:token});
  const base='http://127.0.0.1:'+bridge.server.address().port,headers={Authorization:'Bearer '+token};
  const data=await(await fetch(base+(media==='photos'?'/api/photos/list?filter=image':'/api/home'),{headers})).json(),urls=media==='photos'?data.items.map(x=>base+x.view):data.updates.map(x=>base+x.poster);assert.equal(urls.length,9);
  const obsolete=urls.slice(0,8).map(url=>{const controller=new AbortController();controllers.push(controller);return fetch(url,{headers,signal:controller.signal}).then(r=>r.arrayBuffer()).catch(()=>null)});
  const deadline=Date.now()+3000;while(stats.started<2&&Date.now()<deadline)await delay(5);assert.equal(stats.started,2);
  await delay(40);controllers.forEach(c=>c.abort());await Promise.all(obsolete);
  const start=performance.now(),response=await fetch(urls[8],{headers});assert.equal(response.status,200);await response.arrayBuffer();
  await delay(10);return{cache:Cache.name,media,upstreamDelayMs:350,obsoleteRequests:8,newVisibleMs:Math.round(performance.now()-start),...stats};
 }finally{controllers.forEach(c=>c.abort());if(bridge){bridge.server.closeAllConnections();await new Promise(r=>bridge.server.close(r))}nas.closeAllConnections();await new Promise(r=>nas.close(r));assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('cloudframe-thumbnail-bench-'));await rm(dir,{recursive:true,force:true})}
}
const report={scenario:'synthetic HTTP cancellation; not a TV FPS measurement',results:[]};for(const Cache of[NativeThumbnails,Thumbnails])for(const media of['posters','photos'])report.results.push(await run(Cache,media));
if(process.env.THUMB_BENCH_REPORT)await writeFile(process.env.THUMB_BENCH_REPORT,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
