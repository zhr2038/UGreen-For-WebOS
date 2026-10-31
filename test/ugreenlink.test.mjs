import test from 'node:test';
import assert from 'node:assert/strict';
import { publicEncrypt, constants } from 'node:crypto';
import { UgreenLink, linkId } from '../lib/ugreenlink.mjs';

test('UGREENlink inputs resolve through the official node-discovery contract', async () => {
  assert.equal(linkId('https://ug.link/example'), 'example');
  assert.equal(linkId('https://example.zh9.ug.link'), 'example');
  for (const input of ['https://example.com/id', 'http://ug.link/id', '../id', 'https://user:password@ug.link/id', 'id/another']) assert.throws(() => linkId(input));
  const calls = [];
  const link = new UgreenLink({ request: async (path, body) => { calls.push({ path, body }); return { code: 200, data: { alias: 'example', relayDomain: 'zh9.ug.link' } }; } });
  assert.deepEqual(await link.resolve('example'), { alias: 'example', server: 'https://example.zh9.ug.link' });
  assert.equal(calls[0].path, 'p2p/v2/ta/nodeInfo/byAlias');
  assert.deepEqual(calls[0].body, { alias: 'example' });
  for (const data of [{ alias: 'other', relayDomain: 'zh9.ug.link' }, { alias: 'example', relayDomain: 'attacker.test' }, { alias: 'example', relayDomain: 'zh9.ug.link/elsewhere' }]) {
    link.request = async () => ({ code: 200, data }); await assert.rejects(link.resolve('example'));
  }
});

test('official TV QR authorization uses an ephemeral key, rate-limits polling and consumes the NAS token once', async () => {
  let now = 100000, publicKey, calls = 0;
  const link = new UgreenLink({ now: () => now, request: async (path, body, options) => {
    calls++;
    if (path.includes('create/qrCode')) { publicKey = body.publicKey; assert.equal(body.qrType, 'LOCAL_LOGIN'); assert.equal(body.platform, 'TV'); return { code: 200, data: { qrCode: 'qr-nonce', url: 'https://www.ugnas.com/scan?code=qr-nonce' } }; }
    assert.equal(path, 'oauth/token'); assert.equal(options.form, true); assert.equal(body.grant_type, 'qrcode');
    if (calls === 2) return { code: 81520, msg: '尚未扫码' };
    if (calls === 3) return { code: 81521, msg: '用户已扫码！' };
    const key = publicKey.replaceAll('RSA PUBLIC KEY', 'PUBLIC KEY');
    const encrypted = publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from('private-nas-session')).toString('base64');
    return { code: 200, data: { access_token: 'never-save-cloud-token', user: { linkParams: JSON.stringify({ token: encrypted, token_safe: true, static_token: 'persistent-key', uglink_id: 'example', nas_name: 'Family NAS', username: 'viewer' }) } } };
  } });
  const qr = await link.createQr(); assert.ok(qr.url.includes('features=KEEPALIVE')); assert.equal(qr.expiresAt, now + 180000);
  assert.equal((await link.pollQr()).state, 'waiting'); assert.equal(calls, 2);
  await link.pollQr(); assert.equal(calls, 2, 'rapid polls must not hit the cloud');
  now += 3000; assert.equal((await link.pollQr()).state, 'scanned');
  now += 3000; const result = await link.pollQr(); assert.equal(result.device.token, 'private-nas-session'); assert.equal(result.device.alias, 'example'); assert.ok(result.device.clientId);
  assert.equal(result.device.authMode, 'token'); assert.equal(result.device.staticToken, 'persistent-key');
  assert.equal(JSON.stringify(result).includes('never-save-cloud-token'), false); assert.equal((await link.pollQr()).state, 'expired');
});

test('cancelling or expiring a QR prevents a late authorization from becoming a session', async () => {
  let finish; let now = 10000; const bids = [];
  const link = new UgreenLink({ now: () => now, request: async (path, body) => { if (path.includes('create')) { bids.push(body.bid); return { code: 200, data: { qrCode: 'nonce', url: 'https://www.ugnas.com/scan' } }; } return await new Promise(resolve => finish = resolve); } });
  await link.createQr(); const pending = link.pollQr(); link.cancel(); finish({ code: 200, data: { user: { linkParams: { token: 'late', uglink_id: 'example' } } } });
  await assert.rejects(pending, /取消/); assert.equal(link.qr, null);
  await link.createQr(); now += 180001; assert.equal((await link.pollQr()).state, 'expired');
  assert.equal(bids[0], bids[1], 'Refreshing a QR must retain the same TV identity');
});
