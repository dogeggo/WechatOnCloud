import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import httpProxy from 'http-proxy';
import * as oidc from 'openid-client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import {
  initStore,
  listInstances,
  findInstance,
  setInstanceMemLimits,
  createInstance,
  removeInstance as removeInstanceRecord,
  renameInstance,
  publicInstance,
  type Instance,
} from './store.js';
import {
  ensureNetwork,
  ensureRunning,
  runInstance,
  stopInstance,
  upgradeInstance,
  removeInstance as removeInstanceContainer,
  instanceRuntime,
  triggerWechat,
  wechatStatus,
  instanceTarget,
  uploadToInstance,
  listInstanceFiles,
  downloadFromInstance,
  deleteInstanceFile,
  instanceLogs,
  typeInInstance,
  listOrphanVolumes,
  removeVolume,
  listOrphanContainers,
  removeContainerById,
  instanceMemoryMB,
  instanceHttpHealthy,
  regenInstanceMachineId,
  listVolume,
  volMkdir,
  volMove,
  volDelete,
  volUploadFile,
  volExtractArchive,
  volDownloadFile,
  volBackupStream,
  volRestoreArchive,
} from './docker.js';
import {
  createLoginFlow,
  createSession,
  consumeLoginFlow,
  destroySession,
  destroySessionById,
  findSessionById,
  listSessions,
  touchSession,
  type AuthUser,
} from './sessions.js';
import {
  isAllowedHost,
  isRequestHostAllowed,
  isTrustedProxy,
  parseAllowedHosts,
  parseHost,
  parseTrustedProxies,
} from './host-guard.js';
import { isEmailAllowed, loadAuthConfig } from './auth-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = process.env.STATIC_DIR || join(__dirname, '../../web/dist');
const COOKIE = 'woc_sess';
// Public hostnames the panel will accept Host headers for, in addition to the
// always-on loopback + RFC1918 LAN allowlist. Required for HTTPS reverse-proxy
// deploys (Caddy/nginx/飞牛 内置反代) where the public hostname differs from
// the LAN IP. See .env.example.
const ALLOWED_HOSTS = parseAllowedHosts(process.env.PANEL_ALLOWED_HOSTS);
const TRUSTED_PROXIES = parseTrustedProxies(process.env.PANEL_TRUSTED_PROXIES);
const FLOW_COOKIE = 'woc_oidc';
const authConfig = loadAuthConfig();
let oidcConfigPromise: Promise<oidc.Configuration> | null = null;

const MiB = 1024 * 1024;
function envInt(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === '' ? defaultValue : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 之间的整数`);
  }
  return n;
}
const MAX_TRANSFER_UPLOAD_BYTES = envInt('PANEL_MAX_TRANSFER_UPLOAD_MB', 128, 1, 512) * MiB;
const MAX_VOLUME_FILE_UPLOAD_BYTES = envInt('PANEL_MAX_VOLUME_FILE_UPLOAD_MB', 256, 1, 1024) * MiB;
const MAX_VOLUME_ARCHIVE_UPLOAD_BYTES = envInt('PANEL_MAX_VOLUME_ARCHIVE_UPLOAD_MB', 512, 1, 3072) * MiB;
const MAX_VOLUME_ARCHIVE_EXTRACTED_BYTES = envInt('PANEL_MAX_VOLUME_ARCHIVE_EXTRACTED_MB', 1024, 1, 8192) * MiB;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_API_PER_MIN = envInt('PANEL_RATE_LIMIT_API_PER_MIN', 600, 10, 10000);
const RATE_LIMIT_AUTH_PER_MIN = envInt('PANEL_RATE_LIMIT_AUTH_PER_MIN', 30, 5, 1000);
const sessionSockets = new Map<string, Set<Socket>>();

function firstHeaderValue(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function normalizeIp(ip: string | undefined): string {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') ? s.slice('::ffff:'.length) : s;
}

function trustedClientIp(headers: IncomingMessage['headers'], remoteAddress: string | undefined): string {
  const remote = normalizeIp(remoteAddress);
  const forwardedFor = firstHeaderValue(headers['x-forwarded-for']);
  if (forwardedFor && isTrustedProxy(remote, TRUSTED_PROXIES)) return normalizeIp(forwardedFor.split(',')[0]);
  return remote || 'unknown';
}

function isTrustedForwardSource(remoteAddress: string | undefined): boolean {
  return isTrustedProxy(normalizeIp(remoteAddress), TRUSTED_PROXIES);
}

function requestProtocol(headers: IncomingMessage['headers'], remoteAddress: string | undefined, encrypted: boolean): 'http' | 'https' {
  if (isTrustedForwardSource(remoteAddress)) {
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

function allowedAuthorityForOrigin(raw: string | undefined, protocol: 'http' | 'https'): string {
  const authority = authorityForOrigin(raw, protocol);
  return authority && isAllowedHost(parseHost(authority), ALLOWED_HOSTS) ? authority : '';
}

function effectiveRequestOrigin(
  headers: IncomingMessage['headers'],
  remoteAddress: string | undefined,
  encrypted = false,
): string {
  const protocol = requestProtocol(headers, remoteAddress, encrypted);
  const xfh = firstHeaderValue(headers['x-forwarded-host']);
  if (xfh && isTrustedForwardSource(remoteAddress)) {
    const forwardedAuthority = allowedAuthorityForOrigin(xfh.split(',')[0], protocol);
    if (forwardedAuthority) return `${protocol}://${forwardedAuthority}`;
  }
  const host = allowedAuthorityForOrigin(firstHeaderValue(headers.host), protocol);
  return host ? `${protocol}://${host}` : '';
}

