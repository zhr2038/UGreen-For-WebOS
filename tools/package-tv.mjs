import { build } from 'esbuild';
import { mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import './build-assets.mjs';
import { packageNativeAssets } from './package-native-assets.mjs';
import { auditAudioWasm } from './audit-audio-wasm.mjs';
const base = resolve(import.meta.dirname, '..');
const service = join(base, '.local/tv-package/service');
const packageDir = join(base, '.local/tv-package/ipk');
await rm(service, { recursive: true, force: true });
await rm(packageDir, { recursive: true, force: true });
await mkdir(service, { recursive: true });
await mkdir(packageDir, { recursive: true });
await build({ entryPoints: [join(base, 'service/index.mjs')], outfile: join(service, 'service.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['webos-service'], logLevel: 'warning' });
for (const file of ['package.json', 'services.json']) await copyFile(join(base, 'service', file), join(service, file));
await auditAudioWasm();
for (const file of ['audio-compat.wasm', 'AUDIO-WASM-PROVENANCE.json']) {
  await copyFile(join(base, 'assets/audio-compat', file), join(service, file));
}
await packageNativeAssets(service);
const result = spawnSync(process.execPath, [join(base, 'node_modules/@webos-tools/cli/bin/ares-package.js'), join(base, 'app'), service, '-o', packageDir, '--no-minify'], { env: { ...process.env, ARES_PROFILE: 'tv' }, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
const info = JSON.parse(await readFile(join(base, 'app/appinfo.json'), 'utf8'));
await mkdir(join(base, 'dist'), { recursive: true });
await copyFile(join(packageDir, `${info.id}_${info.version}_all.ipk`), join(base, 'dist/CloudFrame.ipk'));
console.log('Ready: dist/CloudFrame.ipk');
