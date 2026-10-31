import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { UgOS } from './ugos.mjs';
import { UgreenLink, linkId } from './ugreenlink.mjs';

export class DirectConnection {
  constructor({ dir, config, link = new UgreenLink(), createNas = config => new UgOS(config) }) { this.dir = dir; this.config = config; this.link = link; this.createNas = createNas; this.deviceId = randomUUID(); this.generation = 0; this.busy = false; this.onChange = () => {}; this.qrState = { state: 'expired' }; this.qrTimer = null; }
  cancel() { this.generation++; this.link.cancel(); clearTimeout(this.qrTimer); this.qrTimer = null; this.qrState = { state: 'expired' }; this.pendingQr = null; }
  async advanceQr(generation) {
    if (generation !== this.generation || this.qrInFlight === generation) return;
    clearTimeout(this.qrTimer); this.qrTimer = null;
    this.qrInFlight = generation;
    try {
      const result = this.pendingQr ? { state: 'authorized', device: this.pendingQr } : await this.link.pollQr();
      if (generation !== this.generation) return;
      if (result.state === 'authorized') {
        this.pendingQr = result.device;
        const resolved = await this.link.resolve(result.device.alias);
        await this.commit({ ...result.device, ...resolved }, generation);
        this.pendingQr = null;
        this.qrState = { state: 'connected', ...this.status() }; return;
      }
      this.qrState = result;
      if (['waiting', 'scanned'].includes(result.state)) this.qrTimer = setTimeout(() => this.advanceQr(generation), 3000);
    } catch (error) { if (generation === this.generation) this.qrState = { state: 'error', error: (error.step ? error.step + '：' : '') + error.message, step: error.step || 'UGREENlink 连接', code: error.code, diagnostic: this.link.diagnostic }; }
    finally { if (this.qrInFlight === generation) this.qrInFlight = null; }
  }
  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(join(this.dir, 'session.json'), 'utf8'));
      const alias = linkId(saved.alias);
      if (saved.server !== new URL(saved.server).origin || new URL(saved.server).protocol !== 'https:' || !new URL(saved.server).hostname.startsWith(alias.toLowerCase() + '.') || !new URL(saved.server).hostname.endsWith('.ug.link') || !saved.token) throw new Error('Invalid saved session');
      Object.assign(this.config, { ...saved, alias, clientId: saved.clientId || randomUUID() });
      try { Object.assign(this.config, await this.link.resolve(alias)); } catch { /* The previous verified relay may still be available when discovery is offline. */ }
    } catch { /* First launch or unreadable session: show login. */ }
    try {
      const savedId = (await readFile(join(this.dir, 'device-id'), 'utf8')).trim();
      if (!/^[a-zA-Z0-9_-]{16,64}$/.test(savedId)) throw new Error('Invalid device ID');
      this.deviceId = savedId;
    } catch { this.deviceId = this.config.clientId || this.deviceId; await writeFile(join(this.dir, 'device-id'), this.deviceId, { mode: 0o600 }); }
    this.link.clientId = this.deviceId;
  }
  async save() {
    const { alias, server, token, staticToken, authMode, clientId, name, model, username } = this.config;
    const temporary = join(this.dir, 'session-' + randomUUID() + '.tmp');
    await writeFile(temporary, JSON.stringify({ alias, server, token, staticToken, authMode, clientId, name, model, username }), { mode: 0o600 });
    await rename(temporary, join(this.dir, 'session.json'));
  }
  status() { return { connected: Boolean(this.config.token), alias: this.config.alias || '', name: this.config.name || '', username: this.config.username || '', connection: this.config.linkMode === 'lan-https' ? '局域网直连' : 'UGREENlink HTTPS 中继' }; }
  async commit(candidate, generation) {
    if (generation !== this.generation) throw new Error('登录已取消');
    // Verify the NAS session against an authenticated API before persisting it.
    const check = this.createNas(candidate);
    try {
      if (candidate.fromQr && candidate.authMode !== 'ugk') {
        try { await check.request('v1/verify/is_login'); } catch (error) { error.step = 'NAS 登录校验'; throw error; }
      }
      try { await check.request('v1/video/homepage/media_list'); } catch (error) { error.step = 'NAS 会话验证'; throw error; }
      if (candidate.fromQr) { try { await check.request('v1/verify/qrcode/login/record', { method: 'POST' }); } catch (error) { error.step = 'NAS 登录确认'; throw error; } }
    }
    finally { check.httpsAgent.destroy(); }
    if (generation !== this.generation) throw new Error('登录已取消');
    const previous = { ...this.config };
    Object.keys(this.config).forEach(key => delete this.config[key]); Object.assign(this.config, candidate);
    try { await this.save(); } catch (error) { Object.keys(this.config).forEach(key => delete this.config[key]); Object.assign(this.config, previous); throw error; }
    this.onChange(); return this.status();
  }
  async handle(path, method, data) {
    if (path === '/api/direct/status' && method === 'GET') return this.status();
    if (method !== 'POST') throw Object.assign(new Error('不支持的操作'), { status: 405 });
    if (path === '/api/direct/cancel') { this.cancel(); return { ok: true }; }
    if (path === '/api/direct/qr/poll') return this.qrState;
    if (path === '/api/direct/qr/retry') { this.advanceQr(this.generation); return { state: 'waiting' }; }
    if (path === '/api/direct/logout') {
      if (this.busy) throw new Error('请等待当前登录结束');
      this.cancel(); Object.keys(this.config).forEach(key => delete this.config[key]); await this.save(); this.onChange(); return this.status();
    }
    if (this.busy) throw new Error('登录正在进行中，请稍候');
    this.busy = true;
    if (path === '/api/direct/login' || path === '/api/direct/qr/create') this.cancel();
    const generation = this.generation;
    try {
      if (path === '/api/direct/login') {
        if (!data.username?.trim() || !data.password) throw new Error('请输入 NAS 用户名和密码');
        this.link.cancel(); const resolved = await this.link.resolve(data.alias || this.config.alias);
        const candidate = { ...resolved, clientId: this.deviceId, username: data.username.trim() };
        const nas = this.createNas(candidate);
        try { const info = await nas.login(candidate.username, data.password); Object.assign(candidate, info); }
        finally { data.password = ''; nas.httpsAgent.destroy(); }
        return await this.commit(candidate, generation);
      }
      if (path === '/api/direct/qr/create') {
        clearTimeout(this.qrTimer);
        const qr = await this.link.createQr(); this.qrState = { state: 'waiting' };
        this.qrTimer = setTimeout(() => this.advanceQr(generation), 3000);
        return qr;
      }
      throw Object.assign(new Error('接口不存在'), { status: 404 });
    } finally { data.password = ''; this.busy = false; }
  }
}
