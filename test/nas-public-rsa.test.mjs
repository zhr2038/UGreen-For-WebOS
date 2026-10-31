import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UgOS,retainNasPublicRsa} from '../lib/ugos.mjs';
import {UgreenLink} from '../lib/ugreenlink.mjs';
import {DirectConnection} from '../lib/direct.mjs';

const raw=' \n'+Buffer.from('OFFICIAL_DEVICECONNECT_PUBLIC_KEY_BYTES').toString('base64')+'\n ';
const handshake=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'}).toString();
function nasFor(config,data){
  const nas=new UgOS(config);nas.open=async(path,options)=>{assert.equal(path,'/ugreen/v1/verify/check');assert.equal(options.auth,false);return{resume(){},headers:{'x-rsa-token':Buffer.from(handshake).toString('base64')}};};
  nas.request=async(path,options)=>{if(path==='v1/verify/login'){assert.equal(options.auth,false);assert.ok(options.body.password&&options.body.password!=='fake-password');return typeof data==='function'?data():data;}return{};};return nas;
}
async function controlFixture(t,{login=()=>({token:'private-fake-new-session',public_key:raw}),link}={}){
  const dir=await mkdtemp(join(tmpdir(),'nas-public-rsa-')),config={},resolved={alias:'example',server:'https://example.zh9.ug.link'};
  const control=new DirectConnection({dir,config,link:link||{cancel(){},resolve:async()=>resolved},createNas:candidate=>nasFor(candidate,login)});await control.load();
  t.after(async()=>{control.cancel();await rm(dir,{recursive:true,force:true});});return{control,dir,config};
}

test('NAS identity keys are retained verbatim under strict optional string bounds',()=>{
  assert.equal(retainNasPublicRsa(raw),raw);assert.equal(retainNasPublicRsa('a'.repeat(16384)).length,16384);
  for(const value of [undefined,null,42,{},'', ' \n\t', 'a'.repeat(16385),'界'.repeat(6000),'abc\0def','abc\x01def'])assert.equal(retainNasPublicRsa(value),undefined);
});

test('ordinary UGOS login stores only the response public_key privately and never substitutes the RSA handshake',async()=>{
  const config={nasPublicRsa:'old-account-key'},nas=nasFor(config,{token:'new-session',public_key:raw,nas_name:'Synthetic NAS',model:'Test'});
  try{const result=await nas.login('viewer','fake-password');assert.equal(config.nasPublicRsa,raw);assert.notEqual(config.nasPublicRsa,handshake);assert.equal(Object.hasOwn(result,'nasPublicRsa'),false);assert.equal(JSON.stringify(result).includes(raw.trim()),false);}finally{nas.httpsAgent.destroy();}
});

test('a successful account login without a valid public_key clears the previous key but still succeeds',async()=>{
  for(const public_key of [undefined,null,'','a'.repeat(16385)]){const config={nasPublicRsa:'previous-account-key'},nas=nasFor(config,{token:'new-session',public_key,publicKey:'unsupported-camel-alias'});try{await nas.login('viewer','fake-password');assert.equal(config.token,'new-session');assert.equal(Object.hasOwn(config,'nasPublicRsa'),false);}finally{nas.httpsAgent.destroy();}}
  const old={token:'old-session',nasPublicRsa:'old-key'},failed=nasFor(old,{enable_otp:true});try{await assert.rejects(failed.login('viewer','fake-password'));assert.equal(old.nasPublicRsa,'old-key');}finally{failed.httpsAgent.destroy();}
});

test('QR authorization preserves public_key without decoding, and ignores an unsupported compatible-field guess',async()=>{
  for(const key of [raw,undefined,'x'.repeat(16385)]){
    const link=new UgreenLink({now:()=>10000,request:async(path)=>path.includes('create/qrCode')?{code:200,data:{qrCode:'nonce',url:'https://www.ugnas.com/scan'}}:{code:200,data:{user:{linkParams:JSON.stringify({token:'fake-session',uglink_id:'example',public_key:key,publicKey:'unsupported-alias'})}}}});
    await link.createQr();const result=await link.pollQr();assert.equal(result.state,'authorized');if(key===raw)assert.equal(result.device.nasPublicRsa,raw);else assert.equal(Object.hasOwn(result.device,'nasPublicRsa'),false);assert.equal(JSON.stringify(link.diagnostic).includes(raw.trim()),false);
  }
});

