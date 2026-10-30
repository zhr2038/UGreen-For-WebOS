import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { connect } from 'node:tls';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { UgOS } from '../lib/ugos.mjs';

const { values } = parseArgs({ options: { server: { type: 'string' }, 'state-dir': { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('交互式配置绿联 NAS；密码不会回显或写入文件。\n用法：node tools/configure-nas.mjs [--server https://NAS_IP:9443] [--state-dir state]\nDocker：docker compose run --rm --no-deps lg-nas-cinema node tools/configure-nas.mjs');
  process.exit(0);
}

const dir = resolve(values['state-dir'] || process.env.STATE_DIR || '.local/bridge');
let previous = {};
try { previous = JSON.parse(await readFile(join(dir, 'nas.json'), 'utf8')); } catch {}
let muted = false;
const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();
async function ask(prompt, secret = false) {
  muted = secret; process.stdout.write(prompt);
  try {
    const answer = await lines.next();
    if (answer.done) throw new Error('输入已结束，未保存新的配置');
    return answer.value;
  } finally { muted = false; if (secret || !process.stdin.isTTY) process.stdout.write('\n'); }
}

function certificateFingerprint(url) {
  return new Promise((resolveFingerprint, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) || 443, servername: isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: false });
    socket.setTimeout(10000, () => socket.destroy(new Error('无法连接 NAS HTTPS 端口')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate().raw;
      socket.end();
      if (!raw) return reject(new Error('NAS 没有返回 TLS 证书'));
      resolveFingerprint(createHash('sha256').update(raw).digest('hex'));
    });
  });
}

let nas;
try {
  console.log('NAS 首次配置：请使用 NAS 本地账号，LG 开发者账号用于电视端的 Developer Mode。');
  const address = values.server || (await ask(`NAS 管理地址${previous.server ? ' [' + previous.server + ']' : '，例如 https://NAS_IP:9443'}：`)).trim() || previous.server;
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入 http:// 或 https:// 管理地址，地址中不要包含账号密码');
  const config = { server: url.origin, clientId: previous.clientId || randomUUID() };
  if (url.protocol === 'https:') {
    config.tlsFingerprint = await certificateFingerprint(url);
    if (config.tlsFingerprint !== previous.tlsFingerprint) {
      console.log(`NAS 地址：${url.origin}\nTLS SHA-256 指纹：${config.tlsFingerprint}`);
      if ((await ask('确认上述地址是你的 NAS 后输入 yes 继续：')).trim().toLowerCase() !== 'yes') throw new Error('已取消，未保存新的配置');
    }
  }
  const username = (await ask('NAS 用户名：')).trim();
  let password = await ask('NAS 密码（不回显）：', true);
  if (!username || !password) throw new Error('用户名和密码不能为空');
  nas = new UgOS(config);
  let info;
  try { info = await nas.login(username, password); } finally { password = ''; }
  Object.assign(config, info);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, 'nas-' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
  await rename(temporary, join(dir, 'nas.json'));
  console.log(`配置成功：${info.name || '绿联 NAS'}\n登录会话已保存到 ${join(dir, 'nas.json')}，未保存密码。\n首次部署接着启动服务；修改已有 NAS 配置后重启该服务使配置生效。`);
} catch (error) {
  console.error('配置失败：' + error.message); process.exitCode = 1;
} finally {
  muted = false; rl.close(); process.stdin.pause(); nas?.httpsAgent.destroy();
}
