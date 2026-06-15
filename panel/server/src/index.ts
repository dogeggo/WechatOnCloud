import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { loadAuthConfig } from './auth/auth-config.js';
import { AuthManager, type AuthUser } from './auth/auth-manager.js';
import { panelConfig } from './config/panel-config.js';
import { registerDesktopProxy } from './desktop/desktop-proxy.js';
import { httpError, sendError } from './http/http-error.js';
import {
  registerHostGuard,
  registerRateLimit,
  registerRequestProtection,
  registerSecurityHeaders,
} from './http/request-security.js';
import { trustedClientIp } from './http/request-utils.js';
import { gzipQuery, rawUpload, sendBinary } from './http/upload-utils.js';
import { ControlManager } from './instance/control-manager.js';
import { InstanceManager } from './instance/instance-manager.js';
import { initStore } from './instance/store.js';
import { startWatchdog } from './watchdog/watchdog-manager.js';

initStore();

const auth = new AuthManager(
  loadAuthConfig(),
  panelConfig.sessionCookieName,
  panelConfig.flowCookieName,
  panelConfig.trustedProxies,
);
const instances = new InstanceManager(panelConfig.watchdog);
const control = new ControlManager();

const app = Fastify({
  logger: {
    serializers: {
      req(req) {
        const headers = (req as any).headers ?? {};
        const socket = (req as any).socket;
        return {
          method: (req as any).method,
          url: (req as any).url,
          host: (req as any).host ?? headers.host,
          remoteAddress: trustedClientIp(headers, socket?.remoteAddress ?? (req as any).ip, panelConfig.trustedProxies),
          remotePort: socket?.remotePort,
        };
      },
    },
  },
  trustProxy: false,
  bodyLimit: 64 * 1024,
});

registerHostGuard(app, panelConfig);
registerRateLimit(app, panelConfig);

await app.register(cookie);
app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

registerSecurityHeaders(app);
registerRequestProtection(app, panelConfig, auth);

function routeParams(req: FastifyRequest): any {
  return (req.params as any) ?? {};
}

function routeQuery(req: FastifyRequest): any {
  return (req.query as any) ?? {};
}

function routeBody(req: FastifyRequest): any {
  return (req.body as any) ?? {};
}

async function handle(
  reply: FastifyReply,
  action: () => Promise<unknown> | unknown,
  fallbackStatusCode: number,
  fallbackMessage: string,
) {
  try {
    return await action();
  } catch (e) {
    return sendError(reply, e, fallbackStatusCode, fallbackMessage);
  }
}

function requireUser(req: FastifyRequest, reply: FastifyReply): AuthUser | null {
  return auth.requireAuth(req, reply);
}

app.get('/api/auth/login', async (req, reply) => auth.login(req, reply));
app.get('/api/auth/callback', async (req, reply) => auth.callback(req, reply, app.log));
app.post('/api/auth/logout', async (req, reply) => auth.logout(req, reply));
app.get('/api/auth/me', async (req, reply) => auth.me(req, reply));
app.get('/api/admin/sessions', async (req, reply) => auth.currentUserSessions(req, reply));
app.delete('/api/admin/sessions/:id', async (req, reply) => auth.removeCurrentUserSession(req, reply));

app.get('/api/instances', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.listWithStatus(), 500, '读取实例失败');
});

app.post('/api/admin/instances', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const body = routeBody(req);
  return handle(reply, () => instances.createForUser(body.name, user.email, body.reuseVolume, body.appType), 500, '创建实例失败');
});

app.get('/api/admin/orphan-volumes', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.listUnusedVolumes(), 500, '读取数据卷失败');
});

app.get('/api/admin/orphan-containers', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.listUnusedContainers(), 500, '读取容器失败');
});

app.delete('/api/admin/orphan-containers/:idOrName', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.removeUnusedContainer(routeParams(req).idOrName), 500, '删除容器失败');
});

app.delete('/api/admin/orphan-volumes/:name', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.removeUnusedVolume(routeParams(req).name), 500, '删除数据卷失败');
});

