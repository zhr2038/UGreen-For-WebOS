import { build } from 'esbuild';
import { resolve } from 'node:path';
const base = resolve(import.meta.dirname, '..');
await build({ entryPoints: [resolve(base, 'app-src/qr.mjs')], outfile: resolve(base, 'app/qr.js'), bundle: true, platform: 'browser', target: 'chrome87', minify: true, legalComments: 'inline' });
