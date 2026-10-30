// Evaluate a local debugging script only in this project's installed TV app.
import { readFile, writeFile } from 'node:fs/promises';
const port = process.env.TV_INSPECTOR_PORT || '12627';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find(t => t.url?.includes('top.hrhome.nascinema'));
if (!target) throw new Error('This project is not open in the TV inspector');
const url = new URL(target.webSocketDebuggerUrl); url.hostname = '127.0.0.1'; url.port = port;
const socket = new WebSocket(url);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
const script = await readFile(process.argv[2], 'utf8');
const command = process.argv[2].endsWith('.json') ? JSON.parse(script) : { method: 'Runtime.evaluate', params: { expression: script, awaitPromise: true, returnByValue: true, userGesture: true } };
try {
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('TV evaluation timed out')), 30000);
    socket.addEventListener('message', e => { const r = JSON.parse(e.data); if (r.id === 1) { clearTimeout(timeout); resolve(r); } });
    socket.send(JSON.stringify({ id: 1, ...command }));
  });
  if (result.error || result.result?.exceptionDetails) throw new Error(JSON.stringify(result.error || result.result.exceptionDetails));
  if (command.method === 'Page.captureScreenshot' && result.result?.data) {
    await writeFile('.local/tv-app.png', Buffer.from(result.result.data, 'base64'));
    console.log('TV app screenshot saved privately.');
  } else console.log(JSON.stringify(result.result?.result?.value ?? result.result?.result));
} finally {
  socket.close();
  // Some TV firmware never completes the DevTools WebSocket close handshake.
  setTimeout(() => process.exit(), 50).unref();
}
