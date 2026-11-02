import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {DirectConnection} from '../lib/direct.mjs';
import {createBridge} from '../lib/bridge.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const account=()=>({server:'https://synthetic.zh9.ug.link',alias:'synthetic',token:'synthetic-account-token',username:'viewer',clientId:'synthetic-client'});

test('an uncancelled synthetic account completes verification, persistence and activation once',async t=>{
  const config={},writes=[];let changed=0;
  const control=new DirectConnection({dir:'unused-synthetic-directory',config,
    privateState:{async write(name,value){writes.push({name,value});}},link:{cancel(){}},
    createNas:()=>({httpsAgent:{destroy(){}},async request(){return {};}})});
  t.after(()=>control.cancel());control.onChange=()=>changed++;
  const result=await control.commit(account(),control.generation);
  assert.equal(result.connected,true);assert.equal(writes.length,1);assert.equal(changed,1);assert.equal(config.token,account().token);
});

test('cancelling a login during its asynchronous session publication does not activate the cancelled account',async t=>{
  const writing=deferred(),release=deferred(),config={},writes=[];let changed=0;
  const control=new DirectConnection({dir:'unused-synthetic-directory',config,
    privateState:{async write(name,value){writes.push(JSON.parse(value));writing.resolve();await release.promise;}},
    link:{cancel(){}},createNas:()=>({httpsAgent:{destroy(){}},async request(){return {};}})});
  t.after(()=>{release.resolve();control.cancel();});control.onChange=()=>changed++;
  const pending=control.commit(account(),control.generation);
  await writing.promise;assert.equal(Boolean(config.token),false,'Uncommitted credentials became visible');control.cancel();release.resolve();
  await assert.rejects(pending,/取消/);assert.equal(Boolean(config.token),false);assert.equal(changed,0);assert.deepEqual(writes.at(-1),{});
});

test('a newer login waits for cancelled publication rollback and remains the only persisted account', async t => {
  const writing=deferred(),release=deferred(),config={},writes=[];let changed=0;
  const control=new DirectConnection({dir:'unused-synthetic-directory',config,privateState:{async write(name,value){writes.push(JSON.parse(value));if(writes.length===1){writing.resolve();await release.promise;}}},link:{cancel(){}},createNas:()=>({httpsAgent:{destroy(){}},async request(){return {};}})});
  t.after(()=>{release.resolve();control.cancel();});control.onChange=()=>changed++;
  const old=control.commit(account(),control.generation);await writing.promise;control.cancel();
  const next=control.commit({...account(),token:'synthetic-newer-account'},control.generation),rejected=assert.rejects(old,/取消/);release.resolve();await rejected;await next;
  assert.equal(config.token,'synthetic-newer-account');assert.equal(writes.at(-1).token,config.token);assert.equal(changed,1);
});

test('a failed logout write keeps the active account and never reports a successful disconnect', async t => {
  const config=account();let changed=0;const control=new DirectConnection({dir:'unused-synthetic-directory',config,privateState:{async write(){throw Error('synthetic disk failure');}},link:{cancel(){}}});
  t.after(()=>control.cancel());control.onChange=()=>changed++;
  await assert.rejects(control.handle('/api/direct/logout','POST',{}),/disk failure/);assert.equal(control.status().connected,true);assert.equal(config.token,account().token);assert.equal(changed,0);
});

for(const route of ['/api/library?kind=movies','/api/detail?id=1&type=1&library=1','/api/search?q=synthetic'])test('a late '+route.split('?')[0]+' result cannot publish the retired account after bridge reset',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cinema-protocol-race-')),config=account(),entered=deferred(),release=deferred();
  const movie={ug_video_info_id:1,media_lib_set_id:1,category_id:'synthetic',type:1,name:'Retired account movie',duration:300,poster_path:'/synthetic-old-poster.jpg'};
  const nas={config,httpsAgent:{destroy(){}},async request(){entered.resolve();await release.promise;return {video_info:movie,file_information:[],video_arr:[movie],movies_list:{video_arr:[movie]},total_num:1,is_last_page:true};}};
  const bridge=await createBridge({dir,config,nasClient:nas,thumbnails:{clear(){}},host:'127.0.0.1',port:0,clientToken:'synthetic-local-client-capability'});
  t.after(async()=>{release.resolve();await bridge.reset();bridge.server.closeAllConnections();await new Promise(r=>bridge.server.close(r));assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('cinema-protocol-race-'));await rm(dir,{recursive:true,force:true});});
  const pending=fetch('http://127.0.0.1:'+bridge.server.address().port+route,{headers:{Authorization:'Bearer synthetic-local-client-capability'}});
  await entered.promise;config.token='synthetic-replacement-token';await bridge.reset();release.resolve();
  const result=await pending,body=await result.json();assert.equal(result.status,410);assert.equal(JSON.stringify(body).includes('Retired account movie'),false);
});
