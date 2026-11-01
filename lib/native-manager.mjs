import https from 'node:https';
import dns from 'node:dns';
import {createHash} from 'node:crypto';
import {IdentityWorker,NATIVE_PRODUCTION_LIMITS} from './native-worker.mjs';
import {inspectListener} from './native-listener.mjs';
import {requestNas} from './native-http.mjs';
import {NativeNasClient} from './native-client.mjs';
const fail=code=>Object.assign(new Error('原生直连尚未验证，继续使用安全备用连接'),{code});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const keys=['alias','server','token','staticToken','authMode','clientId','nasPublicRsa'];
export function immutableNativeAccount(value){
 const account=Object.freeze(Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]])));
 if(!/^[-a-z0-9]{1,63}$/i.test(account.alias||''))throw fail('NATIVE_ACCOUNT_INVALID');
 let url;try{url=new URL(account.server);}catch{throw fail('NATIVE_ACCOUNT_INVALID');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port&&url.port!=='443'||!url.hostname.endsWith('.ug.link')||url.hostname.endsWith('.lan.ug.link')||url.hostname.split('.')[0]!==account.alias.toLowerCase())throw fail('NATIVE_ACCOUNT_INVALID');
 for(const name of ['token','staticToken','clientId'])if(account[name]!==undefined&&(typeof account[name]!=='string'||!account[name]||account[name].length>8192||/[\x00-\x20\x7f]/.test(account[name])))throw fail('NATIVE_ACCOUNT_INVALID');
 if(!account.token||!account.clientId||!['token','ugk',undefined].includes(account.authMode)||account.authMode==='ugk'&&!account.staticToken)throw fail('NATIVE_ACCOUNT_INVALID');
 return account;
}
/** One immutable account owner. No automatic retries or hidden background work. */
export class NativeManager {
 constructor({account,prepareRuntime,prepareSdk,acquireActivity,enabled=false,createWorker=o=>new IdentityWorker(o),inspect=inspectListener,createClient=o=>new NativeNasClient(o),request=requestNas,now=Date.now,wait=pause,uid=process.getuid?.(),parentPid=process.pid}={}){
  this.account=immutableNativeAccount(account);this.key=createHash('sha256').update(JSON.stringify(this.account)).digest('hex');this.prepareRuntime=prepareRuntime;this.prepareSdk=prepareSdk;this.acquireActivity=acquireActivity;this.enabled=enabled===true;this.createWorker=createWorker;this.inspect=inspect;this.createClient=createClient;this.request=request;this.now=now;this.wait=wait;this.uid=uid;this.parentPid=parentPid;this.generation=0;this.leases=1;this.visible=true;this.reason='NATIVE_NOT_SELECTED';this.route=null;this.pending=null;this.closed=false;
 }
 releaseOwner(){if(this.ownerReleased)return this.closing;this.ownerReleased=true;if(--this.leases===0)return this.close();}
 retain(){if(this.closed)throw fail('NATIVE_OWNER_CLOSED');this.leases++;let released=false;return()=>{if(released)return;released=true;if(--this.leases===0)this.close();};}
 setVisible(value){this.visible=value===true;if(!this.visible)this.reset('NATIVE_APP_HIDDEN');}
 summary(){return{mode:this.route?'native-p2p':'ugreenlink-relay',p2p:Boolean(this.route),verified:Boolean(this.route),authenticated:Boolean(this.route),identityVerified:Boolean(this.route),mediaReadVerified:Boolean(this.route&&this.mediaReadVerified),wanTraversalVerified:false,current:Boolean(this.route),sdkLinkType:this.route?.type??null,reason:this.reason,productionIntegrated:false};}
 routeHandle(){const generation=this.generation,route=this.route,client=this.client,worker=this.worker,owner=this;
  const current=()=>!this.closed&&this.generation===generation&&this.route===route&&this.client===client&&this.worker===worker;
  return{client,route,get summary(){return current()?owner.summary():{mode:'ugreenlink-relay',p2p:false,verified:false,authenticated:false,identityVerified:false,mediaReadVerified:false,wanTraversalVerified:false,current:false,sdkLinkType:null,reason:'NATIVE_STALE_ROUTE',productionIntegrated:false};},close:()=>current()?this.reset():Promise.resolve(),retain:()=>{if(!current())throw fail('NATIVE_STALE_ROUTE');return this.retain();}};
 }
 reset(reason='NATIVE_RESET'){this.generation++;this.controller?.abort();this.client?.close();this.client=null;this.route=null;this.reason=reason;const worker=this.worker,release=this.activityRelease;this.worker=null;this.activityRelease=null;return Promise.resolve(worker?.stop()).finally(()=>{try{release?.();}catch{}});}
 close(){if(this.closed)return this.closing;this.closed=true;this.closing=this.reset('NATIVE_OWNER_CLOSED');return this.closing;}
 releaseActivity(){const release=this.activityRelease;this.activityRelease=null;try{release?.();}catch{}}
 select(options={}){if(this.pending)return this.pending;const task=this.run(options);this.pending=task;task.finally(()=>{if(this.pending===task)this.pending=null;}).catch(()=>{});return task;}
 async run({signal,mediaPath}={}){
  if(!this.enabled)return{summary:{...this.summary(),reason:'NATIVE_PRODUCTION_DISABLED'}};
  if(this.closed||!this.visible)return{summary:{...this.summary(),reason:'NATIVE_OWNER_INACTIVE'}};
  if(this.route)return this.routeHandle();
  if(!this.account.nasPublicRsa)return{summary:{...this.summary(),reason:'NAS_PUBLIC_RSA_MISSING'}};
  if(!Number.isInteger(this.uid)||this.uid<1||typeof this.prepareRuntime!=='function'||typeof this.acquireActivity!=='function')throw fail('NATIVE_OWNER_CONTEXT');
  const generation=this.generation,controller=new AbortController();this.controller=controller;const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const active=()=>{if(controller.signal.aborted||this.closed||!this.visible||generation!==this.generation)throw fail('NATIVE_ROUTE_CHANGED');};
  const relayAgent=new https.Agent({keepAlive:true,maxSockets:1,maxCachedSessions:0});let selected,worker;
  try{
   active();const release=await this.acquireActivity({signal:controller.signal,maximumMs:NATIVE_PRODUCTION_LIMITS.wallMs});if(typeof release!=='function')throw fail('NATIVE_ACTIVITY_UNAVAILABLE');if(controller.signal.aborted||generation!==this.generation){release();active();}this.activityRelease=release;
   const sdk=await this.prepareSdk?.({signal:controller.signal});active();const runtime=await this.prepareRuntime({sdk,signal:controller.signal});active();
   const base={server:this.account.server,readAuth:this.account,agent:relayAgent,signal:controller.signal,timeout:2000};
   const handshake=await this.request({...base,path:'/ugreen/v1/verify/handshake'});const instance=handshake.headers['x-ugreen-id'];handshake.body?.fill(0);if(typeof instance!=='string'||!instance||instance.length>512)throw fail('NATIVE_RELAY_IDENTITY');
   const backend=await this.request({...base,path:'/ugreen/v1/connect/uglink/glinfo',auth:true,query:{clientVersion:'1.21.0'}});backend.body?.fill(0);if(backend.data?.code!==200||backend.data?.data?.tunnel?.tunnelType!=='uglinkAgent'||Number(backend.data?.data?.tunnel?.tunnelStatus)!==1)throw fail('NATIVE_BACKEND_UNAVAILABLE');
   const alias=await this.request({...base,path:'/ugreen/v1/user/priority_link',auth:true});alias.body?.fill(0);if(alias.data?.code!==200||String(alias.data?.data?.uglink_id).toLowerCase()!==this.account.alias.toLowerCase())throw fail('NATIVE_RELAY_ALIAS');active();
   worker=this.createWorker({directory:runtime.directory,cloudApiOrigin:'https://api.ugnas.com',identity:{alias:this.account.alias,nasToken:this.account.authMode==='ugk'?this.account.staticToken:this.account.token,nasPublicRsa:this.account.nasPublicRsa},dnsServers:dns.getServers(),uid:this.uid,parentPid:this.parentPid,enabled:true});this.worker=worker;
   const revoke=()=>{if(this.worker===worker)this.reset('NATIVE_ROUTE_CHANGED');};worker.on('closed',revoke);worker.on('fault',revoke);worker.on('state',()=>{if(selected&&(worker.selection!==selected||worker.nativeListenerPort!==selected.port||worker.lastLinkType!==selected.type))revoke();});
   const until=this.now()+NATIVE_PRODUCTION_LIMITS.selectionMs;
   while(this.now()<until){active();if(worker.closed||worker.failure||worker.stopping||worker.initRejected||worker.startRejected)throw fail('NATIVE_WORKER_UNAVAILABLE');const current=worker.selection;
    if(worker.phase==='started'&&current&&[4,5].includes(current.type)&&current.proxy===worker.proxy&&worker.nativeListenerPort===current.port&&worker.lastLinkType===current.type){const proof=await this.inspect(worker.child.pid,current.port,this.uid);if(proof.verified){selected=current;break;}if(proof.reason!=='LISTENER_NOT_READY')throw fail('NATIVE_LISTENER_UNVERIFIED');}await this.wait(25);
   }
   if(!selected)throw fail('NATIVE_NO_P2P_SELECTION');
   const assertRoute=async()=>{try{active();if(worker.closed||worker.failure||worker.stopping||worker.selection!==selected||worker.phase!=='started'||worker.nativeListenerPort!==selected.port||worker.lastLinkType!==selected.type)throw fail('NATIVE_ROUTE_CHANGED');const proof=await this.inspect(worker.child.pid,selected.port,this.uid);if(!proof.verified)throw fail('NATIVE_LISTENER_UNVERIFIED');active();}catch(error){if(this.worker===worker)this.reset('NATIVE_ROUTE_CHANGED');throw error;}};
   const client=this.createClient({account:this.account,port:selected.port,instance,assertRoute,request:this.request,onMedia:()=>{if(this.route&&this.client===client&&!worker.closed&&worker.selection===selected)this.mediaReadVerified=true;}});this.client=client;
   // This bounded request independently performs local unauthenticated handshake
   // and same-socket authenticated alias verification before it carries auth.
   const verified=await client.request('v1/user/priority_link',{signal:controller.signal,timeout:1500});if(String(verified?.uglink_id).toLowerCase()!==this.account.alias.toLowerCase())throw fail('NATIVE_ACCOUNT_MISMATCH');
   this.mediaReadVerified=false;const route=Object.freeze({type:selected.type,port:selected.port,identityVerified:true});
   if(mediaPath!==undefined){if(typeof mediaPath!=='string'||!mediaPath||mediaPath.length>4096||/[\x00\r\n]/.test(mediaPath)||mediaPath.includes('://'))throw fail('NATIVE_MEDIA_PATH');const response=await client.open('/ugreen/v1/stream/transcode/raw/get',{query:{video_path:mediaPath},headers:{Range:'bytes=0-4095'},signal:controller.signal,timeout:1500});let bytes=0;try{if(response.statusCode!==206)throw fail('NATIVE_MEDIA_STATUS');for await(const chunk of response){bytes+=chunk.length;if(bytes>4096)throw fail('NATIVE_MEDIA_LIMIT');}if(!bytes)throw fail('NATIVE_MEDIA_EMPTY');await assertRoute();this.mediaReadVerified=true;}finally{response.destroy();}}
   await assertRoute();this.route=route;this.reason=null;return this.routeHandle();
  }catch(cause){if(generation===this.generation)await this.reset(cause?.code?.startsWith('NATIVE_')?cause.code:'NATIVE_SELECTION_FAILED');return{summary:this.summary()};}
  finally{relayAgent.destroy();signal?.removeEventListener('abort',cancel);}
 }
}
export const createNativeManager=options=>new NativeManager(options);
