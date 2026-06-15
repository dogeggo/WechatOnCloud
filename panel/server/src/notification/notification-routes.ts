import type { FastifyInstance } from 'fastify';
import type { AuthManager } from '../auth/auth-manager.js';
import { sendError } from '../http/http-error.js';
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
    if (!auth.requireAuth(req, reply)) return;
    notifications.openStream(req, reply);
  });

  app.post('/_woc/internal/instances/:id/notifications', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    try {
      const inst = instances.requireInstance(routeParams(req).id);
      notifications.receive(inst, firstHeaderValue(req.headers.authorization), routeBody(req));
      return { ok: true };
    } catch (e) {
      return sendError(reply, e, 400, '通知上报失败');
    }
  });
}
