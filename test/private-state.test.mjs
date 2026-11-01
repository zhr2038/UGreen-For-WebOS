import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,parse} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createPrivateState,PrivateStateError} from '../lib/private-state.mjs';
import {DirectConnection} from '../lib/direct.mjs';
const posix=process.platform!=='win32',run=promisify(execFile);
async function fixture(t){const base=await fs.mkdtemp(join(tmpdir(),'cloudframe-private-')),dir=join(base,'.state');await fs.mkdir(dir,{mode:0o775});if(posix)await fs.chmod(dir,0o775);t.after(()=>fs.rm(base,{recursive:true,force:true}));return{base,dir,store:createPrivateState({dir,trustedDir:dir})};}
const mode=async path=>Number((await fs.stat(path,{bigint:true})).mode&0o7777n);
const wrapped=(handle,changes)=>new Proxy(handle,{get(target,key){if(key in changes)return changes[key];const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
const privateFailure=error=>error instanceof PrivateStateError&&!error.message.includes('.state');

test('existing broad modes are repaired without content changes; unrelated files/subtrees remain untouched',{skip:!posix},async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.dir,'session.json'),'synthetic-secret');await fs.writeFile(join(f.dir,'device-id'),'synthetic-device');await fs.writeFile(join(f.dir,'unknown'),'untouched');await fs.mkdir(join(f.dir,'unknown-dir'));
  for(const file of ['session.json','device-id','unknown','unknown-dir'])await fs.chmod(join(f.dir,file),0o775);await fs.chmod(f.dir,0o2775);
  const report=await f.store.repair();assert.equal(report.posixProtected,true);assert.equal(await mode(f.dir),0o700);assert.equal(await mode(join(f.dir,'session.json')),0o600);assert.equal(await mode(join(f.dir,'device-id')),0o600);assert.equal(await mode(join(f.dir,'unknown')),0o775);assert.equal(await mode(join(f.dir,'unknown-dir')),0o775);assert.equal(await f.store.read('session.json'),'synthetic-secret');
});

test('a different real POSIX uid can read the broad fixture before repair and is denied afterward',{skip:!posix||process.getuid()!==0},async t=>{
  const f=await fixture(t),path=join(f.dir,'session.json');await fs.chmod(f.base,0o775);await fs.writeFile(path,'synthetic private bytes');await fs.chmod(path,0o775);
  const probe="process.setgid(65534);process.setuid(65534);require('fs').readFile(process.argv[1],error=>process.exit(error?10:0));";
  await run(process.execPath,['-e',probe,path]);await f.store.repair();await assert.rejects(run(process.execPath,['-e',probe,path]),error=>error.code===10);assert.equal(await f.store.read('session.json'),'synthetic private bytes');
});

test('allowlist and explicit trusted directory reject traversal, roots, installation roots and system trees',async t=>{
  const f=await fixture(t);for(const dir of [parse(resolve('.')).root,resolve('.'),posix?'/root/.state':'C:\\Windows',posix?'/usr/private/.state':'C:\\System32',join(f.base,'top.hrhome.nascinema.service')])assert.throws(()=>createPrivateState({dir,trustedDir:dir}),privateFailure);
  assert.throws(()=>createPrivateState({dir:f.dir,trustedDir:f.base}),privateFailure);for(const name of ['../session.json','/etc/passwd','unknown','sub/session.json'])await assert.rejects(f.store.read(name),privateFailure);
});