app.get('/api/admin/instances/:id/mem-limits', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.memoryLimits(routeParams(req).id), 500, '读取阈值失败');
});

app.put('/api/admin/instances/:id/mem-limits', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.updateMemoryLimits(routeParams(req).id, routeBody(req)), 400, '阈值不合法');
});

app.post('/api/admin/instances/:id/regen-machine-id', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.regenerateMachineId(routeParams(req).id), 400, '重置设备 ID 失败');
});

app.delete('/api/admin/instances/:id', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const id = routeParams(req).id;
  const query = routeQuery(req);
  const purge = query.purge === '1' || query.purge === 'true';
  return handle(reply, async () => {
    const result = await instances.remove(id, purge);
    control.release(String(id));
    return result;
  }, 500, '删除实例失败');
});

app.post('/api/admin/instances/:id/rename', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.rename(routeParams(req).id, routeBody(req).name), 400, '重命名失败');
});

app.post('/api/admin/instances/:id/icon', { bodyLimit: 350 * 1024 }, async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.setIcon(routeParams(req).id, routeBody(req).icon), 400, '设置图标失败');
});

app.post('/api/admin/instances/:id/start', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.start(routeParams(req).id), 500, '启动失败');
});

app.post('/api/admin/instances/:id/stop', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.stop(routeParams(req).id), 500, '停止失败');
});

app.post('/api/admin/instances/:id/restart', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.restart(routeParams(req).id), 500, '重启失败');
});

app.post('/api/admin/instances/:id/upgrade', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.upgrade(routeParams(req).id), 500, '升级失败');
});

app.post('/api/instances/:id/upload', { bodyLimit: panelConfig.upload.transferBytes }, async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => {
    const upload = rawUpload(req, panelConfig.upload.transferBytes);
    return instances.uploadTransferFile(routeParams(req).id, routeQuery(req).name, upload.stream, upload.size);
  }, 400, '上传失败');
});

app.get('/api/instances/:id/files', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.listTransferFiles(routeParams(req).id), 400, '读取文件列表失败');
});

app.delete('/api/instances/:id/files', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.deleteTransferFile(routeParams(req).id, routeQuery(req).name), 400, '删除失败');
});

app.get('/api/instances/:id/download', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, async () => {
    const file = await instances.downloadTransferFile(routeParams(req).id, routeQuery(req).name);
    return sendBinary(reply, file.body, file.filename, 'application/octet-stream');
  }, 400, '下载失败');
});

app.post('/api/instances/:id/control/beat', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  return handle(reply, () => {
    const inst = instances.requireInstance(routeParams(req).id);
    const claim = control.claimForAction(inst.id, user);
    return { mine: claim.ok, holder: claim.holder };
  }, 500, '申请控制失败');
});

app.get('/api/instances/:id/control', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  return handle(reply, () => {
    const inst = instances.requireInstance(routeParams(req).id);
    return control.status(inst.id, user);
  }, 500, '读取控制状态失败');
});

app.post('/api/instances/:id/control/take', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  return handle(reply, () => {
    const inst = instances.requireInstance(routeParams(req).id);
    return control.take(inst.id, user);
  }, 500, '接管失败');
});

app.post('/api/instances/:id/type', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const body = routeBody(req);
  return handle(reply, async () => {
    const inst = instances.requireInstance(routeParams(req).id);
    const claim = control.claimForAction(inst.id, user);
    if (!claim.ok) throw httpError(409, `「${claim.holder}」正在操作，请先申请控制`);
    return instances.typeText(inst.id, body.text, body.submit, body.submitKey);
  }, 500, '输入失败');
});

app.post('/api/instances/:id/key', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const body = routeBody(req);
  return handle(reply, async () => {
    const inst = instances.requireInstance(routeParams(req).id);
    const claim = control.claimForAction(inst.id, user);
    if (!claim.ok) throw httpError(409, `「${claim.holder}」正在操作，请先申请控制`);
    return instances.keyInput(inst.id, body.key);
  }, 500, '按键输入失败');
});

