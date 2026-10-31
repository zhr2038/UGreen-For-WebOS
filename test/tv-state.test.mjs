import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTvState,TV_STATE_FILES} from '../lib/tv-state.mjs';
import {createPrivateState,PrivateStateError} from '../lib/private-state.mjs';
import {DirectConnection} from '../lib/direct.mjs';
const posix=process.platform!=='win32',session=token=>Buffer.from(JSON.stringify({alias:'example',server:'https://example.zh9.ug.link',token,nasPublicRsa:'SYNTHETIC_RAW_RSA',clientId:'stable-device-00000000001'}));
const tempName='session-12345678-1234-1234-1234-123456789abc.tmp';
async function fixture(t){const base=await fs.mkdtemp(join(tmpdir(),'cloudframe-tv-state-')),baseDir=join(base,'internal'),legacyDir=join(base,'installed','.state');await fs.mkdir(baseDir);await fs.mkdir(legacyDir,{recursive:true});if(posix){await fs.chmod(baseDir,0o775);await fs.chmod(legacyDir,0o775);}t.after(()=>fs.rm(base,{recursive:true,force:true}));const options={legacyDir,baseDir,trustedBaseDir:baseDir,uid:typeof process.getuid==='function'?process.getuid():1000};return{base,baseDir,legacyDir,options,tv:createTvState(options)};}
async function oldFiles(f){const values={'session.json':session('old-account'),'device-id':Buffer.from('stable-device-00000000001'),'clients.json':Buffer.from(JSON.stringify({['a'.repeat(64)]:{expires:9999999999999}})),'movie-preferences.json':Buffer.from(JSON.stringify({['b'.repeat(64)]:{rate:1.5,mode:'loop_single'}}))};for(const[name,value]of Object.entries(values)){await fs.writeFile(join(f.legacyDir,name),value);if(posix)await fs.chmod(join(f.legacyDir,name),0o775);}return values;}
const oldStore=f=>createPrivateState({dir:f.legacyDir,trustedDir:f.legacyDir,files:TV_STATE_FILES,maxBytes:1024*1024});
const newStore=f=>createPrivateState({dir:f.tv.dir,trustedDir:f.tv.dir,files:[...TV_STATE_FILES,'state-migration.json'],maxBytes:1024*1024});
const mode=async path=>Number((await fs.stat(path,{bigint:true})).mode&0o7777n);

test('construction is lazy; a nonsecret writable check touches only the app/UID child, never the media root mode',async t=>{
  const f=await fixture(t);await assert.rejects(fs.stat(f.tv.dir),{code:'ENOENT'});const original=await mode(f.baseDir),result=await f.tv.checkWritable();assert.equal(result.writable,true);assert.equal(await mode(f.baseDir),original);assert.deepEqual(await fs.readdir(f.tv.dir),[]);if(posix)assert.equal(await mode(f.tv.dir),0o700);
});

test('verified durable migration copies exact account bytes, quarantines only recognized temporary files and retains unknown trees',async t=>{
  const f=await fixture(t),values=await oldFiles(f),temp=Buffer.from([255,254,0,111]);await fs.writeFile(join(f.legacyDir,tempName),temp);await fs.writeFile(join(f.legacyDir,'unknown'),'leave');await fs.mkdir(join(f.legacyDir,'unknown-folder'));if(posix)await fs.chmod(join(f.legacyDir,'unknown'),0o664);
  const result=await f.tv.migrate();assert.equal(result.complete,true);assert.equal(result.copied,5);assert.equal(result.removed,5);assert.equal(result.quarantined,1);for(const[name,value]of Object.entries(values))assert.deepEqual(await fs.readFile(join(f.tv.dir,name)),value);assert.deepEqual(await fs.readFile(join(f.tv.dir,'quarantine',tempName)),temp);assert.deepEqual((await fs.readdir(f.legacyDir)).sort(),['unknown','unknown-folder']);assert.equal(await fs.readFile(join(f.legacyDir,'unknown'),'utf8'),'leave');if(posix){assert.equal(await mode(join(f.legacyDir,'unknown')),0o664);assert.equal(await mode(join(f.tv.dir,'session.json')),0o600);assert.equal(await mode(join(f.tv.dir,'quarantine')),0o700);}assert.equal((await f.tv.migrate()).copied,0);
});

