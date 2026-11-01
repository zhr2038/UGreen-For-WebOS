import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createNativeProvision} from './native-provision.mjs';
import {prepareNativeWorkerRuntime} from './native-runtime.mjs';
import {NativeManager} from './native-manager.mjs';
import runtimeManifest from '../third-party/AOSP-RUNTIME-PROVENANCE.json' with {type:'json'};
import workerManifest from '../native/worker-manifest.json' with {type:'json'};
const fail=()=>Object.assign(new Error('原生连接活动不可用'),{code:'NATIVE_ACTIVITY_UNAVAILABLE'});
export function acquireNativeActivity(service,{signal,maximumMs=21600000,onExpire=()=>{}}={}){
 return new Promise((resolve,reject)=>{
  let finished=false,activity,released=false,lifetime;
  const release=()=>{if(released)return;released=true;clearTimeout(lifetime);signal?.removeEventListener('abort',abort);if(activity)try{service.activityManager.complete(activity,()=>{});}catch{}};
  const abort=()=>{release();if(!finished){finished=true;clearTimeout(timer);reject(fail());}};
  const timer=setTimeout(abort,2000);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
  try{service.activityManager.create({activity:{name:'native-session-'+randomUUID(),description:'Foreground NAS connection',type:{foreground:true,persist:false,explicit:false}},start:true,replace:false,subscribe:true},value=>{
   if(!value||!Number.isInteger(value.activityId)||value.activityId<1){abort();return;}
   if(activity)return;activity=value;if(finished||released||signal?.aborted){try{service.activityManager.complete(activity,()=>{});}catch{}return;}
   finished=true;clearTimeout(timer);lifetime=setTimeout(()=>{try{onExpire();}finally{release();}},Math.min(21600000,Math.max(1,maximumMs)));lifetime.unref?.();resolve(release);
  });}catch{abort();}
 });
}
/** No identity/config from HTTP enters these fixed path/platform factories. */
export function createServiceNativeFactory({service,stateDir,assetDir,platform=process.platform,arch=process.arch,uid=process.getuid?.()}={}){
 const enabled=platform==='linux'&&arch==='arm'&&Number.isInteger(uid)&&uid>0&&uid===process.getuid?.();
 const sdkDir=join(stateDir,'native-sdk'),runtimeDir=join(stateDir,'native-runtime');
 const provision=enabled?createNativeProvision({dir:sdkDir,trustedDir:sdkDir}):null;
 const factory=account=>new NativeManager({account,enabled,productionIntegrated:enabled,
  acquireActivity:options=>acquireNativeActivity(service,options),
  prepareSdk:options=>provision.prepare(options),
  async prepareRuntime({signal}){return prepareNativeWorkerRuntime({dir:runtimeDir,assetDir,workerDir:assetDir,sdkDir,runtimeManifest,workerManifest,signal,uid});},
 });
 factory.enabled=enabled;return factory;
}
