import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {NativeManager} from '../lib/native-manager.mjs';
const account={alias:'owned-nas',server:'https://owned-nas.example.ug.link',token:'fake-token',clientId:'fake-client',nasPublicRsa:'R'.repeat(612)};
function fixture(options={}){
 const calls={start:0,release:0,stop:0,request:[],clients:0},worker=new EventEmitter();let now=0;
 Object.assign(worker,{phase:'started',selection:{type:4,port:34567,proxy:1},proxy:1,nativeListenerPort:34567,lastLinkType:4,child:{pid:7001},async stop(){calls.stop++;this.closed=true;this.emit('closed');return{exitCode:0};}});
 const manager=new NativeManager({account,uid:5567,enabled:true,prepareRuntime:async()=>({directory:'/private/runtime'}),acquireActivity:async()=>()=>calls.release++,createWorker(input){calls.start++;calls.workerInput=input;return worker;},inspect:async()=>({verified:true}),now:()=>now,wait:async ms=>{now+=ms;},request:async input=>{calls.request.push(input);return{headers:{'x-ugreen-id':'same-instance'},body:Buffer.alloc(0),data:{code:200,data:input.path.includes('glinfo')?{tunnel:{tunnelType:'uglinkAgent',tunnelStatus:1}}:{uglink_id:'owned-nas'}}};},createClient(input){calls.clients++;calls.clientInput=input;return{closed:false,async request(){return{uglink_id:'owned-nas'};},close(){this.closed=true;}};},...options});
 return{manager,worker,calls};
}
test('default gate and missing original RSA never start SDK or attempt key inference',async()=>{
 for(const options of [{enabled:false},{account:{...account,nasPublicRsa:undefined}}]){const f=fixture(options),result=await f.manager.select();assert.equal(f.calls.start,0);assert.equal(f.calls.request.length,0);assert.equal(result.summary.current,false);assert.equal(result.summary.reason,options.enabled===false?'NATIVE_PRODUCTION_DISABLED':'NAS_PUBLIC_RSA_MISSING');await f.manager.close();}
});
test('identity-authenticated type4 route does not claim metadata is media or WAN evidence',async()=>{
 const f=fixture(),result=await f.manager.select();assert.equal(result.summary.p2p,true);assert.equal(result.summary.authenticated,true);assert.equal(result.summary.mediaReadVerified,false);assert.equal(result.summary.wanTraversalVerified,false);assert.equal(f.calls.workerInput.uid,5567);assert.equal(f.calls.workerInput.identity.nasPublicRsa,account.nasPublicRsa);assert.equal(f.manager.account.token,account.token);assert.ok(Object.isFrozen(f.manager.account));
 await f.manager.close();assert.equal(f.calls.stop,1);assert.equal(f.calls.release,1);assert.equal(f.manager.summary().current,false);
});
test('relay type2 cannot become P2P or trigger any authenticated local client',async()=>{
 const f=fixture();f.worker.selection.type=2;const result=await f.manager.select();assert.equal(f.calls.clients,0);assert.equal(result.summary.reason,'NATIVE_NO_P2P_SELECTION');assert.equal(f.calls.stop,1);assert.equal(f.calls.release,1);
});
test('owned-listener failure stops before local auth',async()=>{
 const f=fixture({inspect:async()=>({verified:false,reason:'LISTENER_NOT_EXCLUSIVE_LOOPBACK'})}),result=await f.manager.select();assert.equal(f.calls.clients,0);assert.equal(result.summary.reason,'NATIVE_LISTENER_UNVERIFIED');assert.equal(f.calls.stop,1);
});
test('LINK change and worker exit revoke current route and all owned clients',async()=>{
 for(const event of ['state','closed']){const f=fixture();await f.manager.select();const client=f.manager.client;f.worker.selection={type:2,port:0,proxy:1};f.worker.emit(event);await new Promise(r=>setImmediate(r));assert.equal(client.closed,true);assert.equal(f.manager.summary().current,false);assert.equal(f.calls.release,1);}
});
test('cancellation during asynchronous preparation cannot create late SDK worker',async()=>{
 let resolve;const f=fixture({prepareRuntime:()=>new Promise(r=>resolve=r)}),work=f.manager.select();await new Promise(r=>setImmediate(r));const closing=f.manager.close();resolve({directory:'/private/runtime'});await work;await closing;assert.equal(f.calls.start,0);assert.equal(f.calls.release,1);
});
test('old immutable account lease stays pinned and releases once',async()=>{
 const original={...account},f=fixture({account:original});const release=f.manager.retain();original.token='new-account-token';await f.manager.select();assert.equal(f.calls.workerInput.identity.nasToken,'fake-token');await f.manager.releaseOwner();assert.equal(f.manager.closed,false);release();release();await new Promise(r=>setImmediate(r));assert.equal(f.manager.closed,true);assert.equal(f.calls.stop,1);
});
test('hide closes active route instead of keeping a background activity',async()=>{
 const f=fixture();await f.manager.select();f.manager.setVisible(false);await new Promise(r=>setImmediate(r));assert.equal(f.calls.stop,1);assert.equal(f.calls.release,1);assert.equal((await f.manager.select()).summary.reason,'NATIVE_OWNER_INACTIVE');
});
test('old delayed stop cannot release a newer generation activity or route',async()=>{
 const f=fixture(),released=[];let id=0,finishOld;f.manager.acquireActivity=async()=>{const own=++id;return()=>released.push(own);};
 await f.manager.select();f.worker.stop=()=>new Promise(resolve=>finishOld=resolve);const oldCleanup=f.manager.reset();
 const newer=new EventEmitter();Object.assign(newer,{phase:'started',selection:{type:4,port:34567,proxy:1},proxy:1,nativeListenerPort:34567,lastLinkType:4,child:{pid:7002},async stop(){this.closed=true;this.emit('closed');return{exitCode:0};}});f.manager.createWorker=()=>newer;
 await f.manager.select();assert.equal(f.manager.summary().current,true);finishOld({exitCode:0});await oldCleanup;
 assert.deepEqual(released,[1]);assert.equal(f.manager.worker,newer);assert.equal(f.manager.summary().current,true);await f.manager.close();assert.deepEqual(released,[1,2]);
});

