import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import httpProxy from 'http-proxy';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { AuthManager } from '../auth/auth-manager.js';
import { instanceTarget } from '../docker/docker.js';
import { isRequestHostAllowed } from '../http/host-guard.js';
import { firstHeaderValue, sameOrigin, type RequestTrustConfig } from '../http/request-utils.js';
import { findInstance, type Instance } from '../instance/store.js';

interface DesktopUrl {
  id: string;
  rest: string;
}

export function registerDesktopProxy(
  app: FastifyInstance,
  auth: AuthManager,
  trustConfig: RequestTrustConfig,
): void {
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });
  proxy.on('proxyReq', (proxyReq, req) => {
    const basic = (req as any)._wocAuth;
    if (basic) proxyReq.setHeader('authorization', basic);
  });
  proxy.on('proxyReqWs', (proxyReq, req) => {
    const basic = (req as any)._wocAuth;
    if (basic) proxyReq.setHeader('authorization', basic);
  });
  proxy.on('proxyRes', (proxyRes) => {
    delete proxyRes.headers['www-authenticate'];
  });
  proxy.on('error', (_err, _req, res) => {
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
  });

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
    if (!inst) {
      reply.code(404).send({ error: '实例不存在' });
      return;
    }
    reply.hijack();
    req.raw.url = parsed.rest;
    (req.raw as any)._wocAuth = basicAuth(inst);
    proxy.web(req.raw, reply.raw, { target: instanceTarget(inst) });
  };

  app.all('/desktop/:id', desktopHandler);
  app.all('/desktop/:id/*', desktopHandler);

  app.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    try {
      handleUpgrade(req, socket, head, proxy, auth, trustConfig);
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
): void {
  if (!isRequestHostAllowed(
    firstHeaderValue(req.headers.host),
    req.headers['x-forwarded-host'],
    trustConfig.allowedHosts,
    req.socket.remoteAddress,
    trustConfig.trustedProxies,
  ) || !sameOrigin(req, trustConfig)) {
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
  if (!session?.user || !inst) {
    socket.destroy();
    return;
  }
  req.url = parsed.rest;
  (req as any)._wocAuth = basicAuth(inst);
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
