import http from 'node:http';
import { createHmac } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { linkSignals } from './linked-signal.mjs';

const fail = (status = 503) => Object.assign(new Error('兼容音轨服务不可用'), { status });
const localIp = value => typeof value === 'string' && isIPv4(value) &&
  (/^192\.168\./.test(value) || /^10\./.test(value) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(value));

export function audioHelperConfig(value) {
  if (!localIp(value?.host) || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 ||
      typeof value.path !== 'string' || !/^\/volume[0-9]+\/.+\.mkv$/i.test(value.path) ||
      value.path.length > 4096 || /[\x00-\x1f\x7f]/.test(value.path) ||
      !Number.isSafeInteger(value.size) || value.size <= 65536 ||
      !/^[a-f0-9]{64}$/.test(value.headerHash || '') ||
      typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key)) throw fail(400);
  return { host: value.host, port: value.port, path: value.path, key: value.key, size: value.size, headerHash: value.headerHash };
}

export function audioHelperSession(config) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  const controller = new AbortController();
  let playlist = null, count = 0;

  function open(path, { method = 'GET', headers = {}, timeout = 20000, signal } = {}) {
    if (method !== 'GET' || !/^\/(?:playlist\.m3u8|[0-9]{1,5}\.ts)$/.test(path)) throw fail(404);
    const issued = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', Buffer.from(config.key, 'hex'))
      .update(`GET\n${path}\n${issued}`).digest('hex');
    const linked = linkSignals([signal, controller.signal]);
    return new Promise((resolve, reject) => {
      let settled = false, responseStream = null;
      const done = () => linked.dispose();
      const request = http.get({
        host: config.host, port: config.port, path, agent,
        signal: linked.signal,
        headers: { ...headers, 'X-CloudFrame-Time': issued, 'X-CloudFrame-Signature': signature },
      }, res => {
        settled = true;
        responseStream = res;
        request.setTimeout(0);
        res.once('close', done);
        res.once('end', done);
        resolve(res);
      });
      request.on('error', error => {
        done();
        if (!settled) { settled = true; reject(error); }
        else responseStream?.destroy(error);
      });
      request.setTimeout(Math.min(timeout, 20000), () => request.destroy(fail(504)));
    });
  }

  async function prepare(signal) {
    const response = await open('/playlist.m3u8', { signal, timeout: 5000 });
    const chunks = [];
    let length = 0;
    try {
      if (response.statusCode !== 200) throw fail();
      for await (const chunk of response) {
        length += chunk.length;
        if (length > 512 * 1024) throw fail(502);
        chunks.push(chunk);
      }
    } finally { response.destroy(); }
    const lines = Buffer.concat(chunks).toString('ascii').trim().split('\n');
    if (lines[0] !== '#EXTM3U' || lines.at(-1) !== '#EXT-X-ENDLIST') throw fail(502);
    let segments = 0;
    for (const line of lines) {
      if (/^#(?:EXTM3U$|EXT-X-(?:VERSION:\d+|PLAYLIST-TYPE:VOD|INDEPENDENT-SEGMENTS|MEDIA-SEQUENCE:0|TARGETDURATION:\d+|ENDLIST)$|EXTINF:\d+(?:\.\d+)?,)$/.test(line)) continue;
      if (line !== segments + '.ts') throw fail(502);
      segments++;
    }
    if (!segments) throw fail(502);
    playlist = lines;
    count = segments;
  }

  function resource(id) {
    const segment = Number(id);
    if (!/^[0-9]{1,5}$/.test(id) || segment >= count) throw fail(404);
    return { path: '/' + segment + '.ts', query: {}, manifest: false };
  }

  function manifest(map, resourceId) {
    if (!playlist || resourceId !== undefined) throw fail(404);
    return { body: playlist.map(line => line.startsWith('#') ? line : map(line.slice(0, -3))).join('\n') + '\n' };
  }

  function close() { controller.abort(); agent.destroy(); }
  return { owned: { nas: { open }, dispose: close }, session: { prepare, resource, manifest, close } };
}
