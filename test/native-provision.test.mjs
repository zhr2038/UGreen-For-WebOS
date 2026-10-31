import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {deflateRawSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {createNativeProvision,NATIVE_SDK_SOURCE,decodeNativeZipEntry} from '../lib/native-provision.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const anonymous='https://dl-cn.ugnas.com/appVer/android/4421/Tv121044211027cir.apk?timestamp=1234567890&signature=SYNTHETIC_SIGNATURE_ONLY';
async function until(predicate){for(let i=0;i<500;i++){if(predicate())return;await delay(2);}throw new Error('test state timeout');}
function entry(index,compression=0,payload=Buffer.from('SYNTHETIC_LIBRARY_'+index)){
  const base=NATIVE_SDK_SOURCE.entries[index],name=Buffer.from(base.entry),data=compression===8?deflateRawSync(payload):payload,header=Buffer.alloc(30+name.length);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(compression,8);header.writeUInt32LE(123,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(payload.length,22);header.writeUInt16LE(name.length,26);name.copy(header,30);
  return{pin:{...base,localHeaderOffset:1000+index*10000,headerBytes:header.length,compression,compressedBytes:data.length,bytes:payload.length,crc32:123,headerSha256:hash(header),sha256:hash(payload)},bytes:Buffer.concat([header,data]),payload};
}
function response(bytes,statusCode=200,headers={}){const value=Readable.from([bytes]);value.statusCode=statusCode;value.headers=headers;return value;}
async function fixture(t,options={}){
  const base=await fs.mkdtemp(join(tmpdir(),'native-provision-')),dir=join(base,'native-sdk'),items=[entry(0),entry(1,8)],calls=[],tracker={};t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const request=async args=>{calls.push(args);if(tracker.gate)await tracker.gate.promise;
    if(args.url.hostname==='api-zh.ugnas.com')return response(Buffer.from(tracker.metadata||JSON.stringify({code:200,data:{linkData:{tempUrl:tracker.url||anonymous}}})),tracker.metadataStatus||200,tracker.metadataHeaders||{});
    const index=items.findIndex(item=>args.headers.Range===`bytes=${item.pin.localHeaderOffset}-${item.pin.localHeaderOffset+item.bytes.length-1}`);assert.ok(index>=0,'unplanned byte range');const item=items[index];
    const headers={'content-range':`bytes ${item.pin.localHeaderOffset}-${item.pin.localHeaderOffset+item.bytes.length-1}/${NATIVE_SDK_SOURCE.apkBytes}`,'content-length':String(item.bytes.length),etag:'"'+NATIVE_SDK_SOURCE.apkMd5+'"',...tracker.headers};
    if(tracker.stall){const stream=new Readable({read(){}});stream.statusCode=206;stream.headers=headers;tracker.stream=stream;return stream;}
    return response(tracker.body||item.bytes,tracker.status||206,headers);
  };
  const internals={request,entries:items.map(item=>item.pin),...options.internals},factory=()=>createNativeProvision({dir,trustedDir:dir,...options.options},internals),provision=factory();return{dir,base,items,calls,tracker,internals,provision,factory};
}

test('only the fixed metadata source and exact byte ranges are requested, with no NAS credentials or public paths',async t=>{
  const f=await fixture(t);assert.equal(f.calls.length,0);const result=await f.provision.prepare();assert.equal(result.ready,true);assert.equal(result.files,2);assert.equal(f.calls.length,3);assert.equal(f.calls[0].url.href,NATIVE_SDK_SOURCE.metadataUrl);assert.ok(f.calls.every(c=>!Object.keys(c.headers).some(k=>/authorization|cookie|token|ugk/i.test(k))));
  for(let i=0;i<2;i++){assert.equal(f.calls[i+1].url.hostname,'dl-cn.ugnas.com');assert.equal(f.calls[i+1].headers['If-Match'],'"'+NATIVE_SDK_SOURCE.apkMd5+'"');assert.deepEqual(await fs.readFile(result.paths[i?'pgTunnel':'ugAgent']),f.items[i].payload);}
  const publicValue=JSON.stringify([result,f.provision.status()]);assert.equal(publicValue.includes(f.dir),false);assert.equal(publicValue.includes('SYNTHETIC_SIGNATURE'),false);assert.ok(Object.values(f.provision.status()).every(v=>typeof v==='number'||typeof v==='boolean'));if(process.platform!=='win32'){assert.equal((await fs.stat(f.dir)).mode&0o777,0o700);assert.equal((await fs.stat(result.paths.ugAgent)).mode&0o777,0o600);}
});

test('verified cached libraries need no network, and a missing library is fetched alone',async t=>{
  const f=await fixture(t);const first=await f.provision.prepare();const count=f.calls.length;const again=await f.factory().prepare();assert.equal(again.cached,true);assert.equal(f.calls.length,count);await fs.unlink(first.paths.pgTunnel);await f.provision.prepare();assert.equal(f.calls.length,count+2);assert.ok(f.calls.at(-1).headers.Range.startsWith('bytes='+f.items[1].pin.localHeaderOffset));
});

test('damaged existing libraries are rejected without overwriting contents or contacting a server',async t=>{
  const f=await fixture(t);await fs.mkdir(f.dir);await fs.writeFile(join(f.dir,'libugagentsdk.so'),'damaged');await assert.rejects(f.provision.prepare(),{code:'NATIVE_PROVISION_EXISTING_INVALID'});assert.equal(f.calls.length,0);assert.equal(await fs.readFile(join(f.dir,'libugagentsdk.so'),'utf8'),'damaged');
});

test('metadata cannot redirect to another host, protocol, APK path or credential-bearing URL',async t=>{
  for(const url of ['http://dl-cn.ugnas.com'+NATIVE_SDK_SOURCE.path,anonymous.replace('dl-cn.ugnas.com','attacker.test'),anonymous.replace('/4421/','/other/'),anonymous+'&token=private',anonymous+'#fragment']){const f=await fixture(t);f.tracker.url=url;await assert.rejects(f.provision.prepare(),{code:'NATIVE_SOURCE_CHANGED'});assert.equal(f.calls.length,1);}
  const f=await fixture(t);f.tracker.metadataStatus=302;await assert.rejects(f.provision.prepare());assert.equal(f.calls.length,1);
});

test('full-file responses, changed object length/etag, encoding and malformed content-range never trigger fallback download',async t=>{
  for(const change of [{status:200},{headers:{etag:'W/"'+NATIVE_SDK_SOURCE.apkMd5+'"'}},{headers:{etag:'"00000000000000000000000000000000"'}},{headers:{'content-range':'bytes 1-5/135984881'}},{headers:{'content-encoding':'gzip'}},{headers:{'content-length':'135984880'}}]){const f=await fixture(t);Object.assign(f.tracker,change);await assert.rejects(f.provision.prepare(),{code:'NATIVE_SOURCE_CHANGED'});assert.equal(f.calls.length,2);assert.equal(f.provision.status().ready,false);}
});

test('changed ZIP headers, payload hashes, truncated and over-limit responses are rejected before publication',async t=>{
  for(const mutate of [bytes=>{bytes[0]=0;return bytes;},bytes=>{bytes[bytes.length-1]^=1;return bytes;},bytes=>bytes.subarray(0,-1),bytes=>Buffer.concat([bytes,Buffer.from([0])])]){const f=await fixture(t);f.tracker.body=mutate(Buffer.from(f.items[0].bytes));await assert.rejects(f.provision.prepare());await assert.rejects(fs.stat(join(f.dir,'libugagentsdk.so')),{code:'ENOENT'});assert.deepEqual(await fs.readdir(f.dir),[]);}
});

test('deflate extraction has an actual hard output ceiling, and unexpected entry paths cannot pass pins',()=>{
  const good=entry(1,8,Buffer.alloc(4096,97));assert.deepEqual(decodeNativeZipEntry(good.bytes,good.pin),good.payload);const bomb={...good.pin,bytes:16};const changed=Buffer.from(good.bytes);changed.writeUInt32LE(16,22);bomb.headerSha256=hash(changed.subarray(0,bomb.headerBytes));assert.throws(()=>decodeNativeZipEntry(changed,bomb),{code:'NATIVE_PROVISION_INFLATE_LIMIT'});const path={...good.pin,entry:'../outside'};assert.throws(()=>decodeNativeZipEntry(good.bytes,path),{code:'NATIVE_SOURCE_CHANGED'});
});

test('singleflight coalesces callers while one cancellation cannot abort another subscriber',async t=>{
  const f=await fixture(t);f.tracker.gate=deferred();const abort=new AbortController(),one=f.provision.prepare({signal:abort.signal}).catch(e=>e),two=f.factory().prepare();await until(()=>f.calls.length===1);abort.abort();assert.equal((await one).name,'AbortError');f.tracker.gate.resolve();assert.equal((await two).ready,true);assert.equal(f.calls.length,3);
});

test('timeout releases a never-resolving request and all-cancelled late responses cannot publish',async t=>{
  const f=await fixture(t,{options:{timeoutMs:10}});f.tracker.gate=deferred();await assert.rejects(f.provision.prepare(),{code:'NATIVE_PROVISION_TIMEOUT'});await until(()=>f.provision.status().active===0);f.tracker.gate.resolve();await delay(2);assert.deepEqual(await fs.readdir(f.dir),[]);
  const g=await fixture(t);g.tracker.gate=deferred();const abort=new AbortController(),pending=g.provision.prepare({signal:abort.signal}).catch(e=>e);await delay(2);abort.abort();assert.equal((await pending).name,'AbortError');g.tracker.gate.resolve();await delay(5);assert.deepEqual(await fs.readdir(g.dir),[]);
});

test('a stalled body is destroyed on timeout, and concurrently appearing damaged targets are never replaced',async t=>{
  const f=await fixture(t,{options:{timeoutMs:20}});f.tracker.stall=true;await assert.rejects(f.provision.prepare(),{code:'NATIVE_PROVISION_TIMEOUT'});assert.equal(f.tracker.stream.destroyed,true);
  const g=await fixture(t);let injected=false;const io={...fs,async link(source,destination){if(!injected){injected=true;await fs.writeFile(join(g.dir,'libugagentsdk.so'),'concurrent damaged data');}return fs.link(source,destination);}};const p=createNativeProvision({dir:g.dir,trustedDir:g.dir},{...g.internals,fs:io});await assert.rejects(p.prepare(),{code:'NATIVE_PROVISION_EXISTING_INVALID'});assert.equal(await fs.readFile(join(g.dir,'libugagentsdk.so'),'utf8'),'concurrent damaged data');assert.deepEqual(await fs.readdir(g.dir),['libugagentsdk.so']);
});

test('unsafe private directory links and damaged file hardlinks fail without modifying outside data',async t=>{
  const f=await fixture(t),outside=join(f.base,'outside');await fs.mkdir(outside);await fs.symlink(outside,f.dir,process.platform==='win32'?'junction':'dir');await assert.rejects(f.provision.prepare(),{code:'NATIVE_PROVISION_PRIVATE_UNSAFE'});assert.deepEqual(await fs.readdir(outside),[]);assert.equal(f.calls.length,0);
  const g=await fixture(t);await fs.mkdir(g.dir);await fs.writeFile(join(g.base,'alias'),g.items[0].payload);await fs.link(join(g.base,'alias'),join(g.dir,'libugagentsdk.so'));await assert.rejects(g.provision.prepare(),{code:'NATIVE_PROVISION_PRIVATE_UNSAFE'});assert.deepEqual(await fs.readFile(join(g.base,'alias')),g.items[0].payload);assert.equal(g.calls.length,0);
});

test('a 4MiB synthetic library is written and cached through bounded private I/O',async t=>{
  const f=await fixture(t),large=entry(0,0,Buffer.alloc(4060832,97));f.items[0]=large;f.internals.entries[0]=large.pin;const provision=createNativeProvision({dir:f.dir,trustedDir:f.dir},f.internals),result=await provision.prepare();assert.equal((await fs.stat(result.paths.ugAgent)).size,4060832);assert.equal(hash(await fs.readFile(result.paths.ugAgent)),large.pin.sha256);const before=f.calls.length;assert.equal((await provision.prepare()).cached,true);assert.equal(f.calls.length,before);
});

test('abort during a filesystem write never publishes partial bytes and cleans only its owned temporary inode',async t=>{
  const f=await fixture(t),large=entry(0,0,Buffer.alloc(256*1024,97)),abort=new AbortController();f.items[0]=large;f.internals.entries[0]=large.pin;let triggered=false;
  const io={...fs,async open(path,...args){const handle=await fs.open(path,...args);if(!String(path).includes('.libugagentsdk.so-'))return handle;return new Proxy(handle,{get(target,key){if(key==='write')return async(...values)=>{const result=await target.write(...values);if(!triggered){triggered=true;abort.abort();}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}};
  const provision=createNativeProvision({dir:f.dir,trustedDir:f.dir},{...f.internals,fs:io});await assert.rejects(provision.prepare({signal:abort.signal}),{name:'AbortError'});await until(()=>provision.status().active===0);assert.deepEqual(await fs.readdir(f.dir),[]);
});

test('the public deadline rejects even while a native filesystem operation has not yet settled',async t=>{
  const f=await fixture(t),gate=deferred();let blocked=false;
  const io={...fs,async open(path,...args){if(String(path).includes('.libugagentsdk.so-')){blocked=true;await gate.promise;}return fs.open(path,...args);}};
  const provision=createNativeProvision({dir:f.dir,trustedDir:f.dir,timeoutMs:150},{...f.internals,fs:io});await assert.rejects(provision.prepare(),{code:'NATIVE_PROVISION_TIMEOUT'});assert.equal(blocked,true);assert.equal(provision.status().ready,false);gate.resolve();await until(()=>provision.status().active===0);assert.deepEqual(await fs.readdir(f.dir),[]);
});