function basicAuth(inst: Instance) {
  return 'Basic ' + Buffer.from(`${inst.kasmUser}:${inst.kasmPassword}`).toString('base64');
}

initStore();

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
          remoteAddress: trustedClientIp(headers, socket?.remoteAddress ?? (req as any).ip),
          remotePort: socket?.remotePort,
        };
      },
    },
  },
  trustProxy: false,
  bodyLimit: 64 * 1024,
});

// DNS-rebinding gate: reject requests whose Host header is neither a loopback /
// RFC1918 LAN address nor in PANEL_ALLOWED_HOSTS. Runs before every route so
// /api/*, /desktop/* and static-file responses are all covered.
app.addHook('onRequest', async (req, reply) => {
  if (!isRequestHostAllowed(
    req.headers.host,
    req.headers['x-forwarded-host'],
    ALLOWED_HOSTS,
    req.raw.socket.remoteAddress,
    TRUSTED_PROXIES,
  )) {
    // 把被拒的 Host / X-Forwarded-Host 一起回显，反代调试时可一眼看出"后端实际收到的是什么"
    // —— 决定是去白名单加这个 host，还是修反代让它透传 Host。不泄露敏感信息。
    return reply.code(400).send({
      error: 'Host header not allowed',
      host: parseHost(req.headers.host) || null,
      forwardedHost: req.headers['x-forwarded-host'] || null,
      hint: '反代部署请把对外精确域名加入 PANEL_ALLOWED_HOSTS（.env 逗号分隔，不支持通配符），并按需配置 PANEL_TRUSTED_PROXIES，改完用 docker compose up -d 重建容器（不是 restart）使其生效',
    });
  }
});

interface RateBucket {
  start: number;
  count: number;
}
const rateBuckets = new Map<string, RateBucket>();

function pathOf(rawUrl: string | undefined): string {
  return (rawUrl || '/').split('?')[0] || '/';
}

function clientIp(req: FastifyRequest): string {
  return trustedClientIp(req.headers, req.raw.socket.remoteAddress);
}

function rateLimitGroup(path: string): 'auth' | 'api' | null {
  if (path.startsWith('/api/auth/')) return 'auth';
  if (path.startsWith('/api/') || path.startsWith('/desktop/')) return 'api';
  return null;
}

app.addHook('onRequest', async (req, reply) => {
  const group = rateLimitGroup(pathOf(req.raw.url));
  if (!group) return;
  const limit = group === 'auth' ? RATE_LIMIT_AUTH_PER_MIN : RATE_LIMIT_API_PER_MIN;
  const key = `${group}:${clientIp(req)}`;
  const now = Date.now();
  if (rateBuckets.size > 10_000) {
    for (const [k, b] of rateBuckets) {
      if (now - b.start >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k);
    }
  }
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { start: now, count: 1 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    reply.header('retry-after', Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.start)) / 1000));
    return reply.code(429).send({ error: '请求过于频繁，请稍后再试' });
  }
});

await app.register(cookie);
// 文件上传走原始二进制流（前端以 application/octet-stream 直传 File）
app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

// ---------- 鉴权辅助 ----------
function requestSessionMeta(req: FastifyRequest) {
  return {
    ip: clientIp(req),
    userAgent: firstHeaderValue(req.headers['user-agent']),
  };
}

function currentSession(req: FastifyRequest) {
  return touchSession(req.cookies?.[COOKIE], requestSessionMeta(req));
}

function currentUser(req: FastifyRequest): AuthUser | null {
  return currentSession(req)?.user ?? null;
}

function requireAuth(req: FastifyRequest, reply: FastifyReply): AuthUser | null {
  const u = currentUser(req);
  if (!u) {
    reply.code(401).send({ error: '未登录' });
    return null;
  }
  return u;
}

function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
    secure: authConfig.oidc.cookieSecure,
  };
}

function flowCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/api/auth',
    maxAge,
    secure: authConfig.oidc.cookieSecure,
  };
}

function clearCookieOptions(path: string) {
  return {
    sameSite: 'lax' as const,
    path,
    secure: authConfig.oidc.cookieSecure,
  };
}

function normalizeReturnTo(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || !s.startsWith('/') || s.startsWith('//') || s.startsWith('/api/')) return '/';
  return s;
}

function loginError(reply: FastifyReply, message: string) {
  const url = new URL('/login', 'http://woc.local');
  url.searchParams.set('error', message);
  return reply.redirect(`${url.pathname}${url.search}`);
}

function getOidcConfig() {
  oidcConfigPromise ??= oidc.discovery(
    new URL(authConfig.oidc.issuer),
    authConfig.oidc.clientId,
    authConfig.oidc.clientSecret,
  );
  return oidcConfigPromise;
}

function publicUser(u: AuthUser) {
  return u;
}

function trackSessionSocket(sessionId: string, socket: Socket) {
  let sockets = sessionSockets.get(sessionId);
  if (!sockets) {
    sockets = new Set();
    sessionSockets.set(sessionId, sockets);
  }
  sockets.add(socket);
  socket.once('close', () => {
    sockets?.delete(socket);
    if (sockets?.size === 0) sessionSockets.delete(sessionId);
  });
}

function closeSessionSockets(sessionId: string) {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) return;
  sessionSockets.delete(sessionId);
  for (const socket of sockets) socket.destroy();
}

function rawRequestSessionMeta(req: IncomingMessage) {
  return {
    ip: trustedClientIp(req.headers, req.socket.remoteAddress),
    userAgent: firstHeaderValue(req.headers['user-agent']),
  };
}

function isUnsafeMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function isProtectedPath(path: string): boolean {
  if (path.startsWith('/desktop/')) return true;
  if (!path.startsWith('/api/')) return false;
  return path !== '/api/auth/login' && path !== '/api/auth/callback';
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

function sameOrigin(req: FastifyRequest | IncomingMessage): boolean {
  const headers = req.headers;
  const socket = 'raw' in req ? req.raw.socket : req.socket;
  const expected = effectiveRequestOrigin(headers, socket.remoteAddress, !!(socket as any).encrypted);
  return !!expected && normalizedOrigin(firstHeaderValue(headers.origin)) === expected;
}

function contentLength(req: FastifyRequest, reply: FastifyReply, maxBytes: number): number | null {
  const raw = firstHeaderValue(req.headers['content-length']);
  if (!raw || !/^\d+$/.test(raw)) {
    reply.code(411).send({ error: '上传请求必须包含 Content-Length' });
    return null;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    reply.code(400).send({ error: '上传内容为空或大小不合法' });
    return null;
  }
  if (n > maxBytes) {
    reply.code(413).send({ error: `上传文件过大，上限 ${Math.round(maxBytes / MiB)} MiB` });
    return null;
  }
  return n;
}

function rawUpload(
  req: FastifyRequest,
  reply: FastifyReply,
  maxBytes: number,
): { stream: NodeJS.ReadableStream; size: number } | null {
  const size = contentLength(req, reply, maxBytes);
  if (size == null) return null;
  const body = req.body as any;
  if (!body || typeof body.pipe !== 'function') {
    reply.code(415).send({ error: '请使用 application/octet-stream 上传文件' });
    return null;
  }
  return { stream: body as NodeJS.ReadableStream, size };
}

function gzipQuery(req: FastifyRequest, reply: FastifyReply): boolean | null {
  const gzip = String((req.query as any)?.gzip ?? '');
  if (gzip === '1') return true;
  if (gzip === '0') return false;
  reply.code(400).send({ error: '缺少 gzip 参数' });
  return null;
}

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
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    ].join('; '),
  );
  return payload;
});

app.addHook('onRequest', async (req, reply) => {
  const path = pathOf(req.raw.url);
  if ((path.startsWith('/api/') || path.startsWith('/desktop/')) && isUnsafeMethod(req.method) && !sameOrigin(req)) {
    return reply.code(403).send({ error: '请求来源不被允许' });
  }
  if (isProtectedPath(path) && !currentUser(req)) {
    return reply.code(401).send({ error: '未登录' });
  }
});

// ---------- OIDC 登录 / 会话 ----------
app.get('/api/auth/login', async (req, reply) => {
  const config = await getOidcConfig();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const returnTo = normalizeReturnTo((req.query as any)?.returnTo);
  const flowToken = createLoginFlow({ state, nonce, codeVerifier, returnTo });

  reply.setCookie(FLOW_COOKIE, flowToken, flowCookieOptions(60 * 10));

  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: authConfig.oidc.redirectUri,
    scope: authConfig.oidc.scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return reply.redirect(redirectTo.href);
});

app.get('/api/auth/callback', async (req, reply) => {
  const flow = consumeLoginFlow(req.cookies?.[FLOW_COOKIE]);
  reply.clearCookie(FLOW_COOKIE, clearCookieOptions('/api/auth'));
  if (!flow) return loginError(reply, '登录请求已过期，请重新登录');

  const query = (req.query as any) ?? {};
  if (query.error) return loginError(reply, String(query.error_description || query.error || 'OIDC 登录失败'));

  try {
    const config = await getOidcConfig();
    const callbackUrl = new URL(req.raw.url || '/api/auth/callback', authConfig.oidc.redirectUri);
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub) return loginError(reply, 'OIDC 返回缺少用户标识');

    let info: Record<string, unknown> = {};
    if (tokens.access_token) {
      try {
        info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
      } catch {
        info = {};
      }
    }

    const email = String(info.email || claims.email || '').trim().toLowerCase();
    if (!email) return loginError(reply, 'OIDC 返回缺少邮箱');
    const emailVerified = info.email_verified ?? claims.email_verified;
    if (authConfig.oidc.requireEmailVerified && emailVerified !== true) {
      return loginError(reply, '邮箱未通过 OIDC 验证');
    }
    if (!isEmailAllowed(email, authConfig)) return loginError(reply, '该邮箱未被允许访问');

    const name = String(info.name || claims.name || email).trim();
    const picture = String(info.picture || claims.picture || '').trim() || undefined;
    const user: AuthUser = {
      sub: claims.sub,
      email,
      username: name || email,
      name: name || undefined,
      picture,
    };

    const token = createSession(user, requestSessionMeta(req));
    reply.setCookie(COOKIE, token, sessionCookieOptions(60 * 60 * 12));
    return reply.redirect(flow.returnTo);
  } catch (e: any) {
    app.log.warn(`[auth] OIDC callback failed: ${e?.message || e}`);
    return loginError(reply, 'OIDC 登录失败，请重试');
  }
});

app.post('/api/auth/logout', async (req, reply) => {
  const cur = currentSession(req);
  destroySession(req.cookies?.[COOKIE]);
  if (cur) closeSessionSockets(cur.id);
  reply.clearCookie(COOKIE, clearCookieOptions('/'));
  return { ok: true };
});

app.get('/api/auth/me', async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: '未登录' });
  return { user: publicUser(u) };
});

