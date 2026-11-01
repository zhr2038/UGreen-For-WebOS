import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireNativeActivity,createServiceNativeFactory} from '../lib/native-service.mjs';
import {isCompanionCaller} from '../lib/service-caller.mjs';
test('service start accepts only the exact LS2 companion sender',()=>{
 assert.equal(isCompanionCaller({sender:'top.hrhome.nascinema'}),true);
 for(const sender of ['',undefined,'top.hrhome.nascinema.evil','top.hrhome.nascinema.service','top.hrhome.nascinema 123','other.app'])assert.equal(isCompanionCaller({sender}),false);
 assert.equal(isCompanionCaller({applicationID:'top.hrhome.nascinema'}),false);
});
test('job activity is nonpersistent and releases only its captured activity once',async()=>{
 const completed=[];let next=0;const service={activityManager:{create(spec,done){assert.equal(spec.activity.type.persist,false);assert.equal(spec.activity.type.explicit,false);assert.equal(spec.activity.callback,undefined);done({activityId:++next});},complete(value){completed.push(value.activityId);}}};
 const a=await acquireNativeActivity(service),b=await acquireNativeActivity(service);a();a();assert.deepEqual(completed,[1]);b();assert.deepEqual(completed,[1,2]);
});
test('late acquired activity after cancellation is completed without retaining a hidden lifetime',async()=>{
 const controller=new AbortController(),completed=[];let late;const service={activityManager:{create(spec,done){late=done;},complete(value){completed.push(value.activityId);}}};
 const work=acquireNativeActivity(service,{signal:controller.signal});controller.abort();await assert.rejects(work,{code:'NATIVE_ACTIVITY_UNAVAILABLE'});late({activityId:7});assert.deepEqual(completed,[7]);
});
test('unsupported production host is explicitly gated before any SDK provision',async()=>{
 const factory=createServiceNativeFactory({service:{},stateDir:'/private/state',assetDir:'/packaged/assets',platform:'win32',arch:'x64',uid:99});assert.equal(factory.enabled,false);const manager=factory({alias:'owned',server:'https://owned.example.ug.link',token:'fake-token',clientId:'fake-client'});assert.equal((await manager.select()).summary.reason,'NATIVE_PRODUCTION_DISABLED');await manager.close();
});