test('an already valid new account always wins and old secrets are neither inspected nor overwritten',async t=>{
  const f=await fixture(t),values=await oldFiles(f);await f.tv.prepare();await newStore(f).write('session.json',session('new-account'));
  await fs.link(join(f.legacyDir,'session.json'),join(f.legacyDir,'alias'));const result=await f.tv.migrate();assert.equal(result.existingPreferred,true);assert.equal(result.removed,0);assert.deepEqual(await fs.readFile(join(f.tv.dir,'session.json')),session('new-account'));assert.deepEqual(await fs.readFile(join(f.legacyDir,'session.json')),values['session.json']);
});

test('a valid target is still preferred when an unrelated old migration receipt is malformed',async t=>{
  const f=await fixture(t);await oldFiles(f);await f.tv.prepare();await newStore(f).write('session.json',session('new-account'));await newStore(f).write('state-migration.json','malformed');const result=await f.tv.migrate();assert.equal(result.existingPreferred,true);assert.equal(result.receiptIgnored,true);assert.equal(await fs.readFile(join(f.tv.dir,'state-migration.json'),'utf8'),'malformed');
});

test('conflicting incomplete target state is retained instead of being overwritten by an old account',async t=>{
  const f=await fixture(t),values=await oldFiles(f);await f.tv.prepare();await newStore(f).write('session.json','recoverable unknown data');await assert.rejects(f.tv.migrate(),{code:'TV_STATE_TARGET_CONFLICT'});assert.equal(await fs.readFile(join(f.tv.dir,'session.json'),'utf8'),'recoverable unknown data');assert.deepEqual(await fs.readFile(join(f.legacyDir,'session.json')),values['session.json']);assert.deepEqual(await fs.readdir(f.tv.dir),['session.json']);
});

test('a crash after a partial copy resumes idempotently from verified hashes before deleting any old file',async t=>{
  const f=await fixture(t),values=await oldFiles(f);let interrupted=false;const first=createTvState({...f.options,onStep({stage}){if(stage==='copied'&&!interrupted){interrupted=true;throw new Error('synthetic crash');}}});await assert.rejects(first.migrate());for(const name of TV_STATE_FILES)assert.deepEqual(await fs.readFile(join(f.legacyDir,name)),values[name]);
  const result=await createTvState(f.options).migrate();assert.equal(result.complete,true);for(const[name,value]of Object.entries(values))assert.deepEqual(await fs.readFile(join(f.tv.dir,name)),value);assert.deepEqual(await fs.readdir(f.legacyDir),[]);assert.equal((await createTvState(f.options).migrate()).copied,0);
});

test('a crash after all target fsyncs resumes cleanup, while a newer independently established target account supersedes that receipt',async t=>{
  const f=await fixture(t);await oldFiles(f);const first=createTvState({...f.options,onStep({stage}){if(stage==='durable')throw new Error('synthetic crash');}});await assert.rejects(first.migrate());assert.equal((await createTvState(f.options).migrate()).removed,4);
  const g=await fixture(t);await oldFiles(g);await assert.rejects(createTvState({...g.options,onStep({stage}){if(stage==='durable')throw new Error('synthetic crash');}}).migrate());await newStore(g).write('session.json',session('newer-account'));const result=await createTvState(g.options).migrate();assert.equal(result.existingPreferred,true);assert.equal(result.removed,0);assert.equal((await fs.readdir(g.legacyDir)).length,4);
});

test('source change after durable copy is detected before cleanup, retaining every old account file',async t=>{
  const f=await fixture(t),values=await oldFiles(f);const migration=createTvState({...f.options,async onStep({stage}){if(stage==='durable')await oldStore(f).write('session.json',session('concurrently-changed'));}});await assert.rejects(migration.migrate(),{code:'TV_STATE_SOURCE_CHANGED'});assert.equal((await fs.readdir(f.legacyDir)).length,4);for(const name of TV_STATE_FILES.filter(name=>name!=='session.json'))assert.deepEqual(await fs.readFile(join(f.legacyDir,name)),values[name]);assert.deepEqual(await fs.readFile(join(f.legacyDir,'session.json')),session('concurrently-changed'));
});