test('missing files stay optional; repeated atomic writes and malformed payload reads preserve Windows-compatible semantics',async t=>{
  const f=await fixture(t);assert.equal(await f.store.read('session.json'),null);await f.store.write('session.json','one');await f.store.write('session.json','two');assert.equal(await f.store.read('session.json'),'two');assert.deepEqual((await fs.readdir(f.dir)).sort(),['session.json']);const report=await f.store.repair();assert.equal(report.posixProtected,posix);if(!posix){assert.equal(report.directoryMode,null);assert.equal(report.fileMode,null);}
});
test('explicit allowlisted plus-containing runtime filename supports real filesystem writes without allowing traversal',async t=>{
 const f=await fixture(t),store=createPrivateState({dir:f.dir,trustedDir:f.dir,files:['libstdc++.so']});await store.write('libstdc++.so',Buffer.from('synthetic runtime bytes'));assert.equal(await store.read('libstdc++.so'),'synthetic runtime bytes');await store.write('libstdc++.so','second bytes');assert.equal(await store.read('libstdc++.so'),'second bytes');
 for(const name of ['../libstdc++.so','sub/libstdc++.so','sub\\libstdc++.so','/libstdc++.so','..','.',String.fromCharCode(0)+'libstdc++.so'])assert.throws(()=>createPrivateState({dir:f.dir,trustedDir:f.dir,files:[name]}),privateFailure);
 await assert.rejects(store.read('other++.so'),privateFailure);if(posix){assert.equal(await mode(f.dir),0o700);assert.equal(await mode(join(f.dir,'libstdc++.so')),0o600);}
});

test('hardlinked credentials are rejected before their content, modes or external alias can be changed',async t=>{
  const f=await fixture(t),outside=join(f.base,'other');await fs.writeFile(outside,'outside');if(posix)await fs.chmod(outside,0o664);await fs.link(outside,join(f.dir,'session.json'));await assert.rejects(f.store.repair(),privateFailure);await assert.rejects(f.store.write('session.json','replacement'),privateFailure);assert.equal(await fs.readFile(outside,'utf8'),'outside');if(posix)assert.equal(await mode(outside),0o664);
});

test('leaf symlinks and symlinked ancestors never lead to chmod or writes outside the fixed state directory',{skip:!posix},async t=>{
  const f=await fixture(t),outside=join(f.base,'outside');await fs.writeFile(outside,'outside');await fs.chmod(outside,0o664);await fs.symlink(outside,join(f.dir,'device-id'));await assert.rejects(f.store.repair(),privateFailure);assert.equal(await mode(outside),0o664);assert.equal(await fs.readFile(outside,'utf8'),'outside');
  const alias=join(f.base,'alias');await fs.symlink(f.dir,alias);await assert.rejects(createPrivateState({dir:alias,trustedDir:alias}).repair(),privateFailure);
});

test('a regular file replaced during open is rejected before fchmod touches the replacement',async t=>{
  const f=await fixture(t),path=join(f.dir,'session.json');await fs.writeFile(path,'original');if(posix)await fs.chmod(path,0o775);let swapped=false;
  const io={...fs,async open(name,...args){if(!swapped&&String(name).endsWith('/session.json')||!swapped&&String(name).endsWith('\\session.json')){swapped=true;await fs.rename(path,join(f.dir,'old'));await fs.writeFile(path,'replacement',{mode:0o775});if(posix)await fs.chmod(path,0o775);}return fs.open(name,...args);}};
  await assert.rejects(createPrivateState({dir:f.dir,trustedDir:f.dir,fs:io}).read('session.json'),privateFailure);assert.equal(await fs.readFile(path,'utf8'),'replacement');if(posix)assert.equal(await mode(path),0o775);
});

test('replacement by FIFO during open is nonblocking and refused without reading it',{skip:!posix},async t=>{
  const f=await fixture(t),path=join(f.dir,'session.json');await fs.writeFile(path,'original');let switched=false,unblock;
  const io={...fs,async open(name,flags,...args){if(!switched&&String(name).endsWith('/session.json')){switched=true;assert.ok(flags&constants.O_NONBLOCK);await fs.unlink(path);await run('mkfifo',[path]);unblock=setTimeout(()=>{fs.open(path,constants.O_WRONLY|constants.O_NONBLOCK).then(h=>h.close()).catch(()=>{});},500);}return fs.open(name,flags,...args);}};
  const started=Date.now();try{await assert.rejects(createPrivateState({dir:f.dir,trustedDir:f.dir,fs:io}).read('session.json'),privateFailure);assert.ok(Date.now()-started<400);}finally{clearTimeout(unblock);}
});

