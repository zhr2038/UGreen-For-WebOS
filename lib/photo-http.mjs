import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API = '/api/photos/video/';
const HLS = '/photo-hls/';
const cap = /^[a-f0-9]{40}$/;
const resourceCap = /^[a-f0-9]{32}$/;
const fail = status => Object.assign(new Error('Photo HTTP request rejected'), { status });
const aborted = () => new DOMException('Photo HTTP request aborted', 'AbortError');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const tokenValid = value => typeof value === 'string' && /^[\x21-\x7e]{16,512}$/.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const messages = { 400: '无效相册视频请求', 401: '请先配对电视', 403: '无权访问这个播放会话', 404: '相册视频链接已过期', 405: 'Method not allowed', 409: '相册视频请求冲突', 410: '相册视频请求已取消', 413: '请求过大', 415: '请使用 JSON 请求', 429: '播放会话过多，请先关闭其他视频', 502: 'NAS 相册视频响应无效', 503: '相册视频连接正在重置' };
const headerNames = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-type', 'content-encoding'];
const secretsFrom = nas => ['token', 'staticToken', 'password', 'ugk'].map(key => nas?.config?.[key]).filter(value => typeof value === 'string' && value.length >= 8);
function noSecrets(text, secrets) { if (secrets.some(value => text.includes(value) || text.includes(encodeURIComponent(value)))) throw fail(502); return text; }

