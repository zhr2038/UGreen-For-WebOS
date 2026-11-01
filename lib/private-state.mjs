import * as filesystem from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isAbsolute,resolve,dirname,basename,parse,join,sep} from 'node:path';
import {homedir} from 'node:os';

const queues=new Map();
const defaults=Object.freeze(['session.json','device-id']);
const forbidden=new Set(['/','/root','/home','/tmp','/var','/var/lib','/var/tmp','/usr','/usr/local','/etc','/bin','/sbin','/lib','/lib64','/opt','/dev','/sys','/proc','/media','/media/internal','/media/developer','/media/cryptofs']);
const noop=()=>{};
const same=(a,b)=>Boolean(a&&b&&a.dev===b.dev&&a.ino===b.ino);
export class PrivateStateError extends Error {
  constructor(code){super('应用私有状态文件未通过安全检查');this.name='PrivateStateError';this.code=code;this.status=503;}
}
const fail=code=>new PrivateStateError(code);
const missing=error=>error?.code==='ENOENT';
const snapshot=s=>({dev:s.dev,ino:s.ino,size:s.size,mtimeNs:s.mtimeNs,ctimeNs:s.ctimeNs});
const unchanged=(a,b)=>same(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;

/** Fixed caller-owned state only. No traversal, recursive chmod or migration. */
export function createPrivateState(options){return new PrivateState(options);}
export async function repairPrivateState(options){return createPrivateState(options).repair();}
export class PrivateState {
  constructor({dir,trustedDir,files=defaults,maxBytes=128*1024,fs=filesystem,platform=process.platform,uid=typeof process.getuid==='function'?process.getuid():undefined,expectedIdentity}={}){
    if(typeof dir!=='string'||!isAbsolute(dir)||dir!==resolve(dir)||typeof trustedDir!=='string'||trustedDir!==dir||dir===parse(dir).root||/[\x00-\x1f]/.test(dir))throw fail('PRIVATE_STATE_PATH');
    const normalized=dir.replaceAll('\\','/').replace(/\/$/,'');
    const system=['/root','/etc','/usr','/bin','/sbin','/lib','/lib64','/dev','/sys','/proc','/boot','/run'];
    if(forbidden.has(normalized)||system.some(path=>normalized===path||normalized.startsWith(path+'/'))||/^[a-z]:\/(?:windows|program files(?: \(x86\))?)(?:\/|$)/i.test(normalized)||/(?:^|\/)(?:windows|system32|program files(?: \(x86\))?)$/i.test(normalized)||basename(dir).endsWith('.service')||dir===resolve(homedir())||dir===resolve(process.cwd()))throw fail('PRIVATE_STATE_PATH');
    if(!Array.isArray(files)||!files.length||files.length>32||files.some(name=>typeof name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,79}$/.test(name)||name==='.'||name==='..')||new Set(files).size!==files.length||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1024*1024)throw fail('PRIVATE_STATE_OPTIONS');
    if(expectedIdentity&&(typeof expectedIdentity.dev!=='bigint'||typeof expectedIdentity.ino!=='bigint'))throw fail('PRIVATE_STATE_OPTIONS');
    this.dir=dir;this.files=new Set(files);this.maxBytes=maxBytes;this.fs=fs;this.platform=platform;this.posix=platform!=='win32';this.uid=uid===undefined?undefined:BigInt(uid);this.key=platform==='win32'?dir.toLowerCase():dir;this.expected=expectedIdentity?{dev:expectedIdentity.dev,ino:expectedIdentity.ino}:null;
    if(this.posix&&(this.uid===undefined||!constants.O_NOFOLLOW||!constants.O_DIRECTORY||!constants.O_NONBLOCK))throw fail('PRIVATE_STATE_CAPABILITY');
  }
  name(value){if(!this.files.has(value))throw fail('PRIVATE_STATE_FILE_NOT_ALLOWED');return value;}
  equivalent(a,b){return this.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}
  stat(path){return this.fs.lstat(path,{bigint:true});}
  owner(stat){if(this.posix&&stat.uid!==this.uid)throw fail('PRIVATE_STATE_OWNER');}
  directory(stat){if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('PRIVATE_STATE_DIRECTORY');this.owner(stat);}
  file(stat){if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)throw fail('PRIVATE_STATE_FILE');this.owner(stat);}
  async components(path){
    const root=parse(path).root;let current=root;
    for(const piece of path.slice(root.length).split(sep).filter(Boolean)){
      current=join(current,piece);const stat=await this.stat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw fail('PRIVATE_STATE_DIRECTORY');
    }
    const canonical=await this.fs.realpath(path);if(!this.equivalent(canonical,path))throw fail('PRIVATE_STATE_CANONICAL');
  }
  async checkRoot(root){
    await this.components(this.dir);const visible=await this.stat(this.dir),opened=await root.handle.stat({bigint:true});this.directory(visible);this.directory(opened);
    if(!same(visible,root.identity)||!same(opened,root.identity)||this.expected&&!same(visible,this.expected))throw fail('PRIVATE_STATE_REPLACED');
    if(this.posix&&(opened.mode&0o7777n)!==0o700n)throw fail('PRIVATE_STATE_PERMISSIONS');
  }
  async openRoot(){
    await this.components(dirname(this.dir));let before;
    try{before=await this.stat(this.dir);}catch(error){if(!missing(error))throw error;if(this.expected)throw fail('PRIVATE_STATE_REPLACED');try{await this.fs.mkdir(this.dir,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw fail('PRIVATE_STATE_REPLACED');throw error;}before=await this.stat(this.dir);}
    this.directory(before);if(this.expected&&!same(before,this.expected))throw fail('PRIVATE_STATE_REPLACED');
    await this.components(this.dir);
    const flags=constants.O_RDONLY|(this.posix?constants.O_NOFOLLOW|constants.O_DIRECTORY|constants.O_NONBLOCK:0);
    const handle=this.posix?await this.fs.open(this.dir,flags):{stat:options=>this.fs.lstat(this.dir,options),close:async()=>{}};let ready=false;
    try{
      const opened=await handle.stat({bigint:true});this.directory(opened);if(!same(before,opened))throw fail('PRIVATE_STATE_REPLACED');
      const visible=await this.stat(this.dir);if(!same(visible,opened))throw fail('PRIVATE_STATE_REPLACED');
      if(this.posix&&(opened.mode&0o7777n)!==0o700n)await handle.chmod(0o700);
      const root={handle,identity:snapshot(opened),anchor:this.dir};
      if(this.posix){
        let anchor;for(const prefix of ['/proc/self/fd','/dev/fd']){const value=join(prefix,String(handle.fd));try{const pinned=await this.fs.stat(value,{bigint:true});if(same(pinned,opened)&&pinned.isDirectory()){anchor=value;break;}}catch{}}
        if(!anchor)throw fail('PRIVATE_STATE_CAPABILITY');root.anchor=anchor;
      }
      await this.checkRoot(root);this.expected=root.identity;ready=true;return root;
    }finally{if(!ready)await handle.close().catch(noop);}
  }
  async serialized(operation){
    const previous=queues.get(this.key)||Promise.resolve();
    const current=previous.catch(noop).then(async()=>{let root;try{root=await this.openRoot();return await operation(root);}catch(error){if(error instanceof PrivateStateError)throw error;throw fail('PRIVATE_STATE_IO');}finally{await root?.handle.close().catch(noop);}});
    queues.set(this.key,current);try{return await current;}finally{if(queues.get(this.key)===current)queues.delete(this.key);}
  }
  entryPath(root,name){return join(root.anchor,name);}
  async checkEntry(root,name,identity,{links=1n}={}){
    await this.checkRoot(root);const stat=await this.stat(this.entryPath(root,name));
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==links)throw fail('PRIVATE_STATE_FILE');this.owner(stat);if(!same(stat,identity))throw fail('PRIVATE_STATE_REPLACED');return stat;
  }
  async openEntry(root,name){
    await this.checkRoot(root);const path=this.entryPath(root,name);let before;
    try{before=await this.stat(path);}catch(error){if(missing(error))return null;throw error;}
    this.file(before);const handle=await this.fs.open(path,constants.O_RDONLY|(this.posix?constants.O_NOFOLLOW|constants.O_NONBLOCK:0));let ready=false;
    try{
      const opened=await handle.stat({bigint:true});this.file(opened);if(!same(opened,before))throw fail('PRIVATE_STATE_REPLACED');await this.checkEntry(root,name,opened);
      if(this.posix&&(opened.mode&0o7777n)!==0o600n)await handle.chmod(0o600);
      const repaired=await handle.stat({bigint:true});this.file(repaired);if(this.posix&&(repaired.mode&0o7777n)!==0o600n)throw fail('PRIVATE_STATE_PERMISSIONS');await this.checkEntry(root,name,repaired);ready=true;return{handle,identity:snapshot(repaired)};
    }finally{if(!ready)await handle.close().catch(noop);}
  }
  async repair(){return this.serialized(async root=>{
    let found=0;for(const name of this.files){const entry=await this.openEntry(root,name);if(entry){found++;await entry.handle.close();}}
    await this.checkRoot(root);return{posixProtected:this.posix,directoryMode:this.posix?'0700':null,fileMode:this.posix?'0600':null,checkedFiles:this.files.size,existingFiles:found};
  });}
  async readOpened(root,name,entry,maxBytes){
    if(entry.identity.size>BigInt(maxBytes))throw fail('PRIVATE_STATE_TOO_LARGE');
    const bytes=Buffer.alloc(maxBytes+1);let length=0;
    while(length<=maxBytes){const result=await entry.handle.read(bytes,length,Math.min(16384,bytes.length-length),length);if(!result.bytesRead)break;length+=result.bytesRead;if(length>maxBytes)throw fail('PRIVATE_STATE_TOO_LARGE');}
    const after=await entry.handle.stat({bigint:true});this.file(after);if(!unchanged(entry.identity,snapshot(after)))throw fail('PRIVATE_STATE_REPLACED');await this.checkEntry(root,name,after);return{bytes:bytes.subarray(0,length),version:snapshot(after)};
  }
  async readVersioned(name,{maxBytes=this.maxBytes,encoding='utf8'}={}){
    this.name(name);if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>this.maxBytes||!['utf8','buffer'].includes(encoding))throw fail('PRIVATE_STATE_OPTIONS');
    return this.serialized(async root=>{const entry=await this.openEntry(root,name);if(!entry)return null;try{const value=await this.readOpened(root,name,entry,maxBytes);return{value:encoding==='buffer'?value.bytes:value.bytes.toString('utf8'),version:value.version};}finally{await entry.handle.close().catch(noop);}});
  }
  async read(name,options){const record=await this.readVersioned(name,options);return record?.value??null;}
  async names(){return this.serialized(async root=>{await this.checkRoot(root);const names=await this.fs.readdir(root.anchor);await this.checkRoot(root);return names;});}
  async remove(name,version){
    this.name(name);if(!version||typeof version.ino!=='bigint'||typeof version.dev!=='bigint')throw fail('PRIVATE_STATE_OPTIONS');
    return this.serialized(async root=>{const entry=await this.openEntry(root,name);if(!entry)return{removed:false};try{if(!unchanged(entry.identity,version))throw fail('PRIVATE_STATE_REPLACED');await this.checkEntry(root,name,entry.identity);await this.fs.unlink(this.entryPath(root,name));if(this.posix)await root.handle.sync();await this.checkRoot(root);return{removed:true,posixProtected:this.posix};}finally{await entry.handle.close().catch(noop);}});
  }
  async unlinkOwned(root,name,identity){
    try{const stat=await this.stat(this.entryPath(root,name));if(!same(stat,identity))return false;await this.fs.unlink(this.entryPath(root,name));return true;}catch(error){if(missing(error))return true;return false;}
  }
  async write(name,value){
    this.name(name);if(typeof value!=='string'&&!Buffer.isBuffer(value))throw fail('PRIVATE_STATE_OPTIONS');const bytes=Buffer.from(value);if(bytes.length>this.maxBytes)throw fail('PRIVATE_STATE_TOO_LARGE');
    return this.serialized(async root=>{
      const temporary='.'+name+'-'+randomUUID()+'.tmp',backup='.'+name+'-'+randomUUID()+'.backup';let target,temp,backupHandle,tempIdentity,backupIdentity,published=false,complete=false;
      try{
        target=await this.openEntry(root,name);
        temp=await this.fs.open(this.entryPath(root,temporary),constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|(this.posix?constants.O_NOFOLLOW|constants.O_NONBLOCK:0),0o600);
        let created=await temp.stat({bigint:true});tempIdentity=snapshot(created);this.file(created);if(this.posix)await temp.chmod(0o600);await temp.writeFile(bytes);await temp.sync();created=await temp.stat({bigint:true});this.file(created);const identity=snapshot(created);tempIdentity=identity;
        await this.checkRoot(root);const visibleTemp=await this.stat(this.entryPath(root,temporary));if(!same(visibleTemp,identity))throw fail('PRIVATE_STATE_REPLACED');
        if(target){
          const current=await this.checkEntry(root,name,target.identity);if(!unchanged(target.identity,snapshot(current)))throw fail('PRIVATE_STATE_REPLACED');
          // Use a separate inode: a crash must never leave the live credential
          // hardlinked, which would make every later nlink=1 check fail closed.
          const previous=await this.readOpened(root,name,target,this.maxBytes);
          backupHandle=await this.fs.open(this.entryPath(root,backup),constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|(this.posix?constants.O_NOFOLLOW|constants.O_NONBLOCK:0),0o600);
          const createdBackup=await backupHandle.stat({bigint:true});backupIdentity=snapshot(createdBackup);this.file(createdBackup);if(this.posix)await backupHandle.chmod(0o600);await backupHandle.writeFile(previous.bytes);await backupHandle.sync();
          const saved=await backupHandle.stat({bigint:true});this.file(saved);backupIdentity=snapshot(saved);if(this.posix&&(saved.mode&0o7777n)!==0o600n)throw fail('PRIVATE_STATE_PERMISSIONS');await this.checkEntry(root,backup,backupIdentity);await this.checkEntry(root,name,target.identity);
        }else{try{await this.stat(this.entryPath(root,name));throw fail('PRIVATE_STATE_REPLACED');}catch(error){if(!missing(error))throw error;}}
        await this.checkRoot(root);
        // Windows cannot rename these open handles. This compatibility path
        // retains inode checks, but makes no POSIX confinement/ACL guarantee.
        if(!this.posix){await target?.handle.close();if(target)target.handle=null;await temp.close();temp=null;await backupHandle?.close();backupHandle=null;}
        await this.fs.rename(this.entryPath(root,temporary),this.entryPath(root,name));published=true;
        if(!this.posix)temp=await this.fs.open(this.entryPath(root,name),constants.O_RDONLY);
        await this.checkEntry(root,name,identity);const final=await temp.stat({bigint:true});this.file(final);if(this.posix&&(final.mode&0o7777n)!==0o600n)throw fail('PRIVATE_STATE_PERMISSIONS');
        if(this.posix)await root.handle.sync();
        complete=true;if(backupIdentity)await this.unlinkOwned(root,backup,backupIdentity);
        return{written:true,posixProtected:this.posix};
      }catch(error){
        if(published){
          const current=await this.stat(this.entryPath(root,name)).catch(()=>null),created=tempIdentity;
          if(!this.posix&&temp){await temp.close().catch(noop);temp=null;}
          if(same(current,created)){
            if(backupIdentity){const saved=await this.stat(this.entryPath(root,backup)).catch(()=>null);if(same(saved,backupIdentity))await this.fs.rename(this.entryPath(root,backup),this.entryPath(root,name)).catch(noop);}
            else await this.unlinkOwned(root,name,created);
          }
        }
        if(error instanceof PrivateStateError)throw error;throw fail('PRIVATE_STATE_IO');
      }finally{
        if(tempIdentity)await this.unlinkOwned(root,temporary,tempIdentity);
        await temp?.close().catch(noop);
        await backupHandle?.close().catch(noop);
        await target?.handle?.close().catch(noop);
        if(!published&&backupIdentity)await this.unlinkOwned(root,backup,backupIdentity);
        // After a detected post-publication replacement, never overwrite or
        // delete that unknown inode; retain any private old-inode backup.
        if(complete&&this.posix)await root.handle.sync().catch(noop);
      }
    });
  }
}