// 当前账号的已登录设备。每个浏览器会话对应一条记录，可单独移除以强制该设备退出。
app.get('/api/admin/sessions', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const cur = currentSession(req);
  const devices = listSessions()
    .filter((s) => s.user.sub === u.sub)
    .map((s) => ({ ...s, current: s.id === cur?.id }));
  return { devices };
});

app.delete('/api/admin/sessions/:id', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = String((req.params as any).id || '');
  if (!/^[0-9a-f]{16}$/.test(id)) return reply.code(400).send({ error: '会话 ID 不合法' });

  const target = findSessionById(id);
  if (!target) return reply.code(404).send({ error: '设备登录记录不存在或已过期' });
  if (target.user.sub !== u.sub) return reply.code(403).send({ error: '不能移除其他账号的登录设备' });

  const currentId = currentSession(req)?.id;
  destroySessionById(id);
  closeSessionSockets(id);
  if (id === currentId) reply.clearCookie(COOKIE, clearCookieOptions('/'));
  return { ok: true, current: id === currentId };
});

// ---------- 微信实例管理 ----------
// 列出全部实例（含运行态 + 微信安装状态）
app.get('/api/instances', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const out = await Promise.all(
    listInstances().map(async (pub) => {
      const inst = findInstance(pub.id)!;
      const [runtime, wx] = await Promise.all([instanceRuntime(inst), wechatStatus(inst)]);
      return { ...pub, runtime, wechat: wx };
    }),
  );
  return { instances: out };
});

// 新建实例：生成凭据 + docker run
app.post('/api/admin/instances', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  const { name, reuseVolume } = (req.body as any) ?? {};
  if (!name || String(name).trim().length === 0 || String(name).length > 30) {
    return reply.code(400).send({ error: '实例名称为 1-30 个字符' });
  }
  // 复用卷：必须以 woc-data- 开头，且不能被现存实例占用。后端先校验，避免坏名穿透到 docker run。
  let reuseVolumeName: string | undefined;
  if (reuseVolume) {
    if (typeof reuseVolume !== 'string' || !/^woc-data-[0-9a-f]{10}$/.test(reuseVolume)) {
      return reply.code(400).send({ error: '复用卷名不合法' });
    }
    if (listInstances().some((i) => i.volumeName === reuseVolume)) {
      return reply.code(409).send({ error: '该数据卷已被另一个实例占用' });
    }
    reuseVolumeName = reuseVolume;
  }
  let inst: Instance;
  try {
    inst = createInstance(String(name), user.email, reuseVolumeName);
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '创建实例失败' });
  }
  try {
    await runInstance(inst);
  } catch (e: any) {
    removeInstanceRecord(inst.id); // 容器起不来则回滚登记
    return reply.code(500).send({ error: '创建容器失败：' + (e?.message || e) });
  }
  return { instance: publicInstance(inst) };
});

// 列出"未被任何实例引用的 woc-data-* 数据卷"。删除实例时默认保留卷（聊天记录），但 panel 里
// 看不到这些孤儿卷；本接口让登录用户在新建实例时复用旧卷（同微信号扫码可继承聊天记录），
// 或在不需要时彻底删除。
app.get('/api/admin/orphan-volumes', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const referenced = new Set(listInstances().map((i) => i.volumeName));
  try {
    const volumes = await listOrphanVolumes(referenced);
    return { volumes };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '读取数据卷失败' });
  }
});

// 列出"残留的 woc-wx-* 容器"：docker 里存在但 store 没登记。多为 runInstance 启动失败遗留
// 的 Created 容器，会占着 woc-data-<id> 卷名让删卷报 409。提供一键清理。
app.get('/api/admin/orphan-containers', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const known = new Set(listInstances().map((i) => i.containerName));
  try {
    const containers = await listOrphanContainers(known);
    return { containers };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '读取容器失败' });
  }
});

// 强制删除一个残留容器。仅当它不在 store 的已知容器集中（防误删正在用的实例）。
app.delete('/api/admin/orphan-containers/:idOrName', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const known = new Set(listInstances().map((i) => i.containerName));
  const idOrName = (req.params as any).idOrName;
  if (!idOrName || typeof idOrName !== 'string') return reply.code(400).send({ error: '参数不合法' });
  if (known.has(idOrName)) {
    return reply.code(409).send({ error: '该容器属于现存实例，不能在此删除' });
  }
  try {
    await removeContainerById(idOrName, known);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '删除容器失败' });
  }
});

// 显式删除一个未使用的数据卷。被现存实例占用时拒绝（避免误删聊天记录）。
app.delete('/api/admin/orphan-volumes/:name', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const name = (req.params as any).name;
  if (!name || typeof name !== 'string' || !/^woc-data-[0-9a-f]{10}$/.test(name)) {
    return reply.code(400).send({ error: '卷名不合法' });
  }
  if (listInstances().some((i) => i.volumeName === name)) {
    return reply.code(409).send({ error: '该数据卷正被某个实例使用，不能删除' });
  }
  try {
    await removeVolume(name);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '删除数据卷失败' });
  }
});

