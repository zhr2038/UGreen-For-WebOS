import http from 'node:http';
import {requestNas} from './native-http.mjs';
const nativeClientCodes=new Set(['NATIVE_ROUTE_CHANGED','NATIVE_NAS_IDENTITY_MISMATCH','NATIVE_SOCKET_CHANGED','NATIVE_ACCOUNT_MISMATCH','NATIVE_LISTENER_UNVERIFIED','NATIVE_READ_TIMEOUT','NATIVE_REQUEST_FAILED','NATIVE_VERIFICATION_FAILED','NATIVE_PATH','NATIVE_QUERY_AUTH','NATIVE_HEADERS','NATIVE_RESPONSE_LIMIT','NATIVE_RESPONSE_INVALID','NATIVE_NAS_REJECTED','NATIVE_READ_ONLY','NATIVE_CONNECTION_LIMIT']);
export const isNativeRouteFailure=code=>new Set(['NATIVE_ROUTE_CHANGED','NATIVE_NAS_IDENTITY_MISMATCH','NATIVE_SOCKET_CHANGED','NATIVE_ACCOUNT_MISMATCH','NATIVE_LISTENER_UNVERIFIED','NATIVE_READ_TIMEOUT','NATIVE_REQUEST_FAILED','NATIVE_VERIFICATION_FAILED','NATIVE_RESPONSE_LIMIT','NATIVE_RESPONSE_INVALID','NATIVE_NAS_REJECTED']).has(code);
const fail=code=>Object.assign(new Error('原生连接已失效，使用安全备用连接'),{code});
const integrityCodes=new Set(['NATIVE_ROUTE_CHANGED','NATIVE_NAS_IDENTITY_MISMATCH','NATIVE_SOCKET_CHANGED','NATIVE_ACCOUNT_MISMATCH','NATIVE_LISTENER_UNVERIFIED']);
export const isNativeIntegrityFailure=code=>integrityCodes.has(code);
export const isCallerAbort=error=>error?.name==='AbortError'||error?.code==='ABORT_ERR';
const aborted=()=>Object.assign(new Error('读取已取消'),{name:'AbortError',code:'ABORT_ERR'});
function safeClientError(error,signal,fallback){if(error?.code==='PROXY_SOCKET_CONTINUITY')return fail('NATIVE_SOCKET_CHANGED');if(integrityCodes.has(error?.code))return fail(error.code);if(signal?.aborted||isCallerAbort(error))return aborted();return fail(nativeClientCodes.has(error?.code)?error.code:fallback);}
// Give same-turn integrity proof/rejection priority over cancellation, without
// waiting for an uncooperative proof or allowing a later authentication step.
function callerWait(operation,signal,discard=()=>{}){return new Promise((resolve,reject)=>{
 let settled=false;const abort=()=>{queueMicrotask(()=>queueMicrotask(()=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);reject(aborted());}));};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
 let pending;try{pending=operation();}catch(error){signal?.removeEventListener('abort',abort);settled=true;reject(error);return;}
 Promise.resolve(pending).then(value=>{if(settled){try{discard(value);}catch{}return;}settled=true;signal?.removeEventListener('abort',abort);resolve(value);},error=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);reject(error);});
});}
const discardProof=value=>{value?.body?.fill?.(0);value?.socket?.destroy?.();};


