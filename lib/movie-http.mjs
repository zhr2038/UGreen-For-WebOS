import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const sourcePrefix = '/api/play/source/';
const identifier = /^[a-zA-Z0-9_-]{1,160}$/;
const expiredCodes = new Set([1010, 1011, 1012, 1019, 1024]);
const reads = new Map([
  ['/api/play/options', 'options'],
  ['/api/play/active', 'active'],
  ['/api/play/skips', 'skips'],
  ['/api/play/track-preferences', 'trackPreferences'],
]);
const writes = new Map([
  ['/api/play/quality', 'quality'],
  ['/api/play/subtitle', 'subtitle'],
  ['/api/play/preferences', 'preferences'],
  ['/api/play/close', 'close'],
]);
const fields = {
  quality: ['id', 'action', 'qualityId', 'candidateId', 'preferH264'],
  subtitle: ['id', 'action', 'subtitleId', 'resultId', 'format', 'encoding', 'query', 'language', 'page'],
  preferences: ['id', 'preferences', 'action', 'enabled'],
  close: ['id'],
};
const errors = {
  400: ['MOVIE_INVALID_REQUEST', '播放请求参数无效'],
  401: ['MOVIE_AUTH_REQUIRED', '请先配对电视或重新登录 NAS'],
  403: ['MOVIE_ACCESS_DENIED', '无权访问此播放资源'],
  404: ['MOVIE_NOT_FOUND', '播放会话或资源不存在'],
  405: ['MOVIE_METHOD_NOT_ALLOWED', '此播放接口不支持该请求方法'],
  409: ['MOVIE_CONFLICT', '播放源状态已变化，请重试'],
  410: ['MOVIE_CANCELLED', '播放操作已取消或候选源已过期'],
  413: ['MOVIE_REQUEST_TOO_LARGE', '播放请求过大'],
  415: ['MOVIE_FORMAT_UNSUPPORTED', '此字幕或播放格式暂不支持'],
  416: ['MOVIE_RANGE_INVALID', '播放请求的数据范围无效'],
  422: ['MOVIE_INVALID_REQUEST', '播放请求参数无效'],
  429: ['MOVIE_TOO_MANY_SESSIONS', '播放会话过多，请先关闭其他播放'],
  500: ['MOVIE_INTERNAL_ERROR', '播放服务暂时不可用'],
  502: ['MOVIE_UPSTREAM_ERROR', 'NAS 播放请求失败'],
  503: ['MOVIE_UNAVAILABLE', '播放连接暂时不可用'],
  504: ['MOVIE_UPSTREAM_TIMEOUT', 'NAS 播放请求超时'],
};
const failure = (status) => Object.assign(new Error(errors[status]?.[0] || 'MOVIE_UPSTREAM_ERROR'), { status });
const object = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function id(value) {
  if (typeof value !== 'string' || !identifier.test(value)) throw failure(400);
  return value;
}

function clientCapability(req, url) {
  const auth = req.headers.authorization;
  const value = typeof auth === 'string' && /^Bearer /i.test(auth)
    ? auth.replace(/^Bearer /i, '') : url.searchParams.get('client');
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw failure(401);
  return value;
}

/** Pass this directly to MoviePlaybackService.makeUrl. Capabilities stay in memory. */
export function movieSourceUrl({ id: playId, sourceId, resourceId, kind, manifest = false }, { client } = {}) {
  id(playId); id(sourceId); if (resourceId !== undefined) id(resourceId);
  if (typeof client !== 'string' || !client || client.length > 2048 || /[\x00-\x20\x7f]/.test(client)) throw failure(401);
  const suffix=resourceId===undefined?(kind==='hls'||manifest?'/playlist.m3u8':''):'/'+resourceId+(manifest?'.m3u8':'');
  return sourcePrefix + playId + '/' + sourceId + suffix
    + '?client=' + encodeURIComponent(client);
}

