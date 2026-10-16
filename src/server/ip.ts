// Client address resolution for per-address limits.

import type { IncomingMessage } from 'node:http';
import { isIPv6 } from 'node:net';

/**
 * The client's address. With `trustProxyHops` = 0 (default) the socket peer is used. Behind N
 * trusted reverse proxies (TRUST_PROXY=N) the client is the N-th entry from the right of
 * X-Forwarded-For: entries further left are client-supplied and could be spoofed.
 */
export function clientAddress(req: IncomingMessage, trustProxyHops: number): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (trustProxyHops <= 0) return peer;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return peer;
  const hops = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (hops.length === 0) return peer;
  return hops[Math.max(0, hops.length - trustProxyHops)];
}

/** Expand an IPv6 address to its 8 hextets (no zone id, IPv4 tail converted). */
function expandIPv6(addr: string): string[] | null {
  let a = addr.split('%')[0].toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const n = v4.slice(1).map(Number);
    a = a.slice(0, v4.index) + `${((n[0] << 8) | n[1]).toString(16)}:${((n[2] << 8) | n[3]).toString(16)}`;
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (tail === undefined && h.length !== 8) return null;
  const fill = 8 - h.length - t.length;
  if (fill < 0) return null;
  return [...h, ...new Array<string>(tail === undefined ? 0 : fill).fill('0'), ...t];
}

/**
 * Key used for per-address limits: IPv4 addresses as-is (IPv4-mapped IPv6 unwrapped); IPv6
 * addresses by their /64 prefix, since one subscriber usually controls a whole /64.
 */
export function addressKey(addr: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return mapped[1];
  if (!isIPv6(addr)) return addr;
  const parts = expandIPv6(addr);
  if (!parts) return addr;
  return `${parts.slice(0, 4).map((p) => parseInt(p, 16).toString(16)).join(':')}::/64`;
}
