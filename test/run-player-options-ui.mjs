import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
const project = resolve(import.meta.dirname, '..'), session = 'player-options-' + process.pid;
await mkdir(join(project, '.local'), { recursive: true }); await mkdir(join(project, 'output/playwright'), { recursive: true });
const server = http.createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/player-options.css"><style>#dialog{position:absolute;inset:0;z-index:22;pointer-events:none}#dialog>.player-dialog{pointer-events:auto}</style><video id="video"></video><div id="dialog"></div><script src="/player-options.js"></script>'); return; }
  const file = new URL(req.url, 'http://localhost').pathname.slice(1);
  if (!['app.css','player-options.css','player-options.js'].includes(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(join(project, 'app', file)));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const script = (await readFile(join(project, 'test/player-options-ui.js'), 'utf8')).replace('__PLAYER_OPTIONS_BASE__', `http://127.0.0.1:${server.address().port}`);
const runtime = join(project, '.local/player-options-ui-runtime.js'); await writeFile(runtime, script);
let log = '';
async function cli(args) { const child = spawn(process.execPath, [join(project, 'node_modules/@playwright/cli/playwright-cli.js'), '-s=' + session, ...args], { cwd: project, windowsHide: true, stdio: ['ignore','pipe','pipe'] }); let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b); const [status] = await once(child, 'exit'); log += output; return { status, output }; }
try { const opened = await cli(['open','about:blank','--browser=chrome']); if (opened.status) throw new Error(opened.output); const result = await cli(['run-code','--filename=' + runtime]); const start = result.output.indexOf('### Result'), end = result.output.indexOf('### Ran Playwright code', start); console.log(start >= 0 ? result.output.slice(start, end < 0 ? undefined : end).trim() : result.output); process.exitCode = result.status; }
finally { await cli(['close']); await new Promise(r => server.close(r)); await writeFile(join(project, 'output/playwright/player-options-ui.log'), log); }