function rawCredential(req, url) {
  const header = req.headers.authorization;
  if (header != null && (typeof header !== 'string' || !/^Bearer [\x21-\x7e]{16,512}$/i.test(header))) throw fail(401);
  const bearer = header?.replace(/^Bearer /i, ''), values = url.searchParams.getAll('client');
  if (values.length > 1) throw fail(401);
  if (bearer && values[0] && !same(bearer, values[0])) throw fail(401);
  return bearer || values[0];
}
function json(req, res, status, value, secrets = []) {
  if (res.destroyed || res.writableEnded) return false;
  const text = noSecrets(JSON.stringify(value), secrets), bytes = Buffer.from(text);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : bytes); return true;
}
async function readJson(req, signal) {
  if (Number(req.headers['content-length']) > 16384) { req.resume(); throw fail(413); }
  if (req.headers['content-type'] && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'])) throw fail(415);
  const parts = []; let size = 0;
  for await (const part of req) { if (signal.aborted) throw aborted(); size += part.length; if (size > 16384) throw fail(413); parts.push(part); }
  if (signal.aborted) throw aborted();
  try { const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); if (!plain(body)) throw new Error(); return body; }
  catch { throw fail(400); }
}
function actionBody(action, body) {
  const allowed = { start: ['asset'], quality: ['id', 'quality', 'request'], commit: ['id', 'candidate'], discard: ['id', 'candidate', 'request'], close: ['id'] }[action];
  if (!allowed || !plain(body) || Object.keys(body).some(key => !allowed.includes(key))) throw fail(400);
  if (action === 'start') { if (!cap.test(body.asset)) throw fail(400); }
  else if (!cap.test(body.id)) throw fail(400);
  if (action === 'quality' && (typeof body.quality !== 'string' || !body.quality || body.quality.length > 256)) throw fail(400);
  if (body.request != null && (typeof body.request !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.request))) throw fail(400);
  if (body.candidate != null && !cap.test(body.candidate)) throw fail(400);
  if (action === 'commit' && !cap.test(body.candidate) || action === 'discard' && !body.candidate && !body.request) throw fail(400);
  return { ...body, ...(action === 'quality' && !body.request ? { request: randomBytes(16).toString('hex') } : {}) };
}
function scopeFor(req, res, external) {
  const controller = new AbortController(), abort = () => controller.abort();
  const closed = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort); res.once('close', closed); external?.addEventListener('abort', abort, { once: true });
  if (req.aborted || external?.aborted) abort();
  return { controller, signal: controller.signal, cleanup() { req.off('aborted', abort); res.off('close', closed); external?.removeEventListener('abort', abort); } };
}
function localURL(path, { client, context, url, makeURL }) {
  if (!/^\/photo-(?:video\/[a-f0-9]{40}|hls\/[a-f0-9]{40}\/(?:master(?:\.m3u8)?|playlist\.m3u8|[a-f0-9]{32}(?:\.m3u8)?))$/.test(path)) throw fail(502);
  const mapper = context.makeURL || makeURL;
  let value;
  if (mapper) value = mapper(path, { ...context, client });
  else { const local = new URL(path, 'http://photo.invalid'); local.searchParams.set('client', client); value = local.pathname + local.search; }
  if (typeof value !== 'string' || value.startsWith('//')) throw fail(502);
  let result; try { result = new URL(value, url); } catch { throw fail(502); }
  const allowedOrigin = context.origin ? new URL(context.origin).origin : null;
  if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password || result.hash || result.pathname !== path || /^https?:/i.test(value) && result.origin !== allowedOrigin) throw fail(502);
  if (result.searchParams.getAll('client').length !== 1 || !same(result.searchParams.get('client'), client) || [...result.searchParams.keys()].some(key => key !== 'client')) throw fail(502);
  return /^https?:/i.test(value) ? result.href : result.pathname + result.search;
}
async function directProxy(req, res, path, query, kind, client) {
  const upstream = await client.open(path, { method: 'GET', query, headers: req.headers.range ? { Range: req.headers.range, ...(req.headers['if-range'] ? { 'If-Range': req.headers['if-range'] } : {}) } : {} });
  res.writeHead(upstream.statusCode, { ...upstream.headers, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD' || upstream.statusCode === 304 || upstream.statusCode === 416) { upstream.destroy(); res.end(); return; }
  await pipeline(upstream, res);
}
function guardedNas(session, signal, secrets) {
  return {
    async open(path, options = {}) {
      const combined = AbortSignal.any([signal, session.abort.signal, ...(options.signal ? [options.signal] : [])]);
      if (combined.aborted) throw aborted();
      const upstream = await session.nas.open(path, { ...options, method: 'GET', timeout: 60000, signal: combined });
      try {
        if (![200, 206, 304, 416].includes(upstream.statusCode)) throw fail(502);
        const headers = {};
        for (const name of headerNames) if (upstream.headers[name] != null) headers[name] = noSecrets(String(upstream.headers[name]), secrets);
        if (upstream.statusCode === 304 || upstream.statusCode === 416) { upstream.destroy(); const empty = Readable.from([]); empty.statusCode = upstream.statusCode; empty.headers = { ...headers, 'content-length': '0' }; return empty; }
        const mime = String(headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
        // Never pass an unrecognised nested manifest or JSON/HTML auth error
        // through the opaque segment route, even when root supplies its proxy.
        if (!/^(?:video\/[^\s]+|audio\/[^\s]+|application\/(?:octet-stream|mp4|mp2t)|binary\/octet-stream|text\/vtt)$/.test(mime)) throw fail(502);
        upstream.headers = headers;
        const stop = () => upstream.destroy(); combined.addEventListener('abort', stop, { once: true });
        const cleanup = () => combined.removeEventListener('abort', stop); upstream.once('close', cleanup); upstream.once('end', cleanup);
        if (combined.aborted) { stop(); throw aborted(); }
        return upstream;
      } catch (error) { upstream.destroy(); throw error; }
    },
  };
}

/** Route adapter only. Root may pass an already authenticated owner and
 * canonical urlContext.client. No owner or NAS path is accepted from JSON. */
export function createPhotoHttpHandler({ photos, clientToken, authorize, makeURL, proxy = directProxy, onReset } = {}) {
  if (!photos?.videos || typeof proxy !== 'function' || clientToken != null && !tokenValid(clientToken)) throw new TypeError('Photos videos, a proxy, and a valid optional client capability are required');
  const active = new Set(), cleanups = new Set(), qualityRequests = new Set(); let generation = 0, disposed = false, resetting;
  const cleanup = operation => { const task = Promise.resolve().then(operation).catch(() => {}); cleanups.add(task); task.finally(() => cleanups.delete(task)); return task; };
  async function handler(req, res, context = {}) {
    const url = context.url instanceof URL ? context.url : new URL(context.url || req.url, 'http://localhost');
    if (!url.pathname.startsWith(API) && !url.pathname.startsWith(HLS)) return false;
    const scope = scopeFor(req, res, context.signal || context.requestSignal), epoch = generation; active.add(scope);
    let owner, action, body, result, slot, cancel, videos, secretValues = secretsFrom(photos.nas);
    try {
      const incoming = rawCredential(req, url), authorized = authorize ? await authorize(req, url, context) : null;
      if (authorize && !plain(authorized)) throw fail(401);
      owner = authorized?.owner ?? context.owner;
      const client = authorized?.client ?? authorized?.clientToken ?? context.urlContext?.client ?? incoming;
      if (clientToken != null) { if (!same(incoming || client, clientToken)) throw fail(401); owner ??= createHash('sha256').update(clientToken).digest('hex'); }
      if (typeof owner !== 'string' || !owner || owner.length > 512 || !tokenValid(client) || incoming && !same(incoming, client)) throw fail(401);
      if (authorized?.owner && context.owner && authorized.owner !== context.owner) throw fail(403);
      if (disposed || resetting) throw fail(503);
      if (scope.signal.aborted) throw aborted();
      const urlOptions = { client, context: context.urlContext || {}, url, makeURL };
      videos = photos.videos; secretValues = [...secretValues, ...secretsFrom(videos.photos?.nas)];
      if (url.pathname.startsWith(API)) {
        action = url.pathname.slice(API.length);
        if (!['start', 'quality', 'commit', 'discard', 'close', 'active'].includes(action)) throw fail(404);
        const closeRoot = () => videos.close({ id: result?.id || body.id }, owner);
        const discard = () => videos.discard({ id: body.id, request: body.request, ...(result?.candidate ? { candidate: result.candidate } : {}) }, owner);
        if (action === 'active') {
          if (!['GET', 'HEAD'].includes(req.method)) throw fail(405);
          if (url.searchParams.getAll('id').length !== 1 || !cap.test(url.searchParams.get('id')) || [...url.searchParams.keys()].some(key => !['id', 'client'].includes(key))) throw fail(400);
          body = { id: url.searchParams.get('id') }; result = videos.active(body, owner);
        } else {
          if (req.method !== 'POST') throw fail(405);
          body = actionBody(action, await readJson(req, scope.signal)); if (scope.signal.aborted) throw aborted();
          if (action === 'quality') {
            const nextSlot = JSON.stringify([owner, body.id, body.request]); if (qualityRequests.has(nextSlot)) throw fail(409); slot = nextSlot; qualityRequests.add(slot);
            cancel = () => { cleanup(discard); }; scope.signal.addEventListener('abort', cancel, { once: true });
          }
          // Commit promotion is atomic. A lost HTTP acknowledgement must not
          // close the accepted source; the client can reconcile through active.
          result = await videos[action](body, owner, { signal: scope.signal });
        }
        if (scope.signal.aborted || epoch !== generation || res.destroyed) {
          if (action === 'start') await cleanup(closeRoot);
          if (action === 'quality') await cleanup(discard);
          throw aborted();
        }
        if (result.original) result = { ...result, original: localURL(result.original, urlOptions) };
        if (result.url) {
          const path = result.kind === 'hls' ? result.url.replace(/^(\/photo-hls\/[a-f0-9]{40})\/master$/, '$1/playlist.m3u8') : result.url;
          result = { ...result, url: localURL(path, urlOptions) };
        }
        if (!json(req, res, 200, result, secretValues)) throw aborted();
      } else {
        if (!['GET', 'HEAD'].includes(req.method)) throw fail(405);
        const match = /^\/photo-hls\/([a-f0-9]{40})\/(master(?:\.m3u8)?|playlist\.m3u8|[a-f0-9]{32}(?:\.m3u8)?)$/.exec(url.pathname); if (!match) throw fail(404);
        const [, id, requested] = match, resource = /^(?:master(?:\.m3u8)?|playlist\.m3u8)$/.test(requested) ? 'master' : requested.replace(/\.m3u8$/, ''), session = videos.hls(id, owner);
        secretValues = [...secretValues, ...secretsFrom(session.nas)];
        const descriptor = resource === 'master' ? { manifest: true } : session.resource(resource);
        if (requested.endsWith('.m3u8') && !descriptor.manifest) throw fail(404);
        if (descriptor.manifest) {
          const signal = AbortSignal.any([scope.signal, session.abort.signal]);
          const manifest = await session.manifest(key => localURL(`/photo-hls/${id}/${key}${session.resource(key).manifest ? '.m3u8' : ''}`, urlOptions), resource === 'master' ? undefined : resource, signal);
          if (scope.signal.aborted || epoch !== generation) throw aborted();
          const text = noSecrets(manifest.body, secretValues), bytes = Buffer.from(text);
          res.writeHead(200, { 'Content-Type': manifest.contentType, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : bytes);
        } else await proxy(req, res, descriptor.path, descriptor.query, 'photoHls', guardedNas(session, scope.signal, secretValues));
      }
    } catch (error) {
      if (result && action === 'start') await cleanup(() => videos.close({ id: result.id }, owner));
      if (result && action === 'quality') await cleanup(() => videos.discard({ id: body.id, candidate: result.candidate, request: body.request }, owner));
      const status = error?.name === 'AbortError' || scope.signal.aborted || epoch !== generation ? 410 : messages[error?.status] ? error.status : 502;
      if (!res.destroyed && !res.writableEnded) { if (res.headersSent) res.destroy(); else json(req, res, status, { error: messages[status] }); }
    } finally {
      if (cancel) scope.signal.removeEventListener('abort', cancel); if (slot) qualityRequests.delete(slot); scope.cleanup(); active.delete(scope);
    }
    return true;
  }
  handler.reset = () => {
    if (resetting) return resetting;
    ++generation; for (const scope of active) scope.controller.abort();
    resetting = Promise.resolve().then(() => onReset ? onReset() : photos.videos.clear()).then(() => Promise.allSettled([...cleanups])).finally(() => { resetting = null; }); return resetting;
  };
  handler.dispose = () => { disposed = true; return handler.reset(); };
  return handler;
}
