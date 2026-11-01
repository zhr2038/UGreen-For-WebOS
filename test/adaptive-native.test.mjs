import test from 'node:test';
import assert from 'node:assert/strict';
import {AdaptiveNas} from '../lib/adaptive-nas.mjs';
import {NativeNasClient} from '../lib/native-client.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough,Readable} from 'node:stream';
const account={alias:'owned',server:'https://owned.example.ug.link',token:'old-token',clientId:'client',nasPublicRsa:'R'.repeat(612)};
function fixture({lan=false,preferNative=false}={}){
 const calls=[],config={...account};let current=false,retains=0,releases=0,nativeStarts=0;
 const client={async request(path){calls.push('native:'+path);return'native';}};
 const handle={client,route:{type:4},get summary(){return{current,authenticated:current,p2p:current,mediaReadVerified:false};},close(){current=false;},retain(){if(!current)throw Error('stale');retains++;let done=false;return()=>{if(!done){done=true;releases++;}};}};
 const manager={setVisible(value){if(!value)current=false;},close(){current=false;},async select(){nativeStarts++;current=true;return handle;}};
 const relay={httpsAgent:{destroy(){}},async request(path){calls.push('relay:'+path+':'+config.token);return'relay';}};
 const nas=new AdaptiveNas(config,{relay,preferNative,nativeFactory:()=>manager,createProbe:()=>({httpsAgent:{destroy(){}}}),select:async()=>lan?{client:{async request(){calls.push('lan');return'lan';}},close(){calls.push('lan-close');}}:{summary:{reason:'NO_VERIFIED_LAN'}}});
 return{nas,config,calls,handle,client,manager,get starts(){return nativeStarts;},get leases(){return{retains,releases};}};
}
test('verified LAN wins by default and native requires current foreground visibility',async()=>{
 const f=fixture({lan:true});await f.nas.select();assert.equal(f.starts,0);f.nas.setVisibility({scope:f.nas.visibilityScope(),visible:true});await f.nas.select();assert.equal(f.starts,0);assert.equal(await f.nas.request('home'),'lan');f.nas.close();
 const g=fixture();await g.nas.select();assert.equal(g.starts,0);g.nas.setVisibility({scope:g.nas.visibilityScope(),visible:true});await g.nas.select();assert.equal(g.starts,1);assert.equal(g.nas.summary().mode,'native-p2p');g.nas.close();
});
test('explicit internal preference can select native after LAN selection without a public hook',async()=>{
 const f=fixture({lan:true,preferNative:true});f.nas.setVisibility({scope:f.nas.visibilityScope(),visible:true});await f.nas.select();assert.equal(f.starts,1);assert.ok(f.calls.includes('lan-close'));f.nas.close();
});
test('internal native preference waits for a later foreground pulse after initial LAN already completed',async()=>{
 const f=fixture({lan:true,preferNative:true});await f.nas.select();assert.equal(f.nas.summary().mode,'lan-https');assert.equal(f.starts,0);let attempts=0,complete;
 f.manager.select=()=>{attempts++;return new Promise(resolve=>complete=resolve);};const scope=f.nas.visibilityScope();f.nas.setVisibility({scope,visible:true});assert.equal(attempts,1);const selecting=f.nas.pending;
 complete({summary:{current:false,reason:'NATIVE_NO_P2P_SELECTION'}});await selecting;assert.equal(f.nas.summary().mode,'lan-https');assert.equal(f.nas.visible,true);
 f.nas.setVisibility({scope,visible:true});await f.nas.select();assert.equal(attempts,1);assert.equal(f.calls.includes('lan-close'),false);f.nas.close();
});
test('native handles GET while POST goes once to canonical relay',async()=>{
 const f=fixture();f.nas.setVisibility({scope:f.nas.visibilityScope(),visible:true});await f.nas.select();assert.equal(await f.nas.request('home'),'native');assert.equal(await f.nas.request('progress',{method:'POST'}),'relay');assert.equal(f.calls.filter(x=>x==='native:progress').length,0);assert.equal(f.nas.summary().mediaReadVerified,false);f.nas.close();
});
test('snapshot lease destruction never closes the shared native owner and stale fallback keeps original account',async()=>{
 const f=fixture();f.nas.setVisibility({scope:f.nas.visibilityScope(),visible:true});await f.nas.select();const a=f.nas.snapshot(),b=a.snapshot();a.close();assert.equal(f.handle.summary.current,true);assert.deepEqual(f.leases,{retains:2,releases:1});
 f.config.token='new-token';f.nas.reset();let received;b.relay.request=async()=>{received=b.relay.config.token;return'old-relay';};assert.equal(await b.request('old-file'),'old-relay');assert.equal(received,'old-token');b.close();const c=b.snapshot();assert.equal(c.config.token,'old-token');c.close();assert.deepEqual(f.leases,{retains:2,releases:2});
});
test('stale visibility scope cannot hide a newer account and foreground lease expires',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),old=f.nas.visibilityScope();f.nas.reset();const current=f.nas.visibilityScope();assert.notEqual(old,current);assert.equal(f.nas.setVisibility({scope:old,visible:false}),false);
 f.nas.setVisibility({scope:current,visible:true});await f.nas.select();assert.equal(f.nas.summary().p2p,true);t.mock.timers.tick(90000);assert.equal(f.nas.summary().p2p,false);assert.equal(f.nas.visible,false);f.nas.close();
});
test('fifth concurrent stream falls back alone while four healthy owned native streams remain current',async()=>{
 const f=fixture(),sockets=new Map(),held=[];let relayRequests=0;
 const client=new NativeNasClient({account:f.config,port:34567,instance:'same',assertRoute:async()=>{},request:async input=>{
  if(!sockets.has(input.agent))sockets.set(input.agent,{destroyed:false});const socket=sockets.get(input.agent);if(input.auth)assert.equal(input.pinnedSocket,socket);
  return{socket,headers:{'x-ugreen-id':'same'},body:Buffer.alloc(0),data:{code:200,data:{uglink_id:'owned'}}};
 },openRequest(url,options,done){const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=error=>queueMicrotask(()=>request.emit('error',error));request.end=()=>{const response=new PassThrough();response.statusCode=200;response.headers={};held.push(response);done(response);};queueMicrotask(()=>request.emit('socket',sockets.get(options.agent)));return request;}});
 f.handle.client=client;f.nas.relay.open=async()=>{relayRequests++;return{relay:true,destroy(){}};};f.nas.setVisibility({scope:f.nas.visibilityScope(),visible:true});await f.nas.select();
 const streams=await Promise.all(Array.from({length:4},()=>f.nas.open('/ugreen/v1/stream/transcode/raw/get')));assert.equal(client.agents.size,4);
 const fifth=await f.nas.open('/ugreen/v1/stream/transcode/raw/get');assert.equal(fifth.relay,true);assert.equal(relayRequests,1);assert.equal(client.agents.size,4);assert.ok(streams.every(stream=>!stream.destroyed));assert.equal(f.nas.summary().p2p,true);assert.equal(f.handle.summary.current,true);
 client.close();f.nas.close();
});
test('capacity fallback cannot return a late old-account relay stream after reset',async()=>{
 const f=fixture();f.client.open=async()=>{throw Object.assign(new Error('capacity'),{code:'NATIVE_CONNECTION_LIMIT'});};let finish;
 f.nas.relay.open=()=>new Promise(resolve=>finish=resolve);f.nas.setVisibility({scope:f.nas.visibilityScope(),visible:true});await f.nas.select();
 const pending=f.nas.open('/ugreen/v1/stream/transcode/raw/get');await new Promise(r=>setImmediate(r));assert.equal(f.nas.summary().p2p,true);
 f.nas.reset();f.config.token='new-account-token';let destroyed=false;finish({destroy(){destroyed=true;}});await assert.rejects(pending,{name:'AbortError'});assert.equal(destroyed,true);assert.equal(f.starts,1);f.nas.close();
});
test('failed internal native attempt reports a finite independent reason while healthy LAN stays verified',async()=>{
 const f=fixture({lan:true,preferNative:true});await f.nas.select();f.manager.select=async()=>({summary:{current:false,reason:'NATIVE_PROVISION_PRIVATE_UNSAFE'}});f.nas.setVisibility({scope:f.nas.visibilityScope(),visible:true});await f.nas.select();const summary=f.nas.summary();assert.equal(summary.mode,'lan-https');assert.equal(summary.verified,true);assert.equal(summary.reason,null);assert.equal(summary.nativeReason,'NATIVE_PROVISION_PRIVATE_UNSAFE');assert.equal(summary.p2p,false);assert.equal(await f.nas.request('home'),'lan');f.nas.close();
});
test('cancelled deferred image proof cannot revoke a healthy stream or detail read and never retries relay',async()=>{
 const f=fixture(),controller=new AbortController(),sockets=new Map();let finishImage,started,imageAuth=0;const proofStarted=new Promise(resolve=>started=resolve);
 const client=new NativeNasClient({account:f.config,port:34567,instance:'same',assertRoute:async()=>{},request:async input=>{
  if(!sockets.has(input.agent))sockets.set(input.agent,{destroyed:false,destroy(){this.destroyed=true;}});const socket=sockets.get(input.agent);
  if(input.signal===controller.signal){if(input.auth)imageAuth++;if(input.path.endsWith('/handshake'))return new Promise(resolve=>{finishImage=value=>resolve({...value,socket});started();});}
  if(input.auth)assert.equal(input.pinnedSocket,socket);return{socket,headers:{'x-ugreen-id':'same'},body:Buffer.alloc(0),data:{code:200,data:{uglink_id:'owned'}}};
 },openRequest(url,options,done){const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=error=>queueMicrotask(()=>request.emit('error',error));request.end=()=>{const response=url.pathname.endsWith('/raw/get')?new PassThrough():Readable.from([Buffer.from(JSON.stringify({code:200,data:{id:'detail'}}))]);response.statusCode=200;response.headers={};done(response);};queueMicrotask(()=>request.emit('socket',sockets.get(options.agent)));return request;}});
 f.handle.client=client;f.nas.setVisibility({scope:f.nas.visibilityScope(),visible:true});await f.nas.select();const healthy=await f.nas.open('/ugreen/v1/stream/transcode/raw/get');
 const image=f.nas.open('/ugreen/v2/video/getImaStream',{signal:controller.signal});await proofStarted;controller.abort();await assert.rejects(image,{name:'AbortError',code:'ABORT_ERR'});assert.equal(client.agents.size,1);assert.equal(healthy.destroyed,false);assert.equal(f.nas.summary().p2p,true);
 assert.deepEqual(await f.nas.request('v2/video/detail'),{id:'detail'});assert.equal(f.calls.some(call=>call.startsWith('relay:')),false);assert.equal(healthy.destroyed,false);assert.equal(client.agents.size,1);
 const lateBody=Buffer.from('late private response');finishImage({headers:{'x-ugreen-id':'same'},body:lateBody,data:{}});await new Promise(r=>setImmediate(r));assert.ok(lateBody.every(byte=>byte===0));assert.equal(imageAuth,0);assert.equal(f.nas.summary().p2p,true);assert.equal(healthy.destroyed,false);client.close();f.nas.close();
});
test('coincident caller cancellation does not mask a real native integrity failure or retry its relay',async()=>{
 const f=fixture(),controller=new AbortController();f.client.request=async()=>{controller.abort();throw Object.assign(new Error('integrity'),{code:'NATIVE_NAS_IDENTITY_MISMATCH'});};f.nas.setVisibility({scope:f.nas.visibilityScope(),visible:true});await f.nas.select();await assert.rejects(f.nas.request('v2/video/detail',{signal:controller.signal}),{code:'NATIVE_NAS_IDENTITY_MISMATCH'});assert.equal(f.nas.summary().p2p,false);assert.equal(f.handle.summary.current,false);assert.equal(f.calls.some(call=>call.startsWith('relay:')),false);f.nas.close();
});