test('Direct password login persists and restores the private raw key while all public statuses omit it',async t=>{
  const f=await controlFixture(t);const result=await f.control.handle('/api/direct/login','POST',{alias:'example',username:'viewer',password:'fake-password'});assert.equal(result.connected,true);assert.equal(f.config.nasPublicRsa,raw);
  const saved=JSON.parse(await readFile(join(f.dir,'session.json'),'utf8'));assert.equal(saved.nasPublicRsa,raw);
  assert.equal(Object.hasOwn(result,'nasPublicRsa'),false);assert.equal(JSON.stringify([result,f.control.status(),await f.control.handle('/api/direct/status','GET',{})]).includes(raw.trim()),false);
  const restoredConfig={},restored=new DirectConnection({dir:f.dir,config:restoredConfig,link:{cancel(){},resolve:async()=>({alias:'example',server:'https://example.zh9.ug.link'})}});await restored.load();assert.equal(restoredConfig.nasPublicRsa,raw);restored.cancel();
});

test('Direct QR flow persists the identity privately and public poll state contains no key',async t=>{
  const link=new UgreenLink({now:()=>10000,request:async(path)=>path.includes('create/qrCode')?{code:200,data:{qrCode:'nonce',url:'https://www.ugnas.com/scan'}}:path.includes('byAlias')?{code:200,data:{alias:'example',relayDomain:'zh9.ug.link'}}:{code:200,data:{user:{linkParams:{token:'fake-session',uglink_id:'example',public_key:raw}}}}});
  const f=await controlFixture(t,{link});await f.control.handle('/api/direct/qr/create','POST',{});await f.control.advanceQr(f.control.generation);assert.equal(f.config.nasPublicRsa,raw);assert.equal(JSON.parse(await readFile(join(f.dir,'session.json'),'utf8')).nasPublicRsa,raw);
  const poll=await f.control.handle('/api/direct/qr/poll','POST',{});assert.equal(poll.state,'connected');assert.equal(JSON.stringify(poll).includes(raw.trim()),false);assert.equal(Object.hasOwn(poll,'device'),false);
});

test('switching to an account/session without key never inherits a key from config or disk',async t=>{
  let returned={token:'one',public_key:raw};const f=await controlFixture(t,{login:()=>returned});await f.control.handle('/api/direct/login','POST',{alias:'example',username:'one',password:'fake-password'});returned={token:'two'};await f.control.handle('/api/direct/login','POST',{alias:'example',username:'two',password:'fake-password'});assert.equal(Object.hasOwn(f.config,'nasPublicRsa'),false);assert.equal(Object.hasOwn(JSON.parse(await readFile(join(f.dir,'session.json'),'utf8')),'nasPublicRsa'),false);
  f.config.nasPublicRsa='stale-memory-key';await f.control.load();assert.equal(Object.hasOwn(f.config,'nasPublicRsa'),false);
  const saved={alias:'example',server:'https://example.zh9.ug.link',token:'three',public_key:raw};await writeFile(join(f.dir,'session.json'),JSON.stringify(saved));await f.control.load();assert.equal(Object.hasOwn(f.config,'nasPublicRsa'),false,'wire field in an old file must not trigger an unrequested migration');
});

test('an invalid optional key does not block verified commit and a failed replacement restores the old account key',async t=>{
  const f=await controlFixture(t);const candidate={alias:'example',server:'https://example.zh9.ug.link',token:'session',nasPublicRsa:'x'.repeat(16385)};await f.control.commit(candidate,f.control.generation);assert.equal(f.config.token,'session');assert.equal(Object.hasOwn(f.config,'nasPublicRsa'),false);
  f.config.nasPublicRsa=raw;const save=f.control.save;f.control.save=async()=>{throw new Error('synthetic disk failure');};await assert.rejects(f.control.commit({...candidate,token:'replacement',nasPublicRsa:'other-key'},f.control.generation));assert.equal(f.config.token,'session');assert.equal(f.config.nasPublicRsa,raw);f.control.save=save;
  await f.control.handle('/api/direct/logout','POST',{});assert.equal(Object.hasOwn(f.config,'nasPublicRsa'),false);assert.equal(JSON.stringify(f.control.status()).includes(raw.trim()),false);
});
