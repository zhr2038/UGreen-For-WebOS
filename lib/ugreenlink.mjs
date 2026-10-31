import https from 'node:https';
import { generateKeyPairSync, privateDecrypt, constants, randomUUID } from 'node:crypto';

const CLOUD = 'https://api.ugnas.com';
// Public application identifier used by UGOS's TV QR authorization protocol.
const TV_AK = 'UG8FKSDUGREEN001';
const DEVICE_ALIAS = '云映 · LG TV';
export function linkId(value) {
  const input = String(value || '').trim();
  let id = input;
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('请输入 UGREENlink ID 或 https://ug.link/ID');
    if (['ug.link', 'www.ug.link'].includes(url.hostname)) id = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));
    else if (url.hostname.endsWith('.ug.link')) id = url.hostname.split('.')[0];
    else throw new Error('这不是 UGREENlink 地址');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error('UGREENlink ID 格式不正确');
  return id;
}

export function cloudRequest(path, data, { form = false, origin = CLOUD } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = form ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const req = https.request(new URL('/api/' + path.replace(/^\/+/, ''), origin), {
      method: 'POST', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(encoded), lang: 'zh-CN' },
    }, res => {
      let bytes = 0; const chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) return req.destroy(new Error('绿联服务返回的数据过大')); chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('绿联服务暂时不可用（' + res.statusCode + '）'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('绿联服务返回了无效数据')); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('连接绿联服务超时')));
    req.on('error', reject); req.end(encoded);
  });
}

export class UgreenLink {
  constructor({ request = cloudRequest, now = Date.now, clientId = randomUUID() } = {}) { this.request = request; this.now = now; this.clientId = clientId; this.qr = null; this.generation = 0; }
  async resolve(value) {
    const id = linkId(value);
    const response = await this.request('p2p/v2/ta/nodeInfo/byAlias', { alias: id });
    if (response.code !== 200) throw new Error(response.msg || 'UGREENlink ID 不存在或设备离线');
    const { alias, relayDomain } = response.data || {};
    // Credentials may only be sent to the HTTPS relay returned for this alias.
    if (String(alias).toLowerCase() !== id.toLowerCase() || !/^[a-z0-9.-]+\.ug\.link$/i.test(relayDomain || '')) throw new Error('绿联服务未返回有效的中继地址');
    return { alias, server: new URL(`https://${alias}.${relayDomain}`).origin };
  }
  cancel() { this.generation++; this.qr = null; }
  async createQr() {
    this.cancel(); const generation = this.generation;
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).replace('BEGIN PUBLIC KEY', 'BEGIN RSA PUBLIC KEY').replace('END PUBLIC KEY', 'END RSA PUBLIC KEY');
    const bid = this.clientId;
    const response = await this.request('user/v3/sa/create/qrCode', { qrType: 'LOCAL_LOGIN', clientType: 'TV', platform: 'TV', bid, alias: DEVICE_ALIAS, publicKey, ak: TV_AK });
    if (generation !== this.generation) throw new Error('扫码登录已取消');
    if (response.code !== 200 || !response.data?.qrCode || !response.data?.url) throw new Error(response.msg || '无法生成绿联登录二维码');
    const url = new URL(response.data.url);
    if (url.protocol !== 'https:' || !/(^|\.)(ugnas\.com|ug\.link)$/.test(url.hostname)) throw new Error('绿联返回了不受支持的扫码地址');
    url.searchParams.set('features', 'KEEPALIVE');
    this.qr = { code: response.data.qrCode, key: keys.privateKey, bid, expires: this.now() + 180000, generation, lastPoll: 0 };
    return { url: url.href, expiresAt: this.qr.expires, interval: 3000 };
  }
  async pollQr() {
    const qr = this.qr;
    if (!qr || qr.expires <= this.now()) { this.cancel(); return { state: 'expired' }; }
    if (qr.polling || this.now() - qr.lastPoll < 2500) return { state: 'waiting' };
    qr.polling = true; qr.lastPoll = this.now();
    try {
      const response = await this.request('oauth/token', { clientType: 'TV', platform: 'TV', bid: qr.bid, alias: DEVICE_ALIAS, grant_type: 'qrcode', osVer: 'webOS', model: 'LG TV', qrcode: qr.code }, { form: true });
      this.diagnostic = { code: response.code, dataKeys: Object.keys(response.data || {}), userKeys: Object.keys(response.data?.user || {}) };
      if (this.qr !== qr || qr.generation !== this.generation) throw new Error('扫码登录已取消');
      if (response.code === 81520) return { state: 'waiting' };
      if (response.code !== 200 && /已扫码/.test(response.msg || '')) return { state: 'scanned' };
      if (response.code !== 200) throw Object.assign(new Error(response.msg || '扫码确认失败，请刷新二维码'), { step: '扫码授权', code: response.code });
      let device = response.data?.user?.linkParams;
      if (typeof device === 'string') { try { device = JSON.parse(device); } catch { throw new Error('扫码返回的设备信息无效'); } }
      if (!device?.token || !device.uglink_id) throw new Error('扫码未返回可用的 NAS 会话或 UGREENlink ID');
      let token = device.token;
      const tokenSafe = device.token_safe ?? device.tokenSafe;
      if (tokenSafe === true || tokenSafe === 1 || tokenSafe === 'true') token = decryptQrToken(token, qr.key);
      if (typeof token !== 'string' || !token || token.length > 8192) throw new Error('扫码返回的会话无效');
      Object.assign(this.diagnostic, { tokenSafe, tokenLength: token.length, hasStaticToken: Boolean(device.static_token) });
      // A successful result is consumed once. Cloud access tokens are never saved.
      this.cancel();
      return { state: 'authorized', device: { alias: linkId(device.uglink_id), token, staticToken: device.static_token, authMode: 'token', clientId: qr.bid, fromQr: true, name: String(device.nas_name || ''), model: String(device.model || ''), username: String(device.username || '') } };
    } finally { qr.polling = false; }
  }
}

function decryptQrToken(encoded, key) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(encoded)) throw new Error('扫码会话解密失败');
  const cipher = Buffer.from(encoded, 'base64');
  try { return privateDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, cipher).toString('utf8'); }
  catch (error) {
    // Recent Node versions disable native PKCS#1 v1.5 unpadding. This input is
    // exclusively the official cloud's response to our ephemeral QR key; there
    // is no user-supplied decrypt endpoint or reusable private key.
    if (!String(error.message).includes('RSA_PKCS1_PADDING')) throw new Error('扫码会话解密失败');
    const block = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, cipher);
    const separator = block.indexOf(0, 2);
    if (block[0] !== 0 || block[1] !== 2 || separator < 10 || separator >= block.length - 1) throw new Error('扫码会话解密失败');
    return block.subarray(separator + 1).toString('utf8');
  }
}
