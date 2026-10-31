import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const project = resolve(import.meta.dirname, '..'), output = join(project, '.local/reference/photo-uhd');
await mkdir(output, { recursive: true });
const pixels = Buffer.alloc(3840 * 2160 * 3);
for (let y = 0; y < 2160; y++) for (let x = 0; x < 3840; x++) { const at = (y * 3840 + x) * 3, value = x % 2 ? 255 : 0; pixels[at] = value; pixels[at + 1] = value; pixels[at + 2] = value; }
await sharp(pixels, { raw: { width: 3840, height: 2160, channels: 3 } }).png().toFile(join(output, 'source.png'));
await sharp(pixels, { raw: { width: 3840, height: 2160, channels: 3 } }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toFile(join(output, 'source.jpg'));
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (path === '/blank.html') { res.end('<!doctype html><title>UHD validation</title>'); return; }
    if (path === '/source.png' || path === '/source.jpg') { res.setHeader('content-type', path.endsWith('png') ? 'image/png' : 'image/jpeg'); res.end(await readFile(join(output, path.slice(1)))); return; }
    if (/^\/photo-uhd-(probe|pipeline)\.js$/.test(path)) { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(join(project, 'app', path.slice(1)))); return; }
    if (req.method === 'POST' && /^\/artifact\/((png|jpg)\.mp4|(capabilities|attempts)\.json)$/.test(path)) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 50 * 1024 * 1024) throw new Error('artifact too large'); chunks.push(chunk); } await writeFile(join(output, path.split('/').pop()), Buffer.concat(chunks)); res.end('ok'); return; }
    res.writeHead(404); res.end();
  } catch { res.writeHead(500); res.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
const session = 'photo-uhd-' + process.pid, cli = join(project, 'node_modules/@playwright/cli/playwright-cli.js');
const runtime = join(project, '.local/photo-uhd-runtime.js'); await writeFile(runtime, (await readFile(join(project, 'test/photo-uhd-browser.js'), 'utf8')).replace('__UI_BASE_URL__', base));
let log = '';
async function run(args) { const child = spawn(process.execPath, [cli, '-s=' + session, ...args], { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let text = ''; child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b); const [status] = await once(child, 'exit'); log += text; return { status, text }; }
let status = 1;
try {
  const opened = await run(['open', 'about:blank', '--browser=chrome']); if (opened.status) throw new Error(opened.text);
  const result = await run(['run-code', '--filename=' + runtime]); status = result.status;
  const start = result.text.indexOf('### Result'), end = result.text.indexOf('### Ran Playwright code'); const report = result.text.slice(Math.max(0, start), end > start ? end : undefined).trim(); await writeFile(join(output, 'browser-report.txt'), report);
  if (status) throw new Error(report);
  const execute = promisify(execFile), probes = [];
  for (const type of ['png', 'jpg']) {
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,profile,level,width,height,duration,nb_read_frames', '-show_entries', 'format=duration,size', '-of', 'json', join(output, type + '.mp4')], { windowsHide: true });
    const probe = JSON.parse(stdout), video = probe.streams[0]; assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 3840); assert.equal(video.height, 2160); assert.equal(Number(video.nb_read_frames), 2); assert.equal(Number(video.duration), 15); assert.equal(Number(probe.format.duration), 15);
    await writeFile(join(output, 'ffprobe-' + type + '.json'), stdout); probes.push({ input: type, ...video, size: Number(probe.format.size) });
  }
  const grayPath = join(output, 'png-decoded.gray');
  await execute('ffmpeg', ['-v', 'error', '-i', join(output, 'png.mp4'), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', grayPath, '-y'], { windowsHide: true });
  const gray = await readFile(grayPath); assert.equal(gray.length, 3840 * 2160); const contrast = Math.abs(gray[100 * 3840 + 3836] - gray[100 * 3840 + 3837]); assert.ok(contrast > 150);
  const browser = JSON.parse(report.slice(report.indexOf('\n') + 1));
  console.log(JSON.stringify({ ok: true, localBrowser: browser.capabilities.userAgent, images: browser.results, failedEncoderAttempts: browser.attempts, independentProbe: probes, ffmpegLumaContrast: contrast, previewSubstitutionRejected: browser.previewSubstitutionRejected, physicalUhdValidated: false }, null, 2));
} catch (error) { status = 1; console.error(error.message); }
finally { await run(['close']); await new Promise(resolve => server.close(resolve)); await writeFile(join(output, 'browser-log.txt'), log); }
process.exitCode = status;
