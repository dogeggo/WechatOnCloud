import type { FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { isAllowedHost, isTrustedProxy, parseHost, type TrustedProxy } from './host-guard.js';

export interface RequestTrustConfig {
  allowedHosts: string[];
  trustedProxies: TrustedProxy[];
}

export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeIp(ip: string | undefined): string {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') ? s.slice('::ffff:'.length) : s;
}

export function trustedClientIp(
  headers: IncomingMessage['headers'],
  remoteAddress: string | undefined,
  trustedProxies: TrustedProxy[],
): string {
  const remote = normalizeIp(remoteAddress);
  const forwardedFor = firstHeaderValue(headers['x-forwarded-for']);
  if (forwardedFor && isTrustedProxy(remote, trustedProxies)) {
    return normalizeIp(forwardedFor.split(',')[0]);
  }
  return remote || 'unknown';
}

export function clientIp(req: FastifyRequest, trustedProxies: TrustedProxy[]): string {
  return trustedClientIp(req.headers, req.raw.socket.remoteAddress, trustedProxies);
}

export function pathOf(rawUrl: string | undefined): string {
  return (rawUrl || '/').split('?')[0] || '/';
}

function isTrustedForwardSource(remoteAddress: string | undefined, trustedProxies: TrustedProxy[]): boolean {
  return isTrustedProxy(normalizeIp(remoteAddress), trustedProxies);
}

function requestProtocol(
  headers: IncomingMessage['headers'],
  remoteAddress: string | undefined,
  encrypted: boolean,
  trustedProxies: TrustedProxy[],
): 'http' | 'https' {
  if (isTrustedForwardSource(remoteAddress, trustedProxies)) {
    const proto = firstHeaderValue(headers['x-forwarded-proto'])
      ?.split(',')[0]
      ?.trim()
      ?.toLowerCase();
    if (proto === 'http' || proto === 'https') return proto;
  }
  return encrypted ? 'https' : 'http';
}

function normalizeAuthority(raw: string | undefined): string {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || /[\s\0]/.test(value) || value.includes('://') || value.includes('@')) return '';
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close <= 0) return '';
    const rest = value.slice(close + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return '';
    return rest ? `${value.slice(0, close + 1)}:${Number(rest.slice(1))}` : value.slice(0, close + 1);
  }
  const parts = value.split(':');
  if (parts.length > 2) return '';
  if (parts.length === 2) {
    if (!parts[0] || !/^\d{1,5}$/.test(parts[1])) return '';
    return `${parts[0]}:${Number(parts[1])}`;
  }
  return value;
}

function defaultPort(protocol: 'http' | 'https'): number {
  return protocol === 'https' ? 443 : 80;
}

function authorityForOrigin(raw: string | undefined, protocol: 'http' | 'https'): string {
  const authority = normalizeAuthority(raw);
  if (!authority) return '';
  const host = parseHost(authority);
  if (!host) return '';
  const portPart = authority.startsWith('[')
    ? authority.slice(authority.indexOf(']') + 1)
    : authority.slice(host.length);
  if (!portPart) return host;
  const port = Number(portPart.slice(1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
  return port === defaultPort(protocol) ? host : `${host}:${port}`;
}

function allowedAuthorityForOrigin(
  raw: string | undefined,
  protocol: 'http' | 'https',
  allowedHosts: string[],
): string {
  const authority = authorityForOrigin(raw, protocol);
  return authority && isAllowedHost(parseHost(authority), allowedHosts) ? authority : '';
}

export function effectiveRequestOrigin(
  headers: IncomingMessage['headers'],
  remoteAddress: string | undefined,
  encrypted: boolean,
  config: RequestTrustConfig,
): string {
  const protocol = requestProtocol(headers, remoteAddress, encrypted, config.trustedProxies);
  const xfh = firstHeaderValue(headers['x-forwarded-host']);
  if (xfh && isTrustedForwardSource(remoteAddress, config.trustedProxies)) {
    const forwardedAuthority = allowedAuthorityForOrigin(xfh.split(',')[0], protocol, config.allowedHosts);
    if (forwardedAuthority) return `${protocol}://${forwardedAuthority}`;
  }
  const host = allowedAuthorityForOrigin(firstHeaderValue(headers.host), protocol, config.allowedHosts);
  return host ? `${protocol}://${host}` : '';
}

function normalizedOrigin(origin: string | undefined): string {
  if (!origin) return '';
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return '';
  }
}

export function sameOrigin(req: FastifyRequest | IncomingMessage, config: RequestTrustConfig): boolean {
  const headers = req.headers;
  const socket = 'raw' in req ? req.raw.socket : req.socket;
  const expected = effectiveRequestOrigin(headers, socket.remoteAddress, !!(socket as any).encrypted, config);
  return !!expected && normalizedOrigin(firstHeaderValue(headers.origin)) === expected;
}

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}
