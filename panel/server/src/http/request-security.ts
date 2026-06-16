import type { FastifyInstance } from 'fastify';
import type { PanelConfig } from '../config/panel-config.js';
import { RateLimiter } from './rate-limiter.js';
import { isRequestHostAllowed, parseHost } from './host-guard.js';
import { clientIp, pathOf, sameOrigin } from './request-utils.js';
import type { AuthManager } from '../auth/auth-manager.js';

export function registerHostGuard(app: FastifyInstance, config: PanelConfig): void {
  app.addHook('onRequest', async (req, reply) => {
    if (isRequestHostAllowed(
      req.headers.host,
      req.headers['x-forwarded-host'],
      config.allowedHosts,
      req.raw.socket.remoteAddress,
      config.trustedProxies,
    )) {
      return;
    }

    return reply.code(400).send({
      error: 'Host header not allowed',
      host: parseHost(req.headers.host) || null,
      forwardedHost: req.headers['x-forwarded-host'] || null,
      hint: '反代部署请把对外精确域名加入 PANEL_ALLOWED_HOSTS（.env 逗号分隔，不支持通配符），并按需配置 PANEL_TRUSTED_PROXIES，改完用 docker compose up -d 重建容器（不是 restart）使其生效',
    });
  });
}

export function registerRateLimit(app: FastifyInstance, config: PanelConfig): void {
  const limiter = new RateLimiter(config.rateLimit);
  app.addHook('onRequest', async (req, reply) => {
    const result = limiter.consume(pathOf(req.raw.url), clientIp(req, config.trustedProxies));
    if (result.allowed) return;
    reply.header('retry-after', result.retryAfterSec ?? 1);
    return reply.code(429).send({ error: '请求过于频繁，请稍后再试' });
  });
}

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    reply.header('permissions-policy', 'camera=(self), microphone=(self), fullscreen=(self)');
    reply.header(
      'content-security-policy',
      [
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
        "img-src 'self' data: blob: https://*.googleusercontent.com",
        "media-src 'self' blob:",
        "connect-src 'self' ws: wss:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      ].join('; '),
    );
    return payload;
  });
}

export function registerRequestProtection(
  app: FastifyInstance,
  config: PanelConfig,
  auth: AuthManager,
): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req.raw.url);
    if ((path.startsWith('/api/') || path.startsWith('/desktop/')) && isUnsafeMethod(req.method) && !sameOrigin(req, config)) {
      return reply.code(403).send({ error: '请求来源不被允许' });
    }
    if (isProtectedPath(path) && !auth.currentUser(req)) {
      return reply.code(401).send({ error: '未登录' });
    }
  });
}

function isUnsafeMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function isProtectedPath(path: string): boolean {
  if (path.startsWith('/desktop/')) return true;
  if (!path.startsWith('/api/')) return false;
  return path !== '/api/auth/login' && path !== '/api/auth/callback';
}
