import * as fs from 'node:fs/promises';
function listenerProof({pid,uid,expectedUid,port,links,tcp,tcp6}){
 if(!Number.isInteger(pid)||pid<2||uid!==expectedUid||!Number.isInteger(uid)||uid<1||!Number.isInteger(port)||port<1||port>65535)return{verified:false,reason:'LISTENER_CONTEXT'};
 const owned=new Set(links.map(value=>/^socket:\[(\d+)\]$/.exec(value)?.[1]).filter(Boolean));
 const rows=[];
 for(const[family,text]of[[4,tcp],[6,tcp6]])for(const line of String(text||'').trim().split('\n').slice(1)){
  const fields=line.trim().split(/\s+/);if(fields.length<10||fields[3]!=='0A')continue;
  const[host,hex]=fields[1].split(':');if(Number.parseInt(hex,16)!==port)continue;
  rows.push({family,host,uid:Number(fields[7]),inode:fields[9]});
 }
 if(!rows.length)return{verified:false,reason:'LISTENER_NOT_READY'};
 if(rows.some(row=>row.uid!==uid||!owned.has(row.inode)||row.family===4&&row.host!=='0100007F'||row.family===6&&row.host!=='00000000000000000000000001000000'))return{verified:false,reason:'LISTENER_NOT_EXCLUSIVE_LOOPBACK'};
 if(!rows.some(row=>row.family===4))return{verified:false,reason:'IPV4_LOOPBACK_NOT_READY'};
 return{verified:true,pid,uid,port,ownedListeners:rows.length};
}
async function inspectListener(pid,port,expectedUid=process.getuid()){
 try{const[status,descriptors,tcp,tcp6]=await Promise.all([fs.readFile(`/proc/${pid}/status`,'utf8'),fs.readdir(`/proc/${pid}/fd`),fs.readFile('/proc/net/tcp','utf8'),fs.readFile('/proc/net/tcp6','utf8')]);
  const uid=Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);const links=await Promise.all(descriptors.map(name=>fs.readlink(`/proc/${pid}/fd/${name}`).catch(()=>'')));
  return listenerProof({pid,uid,expectedUid,port,links,tcp,tcp6});
 }catch{return{verified:false,reason:'LISTENER_UNREADABLE'};}
}
export {listenerProof,inspectListener};