app.get('/api/admin/instances/:id/logs', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  try {
    const text = await instances.logs(routeParams(req).id);
    reply.header('content-type', 'text/plain; charset=utf-8');
    return reply.send(text || '（暂无日志）');
  } catch (e: any) {
    reply.header('content-type', 'text/plain; charset=utf-8');
    return reply.code(500).send('获取日志失败：' + (e?.message || e));
  }
});

app.get('/api/admin/instances/:id/volume', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.listVolume(routeParams(req).id, routeQuery(req).path), 400, '读取目录失败');
});

app.post('/api/admin/instances/:id/volume/mkdir', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.mkdirVolume(routeParams(req).id, routeBody(req).path), 400, '新建失败');
});

app.post('/api/admin/instances/:id/volume/move', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const body = routeBody(req);
  return handle(reply, () => instances.moveVolume(routeParams(req).id, body.from, body.to), 400, '移动失败');
});

app.delete('/api/admin/instances/:id/volume', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.deleteVolumePath(routeParams(req).id, routeQuery(req).path), 400, '删除失败');
});

app.get('/api/admin/instances/:id/volume/download', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, async () => {
    const file = await instances.downloadVolumeFile(routeParams(req).id, routeQuery(req).path);
    return sendBinary(reply, file.body, file.filename, 'application/octet-stream');
  }, 400, '下载失败');
});

app.post('/api/admin/instances/:id/volume/upload', { bodyLimit: panelConfig.upload.volumeFileBytes }, async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => {
    const upload = rawUpload(req, panelConfig.upload.volumeFileBytes);
    return instances.uploadVolumeFile(routeParams(req).id, routeQuery(req).path, routeQuery(req).name, upload.stream, upload.size);
  }, 400, '上传失败');
});

app.post('/api/admin/instances/:id/volume/extract', { bodyLimit: panelConfig.upload.volumeArchiveBytes }, async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => {
    const upload = rawUpload(req, panelConfig.upload.volumeArchiveBytes);
    return instances.extractVolumeArchive(
      routeParams(req).id,
      routeQuery(req).path,
      upload.stream,
      gzipQuery(req),
      panelConfig.upload.volumeArchiveExtractedBytes,
    );
  }, 400, '解压失败（请确认是 .tar 或 .tar.gz）');
});

app.get('/api/admin/instances/:id/volume/backup', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, async () => {
    const file = await instances.backupVolume(routeParams(req).id);
    return sendBinary(reply, file.body, file.filename, 'application/gzip');
  }, 500, '备份失败');
});

app.post('/api/admin/instances/:id/volume/restore', { bodyLimit: panelConfig.upload.volumeArchiveBytes }, async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => {
    const upload = rawUpload(req, panelConfig.upload.volumeArchiveBytes);
    return instances.restoreVolume(
      routeParams(req).id,
      upload.stream,
      gzipQuery(req),
      panelConfig.upload.volumeArchiveExtractedBytes,
    );
  }, 400, '恢复失败');
});

app.get('/api/instances/:id/app/status', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.getAppStatus(routeParams(req).id), 500, '读取应用状态失败');
});

app.post('/api/admin/instances/:id/app/install', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.triggerAppInstall(routeParams(req).id, 'install'), 500, '无法触发安装');
});

app.post('/api/admin/instances/:id/app/update', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  return handle(reply, () => instances.triggerAppInstall(routeParams(req).id, 'update'), 500, '无法触发更新');
});

registerDesktopProxy(app, auth, panelConfig);

await app.register(fstatic, { root: panelConfig.staticDir, wildcard: false, index: ['index.html'] });
app.setNotFoundHandler((req, reply) => {
  const url = req.raw.url || '';
  if (url.startsWith('/api') || url.startsWith('/desktop')) {
    return reply.code(404).send({ error: 'not found' });
  }
  return reply.sendFile('index.html');
});

await app.ready();
await instances.ensureNetwork();
await instances.startRegisteredInstances(app.log);
startWatchdog(panelConfig.watchdog, instances, control, app.log);

await app.listen({ port: panelConfig.port, host: panelConfig.host });
app.log.info(`[panel] 监听 http://${panelConfig.host}:${panelConfig.port}  （多实例反代已就绪）`);
