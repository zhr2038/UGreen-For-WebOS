import * as filesystem from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,resolve,join} from 'node:path';
import {createPrivateState,PrivateStateError} from './private-state.mjs';

export const TV_STATE_APP='top.hrhome.nascinema.service';
export const TV_STATE_FILES=Object.freeze(['session.json','device-id','clients.json','movie-preferences.json']);
const receiptName='state-migration.json',format='cloudframe.tv-state-migration.v1',queues=new Map();
const temporary=/^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
export class TvStateError extends Error{constructor(code){super('电视私有状态迁移未完成，原状态已保留');this.name='TvStateError';this.code=code;this.status=503;}}
const fail=code=>new TvStateError(code);
function parse(bytes){try{return JSON.parse(bytes.toString('utf8'));}catch{return null;}}
function validSession(bytes){
  const value=parse(bytes);if(!plain(value)||typeof value.alias!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.alias)||typeof value.token!=='string'||!value.token||value.token.length>8192)return false;
  try{const url=new URL(value.server);return url.protocol==='https:'&&url.origin===value.server&&!url.username&&!url.password&&url.hostname.startsWith(value.alias.toLowerCase()+'.')&&url.hostname.endsWith('.ug.link');}catch{return false;}
}
function validLogout(bytes){const value=parse(bytes);return plain(value)&&Object.keys(value).length===0;}
function validFile(name,bytes){if(name==='session.json')return validSession(bytes)||validLogout(bytes);if(name==='device-id')return/^[a-zA-Z0-9_-]{16,64}$/.test(bytes.toString('utf8').trim());return plain(parse(bytes));}
function active(signal){if(signal?.aborted)throw fail('TV_STATE_CANCELLED');}