function json(req, res, status, value, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendError(req, res, error, onError) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const nasCode = Number.isInteger(error?.code) && error.code >= 0 && error.code <= 1000000000 ? error.code : undefined;
  const status = error?.name === 'AbortError' ? 410 : expiredCodes.has(nasCode) ? 401
    : Object.hasOwn(errors, error?.status) ? error.status : error?.code === 'ETIMEDOUT' ? 504 : 502;
  const [code, message] = errors[status];
  const result = { error: message, code, ...(nasCode === undefined ? {} : { nasCode }) };
  // Do not give an observer the raw URL, raw error or authenticated NAS details.
  try { onError?.({ status, code, ...(nasCode === undefined ? {} : { nasCode }) }); } catch {}
  json(req, res, status, result);
}

async function readJson(req, maximum) {
  const chunks = []; let length = 0;
  // Do not destroy the HTTP request on an over-limit body: send a bounded 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maximum) { req.resume(); throw failure(413); }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw failure(400); }
  if (!object(value)) throw failure(400);
  return value;
}

function queryKeys(url, allowed) {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key)) throw failure(400);
  for (const key of allowed) if (url.searchParams.getAll(key).length > 1) throw failure(400);
}

function match(path, handleRawMedia) {
  if (reads.has(path)) return { type: 'read', method: reads.get(path) };
  if (writes.has(path)) return { type: 'write', method: writes.get(path) };
  if (path.startsWith(sourcePrefix)) {
    const parts = path.slice(sourcePrefix.length).split('/');
    if (parts.length < 2 || parts.length > 3 || parts.some(part => !part)) throw failure(404);
    let values;
    try { values = parts.map(part => decodeURIComponent(part));id(values[0]);id(values[1]); } catch { throw failure(400); }
    if(values[2]==='playlist.m3u8')return{type:'source',id:values[0],sourceId:values[1],requireManifest:true};
    const explicitManifest=Boolean(values[2]?.endsWith('.m3u8'));
    const resourceId=explicitManifest?values[2].slice(0,-5):values[2];
    if(resourceId!==undefined)id(resourceId);
    return { type: 'source', id: values[0], sourceId: values[1], ...(resourceId ? { resourceId } : {}), ...(explicitManifest?{requireManifest:true}:{}) };
  }
  if (handleRawMedia && path.startsWith('/media/')) {
    let value;
    try { value = id(decodeURIComponent(path.slice(7))); } catch { throw failure(400); }
    return { type: 'raw', id: value };
  }
  return null;
}

function requestLifecycle(req, res, external) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const disconnected = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort); res.once('close', disconnected);
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted || req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    dispose() { req.removeListener('aborted', abort); res.removeListener('close', disconnected); external?.removeEventListener('abort', abort); },
  };
}

function rangeHeaders(req) {
  const headers = {}, range = req.headers.range;
  if (range !== undefined) {
    if (typeof range !== 'string' || range.length > 100 || !/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(range)) throw failure(416);
    const [start, end] = range.slice(6).split('-');
    if (start && end && BigInt(end) < BigInt(start) || !start && BigInt(end) === 0n) throw failure(416);
    headers.Range = range;
    const ifRange = req.headers['if-range'];
    if (ifRange !== undefined) {
      if (typeof ifRange !== 'string' || ifRange.length > 512 || /[\x00-\x1f\x7f]/.test(ifRange)) throw failure(400);
      headers['If-Range'] = ifRange;
    }
  }
  return headers;
}

