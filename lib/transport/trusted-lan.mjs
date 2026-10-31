import https from 'node:https';
import { lookup as lookupAddress } from 'node:dns/promises';
import { isIP } from 'node:net';
import { UgOS } from '../ugos.mjs';
import { cloudRequest } from '../ugreenlink.mjs';

const HANDSHAKE = '/ugreen/v1/verify/handshake';
const failure = reason => ({ client: null, route: null, summary: { mode: 'ugreenlink-relay', verified: false, p2p: false, reason }, close() {} });
const cancelled = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

export function isPrivateLanAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // ULA is locally routable; link-local IPv6 without an interface scope is not
  // accepted as an automatic candidate. Never probe loopback or public hosts.
  return isIP(address) === 6 && /^(fc|fd)/i.test(address);
}

export function smartDnsCandidates(nodeInfo, alias) {
  const node = nodeInfo?.data || nodeInfo;
  if (!node || String(node.alias || '').toLowerCase() !== String(alias).toLowerCase()) return [];
  const info = node.netInfo || {}, port = Number(info.httpsPort || 9443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  const candidates = [];
  for (const [kind, hosts] of Object.entries(info.smartdns || {})) {
    if (!['lan', 'lanv6'].includes(kind) || !Array.isArray(hosts)) continue;
    for (const host of hosts) {
      if (typeof host !== 'string' || host.length > 253) continue;
      try {
        const url = new URL('https://' + host);
        if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.lan\.ug\.link$/i.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') continue;
        url.port = String(port);
        if (!candidates.some(c => c.origin === url.origin)) candidates.push({ origin: url.origin, hostname: url.hostname, kind });
      } catch { /* Unknown discovery values do not become HTTP destinations. */ }
    }
  }
  return candidates.slice(0, 4);
}

export function pinnedLanLookup(hostname, record) {
  if (!isPrivateLanAddress(record.address) || ![4, 6].includes(record.family)) throw new Error('LAN route requires a private address');
  return (host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (String(host).toLowerCase() !== hostname.toLowerCase() || (options?.family && Number(options.family) !== record.family)) return callback(Object.assign(new Error('Pinned LAN origin mismatch'), { code: 'ENOTFOUND' }));
    if (options?.all) callback(null, [{ address: record.address, family: record.family }]);
    else callback(null, record.address, record.family);
  };
}

export function createTrustedLanClient(config, route) {
  const url = new URL(route.origin);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.lan.ug.link') || url.username || url.password) throw new Error('Untrusted LAN origin');
  const client = new UgOS({ ...config, server: url.origin, tlsFingerprint: undefined });
  client.httpsAgent.destroy();
  client.httpsAgent = new https.Agent({ keepAlive: true, maxCachedSessions: 0, lookup: pinnedLanLookup(url.hostname, route) });
  return client;
}

async function handshake(client, signal, timeout) {
  const response = await client.open(HANDSHAKE, { auth: false, signal, timeout });
  // Capture before consuming the response: Node may detach response.socket
  // after EOF. This flag must come from a CA-verified TLS socket.
  const authorized = response.socket?.authorized === true;
  const identity = response.headers['x-ugreen-id'];
  let bytes = 0; const chunks = [];
  for await (const chunk of response) { bytes += chunk.length; if (bytes > 65536) { response.destroy(); throw new Error('Handshake too large'); } chunks.push(chunk); }
  const data = JSON.parse(Buffer.concat(chunks).toString());
  // UGOS 1.21 returns code 1010 for this deliberately unauthenticated probe.
  // TLS + the instance header are the pre-auth checks; actual account success
  // is required separately below before this client can become a route.
  if (response.statusCode !== 200 || ![200, 1010].includes(data.code) || !authorized || typeof identity !== 'string' || !identity || identity.length > 512) throw new Error('Handshake not verified');
  return identity;
}

function bounded(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled()); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Selects only official SmartDNS HTTPS LAN routes. It never downgrades TLS,
 * trusts a self-signed certificate, sends a session to a raw IP/HTTP origin,
 * or calls this P2P. No origin/address is persisted by this module.
 */
export async function selectTrustedLan({ relayNas, alias, nodeInfo, timeout = 3000, signal, resolve = host => lookupAddress(host, { all: true }), createClient = createTrustedLanClient, discover = value => cloudRequest('p2p/v2/ta/nodeInfo/byAlias', { alias: value }) }) {
  const controller = new AbortController(); const abort = () => controller.abort();
  const deadline = setTimeout(abort, Math.max(100, Math.min(10000, timeout)));
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const owned = controller.signal; let selected;
  try {
    const relay = new URL(relayNas.config.server);
    if (relay.protocol !== 'https:' || relay.username || relay.password || !relay.hostname.endsWith('.ug.link') || relay.hostname.endsWith('.lan.ug.link') || relay.hostname.split('.')[0].toLowerCase() !== String(alias).toLowerCase()) return failure('UNTRUSTED_RELAY_ORIGIN');
    let discovery = nodeInfo;
    if (!discovery) { const response = await bounded(discover(alias), owned); if (response.code !== 200) return failure('DISCOVERY_UNAVAILABLE'); discovery = response.data; }
    const candidates = smartDnsCandidates(discovery, alias);
    if (!candidates.length) return failure('NO_SMARTDNS_CANDIDATE');
    const expectedIdentity = await bounded(handshake(relayNas, owned, timeout), owned);
    for (const candidate of candidates) {
      let client;
      try {
        const addresses = await bounded(resolve(candidate.hostname), owned);
        // Pin one vetted address so a DNS change between the no-token probe and
        // authenticated request cannot redirect the session somewhere else.
        const record = addresses.filter(a => [4, 6].includes(a.family) && isPrivateLanAddress(a.address)).sort((a, b) => a.family - b.family)[0];
        if (!record) continue;
        const route = { ...candidate, address: record.address, family: record.family };
        client = createClient(relayNas.config, route);
        if (client.config.tlsFingerprint) throw new Error('Private certificate bypass not allowed');
        const actualIdentity = await bounded(handshake(client, owned, timeout), owned);
        if (actualIdentity !== expectedIdentity) throw new Error('NAS identity mismatch');
        // Only now may the real native session reach the candidate. The
        // authenticated NAS must report the selected UGREENlink identity too.
        const info = await bounded(client.request('v1/user/priority_link', { signal: owned, timeout }), owned);
        if (String(info.uglink_id || '').toLowerCase() !== String(alias).toLowerCase()) throw new Error('NAS account identity mismatch');
        if (owned.aborted) throw cancelled();
        selected = client;
        return { client, route, summary: { mode: 'lan-https', verified: true, p2p: false, reason: null }, close() { client.httpsAgent.destroy(); } };
      } catch (error) { client?.httpsAgent.destroy(); if (owned.aborted) throw error; }
    }
    return failure('NO_VERIFIED_LAN');
  } catch { return failure(owned.aborted ? (signal?.aborted ? 'CANCELLED' : 'TIMED_OUT') : 'LAN_VERIFICATION_FAILED'); }
  finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); if (owned.aborted) selected?.httpsAgent.destroy(); }
}
