import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import httpProxy from 'http-proxy';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { AuthManager } from '../auth/auth-manager.js';
import { instanceTarget } from '../docker/docker.js';
import { isRequestHostAllowed } from '../http/host-guard.js';
import { firstHeaderValue, isHttpsRequest, sameOrigin, type RequestTrustConfig } from '../http/request-utils.js';
import { canAccessInstance, findInstance, type Instance } from '../instance/store.js';
import type { NotificationManager } from '../notification/notification-manager.js';
import type { DesktopClientManager } from './desktop-client-manager.js';

interface DesktopUrl {
  id: string;
  rest: string;
}

const DESKTOP_STATIC_CACHE_CONTROL = 'public, max-age=604800';
const DESKTOP_COMPRESSIBLE_ASSET_RE = /\.(?:css|html|js|json|map|mjs|svg|txt|wasm)$/i;

export function registerDesktopProxy(
  app: FastifyInstance,
  auth: AuthManager,
  trustConfig: RequestTrustConfig,
  desktopClients: DesktopClientManager,
  notifications: NotificationManager,
): void {
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });
  const staticProxy = httpProxy.createProxyServer({ changeOrigin: true, selfHandleResponse: true });
  const forwardAuth = (proxyReq: { setHeader(name: string, value: string): void }, req: IncomingMessage) => {
    const basic = (req as any)._wocAuth;
    if (basic) proxyReq.setHeader('authorization', basic);
  };
  proxy.on('proxyReq', (proxyReq, req) => forwardAuth(proxyReq, req));
  proxy.on('proxyReqWs', (proxyReq, req) => forwardAuth(proxyReq, req));
  proxy.on('proxyRes', (proxyRes) => {
    delete proxyRes.headers['www-authenticate'];
  });
  staticProxy.on('proxyReq', (proxyReq, req) => forwardAuth(proxyReq, req));
  staticProxy.on('proxyRes', (proxyRes, req, res) => {
    handleDesktopStaticProxyResponse(proxyRes, req, res as ServerResponse);
  });
  const onProxyError = (_err: Error, _req: IncomingMessage, res: ServerResponse | Socket) => {
    try {
      const reply = res as any;
      if (reply && typeof reply.writeHead === 'function') {
        reply.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        reply.end('桌面服务暂时不可用');
      } else if (reply && typeof reply.destroy === 'function') {
        reply.destroy();
      }
    } catch {
      /* ignore */
    }
  };
  proxy.on('error', onProxyError);
  staticProxy.on('error', onProxyError);

  const desktopHandler = (req: FastifyRequest, reply: FastifyReply) => {
    const user = auth.currentUser(req);
    if (!user) {
      reply.code(302).header('location', '/login').send();
      return;
    }
    const parsed = parseDesktopUrl(req.raw.url || '');
    if (!parsed) {
      reply.code(404).send({ error: '实例不存在' });
      return;
    }
    const inst = findInstance(parsed.id);
    if (!inst || !canAccessInstance(inst, user)) {
      reply.code(404).send({ error: '实例不存在' });
      return;
    }
    reply.hijack();
    req.raw.url = parsed.rest;
    (req.raw as any)._wocAuth = basicAuth(inst);
    const selectedProxy = isCacheableDesktopStaticAsset(parsed.rest) ? staticProxy : proxy;
    selectedProxy.web(req.raw, reply.raw, { target: instanceTarget(inst) });
  };

  app.all('/desktop/:id', desktopHandler);
  app.all('/desktop/:id/*', desktopHandler);

  app.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    try {
      handleUpgrade(req, socket, head, proxy, auth, trustConfig, desktopClients, notifications, app.log);
    } catch (e: any) {
      app.log.warn(`[upgrade] rejected malformed upgrade request: ${e?.message || e}`);
      socket.destroy();
    }
  });
}

function handleUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  proxy: httpProxy,
  auth: AuthManager,
  trustConfig: RequestTrustConfig,
  desktopClients: DesktopClientManager,
  notifications: NotificationManager,
  log: FastifyInstance['log'],
): void {
  if (!isRequestHostAllowed(
    firstHeaderValue(req.headers.host),
    req.headers['x-forwarded-host'],
    trustConfig.allowedHosts,
    req.socket.remoteAddress,
    trustConfig.trustedProxies,
  ) || !isHttpsRequest(req, trustConfig) || !sameOrigin(req, trustConfig)) {
    socket.destroy();
    return;
  }

  const parsed = req.url ? parseDesktopUrl(req.url) : null;
  if (!parsed) {
    socket.destroy();
    return;
  }
  const session = auth.rawSession(req);
  const inst = findInstance(parsed.id);
  if (!session?.user || !inst || !canAccessInstance(inst, session.user)) {
    socket.destroy();
    return;
  }

  const prepared = prepareDesktopSocketRest(parsed.rest);
  if (!prepared) {
    socket.destroy();
    return;
  }

  req.url = prepared.rest;
  (req as any)._wocAuth = basicAuth(inst);
  if (
    prepared.clientId &&
    !desktopClients.register({
      inst,
      clientId: prepared.clientId,
      browserClientId: prepared.browserClientId,
      socket,
      notifications,
      log,
    })
  ) {
    return;
  }
  auth.trackSessionSocket(session.id, socket);
  proxy.ws(req, socket, head, { target: instanceTarget(inst) });
}

