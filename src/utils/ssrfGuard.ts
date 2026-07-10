// Shared SSRF guard — ONE source of truth for isBlockedIp / assertSafeUrl / pinnedDispatcher / safeFetch,
// imported by BOTH the Express server (server.ts) and the MCP web-research tools (webResearch.ts). These were
// hand-duplicated before; a NAT64/IPv4-compat fix once landed in only one copy (the drift this consolidates).
// esbuild --bundle inlines this into each standalone bundle, so importing it keeps the MCP bundle self-contained.
import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

// Reject an IP literal that is private / loopback / link-local / CGNAT / NAT64 / IPv4-compatible.
export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 127) return true;                         // loopback
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 169 && b === 254) return true;            // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64.0.0/10
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;                        // loopback / unspecified
    if (lower.startsWith('fe80')) return true;                                // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;        // unique-local
    if (lower.startsWith('::ffff:')) return isBlockedIp(lower.slice(7));       // IPv4-mapped (::ffff:a.b.c.d)
    if (lower.startsWith('64:ff9b:')) { const t = lower.split(':').pop() || ''; return t.includes('.') ? isBlockedIp(t) : true; } // NAT64 64:ff9b::/96
    if (/^::\d+\.\d+\.\d+\.\d+$/.test(lower)) return isBlockedIp(lower.slice(2)); // IPv4-compatible ::a.b.c.d (deprecated)
    return false;
  }
  return true; // not a valid IP literal
}

// Validate the URL and RETURN the validated IP it resolved to, so the caller can pin the connection to
// that exact address (a later independent resolution by fetch can't be DNS-rebound to a private IP).
export async function assertSafeUrl(rawUrl: string): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error('That does not look like a valid URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http and https URLs are allowed.');
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1); // strip FQDN trailing dot so 'localhost.' can't slip past
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('That host is not allowed.');
  // Reject obfuscated numeric hosts (decimal/octal/hex like http://2130706433/) — a real hostname has a letter.
  if (!net.isIP(host) && !/[a-z]/i.test(host)) throw new Error('That host is not allowed.');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(r => r.address);
  if (ips.length === 0 || ips.some(isBlockedIp)) throw new Error('That URL resolves to a private or local address and cannot be fetched.');
  return ips[0]; // every resolved IP passed the block check; pin the connection to this one
}

// A dispatcher that forces the socket to connect to `ip` while the URL hostname still drives TLS SNI / cert
// validation — closing the DNS-rebinding TOCTOU between assertSafeUrl's check and fetch's connect.
export function pinnedDispatcher(ip: string): Agent {
  const family = net.isIP(ip); // 4 | 6
  return new Agent({
    connect: {
      // undici calls this with { all: true } (array form); support the single form too, defensively.
      lookup: (_hostname: string, options: any, cb: any) => {
        if (options && options.all) cb(null, [{ address: ip, family }]);
        else cb(null, ip, family);
      },
    },
  });
}

// Re-validate AND re-pin on every redirect hop, so a public URL can't 30x (or DNS-rebind) into a private
// address after the initial check. Typed against undici's OWN fetch types.
export async function safeFetch(
  initialUrl: string, init: Parameters<typeof undiciFetch>[1], maxHops = 5,
): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
  let url = initialUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    const pinnedIp = await assertSafeUrl(url);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url, { ...init, redirect: 'manual', dispatcher: pinnedDispatcher(pinnedIp), signal: ac.signal as any });
    } finally { clearTimeout(timer); }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      url = new URL(location, url).toString(); // resolve relative redirects
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects while fetching that URL.');
}
