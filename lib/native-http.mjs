import http from 'node:http';
import https from 'node:https';
const failure=code=>Object.assign(new Error('原生连接验证失败'),{code});
function requestNas({server,path,readAuth,auth=false,query={},range,agent,pinnedSocket,signal,timeout=1500,limit=32768},internals={}){
 const url=new URL(path,server);if(url.origin!==new URL(server).origin)throw failure('NAS_ORIGIN_MISMATCH');
 for(const[key,value]of Object.entries(query))url.searchParams.set(key,String(value));
 if(auth)url.searchParams.set(readAuth.authMode==='ugk'?'ugk':'token',readAuth.authMode==='ugk'?readAuth.staticToken:readAuth.token);
 return new Promise((resolve,reject)=>{
  let settled=false;const finish=(cause,value)=>{if(settled)return;settled=true;clearTimeout(timer);cause?reject(cause):resolve(value);};
  const client=url.protocol==='https:'?https:http;
  const request=(internals.request||client.request)(url,{agent,signal,rejectUnauthorized:true,headers:{'UG-Client-Id':readAuth.clientId,Connection:'keep-alive',...(range?{Range:'bytes=0-4095'}:{})}},response=>{
   const socket=response.socket;
   if(response.statusCode!==(range?206:200)){response.destroy();finish(failure('NAS_HTTP_STATUS'));return;}
   let size=0;const chunks=[];response.on('data',chunk=>{size+=chunk.length;if(size>limit){response.destroy();finish(failure('NAS_RESPONSE_LIMIT'));return;}chunks.push(chunk);});
   response.once('error',()=>finish(failure('NAS_RESPONSE_FAILED')));
   response.once('end',()=>{const body=Buffer.concat(chunks);let data=null;if(!range)try{data=JSON.parse(body.toString('utf8'));}catch{body.fill(0);finish(failure('NAS_JSON'));return;}finish(null,{headers:response.headers,body,data,socket,status:response.statusCode});});
  });
  const timer=setTimeout(()=>request.destroy(failure('NAS_TIMEOUT')),Math.max(1,timeout));
  request.once('socket',socket=>{if(pinnedSocket&&(socket!==pinnedSocket||socket.destroyed)){request.destroy(failure('PROXY_SOCKET_CONTINUITY'));return;}request.end();});
  request.setTimeout(Math.max(1,timeout),()=>request.destroy(failure('NAS_TIMEOUT')));
  request.once('error',()=>finish(failure('NAS_REQUEST_FAILED')));
 });
}
export {requestNas};
