import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import sharp from 'sharp';

const project = resolve(import.meta.dirname, '..');
const cli = join(project, 'node_modules/@playwright/cli/playwright-cli.js');
const scenario = process.argv.includes('--photos') ? 'photo-gallery-ui' : 'ui-regression';
const session = 'cinema-' + scenario + '-' + process.pid;
const output = join(project, 'output/playwright');
await mkdir(output, { recursive: true });
await mkdir(join(project, '.local'), { recursive: true });
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/blank.html') { res.end('<!doctype html><title>UI test</title>'); return; }
  const path = pathname === '/' ? '/index.html' : pathname;
  if (!/^\/[a-zA-Z0-9._-]+$/.test(path)) { res.writeHead(404); res.end(); return; }
  try {
    const bytes = await readFile(join(project, 'app', path.slice(1)));
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(path)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const mockImage = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#225577' } }).png().toBuffer();
const code = (await readFile(join(project, 'test', scenario + '.js'), 'utf8')).replace('__UI_BASE_URL__', base).replace('__UI_FILTER__', JSON.stringify(process.env.CINEMA_UI_FILTER || '')).replace('__UI_IMAGE_BASE64__', JSON.stringify(mockImage.toString('base64')));
const runtime = join(project, '.local/' + scenario + '-runtime.js');
await writeFile(runtime, code);
let log = '';
async function run(args) {
  const child = spawn(process.execPath, [cli, '-s=' + session, ...args], { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', b => text += b.toString()); child.stderr.on('data', b => text += b.toString());
  const [status] = await once(child, 'exit'); log += text;
  return { status, text };
}
let status = 1;
try {
  const opened = await run(['open', 'about:blank', '--browser=chrome']);
  if (opened.status !== 0) throw new Error(opened.text);
  const checked = await run(['run-code', '--filename=' + runtime]); status = checked.status || 0;
  const start = checked.text.indexOf('### Result');
  console.log(start >= 0 ? checked.text.slice(start, checked.text.indexOf('### Ran Playwright code', start) < 0 ? undefined : checked.text.indexOf('### Ran Playwright code', start)).trim() : checked.text);
} catch (error) { console.error(error.message); }
finally {
  await run(['close']);
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(output, scenario + '.log'), log);
}
process.exitCode = status;
