import http from 'node:http';
import {requestNas} from './native-http.mjs';
const fail=code=>Object.assign(new Error('原生连接已失效，使用安全备用连接'),{code});

/** Each new local socket proves unauthenticated NAS identity before any token. */
export class NativeNasClient {
 constructor({account,port,instance,assertRoute,onMedia=()=>{},request=requestNas,openRequest=http.request}={}){
  this.account=account;this.port=port;this.instance=instance;this.assertRoute=assertRoute;this.onMedia=onMedia;this.requestProof=request;this.openRequest=openRequest;this.agents=new Set();this.responses=new Set();this.closed=false;
  this.httpsAgent={destroy:()=>this.close()};
 }
 close(){this.closed=true;for(const response of this.responses)response.destroy();this.responses.clear();for(const agent of this.agents)agent.destroy();this.agents.clear();}
 async open(path,{method='GET',query={},headers={},timeout=20000,signal,auth=true,body}={}){
  if(this.closed||!['GET','HEAD'].includes(String(method).toUpperCase())||body!==undefined||this.agents.size>=4)throw fail('NATIVE_READ_ONLY');
  if(typeof path!=='string'||!path.startsWith('/ugreen/')||path.includes('\r')||path.includes('\n')||path.includes('#')||path.includes('?'))throw fail('NATIVE_PATH');
  if(Object.keys(headers).some(key=>!['range','accept','if-range','if-match','if-none-match','if-modified-since','if-unmodified-since'].includes(key.toLowerCase())))throw fail('NATIVE_HEADERS');
  // Reserve a slot synchronously, including in-flight route proofs. The Agent
  // constructor opens no socket; every failure below releases this reservation.
  const agent=new http.Agent({keepAlive:true,maxSockets:1}),server=`http://127.0.0.1:${this.port}`;this.agents.add(agent);
  let released=false;const release=()=>{if(released)return;released=true;this.agents.delete(agent);agent.destroy();};
  const base={server,readAuth:this.account,agent,signal,timeout:Math.min(1500,timeout)};
  try{
   await this.assertRoute();if(this.closed||signal?.aborted)throw fail('NATIVE_ROUTE_CHANGED');
   const handshake=await this.requestProof({...base,path:'/ugreen/v1/verify/handshake'});handshake.body?.fill(0);
   if(handshake.headers['x-ugreen-id']!==this.instance)throw fail('NATIVE_NAS_IDENTITY_MISMATCH');
   const socket=handshake.socket;if(!socket||socket.destroyed)throw fail('NATIVE_SOCKET_CHANGED');
   await this.assertRoute();
   const alias=await this.requestProof({...base,path:'/ugreen/v1/user/priority_link',auth:true,pinnedSocket:socket});alias.body?.fill(0);
   if(alias.data?.code!==200||String(alias.data?.data?.uglink_id).toLowerCase()!==this.account.alias.toLowerCase())throw fail('NATIVE_ACCOUNT_MISMATCH');
   await this.assertRoute();if(this.closed||signal?.aborted)throw fail('NATIVE_ROUTE_CHANGED');
   const url=new URL(path,server);if(url.origin!==server)throw fail('NATIVE_PATH');
   for(const[key,value]of Object.entries(query))if(value!==undefined){if(['token','ugk'].includes(key))throw fail('NATIVE_QUERY_AUTH');url.searchParams.set(key,String(value));}
   if(auth)url.searchParams.set(this.account.authMode==='ugk'?'ugk':'token',this.account.authMode==='ugk'?this.account.staticToken:this.account.token);
   const response=await new Promise((resolve,reject)=>{
    const req=this.openRequest(url,{method,agent,signal,headers:{...headers,'UG-Client-Id':this.account.clientId,Connection:'keep-alive'}},resolve);
    req.once('socket',actual=>{if(actual!==socket||actual.destroyed||this.closed){req.destroy(fail('NATIVE_SOCKET_CHANGED'));return;}req.end();});
    req.setTimeout(Math.max(1,Math.min(120000,timeout)),()=>req.destroy(fail('NATIVE_READ_TIMEOUT')));req.once('error',()=>reject(fail('NATIVE_REQUEST_FAILED')));
   });
   this.responses.add(response);let counted=false;
   // Observe data through emit, without a data listener that would start flow
   // before the caller attaches its stream consumer.
   const original=response.emit;response.emit=(event,...args)=>{if(event==='data'&&!counted&&args[0]?.length){counted=true;if(path==='/ugreen/v1/stream/transcode/raw/get'&&[200,206].includes(response.statusCode))this.onMedia(args[0].length);}return original.call(response,event,...args);};
   const done=()=>{this.responses.delete(response);release();};response.once('close',done);response.once('end',done);return response;
  }catch(error){release();throw error?.code?.startsWith('NATIVE_')?error:fail('NATIVE_VERIFICATION_FAILED');}
 }
 async request(path,options){const response=await this.open('/ugreen/'+path.replace(/^\/+/,''),options);let size=0;const chunks=[];
  try{for await(const chunk of response){size+=chunk.length;if(size>12*1024*1024)throw fail('NATIVE_RESPONSE_LIMIT');chunks.push(chunk);}const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(response.statusCode!==200||data.code!==200)throw fail('NATIVE_NAS_REJECTED');return data.data;}
  finally{response.destroy();}
 }
}
