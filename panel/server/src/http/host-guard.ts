// Host-header allowlist for DNS-rebinding protection.
//
// Background: the panel binds 0.0.0.0:8080 and authenticates with OIDC.
// Without Host-header validation, a malicious site the
// operator visits can use DNS rebinding to point a hostname at the panel's
// LAN/loopback IP and drive every authenticated API from the operator's own
// browser — including the docker.sock-backed management endpoints. The
// `sameSite: 'lax'` cookie does not stop this: after rebinding, the browser
// treats the attacker hostname as same-origin with the panel and includes
// any cookie it issues. The fix is host-allowlisting at the request edge.
//
// Default allowlist (covers documented deploys without operator action):
//   - loopback: localhost / 127.0.0.1 / ::1
//   - RFC1918 private LAN: 10/8, 172.16-31/12, 192.168/16
//   - link-local IPv4: 169.254/16
// Public hostnames (the recommended reverse-proxy deployment) must be added
// via PANEL_ALLOWED_HOSTS=<comma-separated>.

export function parseHost(headerHost: string | undefined): string {
  if (!headerHost) return '';
  const trimmed = headerHost.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close <= 0) return '';
    return trimmed.slice(0, close + 1).toLowerCase();
  }
  const colon = trimmed.lastIndexOf(':');
  const host = colon > 0 ? trimmed.slice(0, colon) : trimmed;
  return host.toLowerCase();
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function normalizeIp(raw: string | undefined): string {
  const ip = String(raw || '').trim();
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

export function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1'
  );
}

export function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = [m[1], m[2], m[3], m[4]].map((s) => Number(s));
  if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  // 10.0.0.0/8
  if (o[0] === 10) return true;
  // 172.16.0.0/12
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  // 192.168.0.0/16
  if (o[0] === 192 && o[1] === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (o[0] === 169 && o[1] === 254) return true;
  return false;
}

export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const lower = part.trim().toLowerCase();
    if (!lower) continue;
    if (lower.includes('*')) throw new Error(`PANEL_ALLOWED_HOSTS 禁止使用通配符：${lower}`);
    if (parseHost(lower) !== lower) throw new Error(`PANEL_ALLOWED_HOSTS 只允许填写不带端口的主机名：${lower}`);
    out.push(lower);
  }
  return [...new Set(out)];
}

export interface TrustedProxy {
  raw: string;
  ip: string;
  cidrBits?: number;
}

function parseIpv4(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map((s) => Number(s));
  if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return (((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;
}

export function parseTrustedProxies(raw: string | undefined): TrustedProxy[] {
  if (!raw) return [];
  const out: TrustedProxy[] = [];
  for (const part of raw.split(',')) {
    const s = normalizeIp(part);
    if (!s) continue;
    const [ip, bitsRaw] = s.split('/');
    const cidrBits = bitsRaw == null || bitsRaw === '' ? undefined : Number(bitsRaw);
    if (parseIpv4(ip) == null && ip !== '::1') throw new Error(`PANEL_TRUSTED_PROXIES 仅支持 IPv4/CIDR 或 ::1：${s}`);
    if (cidrBits != null && (!Number.isInteger(cidrBits) || cidrBits < 0 || cidrBits > 32 || parseIpv4(ip) == null)) {
      throw new Error(`PANEL_TRUSTED_PROXIES CIDR 不合法：${s}`);
    }
    out.push({ raw: s, ip, cidrBits });
  }
  return out;
}

export function isTrustedProxy(remoteAddress: string | undefined, trustedProxies: TrustedProxy[]): boolean {
  const ip = normalizeIp(remoteAddress);
  if (!ip) return false;
  const ip4 = parseIpv4(ip);
  return trustedProxies.some((p) => {
    if (p.cidrBits == null) return p.ip === ip;
    if (ip4 == null) return false;
    const base = parseIpv4(p.ip);
    if (base == null) return false;
    const mask = p.cidrBits === 0 ? 0 : (0xffffffff << (32 - p.cidrBits)) >>> 0;
    return (ip4 & mask) === (base & mask);
  });
}

export function isAllowedHost(host: string, allowlist: string[]): boolean {
  if (!host) return false;
  if (isLoopbackHost(host)) return true;
  if (isPrivateIpv4(host)) return true;
  for (const entry of allowlist) {
    if (entry === host) return true;
  }
  return false;
}

// 反代/CDN（Cloudflare、nginx、Caddy 等）部署时，真实对外域名可能在 X-Forwarded-Host 里，
// 而 Host 被改写成内部地址。只有 TCP 来源命中 PANEL_TRUSTED_PROXIES 时才信任该首部；
// 直连公网请求即使伪造 X-Forwarded-Host 也不会被接受。
export function isRequestHostAllowed(
  hostHeader: string | undefined,
  forwardedHostHeader: string | string[] | undefined,
  allowlist: string[],
  remoteAddress: string | undefined,
  trustedProxies: TrustedProxy[],
): boolean {
  return !!effectiveRequestHost(hostHeader, forwardedHostHeader, allowlist, remoteAddress, trustedProxies);
}

export function effectiveRequestHost(
  hostHeader: string | undefined,
  forwardedHostHeader: string | string[] | undefined,
  allowlist: string[],
  remoteAddress: string | undefined,
  trustedProxies: TrustedProxy[],
): string {
  const xfh = headerValue(forwardedHostHeader);
  if (xfh && isTrustedProxy(remoteAddress, trustedProxies)) {
    const forwarded = parseHost(xfh.split(',')[0]);
    if (isAllowedHost(forwarded, allowlist)) return forwarded;
  }
  const host = parseHost(hostHeader);
  return isAllowedHost(host, allowlist) ? host : '';
}
