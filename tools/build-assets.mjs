import { build } from 'esbuild';
import { resolve } from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
const base = resolve(import.meta.dirname, '..');
await build({ entryPoints: [resolve(base, 'app-src/qr.mjs')], outfile: resolve(base, 'app/qr.js'), bundle: true, platform: 'browser', target: 'chrome87', minify: true, legalComments: 'inline' });
await build({ entryPoints: [resolve(base, 'app-src/playback.mjs')], outfile: resolve(base, 'app/playback.js'), bundle: true, platform: 'browser', format: 'iife', globalName: 'CloudFramePlayback', target: 'chrome87', minify: true, legalComments: 'inline' });
// The installed file: app loads this public source package only for HEIF.
// Keeping the unmodified loader and replaceable WASM distinct in the package
// object avoids file: fetch/Worker assumptions and preserves rebuilding access.
const heifWorker = await build({ entryPoints: [resolve(base, 'app-src/heif-worker.mjs')], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'chrome87', minify: true, legalComments: 'inline' });
const vendor = resolve(base, 'node_modules/libheif-js/libheif-wasm');
const [loaderSource, wasm] = await Promise.all([readFile(resolve(vendor, 'libheif.js'), 'utf8'), readFile(resolve(vendor, 'libheif.wasm'))]);
await writeFile(resolve(base, 'app/heif-assets.js'), 'window.CloudFrameHeifAssets=' + JSON.stringify({ workerSource: heifWorker.outputFiles[0].text, loaderSource, wasmBase64: wasm.toString('base64') }) + ';');
await mkdir(resolve(base, 'app/licenses/heif'), { recursive: true });
await Promise.all(['HEIF-NOTICES.md', 'libde265-COPYING.txt', 'libheif-COPYING.txt', 'libheif-js-LGPL-3.0.txt'].map(file => copyFile(resolve(base, 'third-party', file), resolve(base, 'app/licenses/heif', file))));
