import type { FastifyInstance } from 'fastify';
import type { AuthManager } from '../auth/auth-manager.js';
import { HttpError, sendError } from '../http/http-error.js';
import { firstHeaderValue } from '../http/request-utils.js';
import type { DesktopClientManager } from '../desktop/desktop-client-manager.js';
import type { InstanceManager } from '../instance/instance-manager.js';
import type { NotificationManager } from './notification-manager.js';

function routeParams(req: any): any {
  return req.params ?? {};
}

function routeBody(req: any): any {
  return req.body ?? {};
}

function routeQuery(req: any): any {
  return req.query ?? {};
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  auth: AuthManager,
  instances: InstanceManager,
  desktopClients: DesktopClientManager,
  notifications: NotificationManager,
): void {
  app.get('/api/notifications/stream', (req, reply) => {
    const user = auth.requireAuth(req, reply);
    if (!user) return;
    const query = routeQuery(req);
    notifications.openStream(req, reply, user, {
      externalLinksEnabled: query.externalLinks === '1' || query.externalLinks === 'true',
      browserClientId: normalizeBrowserClientId(query.browserClient),
    });
  });

  app.post('/_woc/internal/instances/:id/notifications', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    try {
      const inst = instances.requireInstance(routeParams(req).id);
      notifications.receive(inst, firstHeaderValue(req.headers.authorization), routeBody(req));
      return { ok: true };
    } catch (e) {
      if (isInternalAuthError(e)) {
        return reply.code(401).send({ error: '通知上报密钥不正确' });
      }
      return sendError(reply, e, 400, '通知上报失败');
    }
  });

  app.post('/_woc/internal/instances/:id/external-links', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    try {
      const inst = instances.requireInstance(routeParams(req).id);
      const result = notifications.receiveExternalLink(
        inst,
        firstHeaderValue(req.headers.authorization),
        routeBody(req),
        desktopClients.activeBrowserClientId(inst.id),
      );
      return { ok: true, accepted: result.accepted };
    } catch (e) {
      if (isInternalAuthError(e)) {
        return reply.code(401).send({ error: '外链上报密钥不正确' });
      }
      return sendError(reply, e, 400, '外链上报失败');
    }
  });
}

const BROWSER_CLIENT_ID_RE = /^[0-9a-f]{32}$/;

function normalizeBrowserClientId(value: unknown): string {
  const id = String(value || '');
  return BROWSER_CLIENT_ID_RE.test(id) ? id : '';
}

function isInternalAuthError(error: unknown): boolean {
  return error instanceof HttpError && (error.statusCode === 401 || error.statusCode === 404);
}