/** No IO at construction; migration must be explicitly requested by the service. */
export function createTvState({legacyDir,baseDir='/media/internal',trustedBaseDir=baseDir,uid=typeof process.getuid==='function'?process.getuid():undefined,appId=TV_STATE_APP,fs=filesystem,onStep=()=>{}}={}){
  if(!Number.isInteger(uid)||uid<0||uid>4294967295||typeof process.getuid==='function'&&uid!==process.getuid()||appId!==TV_STATE_APP||typeof baseDir!=='string'||!isAbsolute(baseDir)||baseDir!==resolve(baseDir)||trustedBaseDir!==baseDir||typeof legacyDir!=='string'||!isAbsolute(legacyDir)||legacyDir!==resolve(legacyDir))throw fail('TV_STATE_OPTIONS');
  const dir=join(baseDir,appId+'.uid-'+uid),sourceId=digest(legacyDir),key=process.platform==='win32'?dir.toLowerCase():dir;
  if(dir===legacyDir)throw fail('TV_STATE_OPTIONS');
  const target=createPrivateState({dir,trustedDir:dir,files:[...TV_STATE_FILES,receiptName,'storage-check'],maxBytes:1024*1024,fs});
  const store=(directory,files,expectedIdentity)=>createPrivateState({dir:directory,trustedDir:directory,files,maxBytes:1024*1024,fs,expectedIdentity});
  async function serial(operation){const previous=queues.get(key)||Promise.resolve(),current=previous.catch(()=>{}).then(operation).catch(error=>{if(error instanceof TvStateError||error instanceof PrivateStateError)throw error;throw fail('TV_STATE_IO');});queues.set(key,current);try{return await current;}finally{if(queues.get(key)===current)queues.delete(key);}}
  function readReceipt(bytes){
    const value=parse(bytes);if(!plain(value)||value.format!==format||value.appId!==appId||value.uid!==uid||value.source!==sourceId||!['prepared','copied','complete'].includes(value.phase)||!Array.isArray(value.files)||value.files.length>32)throw fail('TV_STATE_RECEIPT_INVALID');
    const seen=new Set();for(const item of value.files){if(!plain(item)||seen.has(item.name)||!TV_STATE_FILES.includes(item.name)&&!temporary.test(item.name)||item.quarantine!==temporary.test(item.name)||!/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>1024*1024)throw fail('TV_STATE_RECEIPT_INVALID');seen.add(item.name);}return value;
  }
  async function reportBase(){const info=await target.repair();return{ready:true,posixProtected:info.posixProtected};}
  async function checkWritable(){return serial(async()=>{
    await target.repair();const previous=await target.readVersioned('storage-check');
    if(previous){if(!previous.value.startsWith('cloudframe-state-check-v1:'+uid+':')||!/^cloudframe-state-check-v1:[0-9]+:[a-f0-9-]{36}$/.test(previous.value))throw fail('TV_STATE_PROBE_CONFLICT');await target.remove('storage-check',previous.version);}
    const value='cloudframe-state-check-v1:'+uid+':'+randomUUID();await target.write('storage-check',value);const record=await target.readVersioned('storage-check');if(record?.value!==value)throw fail('TV_STATE_VERIFY_FAILED');await target.remove('storage-check',record.version);return{writable:true,posixProtected:process.platform!=='win32'};
  });}
  async function migrate({signal}={}){return serial(async()=>{
    active(signal);const base=await reportBase(),newSession=await target.readVersioned('session.json',{encoding:'buffer'}),savedReceipt=await target.readVersioned(receiptName,{encoding:'buffer'});
    let receipt=null;
    if(savedReceipt){try{receipt=readReceipt(savedReceipt.value);}catch(error){if(newSession&&validSession(newSession.value))return{...base,complete:true,existingPreferred:true,receiptIgnored:true,copied:0,removed:0,quarantined:0,retained:0};throw error;}}
    // Never inspect or repair the old tree when a separately established valid
    // new session already owns this service's state.
    const plannedSession=receipt?.files.find(item=>item.name==='session.json');
    if(newSession&&validSession(newSession.value)&&(!plannedSession||digest(newSession.value)!==plannedSession.sha256))return{...base,complete:true,existingPreferred:true,copied:0,removed:0,quarantined:0,retained:0};
    if(receipt?.phase==='complete')return{...base,complete:true,existingPreferred:true,copied:0,removed:0,quarantined:0,retained:0};
    let legacyExists=true,legacyIdentity;try{legacyIdentity=await fs.lstat(legacyDir,{bigint:true});}catch(error){if(error.code==='ENOENT')legacyExists=false;else throw error;}
    if(!legacyExists&&!receipt)return{...base,complete:true,legacyMissing:true,copied:0,removed:0,quarantined:0,retained:0};
    let names=[];
    if(legacyExists){const discovery=store(legacyDir,TV_STATE_FILES,legacyIdentity);await discovery.repair();names=(await discovery.names()).filter(name=>temporary.test(name));if(names.length>28)throw fail('TV_STATE_TOO_MANY_TEMPORARIES');}
    const requested=receipt?receipt.files.map(item=>item.name):[...TV_STATE_FILES,...names],source=legacyExists?store(legacyDir,[...new Set([...TV_STATE_FILES,...requested])],legacyIdentity):null;
    if(source)await source.repair();
    const records=new Map();for(const name of requested){active(signal);const value=source?await source.readVersioned(name,{encoding:'buffer'}):null;if(value)records.set(name,value);}
    if(!receipt){
      for(const name of TV_STATE_FILES){const record=records.get(name);if(record&&!validFile(name,record.value))throw fail('TV_STATE_INVALID_LEGACY');}
      // Check all existing target entries before publishing any account data.
      for(const name of TV_STATE_FILES){const existing=await target.readVersioned(name,{encoding:'buffer'}),old=records.get(name);if(existing&&(!old||!existing.value.equals(old.value)))throw fail('TV_STATE_TARGET_CONFLICT');}
      receipt={format,appId,uid,source:sourceId,phase:'prepared',files:[...records].map(([name,record])=>({name,quarantine:temporary.test(name),sha256:digest(record.value),bytes:record.value.length}))};
      if(!receipt.files.length)return{...base,complete:true,copied:0,removed:0,quarantined:0,retained:0};
      await target.write(receiptName,JSON.stringify(receipt));await onStep({stage:'prepared'});
    }
    const temporaryNames=receipt.files.filter(item=>item.quarantine).map(item=>item.name);
    const quarantine=temporaryNames.length?store(join(dir,'quarantine'),temporaryNames):null;if(quarantine)await quarantine.repair();
    let copied=0,quarantined=0,removed=0,retained=0;
    // Publish session last; a partially copied account never appears valid
    // before its identity and ancillary state have been staged.
    const ordered=[...receipt.files].sort((a,b)=>(a.name==='session.json'?1:0)-(b.name==='session.json'?1:0));
    for(const item of ordered){
      active(signal);const destination=item.quarantine?quarantine:target,existing=await destination.readVersioned(item.name,{encoding:'buffer'}),old=records.get(item.name);
      if(existing){if(existing.value.length!==item.bytes||digest(existing.value)!==item.sha256)throw fail('TV_STATE_TARGET_CONFLICT');}
      else{
        if(!old||old.value.length!==item.bytes||digest(old.value)!==item.sha256)throw fail('TV_STATE_SOURCE_CHANGED');
        const fresh=await source.readVersioned(item.name,{encoding:'buffer'});if(!fresh||digest(fresh.value)!==item.sha256)throw fail('TV_STATE_SOURCE_CHANGED');records.set(item.name,fresh);await destination.write(item.name,fresh.value);copied++;if(item.quarantine)quarantined++;
      }
      const verified=await destination.readVersioned(item.name,{encoding:'buffer'});if(!verified||verified.value.length!==item.bytes||digest(verified.value)!==item.sha256)throw fail('TV_STATE_VERIFY_FAILED');await onStep({stage:'copied',name:item.name});
    }
    receipt.phase='copied';await target.write(receiptName,JSON.stringify(receipt));await onStep({stage:'durable'});
    // Every destination is now verified and fsynced. Delete only the exact
    // freshly observed old version whose bytes match the durable receipt.
    const cleanup=new Map();
    for(const item of receipt.files){active(signal);if(!source)continue;const old=await source.readVersioned(item.name,{encoding:'buffer'});if(!old)continue;if(old.value.length!==item.bytes||digest(old.value)!==item.sha256)throw fail('TV_STATE_SOURCE_CHANGED');cleanup.set(item.name,old.version);}
    for(const[name,version]of cleanup){active(signal);await source.remove(name,version);removed++;await onStep({stage:'removed',name});}
    receipt.phase='complete';await target.write(receiptName,JSON.stringify(receipt));return{...base,complete:true,existingPreferred:false,copied,removed,quarantined,retained};
  });}
  return{dir,prepare:reportBase,checkWritable,migrate};
}