function binaryType(upstream, path, query) {
  const declared = String(upstream.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (/^(?:video|audio)\/[a-z0-9.+-]+$/.test(declared)) return declared;
  if (declared && !['application/octet-stream', 'binary/octet-stream', 'text/vtt'].includes(declared)) throw failure(502);
  const source = path.endsWith('/raw/get') ? String(query.video_path || '') : path;
  const extension = source.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (declared === 'text/vtt' && extension !== 'vtt') throw failure(502);
  return ({ mp4: 'video/mp4', m4v: 'video/mp4', m4s: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg', avi: 'video/x-msvideo', aac: 'audio/aac', mp3: 'audio/mpeg', vtt: 'text/vtt; charset=utf-8' })[extension] || 'application/octet-stream';
}

/** Safe default with the bridge proxy's first six arguments and an extra lifecycle. */
export async function proxyMovieMedia(req, res, path, query, kind, nas, { signal } = {}) {
  const headers = rangeHeaders(req);
  let upstream;
  const abortUpstream = () => upstream?.destroy();
  try {
    // UGOS stream endpoints implement GET, including for a client HEAD.
    upstream = await nas.open(path, { method: 'GET', query, headers, timeout: 60000, signal });
    // Some adapters resolve open() before detaching their request signal. Own
    // the response body too, including a slow iterator blocked in next().
    signal?.addEventListener('abort', abortUpstream, { once:true });
    if (signal?.aborted) { abortUpstream(); throw Object.assign(failure(410),{name:'AbortError'}); }
    if (![200, 206, 416].includes(upstream.statusCode)) throw failure(502);
    const range = String(upstream.headers?.['content-range'] || '');
    if (upstream.statusCode === 416) {
      if (!/^bytes \*\/[0-9]+$/.test(range)) throw failure(502);
      json(req, res, 416, { error: errors[416][1], code: errors[416][0] }, { 'Content-Range': range });
      return;
    }
    let rangeLength;
    if (upstream.statusCode === 206) {
      const values = range.match(/^bytes ([0-9]{1,20})-([0-9]{1,20})\/([0-9]{1,20}|\*)$/);
      if (!values) throw failure(502);
      const start=BigInt(values[1]), end=BigInt(values[2]);
      if (end < start || values[3] !== '*' && end >= BigInt(values[3])) throw failure(502);
      rangeLength=end-start+1n;
    }
    const declaredLength = String(upstream.headers?.['content-length'] || '');
    if (declaredLength && !/^[0-9]{1,20}$/.test(declaredLength) || rangeLength !== undefined && declaredLength && BigInt(declaredLength) !== rangeLength) throw failure(502);
    const contentType = binaryType(upstream, path, query);
    const iterator = upstream[Symbol.asyncIterator]();
    const prefix = []; let length = 0, ended = false;
    while (length < 512) {
      const item = await iterator.next();
      if (item.done) { ended = true; break; }
      const chunk = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value);
      prefix.push(chunk); length += chunk.length;
    }
    const first = Buffer.concat(prefix, length).subarray(0, 1024).toString('utf8');
    if (/^\s*(?:\{\s*"(?:code|msg|error|message|data)"\s*:|<!doctype\s+html|<html(?:\s|>)|<\?xml)/i.test(first)) throw failure(502);
    if (declaredLength && (BigInt(length) > BigInt(declaredLength) || ended && BigInt(length) !== BigInt(declaredLength))) throw failure(502);
    if (signal?.aborted) throw Object.assign(failure(410), { name:'AbortError' });
    const responseHeaders = { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (/^[0-9]{1,20}$/.test(declaredLength)) responseHeaders['Content-Length'] = declaredLength;
    if (upstream.statusCode === 206) responseHeaders['Content-Range'] = range;
    if (upstream.statusCode === 206 || upstream.headers?.['accept-ranges'] === 'bytes') responseHeaders['Accept-Ranges'] = 'bytes';
    res.writeHead(upstream.statusCode, responseHeaders);
    if (req.method === 'HEAD') { res.end(); return; }
    async function* body() {
      for (const chunk of prefix) yield chunk;
      if (!ended) for (;;) { const item = await iterator.next(); if (item.done) break; yield item.value; }
    }
    await pipeline(Readable.from(body()), res, { signal });
  } finally { signal?.removeEventListener('abort',abortUpstream); upstream?.destroy(); }
}

/** Unknown routes return false without authentication, reads or side effects. */
export function createMovieHttpHandler({
  movies, authenticate, validatePlay, proxy = proxyMovieMedia, readBody,
  maxBodyBytes = 16384, handleRawMedia = true, onError,
} = {}) {
  if (!movies || typeof movies.options !== 'function' || typeof proxy !== 'function') throw new TypeError('Movie playback service and proxy are required');
  if (authenticate !== undefined && typeof authenticate !== 'function' || validatePlay !== undefined && typeof validatePlay !== 'function') throw new TypeError('Invalid movie authorization callback');
  const maximum = Math.max(1, Math.min(65536, Number(maxBodyBytes) || 16384));
  return async function handleMovieHttp(req, res, context = {}) {
    let route, lifecycle;
    try {
      const url = context.url || new URL(req.url, 'http://localhost');
      route = match(url.pathname, handleRawMedia);
      if (!route) return false;
      const owner = context.owner ?? await authenticate?.(req, url);
      if (typeof owner !== 'string' || !owner) throw failure(401);
      // Even when root already authenticated owner, child playlist URLs must use
      // this request's current capability, never a stale or global account cap.
      const urlContext = { ...(context.urlContext || {}), client: clientCapability(req, url) };
      lifecycle = requestLifecycle(req, res, context.signal);
      if (lifecycle.signal.aborted) throw Object.assign(failure(410), { name: 'AbortError' });
      const methods = route.type === 'write' ? ['POST'] : ['GET', 'HEAD'];
      if (!methods.includes(req.method)) {
        json(req, res, 405, { error: errors[405][1], code: errors[405][0] }, { Allow: methods.join(', ') });
        return true;
      }
      let payload;
      if (route.type === 'write') {
        payload = readBody ? await readBody(req) : await readJson(req, maximum);
        if (!object(payload) || Object.keys(payload).some(key => !fields[route.method].includes(key))) throw failure(400);
        if (route.method === 'quality' && payload.preferH264 !== undefined && payload.preferH264 !== true) throw failure(400);
        id(payload.id);
      } else if (route.type === 'read') {
        queryKeys(url, ['id', 'client', ...(route.method === 'skips' ? ['duration'] : [])]);
        payload = { id: id(url.searchParams.get('id')) };
        if (url.searchParams.has('duration')) {
          const duration = Number(url.searchParams.get('duration'));
          if (!Number.isFinite(duration) || duration <= 0) throw failure(400);
          payload.duration = duration;
        }
      } else { queryKeys(url, ['client']); payload = route; }
      const playId = payload.id;
      if (validatePlay && await validatePlay(playId, owner, { req, url, kind: route.type }) === false) throw failure(404);
      if (lifecycle.signal.aborted) throw Object.assign(failure(410), { name: 'AbortError' });
      const options = { signal: lifecycle.signal, urlContext };
      if (route.type === 'read') {
        const result = route.method === 'skips'
          ? await movies.skips(playId, owner, payload.duration === undefined ? undefined : { duration: payload.duration })
          : route.method === 'active' ? movies.active(playId, owner, options)
          : await movies[route.method](playId, owner);
        json(req, res, 200, result);
      } else if (route.type === 'write') {
        const result = route.method === 'close' ? await movies.close(playId, owner)
          : await movies[route.method](payload, owner, options);
        json(req, res, 200, result);
      } else if (route.type === 'raw') {
        const value = movies.raw(playId, owner);
        await proxy(req, res, value.path, value.query, 'video', value.nas, options);
      } else if (route.resourceId) {
        const value = movies.resource(route, owner);
        if(route.requireManifest&&!value.manifest)throw failure(404);
        if (value.manifest) await sendManifest(req, res, movies, route, owner, options);
        else await proxy(req, res, value.path, value.query, 'video', value.nas, options);
      } else {
        const { source } = movies.source(playId, owner, route.sourceId);
        if(route.requireManifest&&source.kind!=='hls')throw failure(404);
        if (source.kind === 'hls') await sendManifest(req, res, movies, route, owner, options);
        else {
          const value = movies.stream(route, owner);
          await proxy(req, res, value.path, value.query, 'video', value.nas, options);
        }
      }
      return true;
    } catch (error) {
      // Malformed source paths belong to this handler even before match returns.
      sendError(req, res, error, onError);
      return true;
    } finally { lifecycle?.dispose(); }
  };
}

async function sendManifest(req, res, movies, route, owner, options) {
  const result = await movies.manifest(route, owner, options);
  if (typeof result.body !== 'string' || !result.body.trimStart().startsWith('#EXTM3U')) throw failure(502);
  const body = Buffer.from(result.body);
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'none',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
