import {EventEmitter} from 'node:events';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import {isIP} from 'node:net';
import {StringDecoder} from 'node:string_decoder';

const error=code=>Object.assign(new Error(code),{code});
const fields=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).every(key=>keys.includes(key));
function encodeIdentity({ownerPid,ownerUid,cloudApiOrigin,identity,dnsServers}){
 if(!Number.isInteger(ownerUid)||ownerUid<1||ownerUid>2147483647||!Number.isInteger(ownerPid)||ownerPid<2)throw error('UNPROVED_OWNER');
 if(!fields(identity,['alias','nasToken','nasPublicRsa'])||!/^[-a-z0-9]{1,63}$/i.test(identity.alias||'')
  ||typeof identity.nasToken!=='string'||identity.nasToken.length<1||identity.nasToken.length>8192||/[\x00-\x20\x7f]/.test(identity.nasToken)
  ||typeof identity.nasPublicRsa!=='string'||identity.nasPublicRsa.length<128||identity.nasPublicRsa.length>16384||/[\x00\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(identity.nasPublicRsa))throw error('IDENTITY_SCHEMA');
 // Exact fixed origin chosen by the recovered Android TV1.21 call chain.
 // It is supplied by the owning service, never accepted from an HTTP payload.
 if(cloudApiOrigin!=='https://api.ugnas.com')throw error('UNREVIEWED_CLOUD_ORIGIN');
 if(!Array.isArray(dnsServers)||dnsServers.length<1||dnsServers.length>3||new Set(dnsServers).size!==dnsServers.length
  ||dnsServers.some(value=>typeof value!=='string'||value.includes('%')||!isIP(value)))throw error('SYSTEM_DNS_UNREPRESENTABLE');
 const init=Buffer.from(JSON.stringify({cloudServer:{serverHost:'api.ugnas.com',serverPort:443},aesSize:256,logLev:2,logMaxDelay:5,logMaxCount:5,logConsole:false,uploadPeriod:120000,logPath:'.',logMaxSize:128}));
 const start=Buffer.from(JSON.stringify({address:identity.alias,uglinkAgent:true,localAgent:false,ddnsAgent:false,p2pAgent:false,p2pdirect:false,nasToken:identity.nasToken,nasPublicRsa:identity.nasPublicRsa}));
 const dns=Buffer.from(dnsServers.join('\n'));
 if(init.length>8192||start.length>24576||dns.length>255)throw error('IDENTITY_FRAME_LIMIT');
 const header=Buffer.alloc(28);header.write('CFUGW002');header.writeUInt32LE(ownerPid,8);header.writeUInt32LE(ownerUid,12);header.writeUInt32LE(init.length,16);header.writeUInt32LE(start.length,20);header.writeUInt32LE(dns.length,24);
 const frame=Buffer.concat([header,init,start,dns]);init.fill(0);start.fill(0);dns.fill(0);return frame;
}
async function sample(pid){try{const status=await fs.readFile(`/proc/${pid}/status`,'utf8'),item={};for(const line of status.split('\n')){const m=line.match(/^(Uid|VmRSS|Threads):\s+(.+)$/);if(m)item[m[1]]=m[2];}return{uid:Number(item.Uid?.split(/\s+/)[0]),rssKiB:Number.parseInt(item.VmRSS||'0',10),threads:Number(item.Threads||0)};}catch{return null;}}
class IdentityWorker extends EventEmitter{
 constructor({directory,cloudApiOrigin,identity,dnsServers,uid=process.getuid?.(),parentPid=process.pid,spawn=cp.spawn,sampleProcess=sample,wallMs=21600000,enabled=false}){
  super();if(enabled!==true)throw error('NATIVE_PRODUCTION_DISABLED');this.uid=uid;this.phase='starting';this.frames=[];this.selection=null;this.proxy=null;this.port=0;this.failure=null;this.closed=false;this.stopping=false;this.nativeListenerPort=0;this.outputBytes=0;this.stderrBytes=0;this.maxRssKiB=0;this.maxThreads=0;this.observedUids=new Set();this.initReturnCode=null;this.initRejected=false;this.startReturnCode=null;this.startRejected=false;this.nativeHello=false;this.gotGuard=false;this.releaseReturned=false;this.decoder=new StringDecoder('utf8');this.buffer='';this.lastLinkType=null;
  const frame=encodeIdentity({ownerPid:parentPid,ownerUid:uid,cloudApiOrigin,identity,dnsServers});
  this.result=new Promise(resolve=>this.resolveResult=resolve);
  const command='ulimit -c 0 && ulimit -t 3600 && ulimit -v 262144 && exec ./p2p-connect-worker';
  this.child=spawn('/bin/sh',['-c',command],{cwd:directory,env:{PATH:'/usr/bin:/bin',LD_LIBRARY_PATH:directory,TMPDIR:directory,LANG:'C',ANDROID_DNS_MODE:'local'},stdio:['pipe','pipe','pipe'],detached:false,windowsHide:true});
  this.child.stdout.on('data',bytes=>this.receive(bytes));
  this.child.stderr.on('data',bytes=>{this.stderrBytes+=bytes.length;this.outputBytes+=bytes.length;if(this.outputBytes>65536)this.fail('OUTPUT_LIMIT');});
  this.child.stdin.on('error',()=>this.fail('WORKER_INPUT_CLOSED'));
  this.child.once('error',()=>this.fail('WORKER_SPAWN_ERROR'));
  this.child.once('close',(code,signal)=>this.finish(code,signal));
  this.timer=setTimeout(()=>this.fail('WALL_TIMEOUT'),Math.min(21600000,Math.max(100,wallMs)));
  const observe=async()=>{if(this.closed||!this.child.pid)return;const data=await sampleProcess(this.child.pid);if(!data||this.closed)return;this.observedUids.add(data.uid);this.maxRssKiB=Math.max(this.maxRssKiB,data.rssKiB||0);this.maxThreads=Math.max(this.maxThreads,data.threads||0);if(data.uid!==this.uid)this.fail('CHILD_UID_MISMATCH');};
  this.sampler=setInterval(observe,1000);observe();
  try{this.child.stdin.write(frame,()=>frame.fill(0));}catch{frame.fill(0);this.fail('WORKER_INPUT_CLOSED');}
 }
 fail(code){if(this.closed||this.failure)return;this.failure=code;this.phase='failed';this.selection=null;try{this.child.kill('SIGKILL');}catch{}this.emit('fault',{code});}
 receive(bytes){
  if(this.closed||this.failure)return;this.outputBytes+=bytes.length;if(this.outputBytes>65536)return this.fail('OUTPUT_LIMIT');
  this.buffer+=this.decoder.write(bytes);
  for(let index;(index=this.buffer.indexOf('\n'))>=0;){const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);if(Buffer.byteLength(line)>512)return this.fail('FRAME_LIMIT');
   let frame;try{frame=JSON.parse(line);}catch{return this.fail('PROTOCOL_FRAME');}
   if(!fields(frame,['v','event','stage','code','proxy','type','port'])||Object.keys(frame).length!==7||frame.v!==1||!['event','stage','code','proxy','type','port'].every(key=>Number.isInteger(frame[key])&&Math.abs(frame[key])<=2147483647)||frame.port<0||frame.port>65535)return this.fail('PROTOCOL_FRAME');
   if(this.frames.length>=256)return this.fail('EVENT_LIMIT');this.frames.push(frame);
   if(frame.event===-100)return this.fail('NATIVE_POLICY_'+frame.code);
   if(!this.nativeHello){if(frame.event!==100||frame.stage!==0||frame.code!==0||frame.proxy!==this.child.pid||frame.type!==this.uid)return this.fail('NATIVE_OWNER_OR_GUARD');this.nativeHello=true;this.phase='guarded';continue;}
   if(frame.event===100){
    if(frame.stage===6){if(frame.code!==0)return this.fail('PLT_GUARD');this.gotGuard=true;}
    if(frame.stage===2){if(!this.gotGuard)return this.fail('PLT_GUARD');this.initReturnCode=frame.code;this.initRejected=frame.code<0;this.phase=this.initRejected?'init-rejected':'initialized';if(this.initRejected)this.selection=null;}
    if(frame.stage===3){if(this.phase!=='initialized'||frame.proxy!==frame.code||this.selection&&this.selection.proxy!==frame.proxy)return this.fail('SDK_START_REJECTED');this.startReturnCode=frame.code;this.startRejected=frame.code<1;if(this.startRejected){this.phase='start-rejected';this.selection=null;}else{this.proxy=frame.proxy;this.port=frame.port;this.phase='started';}}
    if(frame.stage===7){if(frame.proxy!==this.proxy||![0,1].includes(frame.code))return this.fail('LISTENER_FRAME');this.nativeListenerPort=frame.code===1?frame.port:0;if(this.selection&&this.nativeListenerPort!==this.selection.port)this.selection=null;this.emit('state',{event:100,stage:7,port:this.nativeListenerPort});}
    if(frame.stage===5){this.releaseReturned=true;this.phase='releasing';}
   }else if(frame.event===101){if(this.proxy&&frame.proxy!==this.proxy)return this.fail('PROXY_MISMATCH');this.lastLinkType=frame.type;if(this.selection&&this.selection.type!==frame.type)this.selection=null;this.emit('state',{event:101,type:frame.type});}
   else if([0,6,7,-1,-2].includes(frame.event)){
    if(this.proxy&&frame.proxy!==this.proxy)return this.fail('PROXY_MISMATCH');
    if(this.stopping||this.phase==='releasing')continue;
    if(frame.event===6){if(![0,2,4,5].includes(frame.type)||[4,5].includes(frame.type)&&!frame.port)return this.fail('LINK_FRAME');this.selection={type:frame.type,port:frame.port,proxy:frame.proxy,at:Date.now()};}
    if([7,-1,-2].includes(frame.event))this.selection=null;
    this.emit('state',{event:frame.event,type:frame.type,port:frame.port,proxy:frame.proxy,p2pEstablished:false});
   }else return this.fail('UNKNOWN_FRAME');
  }
  if(Buffer.byteLength(this.buffer)>512)this.fail('FRAME_LIMIT');
 }
 async stop(){if(this.closed||this.stopping)return this.result;this.stopping=true;this.selection=null;if(!this.failure){try{this.child.stdin.write('X');}catch{this.fail('WORKER_INPUT_CLOSED');}this.stopTimer=setTimeout(()=>this.fail('STOP_TIMEOUT'),1000);}return this.result;}
 finish(code,signal){if(this.closed)return;this.closed=true;clearTimeout(this.timer);clearTimeout(this.stopTimer);clearInterval(this.sampler);if(!this.failure&&(this.buffer.length||this.decoder.end().length))this.failure='TRUNCATED_FRAME';const uidVerified=this.observedUids.size===1&&this.observedUids.has(this.uid);this.phase='closed';this.selection=null;const result={exitCode:code,signal,failure:this.failure||(this.initRejected?'SDK_INIT_REJECTED':this.startRejected?'SDK_START_REJECTED':null),initReturnCode:this.initReturnCode,initRejected:this.initRejected,startReturnCode:this.startReturnCode,startRejected:this.startRejected,uid:this.uid,childPid:this.child.pid,childUids:[...this.observedUids],uidVerified,nativeHello:this.nativeHello,gotGuard:this.gotGuard,releaseReturned:this.releaseReturned,outputBytes:this.outputBytes,stderrBytes:this.stderrBytes,maxObservedRssKiB:this.maxRssKiB,maxObservedThreads:this.maxThreads,events:this.frames,p2pEstablished:false};this.resolveResult(result);this.emit('closed',result);}
}
export const NATIVE_PRODUCTION_LIMITS=Object.freeze({wallMs:21600000,cpuSeconds:3600,addressSpaceBytes:268435456,coreBytes:0,fileSizeBytes:0,outputBytes:65536,selectionMs:10000,proofBytes:4096,stopGraceMs:1000});
export {encodeIdentity,IdentityWorker};