test('unsafe old links, ownership and ancestor paths fail before any credential is copied',async t=>{
  const f=await fixture(t);await oldFiles(f);await fs.link(join(f.legacyDir,'session.json'),join(f.legacyDir,'hardlink'));await assert.rejects(f.tv.migrate(),error=>error instanceof PrivateStateError);await assert.rejects(fs.stat(join(f.tv.dir,'session.json')),{code:'ENOENT'});
  if(posix){const g=await fixture(t);await oldFiles(g);const alias=join(g.base,'alias');await fs.symlink(g.legacyDir,alias);await assert.rejects(createTvState({...g.options,legacyDir:alias}).migrate(),error=>error instanceof PrivateStateError);assert.equal((await fs.readdir(g.legacyDir)).length,4);if(process.getuid()===0){const h=await fixture(t);await oldFiles(h);await fs.chown(h.legacyDir,12345,12345);await assert.rejects(h.tv.migrate(),error=>error.code==='PRIVATE_STATE_OWNER');await fs.chown(h.legacyDir,0,0);}}
});

test('malformed old session and invalid namespace choices are refused without changing the old bytes',async t=>{
  const f=await fixture(t);await oldFiles(f);await fs.writeFile(join(f.legacyDir,'session.json'),'malformed');await assert.rejects(f.tv.migrate(),{code:'TV_STATE_INVALID_LEGACY'});assert.equal(await fs.readFile(join(f.legacyDir,'session.json'),'utf8'),'malformed');assert.throws(()=>createTvState({...f.options,appId:'other.app'}));assert.throws(()=>createTvState({...f.options,trustedBaseDir:f.base}));if(typeof process.getuid==='function')assert.throws(()=>createTvState({...f.options,uid:process.getuid()+1}));
});

test('an explicit empty logout session migrates without logging in or losing the stable device ID',async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.legacyDir,'session.json'),'{}');await fs.writeFile(join(f.legacyDir,'device-id'),'stable-device-00000000001');const result=await f.tv.migrate();assert.equal(result.complete,true);assert.equal(result.copied,2);assert.equal(result.removed,2);assert.equal(await fs.readFile(join(f.tv.dir,'session.json'),'utf8'),'{}');
  const config={},control=new DirectConnection({dir:f.tv.dir,config,link:{cancel(){},resolve(){throw new Error('logged-out state must not resolve a NAS');}}});await control.load();assert.equal(control.status().connected,false);assert.equal(config.token,undefined);assert.equal(control.deviceId,'stable-device-00000000001');control.cancel();
});

test('a new logout state with a complete receipt never restores an older active account',async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.legacyDir,'session.json'),'{}');await fs.writeFile(join(f.legacyDir,'device-id'),'stable-device-00000000001');await f.tv.migrate();await fs.writeFile(join(f.legacyDir,'session.json'),session('stale-older-account'));const result=await createTvState(f.options).migrate();assert.equal(result.complete,true);assert.equal(result.copied,0);assert.equal(result.removed,0);assert.equal(await fs.readFile(join(f.tv.dir,'session.json'),'utf8'),'{}');assert.deepEqual(await fs.readFile(join(f.legacyDir,'session.json')),session('stale-older-account'));
});

test('only an exactly empty object is a logout declaration; malformed nonempty states and target conflicts remain refused',async t=>{
  for(const value of ['null','[]','{"token":null}','{"alias":"","token":""}','{"unexpected":true}']){const f=await fixture(t);await fs.writeFile(join(f.legacyDir,'session.json'),value);await assert.rejects(f.tv.migrate(),{code:'TV_STATE_INVALID_LEGACY'});assert.equal(await fs.readFile(join(f.legacyDir,'session.json'),'utf8'),value);}
  const f=await fixture(t);await oldFiles(f);await f.tv.prepare();await newStore(f).write('session.json','{}');await assert.rejects(f.tv.migrate(),{code:'TV_STATE_TARGET_CONFLICT'});assert.equal(await fs.readFile(join(f.tv.dir,'session.json'),'utf8'),'{}');assert.deepEqual(await fs.readFile(join(f.legacyDir,'session.json')),session('old-account'));
});