/** Each new local socket proves unauthenticated NAS identity before any token. */
export class NativeNasClient {
 constructor({account,port,instance,assertRoute,onMedia=()=>{},request=requestNas,openRequest=http.request}={}){
  this.account=account;this.port=port;this.instance=instance;this.assertRoute=assertRoute;this.onMedia=onMedia;this.requestProof=request;this.openRequest=openRequest;this.agents=new Set();this.responses=new Set();this.closed=false;
  this.httpsAgent={destroy:()=>this.close()};
 }
 close(){this.closed=true;for(const response of this.responses)response.destroy();this.responses.clear();for(const agent of this.agents)agent.destroy();this.agents.clear();}
 async open(path,{method='GET',query={},headers={},timeout=20000,signal,auth=true,body}={}){
  if(this.closed)throw fail('NATIVE_ROUTE_CHANGED');
  if(signal?.aborted)throw aborted();
  if(!['GET','HEAD'].includes(String(method).toUpperCase())||body!==undefined)throw fail('NATIVE_READ_ONLY');
  if(this.agents.size>=4)throw fail('NATIVE_CONNECTION_LIMIT');
  if(typeof path!=='string'||!path.startsWith('/ugreen/')||path.includes('\r')||path.includes('\n')||path.includes('#')||path.includes('?'))throw fail('NATIVE_PATH');
  if(Object.keys(headers).some(key=>!['range','accept','if-range','if-match','if-none-match','if-modified-since','if-unmodified-since'].includes(key.toLowerCase())))throw fail('NATIVE_HEADERS');
  // Reserve a slot synchronously, including in-flight route proofs. The Agent
  // constructor opens no socket; every failure below releases this reservation.
  const agent=new http.Agent({keepAlive:true,maxSockets:1}),server=`http://127.0.0.1:${this.port}`;this.agents.add(agent);
  let released=false;const release=()=>{if(released)return;released=true;this.agents.delete(agent);agent.destroy();};
  const base={server,readAuth:this.account,agent,signal,timeout:Math.min(1500,timeout)};
  try{
   await callerWait(()=>this.assertRoute(),signal);if(this.closed)throw fail('NATIVE_ROUTE_CHANGED');if(signal?.aborted)throw aborted();
   const handshake=await callerWait(()=>this.requestProof({...base,path:'/ugreen/v1/verify/handshake'}),signal,discardProof);handshake.body?.fill(0);
   if(handshake.headers['x-ugreen-id']!==this.instance)throw fail('NATIVE_NAS_IDENTITY_MISMATCH');
   const socket=handshake.socket;if(!socket||socket.destroyed)throw fail('NATIVE_SOCKET_CHANGED');
   if(signal?.aborted)throw aborted();await callerWait(()=>this.assertRoute(),signal);if(this.closed)throw fail('NATIVE_ROUTE_CHANGED');if(signal?.aborted)throw aborted();
   const alias=await callerWait(()=>this.requestProof({...base,path:'/ugreen/v1/user/priority_link',auth:true,pinnedSocket:socket}),signal,discardProof);alias.body?.fill(0);
   if(alias.data?.code!==200||String(alias.data?.data?.uglink_id).toLowerCase()!==this.account.alias.toLowerCase())throw fail('NATIVE_ACCOUNT_MISMATCH');
   await callerWait(()=>this.assertRoute(),signal);if(this.closed)throw fail('NATIVE_ROUTE_CHANGED');if(signal?.aborted)throw aborted();
   const url=new URL(path,server);if(url.origin!==server)throw fail('NATIVE_PATH');
   for(const[key,value]of Object.entries(query))if(value!==undefined){if(['token','ugk'].includes(key))throw fail('NATIVE_QUERY_AUTH');url.searchParams.set(key,String(value));}
   if(auth)url.searchParams.set(this.account.authMode==='ugk'?'ugk':'token',this.account.authMode==='ugk'?this.account.staticToken:this.account.token);
   const response=await callerWait(()=>new Promise((resolve,reject)=>{
    const req=this.openRequest(url,{method,agent,signal,headers:{...headers,'UG-Client-Id':this.account.clientId,Connection:'keep-alive'}},resolve);
    req.once('socket',actual=>{if(actual!==socket||actual.destroyed||this.closed){req.destroy(fail('NATIVE_SOCKET_CHANGED'));return;}if(signal?.aborted){req.destroy(aborted());return;}req.end();});
    req.setTimeout(Math.max(1,Math.min(120000,timeout)),()=>req.destroy(fail('NATIVE_READ_TIMEOUT')));req.once('error',cause=>reject(safeClientError(cause,signal,'NATIVE_REQUEST_FAILED')));
   }),signal,response=>response?.destroy?.());
   if(this.closed){response.destroy();throw fail('NATIVE_ROUTE_CHANGED');}if(signal?.aborted){response.destroy();throw aborted();}
   this.responses.add(response);let counted=false;
   // Observe data through emit, without a data listener that would start flow
   // before the caller attaches its stream consumer.
   const original=response.emit;response.emit=(event,...args)=>{if(event==='data'&&!counted&&args[0]?.length){counted=true;if(path==='/ugreen/v1/stream/transcode/raw/get'&&[200,206].includes(response.statusCode))this.onMedia(args[0].length);}return original.call(response,event,...args);};
   const done=()=>{this.responses.delete(response);release();};response.once('close',done);response.once('end',done);return response;
  }catch(error){release();if(this.closed&&!isNativeIntegrityFailure(error?.code)&&error?.code!=='PROXY_SOCKET_CONTINUITY')throw fail('NATIVE_ROUTE_CHANGED');throw safeClientError(error,signal,'NATIVE_VERIFICATION_FAILED');}
 }
 async request(path,options){const response=await this.open('/ugreen/'+path.replace(/^\/+/,''),options);let size=0;const chunks=[];
  try{for await(const chunk of response){if(options?.signal?.aborted)throw aborted();size+=chunk.length;if(size>12*1024*1024)throw fail('NATIVE_RESPONSE_LIMIT');chunks.push(chunk);}if(options?.signal?.aborted)throw aborted();const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(response.statusCode!==200||data.code!==200)throw fail('NATIVE_NAS_REJECTED');return data.data;}
  catch(error){if(this.closed&&!isNativeIntegrityFailure(error?.code))throw fail('NATIVE_ROUTE_CHANGED');throw safeClientError(error,options?.signal,'NATIVE_RESPONSE_INVALID');}
  finally{response.destroy();}
 }
}
