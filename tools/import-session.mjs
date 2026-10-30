import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const dir = resolve(process.env.STATE_DIR || '.local/bridge');
const source = JSON.parse(await readFile('.local/ugos-session.json', 'utf8'));
const d = source.login.data;
await mkdir(dir, { recursive: true });
const nas = { server: source.server, token: d.token, staticToken: d.static_token, clientId: source.clientId, name: d.nas_name, model: d.model, tlsFingerprint: (await readFile('.local/nas-tls-fingerprint', 'utf8')).trim() };
await writeFile(resolve(dir, 'nas.json'), JSON.stringify(nas), { mode: 0o600 });
console.log('NAS session imported. No password was stored.');
