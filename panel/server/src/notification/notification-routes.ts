import type { FastifyInstance } from 'fastify';
import type { AuthManager } from '../auth/auth-manager.js';
import { HttpError, sendError } from '../http/http-error.js';
import { firstHeaderValue } from '../http/request-utils.js';
import type { InstanceManager } from '../instance/instance-manager.js';
import type { NotificationManager } from './notification-manager.js';

function routeParams(req: any): any {
  return req.params ?? {};
}

function routeBody(req: any): any {
  return req.body ?? {};
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  auth: AuthManager,
  instances: InstanceManager,
  notifications: NotificationManager,
): void {
  app.get('/api/notifications/stream', (req, reply) => {
    const user = auth.requireAuth(req, reply);
    if (!user) return;
    notifications.openStream(req, reply, user);
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
}

function isInternalAuthError(error: unknown): boolean {
  return error instanceof HttpError && (error.statusCode === 401 || error.statusCode === 404);
}
