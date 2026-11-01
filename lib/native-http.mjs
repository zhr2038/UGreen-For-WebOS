import http from 'node:http';
import https from 'node:https';
export const NATIVE_HTTP_NETWORK_CODES=Object.freeze(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','ECONNABORTED','EPIPE','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_NOT_YET_VALID','ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED','ERR_SSL_WRONG_VERSION_NUMBER','EPROTO','ABORT_ERR']);
const safeCodes=new Set(['NAS_ORIGIN_MISMATCH','NAS_HTTP_STATUS','NAS_RESPONSE_LIMIT','NAS_RESPONSE_FAILED','NAS_JSON','NAS_TIMEOUT','NAS_REQUEST_FAILED','PROXY_SOCKET_CONTINUITY',...NATIVE_HTTP_NETWORK_CODES]);
const failure=(code,httpStatus)=>Object.assign(new Error('原生连接验证失败'),{code},Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?{httpStatus}:{});
const safeFailure=(cause,fallback)=>failure(safeCodes.has(cause?.code)?cause.code:fallback,cause?.code==='NAS_HTTP_STATUS'?cause.httpStatus:undefined);
function requestNas({server,path,readAuth,auth=false,query={},range,agent,pinnedSocket,signal,timeout=1500,limit=32768},internals={}){
 const url=new URL(path,server);if(url.origin!==new URL(server).origin)throw failure('NAS_ORIGIN_MISMATCH');
 for(const[key,value]of Object.entries(query))url.searchParams.set(key,String(value));
 if(auth)url.searchParams.set(readAuth.authMode==='ugk'?'ugk':'token',readAuth.authMode==='ugk'?readAuth.staticToken:readAuth.token);
 return new Promise((resolve,reject)=>{
  let timer,settled=false;const finish=(cause,value)=>{if(settled)return;settled=true;clearTimeout(timer);cause?reject(cause):resolve(value);};
  const client=url.protocol==='https:'?https:http;
  let request;try{request=(internals.request||client.request)(url,{agent,signal,rejectUnauthorized:true,headers:{'UG-Client-Id':readAuth.clientId,Connection:'keep-alive',...(range?{Range:'bytes=0-4095'}:{})}},response=>{
   const socket=response.socket;
   if(response.statusCode!==(range?206:200)){response.destroy();finish(failure('NAS_HTTP_STATUS',response.statusCode));return;}
   let size=0;const chunks=[];response.on('data',chunk=>{size+=chunk.length;if(size>limit){response.destroy();finish(failure('NAS_RESPONSE_LIMIT'));return;}chunks.push(chunk);});
   response.once('error',cause=>finish(safeFailure(cause,'NAS_RESPONSE_FAILED')));
   response.once('end',()=>{const body=Buffer.concat(chunks);let data=null;if(!range)try{data=JSON.parse(body.toString('utf8'));}catch{body.fill(0);finish(failure('NAS_JSON'));return;}finish(null,{headers:response.headers,body,data,socket,status:response.statusCode});});
  });}catch(cause){finish(safeFailure(cause,'NAS_REQUEST_FAILED'));return;}
  if(settled)return;timer=setTimeout(()=>request.destroy(failure('NAS_TIMEOUT')),Math.max(1,timeout));
  request.once('socket',socket=>{if(pinnedSocket&&(socket!==pinnedSocket||socket.destroyed)){request.destroy(failure('PROXY_SOCKET_CONTINUITY'));return;}request.end();});
  request.setTimeout(Math.max(1,timeout),()=>request.destroy(failure('NAS_TIMEOUT')));
  request.once('error',cause=>finish(safeFailure(cause,'NAS_REQUEST_FAILED')));
 });
}
export {requestNas};