test('wrong-owner state is refused, and only the owned opened directory gets narrowed after a namespace replacement',{skip:!posix},async t=>{
  const f=await fixture(t);if(process.getuid()===0){await fs.chown(f.dir,12345,12345);await assert.rejects(f.store.repair(),privateFailure);assert.equal(await mode(f.dir),0o775);await fs.chown(f.dir,0,0);}
  let replaced=false;const io={...fs,async open(name,...args){const h=await fs.open(name,...args);if(name===f.dir&&!replaced)return wrapped(h,{chmod:async value=>{replaced=true;await fs.rename(f.dir,join(f.base,'original-state'));await fs.mkdir(f.dir,{mode:0o775});await fs.chmod(f.dir,0o775);return h.chmod(value);}});return h;}};
  await assert.rejects(createPrivateState({dir:f.dir,trustedDir:f.dir,fs:io}).repair(),privateFailure);assert.equal(await mode(f.dir),0o775);assert.equal(await mode(join(f.base,'original-state')),0o700);
});

test('directory FD anchoring rejects a parent replacement without touching the substituted tree',{skip:!posix},async t=>{
  const f=await fixture(t),outside=join(f.base,'outside');await fs.mkdir(outside);await fs.writeFile(join(outside,'session.json'),'outside');await fs.chmod(join(outside,'session.json'),0o664);await fs.writeFile(join(f.dir,'session.json'),'inside');let swapped=false;
  const io={...fs,async open(name,...args){if(!swapped&&String(name).startsWith('/proc/self/fd/')&&String(name).endsWith('/session.json')){swapped=true;await fs.rename(f.dir,join(f.base,'original-state'));await fs.symlink(outside,f.dir);}return fs.open(name,...args);}};
  await assert.rejects(createPrivateState({dir:f.dir,trustedDir:f.dir,fs:io}).read('session.json'),privateFailure);assert.equal(await mode(join(outside,'session.json')),0o664);assert.equal(await fs.readFile(join(outside,'session.json'),'utf8'),'outside');
});

test('failure before atomic publication keeps the original session and removes only owned temporary entries',async t=>{
  const f=await fixture(t);await f.store.write('session.json','original');const io={...fs,async rename(){throw Object.assign(new Error('synthetic failure'),{code:'EIO'});}};await assert.rejects(createPrivateState({dir:f.dir,trustedDir:f.dir,fs:io}).write('session.json','replacement'),privateFailure);assert.equal(await f.store.read('session.json'),'original');assert.deepEqual(await fs.readdir(f.dir),['session.json']);
});

test('a post-publication directory fsync failure atomically restores the original contents',{skip:!posix},async t=>{
  const f=await fixture(t);await f.store.write('session.json','original');const original=await fs.stat(join(f.dir,'session.json'),{bigint:true});let failed=false;
  const io={...fs,async open(name,...args){const h=await fs.open(name,...args);return name===f.dir?wrapped(h,{sync:async()=>{if(!failed){failed=true;throw Object.assign(new Error('synthetic fsync failure'),{code:'EIO'});}return h.sync();}}):h;}};
  await assert.rejects(createPrivateState({dir:f.dir,trustedDir:f.dir,fs:io}).write('session.json','replacement'),privateFailure);assert.equal(await f.store.read('session.json'),'original');assert.notEqual((await fs.stat(join(f.dir,'session.json'),{bigint:true})).ino,original.ino);assert.deepEqual(await fs.readdir(f.dir),['session.json']);
});