// 查/改单实例的内存安全阀（soft / hard）。前端"实例卡片 → 安全"弹窗用。
// GET 返回 per-instance 当前覆盖值 + 全局默认 + 实时内存（用于弹窗里展示）。
// PUT 接受 {soft, hard}，每项可为正整数 / null（null = 恢复默认）。
app.get('/api/admin/instances/:id/mem-limits', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  let currentMB = 0;
  try {
    if ((await instanceRuntime(inst)) === 'running') currentMB = await instanceMemoryMB(inst);
  } catch {
    /* ignore：未运行时为 0 */
  }
  return {
    soft: inst.memSoftLimitMB ?? null,
    hard: inst.memHardLimitMB ?? null,
    defaultSoft: DEFAULT_SOFT_MB,
    defaultHard: DEFAULT_HARD_MB,
    currentMB,
    watchdogEnabled: WATCHDOG_ENABLED,
    intervalSec: WATCHDOG_INTERVAL_SEC,
  };
});
app.put('/api/admin/instances/:id/mem-limits', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const body = (req.body as any) ?? {};
  // 允许 number / null；其它类型都视为"未提供"（保持原值）
  const norm = (v: any): number | null | undefined =>
    v === null ? null : typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
  const s = norm(body.soft);
  const h = norm(body.hard);
  // 取最终生效值（写入前校验）
  const finalSoft = s === undefined ? inst.memSoftLimitMB ?? null : s;
  const finalHard = h === undefined ? inst.memHardLimitMB ?? null : h;
  try {
    const pub = setInstanceMemLimits(
      id,
      finalSoft,
      finalHard,
    );
    return { instance: pub };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '阈值不合法' });
  }
});

// 重置实例的设备 machine-id：滚一个全新的唯一设备身份并重启实例。
// 用于某微信账号被腾讯按"设备风险"标记、登录即被踢时，像"换台新设备"一样恢复。会触发重新扫码登录。
app.post('/api/admin/instances/:id/regen-machine-id', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await regenInstanceMachineId(inst);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '重置设备 ID 失败' });
  }
});

// 删除实例：默认保留数据卷，?purge=1 才永久删聊天记录
app.delete('/api/admin/instances/:id', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = (req.params as any).id;
  const purge = (req.query as any)?.purge === '1' || (req.query as any)?.purge === 'true';
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  await removeInstanceContainer(inst, purge);
  removeInstanceRecord(id);
  controlHolders.delete(id);
  return { ok: true };
});

// 重命名实例：只改显示名，不动容器/卷。
app.post('/api/admin/instances/:id/rename', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const { name } = (req.body as any) ?? {};
  try {
    return { instance: renameInstance((req.params as any).id, String(name ?? '')) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

// 启动实例容器：容器停止或被删后，一键拉起（不重建数据卷）。
app.post('/api/admin/instances/:id/start', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await ensureRunning(inst);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: '启动失败：' + (e?.message || e) });
  }
});

// 停止实例容器：保留容器与数据卷。
app.post('/api/admin/instances/:id/stop', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await stopInstance(inst);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: '停止失败：' + (e?.message || e) });
  }
});

// 重启实例容器：按当前本地镜像重建（保留数据卷 → 登录态不丢；快速，不联网拉取）。
app.post('/api/admin/instances/:id/restart', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await runInstance(inst);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: '重启失败：' + (e?.message || e) });
  }
});

// 升级实例：拉取最新微信镜像后重建（保留数据卷）。用于把旧实例更新到新版镜像
// （如修复"最小化丢失"等），类似「更新微信」但更新的是实例容器镜像本身。
app.post('/api/admin/instances/:id/upgrade', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await upgradeInstance(inst);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: '升级失败：' + (e?.message || e) });
  }
});

// ---------- 文件中转（登录即可用；走面板鉴权，不额外暴露） ----------
// 上传：原始二进制直传，落到实例 ~/Desktop，微信文件选择器可直接选到。
app.post('/api/instances/:id/upload', { bodyLimit: MAX_TRANSFER_UPLOAD_BYTES }, async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const name = String((req.query as any)?.name || '').trim();
  const upload = rawUpload(req, reply, MAX_TRANSFER_UPLOAD_BYTES);
  if (!upload) return;
  try {
    await uploadToInstance(inst, name, upload.stream, upload.size);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '上传失败' });
  }
});

// 列出可下载的中转文件
app.get('/api/instances/:id/files', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    return { files: await listInstanceFiles(inst) };
  } catch {
    return { files: [] };
  }
});

// 删除某个中转文件
app.delete('/api/instances/:id/files', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const name = String((req.query as any)?.name || '').trim();
  try {
    await deleteInstanceFile(inst, name);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '删除失败' });
  }
});

// 下载某个中转文件
app.get('/api/instances/:id/download', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const name = String((req.query as any)?.name || '').trim();
  try {
    const buf = await downloadFromInstance(inst, name);
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(buf);
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '下载失败' });
  }
});

// ---------- 多端协作：操作控制权（心跳软锁，避免多人同时操作打架） ----------
// 同一实例被多个浏览器连的是同一会话，键鼠会互相打架。这里用"心跳持锁"：
// 当前操作者每隔几秒 beat 续约；TTL 内他人只读（前端盖只读遮罩）。空闲超 TTL 自动释放。
const CONTROL_TTL = 10_000; // ms：超过则视为已空闲，可被接管
const controlHolders = new Map<string, { sub: string; username: string; at: number }>();

// 续约/认领：无人持有、已超时、或本来就是我 → 我成为操作者；否则返回当前操作者。
app.post('/api/instances/:id/control/beat', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!findInstance(id)) return reply.code(404).send({ error: '实例不存在' });
  const now = Date.now();
  const h = controlHolders.get(id);
  if (!h || now - h.at > CONTROL_TTL || h.sub === u.sub) {
    controlHolders.set(id, { sub: u.sub, username: u.username, at: now });
    return { mine: true, holder: u.username };
  }
  return { mine: false, holder: h.username };
});

