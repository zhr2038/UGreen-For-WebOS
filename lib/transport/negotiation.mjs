import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

const KNOWN_TUNNELS = new Set(['uglinkAgent', 'guanglian', 'peergine', 'tutk']);
export function normalizeNegotiation(data) {
  if (!data || typeof data !== 'object' || !data.tunnel || typeof data.tunnel !== 'object') throw new Error('NAS 未返回连接协商信息');
  const type = String(data.tunnel.tunnelType || '');
  const supported = Array.isArray(data.supportTunnels) ? data.supportTunnels.filter(t => typeof t === 'string' && KNOWN_TUNNELS.has(t)) : [];
  return {
    type, knownType: KNOWN_TUNNELS.has(type), online: Number(data.tunnel.tunnelStatus) === 1,
    supportedTypes: supported, hasAgentConfig: Boolean(data.agent && typeof data.agent === 'object'),
    // Kept inside the transport layer. Never serialize this object to the UI.
    privateConfig: { tunnel: data.tunnel, agent: data.agent || null, glConfig: data.glConfig || null, pgConfig: data.pgConfig || null, token: data.token },
  };
}

export async function negotiateTransport(nas, { clientVersion = '1.21.0', signal } = {}) {
  return normalizeNegotiation(await nas.request('v1/connect/uglink/glinfo', { query: { clientVersion }, signal }));
}

export function isGlobalIpv6(address) {
  const value = String(address || '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (isIP(value) !== 6 || value === '::' || value === '::1' || value.startsWith('::ffff:')) return false;
  let canonical = value;
  try { canonical = new URL(`http://[${value}]`).hostname.slice(1, -1); } catch { return false; }
  // Current globally-routable unicast addresses are 2000::/3. Documentation
  // (2001:db8::/32), Teredo (2001::/32), Benchmarking (2001:2::/48) and 6to4
  // (2002::/16) prefixes are excluded.
  if (!/^[23]/.test(canonical)) return false;
  if (/^2001:(?:0?db8|0?:|2(?::|$)|1[0-9a-f](?::|$))/i.test(canonical) || /^2002(?::|$)/i.test(canonical)) return false;
  return true;
}

export function networkReadiness({ interfaces = networkInterfaces(), nasIpv6 = [] } = {}) {
  const addresses = Object.values(interfaces).flat().filter(Boolean);
  return {
    clientPublicIpv6: addresses.some(a => !a.internal && isGlobalIpv6(a.address)),
    nasPublicIpv6: nasIpv6.some(isGlobalIpv6),
    // These are prerequisites for the documented IPv6 path, not evidence of
    // a proprietary UDP/QUIC hole-punch or an established P2P data channel.
    nativeP2pEstablished: false,
  };
}

export function safeNegotiationSummary(info) {
  return { type: info.knownType ? info.type : 'unknown', knownType: info.knownType, online: info.online, supportedTypes: [...info.supportedTypes], hasAgentConfig: info.hasAgentConfig };
}

export function validateRelayOrigin(origin, alias) {
  const url = new URL(origin);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !host.endsWith('.ug.link') || host.endsWith('.lan.ug.link') || host.split('.')[0] !== String(alias).toLowerCase()) throw new Error('无效的 UGREENlink 中继地址');
  return url.origin;
}
