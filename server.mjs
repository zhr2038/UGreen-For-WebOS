import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from './lib/bridge.mjs';
import { Thumbnails } from './lib/images.mjs';
import { createPairing } from './tools/pair-code.mjs';

const rootDir = import.meta.dirname || dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.env.STATE_DIR || '.local/bridge');
await mkdir(dir, { recursive: true });
let config;
try { config = JSON.parse(await readFile(join(dir, 'nas.json'), 'utf8')); }
catch { throw new Error('请先配置 NAS 会话，参见 README。'); }
await createPairing(dir);
await createBridge({ dir, config, thumbnails: new Thumbnails(), host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT) || 8780, staticDir: join(rootDir, 'app') });
console.log('LG NAS Cinema ready. Pairing code is in the private STATE_DIR/pair-code file (valid 15 minutes).');
