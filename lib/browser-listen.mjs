// WHATWG Fetch port-blocking table (2026-11-02):
// https://fetch.spec.whatwg.org/#port-blocking
const blocked = new Set([0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);
export const browserPortAllowed = value => Number.isInteger(value) && value > 0 && value <= 65535 && !blocked.has(value);

/** Port zero remains OS allocated; retry only if the browser would reject it.
 * Explicit ports and ordinary bind failures are never silently replaced. */
export async function listenBrowser(server, { port = 0, host = '127.0.0.1' } = {}) {
  port = Number(port);
  if (port !== 0 && !browserPortAllowed(port)) throw Object.assign(new Error('此端口不能供浏览器访问，请选择其他端口'), { code: 'BROWSER_PORT_BLOCKED' });
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve, reject) => {
      const done = error => { server.off('error', failed); server.off('listening', ready); error ? reject(error) : resolve(); };
      const failed = error => done(error), ready = () => done();
      server.once('error', failed); server.once('listening', ready);
      try { server.listen(port, host); } catch (error) { done(error); }
    });
    const bound = server.address();
    if (bound && typeof bound === 'object' && browserPortAllowed(bound.port)) return server;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (port !== 0) break;
  }
  throw Object.assign(new Error('未能分配可供浏览器访问的端口'), { code: 'BROWSER_PORT_UNAVAILABLE' });
}
