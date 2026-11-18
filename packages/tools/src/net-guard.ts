import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Thrown when a URL is refused by the SSRF guard. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split('.').map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0/24 IETF
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

/**
 * Expand any valid IPv6 literal (already validated by isIP) to its 16 bytes, handling `::`
 * compression and an embedded dotted-decimal IPv4 tail. Returns null if it can't be parsed. This
 * canonicalization is what closes the hex-vs-dotted IPv4-mapped bypass (e.g. `::ffff:a9fe:a9fe`
 * and `::ffff:169.254.169.254` are the SAME address and must classify identically).
 */
function ipv6ToBytes(input: string): number[] | null {
  let ip = input.toLowerCase().split('%')[0] ?? ''; // drop any zone id
  // Convert a trailing embedded IPv4 (dotted) into two hex groups.
  const dot = ip.lastIndexOf('.');
  if (dot !== -1) {
    const lastColon = ip.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = ip.slice(lastColon + 1).split('.').map((x) => Number(x));
    if (v4.length !== 4 || v4.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = v4 as [number, number, number, number];
    ip = `${ip.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const n = Number.parseInt(g, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff || !/^[0-9a-f]{1,4}$/.test(g)) return null;
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isBlockedV6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable → refuse
  const allZeroThrough = (end: number): boolean => b.slice(0, end).every((x) => x === 0);
  // Unspecified :: and loopback ::1 (any notation, e.g. 0:0:0:0:0:0:0:1).
  if (allZeroThrough(16)) return true; // ::
  if (allZeroThrough(15) && b[15] === 1) return true; // ::1
  // IPv4-mapped ::ffff:0:0/96 — classify the embedded IPv4 (regardless of hex/dotted notation).
  if (allZeroThrough(10) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  // IPv4-compatible (deprecated) ::a.b.c.d — embedded IPv4, also classify it.
  if (allZeroThrough(12)) {
    return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0x64 && b[1] === 0xff && b[2] === 0x9b) return true; // 64:ff9b::/96 NAT64 (maps to v4)
  return false; // global unicast
}

/** True if the IP literal is loopback / private / link-local / reserved and must not be fetched. */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedV4(ip);
  if (version === 6) return isBlockedV6(ip);
  return true; // not a valid IP literal → refuse
}

/**
 * SSRF guard: validate a URL is safe to fetch from the server and return the URL plus the exact
 * resolved addresses that were vetted. Restricts the scheme to http(s) and resolves the hostname,
 * refusing if ANY resolved address is loopback/private/link-local/reserved (blocks localhost,
 * RFC1918, 169.254.169.254 cloud metadata, IPv4-mapped IPv6, etc.). Call this on the initial URL
 * AND on every redirect target. The caller should PIN the connection to one of the returned
 * `addresses` (don't re-resolve), otherwise a low-TTL hostname can rebind to an internal IP between
 * this check and connect (DNS rebinding).
 */
export async function assertAllowedUrl(
  raw: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`only http(s) URLs are allowed (got ${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  // Escape hatch for trusted/local use (e.g. fetching an internal service intentionally, or tests).
  // Off by default so the agent's tools fail closed against SSRF.
  if (opts.allowPrivate) return { url, addresses: isIP(host) ? [host] : [] };
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    const resolved = await lookup(host, { all: true }).catch(() => [] as { address: string }[]);
    if (resolved.length === 0) throw new BlockedUrlError(`DNS resolution failed for ${host}`);
    addresses = resolved.map((r) => r.address);
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new BlockedUrlError(`refused to connect to internal address ${address} (${host})`);
    }
  }
  return { url, addresses };
}