test('raw SDK link downgrade or lost owned listener immediately revokes route',async()=>{for(const property of ['lastLinkType','nativeListenerPort']){const f=fixture();await f.manager.select();f.worker[property]=property==='lastLinkType'?2:0;f.worker.emit('state',{event:101});await new Promise(r=>setImmediate(r));assert.equal(f.manager.summary().current,false);assert.equal(f.calls.stop,1);assert.equal(f.calls.release,1);}});
test('late old route handle close or retain cannot affect the new selected route',async()=>{
 const f=fixture(),old=await f.manager.select();await f.manager.reset();const newer=new EventEmitter();let stops=0;
 Object.assign(newer,{phase:'started',selection:{type:4,port:34567,proxy:1},proxy:1,nativeListenerPort:34567,lastLinkType:4,child:{pid:7002},async stop(){stops++;this.closed=true;this.emit('closed');return{exitCode:0};}});f.manager.createWorker=()=>newer;
 const current=await f.manager.select();await old.close();assert.throws(()=>old.retain(),{code:'NATIVE_STALE_ROUTE'});assert.equal(old.summary.current,false);assert.equal(current.summary.current,true);assert.equal(f.manager.worker,newer);assert.equal(stops,0);await current.close();assert.equal(stops,1);
});
test('SDK identity uses original NAS login token even when HTTP authenticates with static ugk',async()=>{
 const f=fixture({account:{...account,authMode:'ugk',staticToken:'different-static-ugk'}});await f.manager.select();assert.equal(f.calls.workerInput.identity.nasToken,'fake-token');assert.notEqual(f.calls.workerInput.identity.nasToken,'different-static-ugk');await f.manager.close();
});
test('lifetime expiry revokes current route and cannot transparently respawn the same owner',async()=>{
 let expired;const f=fixture({acquireActivity:async options=>{expired=options.onExpire;return()=>{};}});await f.manager.select();expired();await new Promise(r=>setImmediate(r));assert.equal(f.manager.summary().current,false);assert.equal((await f.manager.select()).summary.reason,'NATIVE_LIFETIME_EXPIRED');assert.equal(f.calls.start,1);
});
test('numeric or arbitrary provider codes become a finite selection reason after cleanup',async()=>{
 for(const code of [7,'NATIVE_PRIVATE_TOKEN_SUFFIX']){let released=0;const f=fixture({acquireActivity:async()=>()=>released++,prepareRuntime:async()=>{throw Object.assign(new Error('untrusted private content'),{code});}});const result=await f.manager.select();assert.equal(result.summary.reason,'NATIVE_RUNTIME_FAILED');assert.equal(released,1);assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN'),false);await f.manager.close();}
});
test('default native deadline clock remains monotonic when the system wall clock rolls back',async()=>{
 const manager=new NativeManager({account}),original=Date.now,before=manager.now();try{Date.now=()=>original()-86400000;assert.ok(manager.now()>=before);}finally{Date.now=original;await manager.close();}
});
test('known provisioning and runtime errors retain their finite stage without raw exception text',async()=>{
 for(const [stage,code] of [['SDK_PREPARE','NATIVE_PROVISION_PRIVATE_UNSAFE'],['RUNTIME_PREPARE','NATIVE_RUNTIME_HASH']]){
  const operation=async()=>{throw Object.assign(new Error('private NAS key /secret/path'),{code});};const f=fixture(stage==='SDK_PREPARE'?{prepareSdk:operation}:{prepareRuntime:operation});const result=await f.manager.select();assert.equal(result.summary.reason,code);assert.equal(result.summary.nativeStage,stage);assert.equal(JSON.stringify(result).includes('/secret/path'),false);assert.equal(f.calls.release,1);await f.manager.close();
 }
});
test('unexpected current worker close exposes only bounded lifecycle facts and normal stop records none',async()=>{
 const f=fixture();await f.manager.select();assert.equal(f.manager.summary().nativeStage,'READY');
 f.worker.emit('closed',{nativeHello:true,gotGuard:true,uidVerified:true,initReturnCode:0,startReturnCode:1,exitCode:null,releaseReturned:false,signal:'SIGFPE',failure:'PRIVATE_TOKEN_SUFFIX',childPid:999,events:[{secret:'not-public'}],nasToken:'private-token',path:'/private'});
 const diagnostic=f.manager.summary().lastWorkerFailure;assert.deepEqual(Object.keys(diagnostic).sort(),['nativeHello','gotGuard','uidVerified','initReturnCode','startReturnCode','exitCode','releaseReturned','failure','signal'].sort());assert.equal(diagnostic.signal,'SIGFPE');assert.equal(diagnostic.failure,'OTHER');assert.equal(JSON.stringify(diagnostic).includes('private'),false);
 const normal=fixture();await normal.manager.select();await normal.manager.close();assert.equal(normal.manager.summary().lastWorkerFailure,null);await f.manager.close();
});
test('fault lifecycle waits for close and late old worker cannot overwrite newer diagnostics',async()=>{
 const f=fixture();await f.manager.select();let finish;f.worker.stop=()=>new Promise(resolve=>finish=resolve);f.worker.emit('fault',{code:'PLT_GUARD'});assert.equal(f.manager.summary().lastWorkerFailure,null);
 f.worker.emit('closed',{nativeHello:true,gotGuard:false,uidVerified:true,exitCode:null,signal:'SIGKILL',failure:'PLT_GUARD'});assert.equal(f.manager.summary().lastWorkerFailure.failure,'PLT_GUARD');finish({exitCode:null});await new Promise(r=>setImmediate(r));
 const newer=new EventEmitter();Object.assign(newer,{phase:'started',selection:{type:4,port:34567,proxy:1},proxy:1,nativeListenerPort:34567,lastLinkType:4,child:{pid:7002},async stop(){this.closed=true;this.emit('closed');return{exitCode:0};}});f.manager.createWorker=()=>newer;await f.manager.select();assert.equal(f.manager.summary().lastWorkerFailure,null);
 newer.emit('closed',{nativeHello:true,gotGuard:true,uidVerified:true,exitCode:2,signal:null,failure:'SDK_START_REJECTED'});f.worker.emit('closed',{failure:'PLT_GUARD',signal:'SIGFPE'});assert.equal(f.manager.summary().lastWorkerFailure.failure,'SDK_START_REJECTED');assert.equal(f.manager.summary().lastWorkerFailure.exitCode,2);await f.manager.close();
});
test('relay diagnostics distinguish bounded handshake backend and alias failures before SDK start',async()=>{
 for(const [stage,path,code,expected,httpStatus]of [
  ['RELAY_HANDSHAKE','handshake','NAS_TIMEOUT','NATIVE_RELAY_TIMEOUT',null],
  ['RELAY_BACKEND','glinfo','NAS_HTTP_STATUS','NATIVE_RELAY_HTTP_STATUS',503],
  ['RELAY_ALIAS','priority_link','ERR_TLS_CERT_ALTNAME_INVALID','NATIVE_RELAY_ERR_TLS_CERT_ALTNAME_INVALID',null],
  ['RELAY_HANDSHAKE','handshake','PRIVATE_TOKEN_SUFFIX','NATIVE_SELECTION_FAILED',null]]){
  const f=fixture({request:async input=>{assert.equal(input.timeout,3000);if(input.path.includes(path))throw Object.assign(new Error('secret-host fake-token'),{code,httpStatus});return{headers:{'x-ugreen-id':'same-instance'},body:Buffer.alloc(0),data:{code:200,data:input.path.includes('glinfo')?{tunnel:{tunnelType:'uglinkAgent',tunnelStatus:1}}:{uglink_id:'owned-nas'}}};}});
  const result=await f.manager.select();assert.equal(result.summary.nativeStage,stage);assert.equal(result.summary.reason,expected);assert.equal(result.summary.nativeHttpStatus,httpStatus);assert.equal(result.summary.lastWorkerFailure,null);assert.equal(f.calls.start,0);assert.equal(JSON.stringify(result).includes('secret-host'),false);await f.manager.close();
 }
});