// 只读查询当前操作者（前端轮询；不认领）。超 TTL 视为空闲。
app.get('/api/instances/:id/control', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!findInstance(id)) return reply.code(404).send({ error: '实例不存在' });
  const h = controlHolders.get(id);
  if (!h || Date.now() - h.at > CONTROL_TTL) return { free: true, mine: false, holder: null };
  return { free: false, mine: h.sub === u.sub, holder: h.username };
});

// 主动接管（"申请控制"）：强制把操作权抢过来。
app.post('/api/instances/:id/control/take', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!findInstance(id)) return reply.code(404).send({ error: '实例不存在' });
  controlHolders.set(id, { sub: u.sub, username: u.username, at: Date.now() });
  return { mine: true, holder: u.username };
});

// 通过 xdotool 在实例容器内输入文字（绕过 VNC XKB keysym 容量限制，修复中文 IME 吞字）
app.post('/api/instances/:id/type', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const { text } = (req.body as any) ?? {};
  if (!text || typeof text !== 'string' || text.length > 500) return reply.code(400).send({ error: '文字为空或过长' });
  try {
    await typeInInstance(inst, text);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '输入失败' });
  }
});

// 查看实例容器日志：排查"无法进入/未安装/卡死"等。inline 文本，浏览器可直接看/另存。
app.get('/api/admin/instances/:id/logs', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    const text = await instanceLogs(inst);
    reply.header('content-type', 'text/plain; charset=utf-8');
    return reply.send(text || '（暂无日志）');
  } catch (e: any) {
    reply.header('content-type', 'text/plain; charset=utf-8');
    return reply.send('获取日志失败：' + (e?.message || e));
  }
});

// ---------- 数据卷管理：浏览/上传/解压/下载/改名/移动/删除 + 整卷备份/恢复 ----------
// 数据卷 = 容器 /config，含微信完整会话与加密聊天库；所有白名单登录用户均可操作。
// 全程在「运行中」的实例上操作：浏览/改名/移动/删除靠 docker exec（需容器运行），上传/解压/下载/备份靠
// getArchive/putArchive。不强制停止实例（exec 在停止容器无法运行）。整卷恢复会覆盖全部数据，前端强提示
// 并建议恢复后重启实例以加载数据。

// 浏览目录（一层）
app.get('/api/admin/instances/:id/volume', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    return await listVolume(inst, String((req.query as any)?.path || ''));
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '读取目录失败' });
  }
});

// 新建文件夹
app.post('/api/admin/instances/:id/volume/mkdir', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await volMkdir(inst, String((req.body as any)?.path || ''));
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '新建失败' });
  }
});

// 重命名 / 移动
app.post('/api/admin/instances/:id/volume/move', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const { from, to } = (req.body as any) ?? {};
  try {
    await volMove(inst, String(from || ''), String(to || ''));
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '移动失败' });
  }
});

// 删除文件 / 目录
app.delete('/api/admin/instances/:id/volume', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await volDelete(inst, String((req.query as any)?.path || ''));
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '删除失败' });
  }
});

// 下载单个文件
app.get('/api/admin/instances/:id/volume/download', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const path = String((req.query as any)?.path || '');
  const name = path.split('/').filter(Boolean).pop() || 'file';
  try {
    const buf = await volDownloadFile(inst, path);
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(buf);
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '下载失败' });
  }
});

// 上传单个文件到当前目录（原始二进制；落地为 abc 属主）
app.post('/api/admin/instances/:id/volume/upload', { bodyLimit: MAX_VOLUME_FILE_UPLOAD_BYTES }, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const path = String((req.query as any)?.path || '');
  const name = String((req.query as any)?.name || '').trim();
  const upload = rawUpload(req, reply, MAX_VOLUME_FILE_UPLOAD_BYTES);
  if (!upload) return;
  try {
    await volUploadFile(inst, path, name, upload.stream, upload.size);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '上传失败' });
  }
});

// 上传压缩包并解压到当前目录（.tar / .tar.gz；PC 微信数据迁移用）
app.post('/api/admin/instances/:id/volume/extract', { bodyLimit: MAX_VOLUME_ARCHIVE_UPLOAD_BYTES }, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const upload = rawUpload(req, reply, MAX_VOLUME_ARCHIVE_UPLOAD_BYTES);
  if (!upload) return;
  const gzip = gzipQuery(req, reply);
  if (gzip == null) return;
  try {
    await volExtractArchive(inst, String((req.query as any)?.path || ''), upload.stream, gzip, MAX_VOLUME_ARCHIVE_EXTRACTED_BYTES);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '解压失败（请确认是 .tar 或 .tar.gz）' });
  }
});

