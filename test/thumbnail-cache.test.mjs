import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {ThumbnailCache} from '../lib/thumbnail-cache.mjs';
import {NativeThumbnails} from '../lib/native-images.mjs';
import {Thumbnails} from '../lib/images.mjs';

const input=await sharp({create:{width:20,height:30,channels:3,background:'#456789'}}).png().toBuffer();
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const turn=()=>new Promise(r=>setImmediate(r));
const cancellable=(signal,g)=>{signal.addEventListener('abort',()=>g.reject(signal.reason),{once:true});return g.promise};
for(const Cache of[NativeThumbnails,Thumbnails]){
 test(Cache.name+' one cancelled subscriber cannot abort another subscriber',async()=>{
  const cache=new Cache(),g=gate(),first=new AbortController();let sourceSignal,loads=0;
  const a=cache.make('shared','poster',signal=>{loads++;sourceSignal=signal;return cancellable(signal,g)},{signal:first.signal});
  const rejected=assert.rejects(a,{name:'AbortError'}),b=cache.make('shared','poster',()=>{throw Error('Duplicate NAS load')});
  first.abort();await rejected;assert.equal(sourceSignal.aborted,false);g.resolve(input);assert.ok(Buffer.isBuffer(await b));assert.equal(loads,1);assert.equal(cache.cache.size,1);assert.equal(cache.active,0);
 });
 test(Cache.name+' a cancelled queued image never reads or converts its source',async()=>{
  const cache=new Cache({concurrency:1}),g=gate(),cancel=new AbortController();let loads=0;
  const a=cache.make('visible','poster',()=>g.promise),b=cache.make('obsolete','poster',()=>{loads++;return input},{signal:cancel.signal}),rejected=assert.rejects(b,{name:'AbortError'});
  cancel.abort();await rejected;g.resolve(input);await a;assert.equal(loads,0);assert.equal(cache.pending.size,0);assert.equal(cache.stats().queued,0);
 });
 test(Cache.name+' last cancellation aborts the NAS source and lets the next image run',async()=>{
  const cache=new Cache({concurrency:1}),g=gate(),cancel=new AbortController();let sourceSignal;
  const a=cache.make('obsolete','poster',signal=>{sourceSignal=signal;return cancellable(signal,g)},{signal:cancel.signal}),rejected=assert.rejects(a,{name:'AbortError'});
  const b=cache.make('new-visible','poster',async()=>input);cancel.abort();await rejected;await b;
  assert.equal(sourceSignal.aborted,true);assert.equal(cache.cache.has('obsolete'),false);assert.equal(cache.active,0);
 });
 test(Cache.name+' reset cancels active and queued work without loading old queued images',async()=>{
  const cache=new Cache({concurrency:1}),g=gate();let queuedLoads=0;
  const a=cache.make('active','poster',signal=>cancellable(signal,g)),b=cache.make('queued','poster',()=>{queuedLoads++;return input});
  const rejected=[assert.rejects(a,/连接已切换/),assert.rejects(b,/连接已切换/)];cache.clear();await Promise.all(rejected);await turn();
  await cache.make('replacement','poster',async()=>input);assert.equal(queuedLoads,0);assert.equal(cache.cache.size,1);assert.equal(cache.active,0);assert.equal(cache.pending.size,0);
 });
}
test('a slow image times out, aborts its source and leaves the queue usable',async()=>{
 const cache=new ThumbnailCache({transform:b=>b,timeoutMs:20,concurrency:1}),g=gate();let signal;
 const keepAlive=setTimeout(()=>{},1000);
 try{await assert.rejects(cache.make('slow','poster',value=>{signal=value;return cancellable(value,g)}),/超时/);await turn();assert.equal(signal.aborted,true);assert.equal(cache.active,0);assert.equal(await cache.make('fast','poster',async()=>input),input)}finally{clearTimeout(keepAlive);cache.clear()}
});
test('the pending queue is bounded and reset removes all its cancelled entries',async()=>{
 const cache=new ThumbnailCache({transform:b=>b,concurrency:1}),g=gate(),promises=[];
 for(let n=0;n<128;n++)promises.push(cache.make(String(n),'poster',signal=>cancellable(signal,g)).catch(e=>e));
 await assert.rejects(cache.make('overflow','poster',async()=>input),{status:429});assert.equal(cache.pending.size,128);cache.clear();await Promise.all(promises);await turn();assert.equal(cache.pending.size,0);assert.equal(cache.active,0);assert.equal(cache.stats().queued,0);
});
test('an abort callback can enqueue the same image in the replacement epoch without losing its subscriber',async()=>{
 const cache=new ThumbnailCache({transform:b=>b,concurrency:1});let replacement;
 const old=cache.make('same','poster',signal=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{replacement=cache.make('same','poster',async()=>input);reject(signal.reason)},{once:true})})),rejected=assert.rejects(old,/连接已切换/);
 cache.clear();assert.equal(cache.pending.size,1);assert.equal(cache.stats().queued,1);await rejected;assert.equal(await replacement,input);assert.equal(cache.cache.size,1);assert.equal(cache.active,0);
});
