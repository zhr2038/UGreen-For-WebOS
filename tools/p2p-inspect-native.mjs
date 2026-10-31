import { readFile } from 'node:fs/promises';
import { inspectElf, elfCompatibility } from '../lib/transport/elf.mjs';
const path = process.argv[2];
if (!path) { console.log('只读检查本地原生引擎 ABI，不执行文件。用法：node tools/p2p-inspect-native.mjs PATH [arm|arm64]'); process.exit(0); }
const info = inspectElf(await readFile(path));
console.log(JSON.stringify({ ...info, lgCompatibility: elfCompatibility(info, { platform: 'linux', arch: process.argv[3] || 'arm' }) }, null, 2));
