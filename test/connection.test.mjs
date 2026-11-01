import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../lib/bridge.mjs';
import { AdaptiveNas } from '../lib/adaptive-nas.mjs';
import http from 'node:http';

test('connection diagnostics require the companion capability and GET/HEAD never wait for discovery', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lan-diagnostics-'));
  let finish, attempts = 0;
  const config = { token: 'private-session', alias: 'private-alias', server: 'https://private-alias.zh9.ug.link' };
  const nas = new AdaptiveNas(config, { select: async () => { attempts++; return new Promise(resolve => finish = resolve); }, createProbe: () => ({ httpsAgent: { destroy() {} } }) });
  const bridge = await createBridge({ dir, config, thumbnails: { clear() {} }, nasClient: nas, host: '127.0.0.1', port: 0, clientToken: 'companion-secret' });
  t.after(async () => { finish?.({ client: null, summary: { reason: 'TIMED_OUT' }, close() {} }); nas.close(); await new Promise(resolve => bridge.server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + bridge.server.address().port + '/api/connection';
  assert.equal((await fetch(url)).status, 401); assert.equal(attempts, 0);
  const headers = { Authorization: 'Bearer companion-secret' };
  const response = await fetch(url, { headers }); assert.equal(response.status, 200);
  const status = await response.json(); assert.equal(status.probing, true); assert.equal(status.p2p, false); assert.equal(status.verified, false);
  assert.deepEqual(Object.keys(status).sort(), ['accountScope','attempts','authenticated','automaticRetry','mediaReadVerified','mode','nativeEnabled','nativeReason','nativeStage','nativeHttpStatus','lastWorkerFailure','p2p','probeElapsedMs','probeError','probeStage','probing','reason','retryAfterMs','verified','visibilityScope','wanTraversalVerified'].sort());
  assert.equal(JSON.stringify(status).includes('private'), false);
  assert.equal((await fetch(url, { headers, method: 'HEAD' })).status, 200); assert.equal(attempts, 1);
});
test('visibility and status bind account plus transport owner and reject a late request body after reset',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'native-visibility-')),config={alias:'owned',token:'private-token',server:'https://owned.example.ug.link',username:'owner'};
 const nas=new AdaptiveNas(config,{automaticRetry:false});const bridge=await createBridge({dir,config,thumbnails:{clear(){}},nasClient:nas,host:'127.0.0.1',port:0,clientToken:'visibility-secret'});
 t.after(async()=>{nas.close();await new Promise(r=>bridge.server.close(r));await rm(dir,{recursive:true,force:true});});
 const server='http://127.0.0.1:'+bridge.server.address().port,headers={Authorization:'Bearer visibility-secret','Content-Type':'application/json'};
 const old=await(await fetch(server+'/api/connection',{headers})).json();const payload={visible:true,scope:old.visibilityScope,accountScope:old.accountScope};
 assert.equal((await fetch(server+'/api/connection/visibility',{method:'POST',headers,body:JSON.stringify(payload)})).status,200);
 let finish;const late=new Promise((resolve,reject)=>{const req=http.request(server+'/api/connection/visibility',{method:'POST',headers:{...headers,'Transfer-Encoding':'chunked'}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});req.once('error',reject);req.write('{"visible":false,');finish=()=>req.end('"scope":'+JSON.stringify(old.visibilityScope)+',"accountScope":'+JSON.stringify(old.accountScope)+'}');});
 await new Promise(r=>setTimeout(r,10));nas.reset();await bridge.reset();const current=nas.visibilityScope();nas.setVisibility({scope:current,visible:true});finish();assert.equal(await late,409);assert.equal(nas.visible,true);
 assert.equal((await fetch(server+'/api/connection?owner='+old.visibilityScope+'&accountScope='+old.accountScope,{headers})).status,409);
 assert.equal((await fetch(server+'/api/connection/visibility',{method:'POST',headers,body:JSON.stringify({...payload,visible:false})})).status,409);assert.equal(nas.visible,true);
});