test('post-publication directory replacement rolls back only inside the held original directory',{skip:!posix},async t=>{
  const f=await fixture(t);await f.store.write('session.json','original');let switched=false;
  const io={...fs,async rename(...args){await fs.rename(...args);if(!switched){switched=true;await fs.rename(f.dir,join(f.base,'moved'));await fs.mkdir(f.dir,{mode:0o775});await fs.chmod(f.dir,0o775);}}};
  await assert.rejects(createPrivateState({dir:f.dir,trustedDir:f.dir,fs:io}).write('session.json','replacement'),privateFailure);assert.equal(await fs.readFile(join(f.base,'moved/session.json'),'utf8'),'original');assert.deepEqual(await fs.readdir(f.dir),[]);assert.equal(await mode(f.dir),0o775);
});

test('post-publication file replacement is never overwritten; a private original-content backup is retained',async t=>{
  const f=await fixture(t);await f.store.write('session.json','original');let switched=false;
  const io={...fs,async rename(...args){await fs.rename(...args);if(!switched){switched=true;await fs.rename(join(f.dir,'session.json'),join(f.dir,'published-retired'));await fs.writeFile(join(f.dir,'session.json'),'unknown replacement',{mode:0o600});}}};
  await assert.rejects(createPrivateState({dir:f.dir,trustedDir:f.dir,fs:io}).write('session.json','replacement'),privateFailure);assert.equal(await fs.readFile(join(f.dir,'session.json'),'utf8'),'unknown replacement');const backup=(await fs.readdir(f.dir)).find(name=>name.endsWith('.backup'));assert.ok(backup);assert.equal(await fs.readFile(join(f.dir,backup),'utf8'),'original');if(posix)assert.equal(await mode(join(f.dir,backup)),0o600);
});

test('backup creation failure cannot poison the original session with a second hardlink',async t=>{
  const f=await fixture(t);await f.store.write('session.json','original');let failed=false;
  const io={...fs,async lstat(path,...args){if(!failed&&String(path).endsWith('.backup')){failed=true;throw Object.assign(new Error('synthetic metadata failure'),{code:'EIO'});}return fs.lstat(path,...args);}};
  await assert.rejects(createPrivateState({dir:f.dir,trustedDir:f.dir,fs:io}).write('session.json','replacement'),privateFailure);assert.equal((await fs.stat(join(f.dir,'session.json'),{bigint:true})).nlink,1n);assert.equal(await f.store.read('session.json'),'original');await f.store.write('session.json','retry works');assert.equal(await f.store.read('session.json'),'retry works');
});

test('versioned removal refuses a changed source and only removes the allowlisted unchanged inode',async t=>{
  const f=await fixture(t);await f.store.write('session.json','one');const version=await f.store.readVersioned('session.json');await f.store.write('session.json','two');await assert.rejects(f.store.remove('session.json',version.version),privateFailure);assert.equal(await f.store.read('session.json'),'two');const current=await f.store.readVersioned('session.json');await f.store.remove('session.json',current.version);assert.equal(await f.store.read('session.json'),null);
});

test('Direct load never swallows a private-state boundary failure or applies a partially loaded account',async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.dir,'session.json'),JSON.stringify({alias:'example',server:'https://example.zh9.ug.link',token:'new-account'}));await fs.writeFile(join(f.base,'external-id'),'unchanged');await fs.link(join(f.base,'external-id'),join(f.dir,'device-id'));const config={token:'previous-account'},control=new DirectConnection({dir:f.dir,config,link:{cancel(){},resolve(){throw new Error('must not reach discovery');}}});
  await assert.rejects(control.load(),privateFailure);assert.equal(config.token,'previous-account');assert.equal(await fs.readFile(join(f.base,'external-id'),'utf8'),'unchanged');
});

test('Direct first launch and malformed private JSON/ID preserve legitimate recovery without overwriting the session',async t=>{
  const f=await fixture(t);await f.store.write('session.json','not-json');await f.store.write('device-id','malformed id');const config={},control=new DirectConnection({dir:f.dir,config,link:{cancel(){},resolve(){throw new Error('offline');}}});await control.load();assert.equal(config.token,undefined);assert.match(await f.store.read('device-id'),/^[a-zA-Z0-9_-]{16,64}$/);assert.equal(await f.store.read('session.json'),'not-json');
});
