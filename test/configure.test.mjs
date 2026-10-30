import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

for (const otp of [false, true]) test(otp ? 'NAS setup leaves no configuration when OTP is required' : 'NAS setup creates a reusable session without persisting or printing the password', async t => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { format: 'pem', type: 'pkcs1' }, privateKeyEncoding: { format: 'pem', type: 'pkcs1' } });
  const password = 'test-only-password'; let loginRequest;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url.startsWith('/ugreen/v1/verify/check')) {
      res.writeHead(200, { 'x-rsa-token': Buffer.from(publicKey).toString('base64') }); return res.end('{}');
    }
    loginRequest = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, data: otp ? { enable_otp: true } : { token: 'fake-session', static_token: 'fake-static', nas_name: 'Example NAS', model: 'DXP example' } }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const state = await mkdtemp(join(tmpdir(), 'lg-cinema-configure-'));
  t.after(async () => { await new Promise(r => upstream.close(r)); await rm(state, { recursive: true, force: true }); });
  const child = spawn(process.execPath, ['tools/configure-nas.mjs', '--server', `http://127.0.0.1:${upstream.address().port}`, '--state-dir', state], { cwd: resolve(import.meta.dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', usernameSent = false, passwordSent = false;
  child.stdout.on('data', b => {
    output += b.toString();
    if (!usernameSent && output.includes('NAS 用户名：')) { usernameSent = true; child.stdin.write('movie-user\n'); }
    if (!passwordSent && output.includes('NAS 密码（不回显）：')) { passwordSent = true; child.stdin.end(password + '\n'); }
  });
  child.stderr.on('data', b => output += b.toString());
  const timer = setTimeout(() => child.kill(), 10000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  assert.equal(code, otp ? 1 : 0, output);
  assert.equal(loginRequest.username, 'movie-user'); assert.notEqual(loginRequest.password, password);
  assert.equal(Buffer.from(loginRequest.password, 'base64').length, 256);
  assert.ok(!output.includes(password));
  if (otp) await assert.rejects(access(join(state, 'nas.json')));
  else {
    const text = await readFile(join(state, 'nas.json'), 'utf8'), saved = JSON.parse(text);
    assert.equal(saved.token, 'fake-session'); assert.equal(saved.name, 'Example NAS'); assert.equal(saved.model, 'DXP example'); assert.ok(!text.includes(password));
  }
});