// 整卷备份：流式下载 /config 为 .tar.gz
app.get('/api/admin/instances/:id/volume/backup', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    const stream = await volBackupStream(inst);
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`woc-${inst.name}-backup.tar.gz`)}`);
    return reply.send(stream);
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '备份失败' });
  }
});

// 整卷恢复：上传本系统导出的 .tar.gz 备份（要求实例已停止）
app.post('/api/admin/instances/:id/volume/restore', { bodyLimit: MAX_VOLUME_ARCHIVE_UPLOAD_BYTES }, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const upload = rawUpload(req, reply, MAX_VOLUME_ARCHIVE_UPLOAD_BYTES);
  if (!upload) return;
  const gzip = gzipQuery(req, reply);
  if (gzip == null) return;
  try {
    await volRestoreArchive(inst, upload.stream, gzip, MAX_VOLUME_ARCHIVE_EXTRACTED_BYTES);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '恢复失败' });
  }
});

// 该实例的微信安装状态
app.get('/api/instances/:id/wechat/status', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  return { status: await wechatStatus(inst) };
});

// 触发该实例微信下载/更新
async function triggerInstanceWechat(id: string, cmd: 'install' | 'update', reply: FastifyReply) {
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await triggerWechat(inst, cmd);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: '无法触发安装：' + (e?.message || e) });
  }
}

app.post('/api/admin/instances/:id/wechat/install', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return triggerInstanceWechat((req.params as any).id, 'install', reply);
});

app.post('/api/admin/instances/:id/wechat/update', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return triggerInstanceWechat((req.params as any).id, 'update', reply);
});

// ---------- 反向代理到内网 KasmVNC（按实例注入 Basic auth，会话把守） ----------
// 单个 proxy 实例，target 与凭据逐请求指定：凭据暂存在 req 上，proxyReq 时注入。
const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });
proxy.on('proxyReq', (proxyReq, req) => {
  const auth = (req as any)._wocAuth;
  if (auth) proxyReq.setHeader('authorization', auth);
});
proxy.on('proxyReqWs', (proxyReq, req) => {
  const auth = (req as any)._wocAuth;
  if (auth) proxyReq.setHeader('authorization', auth);
});
// 兜底：剥掉 KasmVNC 401 的 WWW-Authenticate 头，避免浏览器弹出原生 Basic Auth 登录框。
// 正常路径下我们已注入正确凭据（不会 401）；万一凭据失配，宁可桌面加载失败也绝不把登录弹窗暴露给用户。
proxy.on('proxyRes', (proxyRes) => {
  delete proxyRes.headers['www-authenticate'];
});
proxy.on('error', (_err, _req, res) => {
  try {
    const r = res as any;
    if (r && typeof r.writeHead === 'function') {
      r.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      r.end('桌面服务暂时不可用');
    } else if (r && typeof r.destroy === 'function') {
      r.destroy();
    }
  } catch {
    /* ignore */
  }
});

// /desktop/:id/rest → rest（剥掉前缀与实例段）。返回 null 表示 url 非法。
function parseDesktopUrl(rawUrl: string): { id: string; rest: string } | null {
  const m = rawUrl.match(/^\/desktop\/([0-9a-f]{10})(\/.*|\?.*|)?$/);
  if (!m) return null;
  const id = m[1];
  let rest = m[2] || '/';
  if (rest.startsWith('?')) rest = '/' + rest;
  if (rest === '') rest = '/';
  return { id, rest };
}

const desktopHandler = (req: FastifyRequest, reply: FastifyReply) => {
  const u = currentUser(req);
  if (!u) {
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

// ---------- 静态 SPA + 前端路由回退 ----------
await app.register(fstatic, { root: STATIC_DIR, wildcard: false, index: ['index.html'] });
app.setNotFoundHandler((req, reply) => {
  const url = req.raw.url || '';
  if (url.startsWith('/api') || url.startsWith('/desktop')) {
    return reply.code(404).send({ error: 'not found' });
  }
  return reply.sendFile('index.html');
});

// ---------- 启动 + WebSocket 升级（同样校验会话） ----------
function parseCookies(header?: string): Record<string, string> {
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

await app.ready();

function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
  // DNS-rebinding gate for WebSocket upgrades (Fastify's onRequest hook does
  // not run on raw upgrades). KasmVNC proxying goes through this path.
  if (!isRequestHostAllowed(
    firstHeaderValue(req.headers.host),
    req.headers['x-forwarded-host'],
    ALLOWED_HOSTS,
    req.socket.remoteAddress,
    TRUSTED_PROXIES,
  ) || !sameOrigin(req)) {
    socket.destroy();
    return;
  }
  const parsed = req.url ? parseDesktopUrl(req.url) : null;
  if (!parsed) {
    socket.destroy();
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = touchSession(cookies[COOKIE], rawRequestSessionMeta(req));
  const u = session?.user;
  const inst = findInstance(parsed.id);
  if (!u || !inst) {
    socket.destroy();
    return;
  }
  req.url = parsed.rest;
  (req as any)._wocAuth = basicAuth(inst);
  trackSessionSocket(session.id, socket);
  proxy.ws(req, socket, head, { target: instanceTarget(inst) });
}

app.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
  try {
    handleUpgrade(req, socket, head);
  } catch (e: any) {
    app.log.warn(`[upgrade] rejected malformed upgrade request: ${e?.message || e}`);
    socket.destroy();
  }
});

// 探测面板网络 + 重启后把已登记实例的容器拉起来
await ensureNetwork().catch(() => {});
for (const pub of listInstances()) {
  try {
    await ensureRunning(findInstance(pub.id)!);
  } catch (e: any) {
    app.log.warn(`[instance] 启动实例 ${pub.id} 失败: ${e?.message || e}`);
  }
}

// Watchdog：KasmVNC/Xvnc 长跑会泄漏（实测 24h 可达 ~9 GiB），小内存机器会被拖垮。
// 两档阈值，按"是否有人在用"决定时机：
//   soft：mem >= soft 且当前无活跃会话 → 主动重启（柔和自愈，不打扰）
//   hard：mem >= hard → 无视会话强制重启（防止 OOM）
// 优先级 hard > soft。两档阈值可在面板"管理 → 实例卡片 → 安全"按钮里单实例覆盖；缺省走 env。
//
// env 默认（可被 per-instance 覆盖）：
//   WOC_INSTANCE_MEM_SOFT_MB    soft 阈值；默认 1500
//   WOC_INSTANCE_MEM_HARD_MB    hard 阈值；默认 2500（也兼容旧名 WOC_INSTANCE_MEM_LIMIT_MB）
//   WOC_WATCHDOG_INTERVAL_SEC   巡检间隔秒；默认 300（5 分钟），最小 60；0 关闭整个 watchdog
const DEFAULT_SOFT_MB = Math.max(0, Number(process.env.WOC_INSTANCE_MEM_SOFT_MB ?? 1500));
const DEFAULT_HARD_MB = Math.max(
  0,
  Number(process.env.WOC_INSTANCE_MEM_HARD_MB ?? process.env.WOC_INSTANCE_MEM_LIMIT_MB ?? 2500),
);
const WATCHDOG_INTERVAL_SEC = Math.max(60, Number(process.env.WOC_WATCHDOG_INTERVAL_SEC ?? 300));
const WATCHDOG_ENABLED = WATCHDOG_INTERVAL_SEC > 0 && (DEFAULT_SOFT_MB > 0 || DEFAULT_HARD_MB > 0);

// 单实例生效阈值：per-instance 覆盖优先；为 undefined 则用 env 默认。
function effectiveLimits(inst: Instance): { soft: number; hard: number } {
  return {
    soft: inst.memSoftLimitMB ?? DEFAULT_SOFT_MB,
    hard: inst.memHardLimitMB ?? DEFAULT_HARD_MB,
  };
}

// "当前有人在远程会话" 启发式判定：复用控制权心跳。前端在用户鼠标/键盘/滚轮交互时 2.5s 节流 beat，
// 故 holder 在 TTL 内即视为"有人在主动操作"。只看屏（不交互）超过 TTL 后会被判为空闲——这是有意的，
// 软自愈宁愿在"看似空闲"时短暂打扰，也不要拖到 hard 强制重启。
function hasActiveSession(id: string): boolean {
  const h = controlHolders.get(id);
  return !!h && Date.now() - h.at <= CONTROL_TTL;
}

if (WATCHDOG_ENABLED) {
  const recovering = new Set<string>(); // 防重入：自愈期间跳过本实例
  const healthFails = new Map<string, number>(); // id → 连续无响应次数
  const HEALTH_FAIL_LIMIT = 2; // 连续 N 次无响应才重启，避免误杀刚启动/瞬时抖动

  const recover = async (inst: Instance, reason: string, detail: string) => {
    recovering.add(inst.id);
    app.log.warn(`[watchdog] ${inst.containerName} ${detail}`);
    try {
      await stopInstance(inst);
      await runInstance(inst);
      healthFails.delete(inst.id);
      app.log.info(`[watchdog] ${inst.containerName} 自愈完成（${reason}）`);
    } catch (e: any) {
      app.log.error(`[watchdog] ${inst.containerName} 自愈失败（${reason}）: ${e?.message || e}`);
    } finally {
      recovering.delete(inst.id);
    }
  };

  const tick = async () => {
    for (const pub of listInstances()) {
      const inst = findInstance(pub.id);
      if (!inst || recovering.has(inst.id)) continue;
      try {
        if ((await instanceRuntime(inst)) !== 'running') {
          healthFails.delete(inst.id);
          continue;
        }
        // 1) 内存阈值自愈（既有）：hard 强制 / soft 仅在无人会话时
        const mb = await instanceMemoryMB(inst);
        if (mb > 0) {
          const { soft, hard } = effectiveLimits(inst);
          const active = hasActiveSession(inst.id);
          if (hard > 0 && mb >= hard) {
            await recover(inst, 'hard', `mem=${mb}MiB ≥ hard=${hard}MiB，强制重启（active=${active}）`);
            continue;
          }
          if (soft > 0 && mb >= soft && !active) {
            await recover(inst, 'soft', `mem=${mb}MiB ≥ soft=${soft}MiB 且无活跃会话，柔和重启`);
            continue;
          }
          if (soft > 0 && mb >= soft && active) {
            app.log.info(`[watchdog] ${inst.containerName} mem=${mb}MiB ≥ soft=${soft}MiB 但用户在使用，延后`);
          }
        }
        // 2) 响应性自愈（新）：探测 VNC 是否还能提供页面；连续 N 次无响应 → 重启
        //    应对"进程没死、显示在线，但 I/O/服务 stall 读不出 VNC 文件、永远卡在正在连接桌面"。
        const healthy = await instanceHttpHealthy(inst);
        if (healthy) {
          healthFails.delete(inst.id);
          continue;
        }
        const fails = (healthFails.get(inst.id) || 0) + 1;
        healthFails.set(inst.id, fails);
        app.log.warn(`[watchdog] ${inst.containerName} VNC 无响应（连续 ${fails}/${HEALTH_FAIL_LIMIT}）`);
        if (fails >= HEALTH_FAIL_LIMIT) {
          await recover(inst, 'unresponsive', `VNC 连续 ${fails} 次无响应（疑似 I/O/服务 stall），自愈重启`);
        }
      } catch (e: any) {
        app.log.warn(`[watchdog] ${pub.id} 检查异常: ${e?.message || e}`);
      }
    }
  };
  setInterval(() => void tick(), WATCHDOG_INTERVAL_SEC * 1000).unref();
  console.log(
    `[watchdog] 已启用 · soft=${DEFAULT_SOFT_MB} MiB · hard=${DEFAULT_HARD_MB} MiB · 间隔=${WATCHDOG_INTERVAL_SEC}s · 含响应性探测`,
  );
}

await app.listen({ port: PORT, host: HOST });
console.log(`[panel] 监听 http://${HOST}:${PORT}  （多实例反代已就绪）`);