function parseDesktopUrl(rawUrl: string): DesktopUrl | null {
  const match = rawUrl.match(/^\/desktop\/([0-9a-f]{10})(\/.*|\?.*|)?$/);
  if (!match) return null;
  let rest = match[2] || '/';
  if (rest.startsWith('?')) rest = '/' + rest;
  if (rest === '') rest = '/';
  return { id: match[1], rest };
}

function basicAuth(inst: Instance): string {
  return 'Basic ' + Buffer.from(`${inst.kasmUser}:${inst.kasmPassword}`).toString('base64');
}

function handleDesktopStaticProxyResponse(proxyRes: IncomingMessage, req: IncomingMessage, res: ServerResponse): void {
  const statusCode = proxyRes.statusCode ?? 502;
  const headers: OutgoingHttpHeaders = { ...proxyRes.headers };
  delete headers['www-authenticate'];
  headers['cache-control'] = DESKTOP_STATIC_CACHE_CONTROL;
  headers.vary = appendVary(headers.vary, 'Accept-Encoding');

  const noBody = req.method === 'HEAD' || statusCode === 204 || statusCode === 304;
  const gzip = !noBody && shouldGzipDesktopStaticAsset(req, proxyRes);
  if (gzip) {
    delete headers['content-length'];
    headers['content-encoding'] = 'gzip';
  }

  if (proxyRes.statusMessage) {
    res.writeHead(statusCode, proxyRes.statusMessage, headers);
  } else {
    res.writeHead(statusCode, headers);
  }

  if (noBody) {
    proxyRes.resume();
    res.end();
    return;
  }

  if (gzip) {
    pipeline(proxyRes, createGzip({ level: 6 }), res, (err) => {
      if (err) res.destroy(err);
    });
    return;
  }

  pipeline(proxyRes, res, (err) => {
    if (err) res.destroy(err);
  });
}

function shouldGzipDesktopStaticAsset(req: IncomingMessage, proxyRes: IncomingMessage): boolean {
  if (proxyRes.headers['content-encoding']) return false;
  if (!acceptsGzip(req)) return false;

  const contentType = firstHeaderValue(proxyRes.headers['content-type']) || '';
  if (/^(application\/(?:javascript|json|wasm)|image\/svg\+xml|text\/)/i.test(contentType)) return true;

  const pathname = requestPathname(req.url || '');
  return DESKTOP_COMPRESSIBLE_ASSET_RE.test(pathname);
}

function acceptsGzip(req: IncomingMessage): boolean {
  return /\bgzip\b/i.test(firstHeaderValue(req.headers['accept-encoding']) || '');
}

function appendVary(value: OutgoingHttpHeaders['vary'], header: string): string {
  const current = Array.isArray(value) ? value.join(', ') : String(value || '');
  const parts = current.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.some((part) => part.toLowerCase() === header.toLowerCase())) return current || header;
  return parts.length ? `${current}, ${header}` : header;
}

function isCacheableDesktopStaticAsset(rest: string): boolean {
  const pathname = requestPathname(rest);
  return pathname.startsWith('/vnc/dist/') && !pathname.endsWith('/');
}

function requestPathname(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'http://woc.local').pathname;
  } catch {
    return '';
  }
}

const DESKTOP_CLIENT_ID_RE = /^[0-9a-f]{32}$/;

interface PreparedDesktopSocketRest {
  rest: string;
  clientId: string | null;
  browserClientId: string;
}

function prepareDesktopSocketRest(rest: string): PreparedDesktopSocketRest | null {
  try {
    const url = new URL(rest, 'http://woc.local');
    const pathname = url.pathname || '/';
    const isDesktopClient = pathname === '/websockify' || pathname === '/websockify/';
    const clientId = url.searchParams.get('wocClient') || '';
    const browserClientId = url.searchParams.get('wocBrowserClient') || '';
    url.searchParams.delete('wocClient');
    url.searchParams.delete('wocBrowserClient');
    const cleanedRest = `${pathname}${url.search}`;

    if (!isDesktopClient) return { rest: cleanedRest, clientId: null, browserClientId: '' };
    if (!DESKTOP_CLIENT_ID_RE.test(clientId)) return null;
    if (!DESKTOP_CLIENT_ID_RE.test(browserClientId)) return null;
    return { rest: cleanedRest, clientId, browserClientId };
  } catch {
    return null;
  }
}
