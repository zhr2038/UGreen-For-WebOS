import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../lib/bridge.mjs';
import { AdaptiveNas } from '../lib/adaptive-nas.mjs';

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
  assert.deepEqual(Object.keys(status).sort(), ['mode','verified','p2p','reason','probing','probeStage','probeError','probeElapsedMs','attempts','retryAfterMs','automaticRetry'].sort());
  assert.equal(JSON.stringify(status).includes('private'), false);
  assert.equal((await fetch(url, { headers, method: 'HEAD' })).status, 200); assert.equal(attempts, 1);
});
