import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {NativeNasClient} from '../lib/native-client.mjs';
import {requestNas} from '../lib/native-http.mjs';
const account={alias:'owned-nas',token:'fake-secret',clientId:'fake-client'};
function fixture({wrongIdentity=false,replaceSocket=false}={}){
 const calls=[],socket={destroyed:false};let media=0;
 const client=new NativeNasClient({account,port:33445,instance:'expected',assertRoute:async()=>{},onMedia:()=>media++,request:async input=>{
  calls.push(input);if(input.auth)assert.equal(input.pinnedSocket,socket);
  return{socket,headers:{'x-ugreen-id':wrongIdentity?'different':'expected'},body:Buffer.alloc(0),data:{code:200,data:{uglink_id:'owned-nas'}}};
 },openRequest(url,options,callback){const req=new EventEmitter();req.end=()=>{calls.push({url,method:options.method});const response=Readable.from([Buffer.from('actual-response')]);response.statusCode=200;response.headers={};callback(response);};req.destroy=error=>queueMicrotask(()=>req.emit('error',error));req.setTimeout=()=>{};queueMicrotask(()=>req.emit('socket',replaceSocket?{destroyed:false}:socket));return req;}});
 return{client,calls,media:()=>media};
}
test('each new authenticated connection requires unauthenticated NAS and same-socket alias checks',async()=>{
 const f=fixture();for(let i=0;i<2;i++){const response=await f.client.open('/ugreen/v1/user/info');for await(const chunk of response)assert.ok(chunk.length);}
 assert.equal(f.calls.length,6);for(const i of [0,3]){assert.equal(f.calls[i].path,'/ugreen/v1/verify/handshake');assert.equal(Boolean(f.calls[i].auth),false);assert.equal(f.calls[i+1].auth,true);}assert.equal(f.media(),0);f.client.close();
});
test('wrong NAS handshake prevents local alias auth and media request',async()=>{
 const f=fixture({wrongIdentity:true});await assert.rejects(f.client.open('/ugreen/v1/stream/transcode/raw/get'),{code:'NATIVE_NAS_IDENTITY_MISMATCH'});assert.equal(f.calls.length,1);assert.equal(f.media(),0);f.client.close();
});
test('socket replacement prevents final authenticated HTTP write',async()=>{
 const f=fixture({replaceSocket:true});await assert.rejects(f.client.open('/ugreen/v1/user/info'),{code:'NATIVE_SOCKET_CHANGED'});assert.equal(f.calls.length,2);f.client.close();
});
test('media proof changes only for internally recognized raw media bytes',async()=>{
 const f=fixture();const response=await f.client.open('/ugreen/v1/stream/transcode/raw/get');assert.equal(f.media(),0);for await(const chunk of response)assert.ok(chunk.length);assert.equal(f.media(),1);f.client.close();
});
test('native client rejects mutation and caller-supplied token override without any request',async()=>{
 const f=fixture();await assert.rejects(f.client.open('/ugreen/v1/user/info',{method:'POST'}),{code:'NATIVE_READ_ONLY'});assert.equal(f.calls.length,0);await assert.rejects(f.client.open('/ugreen/v1/user/info',{query:{token:'different-account'}}),{code:'NATIVE_QUERY_AUTH'});assert.equal(f.calls.length,2);f.client.close();
});
test('actual proof request primitive writes no authentication when pinned socket changes',async()=>{
 let ended=false;const wanted={destroyed:false};
 await assert.rejects(requestNas({server:'http://127.0.0.1:33445',path:'/ugreen/v1/user/priority_link',readAuth:account,auth:true,pinnedSocket:wanted,timeout:50},{request(){const req=new EventEmitter();req.end=()=>{ended=true;};req.setTimeout=()=>{};req.destroy=error=>queueMicrotask(()=>req.emit('error',error));queueMicrotask(()=>req.emit('socket',{destroyed:false}));return req;}}),{code:'PROXY_SOCKET_CONTINUITY'});assert.equal(ended,false);
});
test('four synchronous reservations bound concurrent deferred route proofs',async()=>{
 let resume;const gate=new Promise(resolve=>resume=resolve),f=fixture();f.client.assertRoute=()=>gate;
 const work=Array.from({length:5},()=>f.client.open('/ugreen/v1/user/info'));const fifth=assert.rejects(work[4],{code:'NATIVE_CONNECTION_LIMIT'});
 assert.equal(f.client.agents.size,4);assert.equal(f.calls.length,0);resume();await fifth;
 const responses=await Promise.all(work.slice(0,4));for(const response of responses)for await(const chunk of response)assert.ok(chunk.length);
 assert.equal(f.client.agents.size,0);f.client.close();
});
test('failed route proof releases a reserved slot before any local HTTP',async()=>{
 const f=fixture();f.client.assertRoute=async()=>{throw Object.assign(new Error('fake'),{code:'NATIVE_ROUTE_CHANGED'});};
 await assert.rejects(f.client.open('/ugreen/v1/user/info'),{code:'NATIVE_ROUTE_CHANGED'});assert.equal(f.client.agents.size,0);assert.equal(f.calls.length,0);f.client.close();
});
test('numeric and arbitrary provider errors release reservations and expose only a finite client code',async()=>{
 for(const code of [12,'NATIVE_PRIVATE_TOKEN_SUFFIX']){const f=fixture();f.client.assertRoute=async()=>{throw Object.assign(new Error('private'),{code});};await assert.rejects(f.client.open('/ugreen/v1/user/info'),{code:'NATIVE_VERIFICATION_FAILED'});assert.equal(f.client.agents.size,0);f.client.close();}
});
test('already aborted caller creates no slot, proof or local request and does not close the client',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.client.open('/ugreen/v2/video/getImaStream',{signal:controller.signal}),{name:'AbortError',code:'ABORT_ERR'});assert.equal(f.calls.length,0);assert.equal(f.client.agents.size,0);assert.equal(f.client.closed,false);f.client.close();
});
test('known integrity failure in the same turn outranks caller cancellation',async()=>{
 for(const code of ['NATIVE_NAS_IDENTITY_MISMATCH','NATIVE_ACCOUNT_MISMATCH','NATIVE_LISTENER_UNVERIFIED','PROXY_SOCKET_CONTINUITY']){
  const f=fixture(),controller=new AbortController();f.client.requestProof=async()=>{controller.abort();throw Object.assign(new Error('private'),{code});};await assert.rejects(f.client.open('/ugreen/v2/video/getImaStream',{signal:controller.signal}),{code:code==='PROXY_SOCKET_CONTINUITY'?'NATIVE_SOCKET_CHANGED':code});assert.equal(f.client.agents.size,0);f.client.close();
 }
});
