import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import * as oidc from 'openid-client';
import { isAdminEmail, isEmailAllowed, type AuthConfig } from './auth-config.js';
import { firstHeaderValue, parseCookies, trustedClientIp } from '../http/request-utils.js';
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
  type PublicSession,
  type Session,
  type SessionMeta,
} from './sessions.js';
import type { TrustedProxy } from '../http/host-guard.js';

export type { AuthUser };

export class AuthManager {
  private oidcConfigPromise: Promise<oidc.Configuration> | null = null;
  private readonly sessionSockets = new Map<string, Set<Socket>>();

  constructor(
    private readonly config: AuthConfig,
    private readonly sessionCookieName: string,
    private readonly flowCookieName: string,
    private readonly trustedProxies: TrustedProxy[],
  ) {}

  currentSession(req: FastifyRequest) {
    return this.applyCurrentRole(touchSession(req.cookies?.[this.sessionCookieName], this.requestSessionMeta(req)));
  }

  currentUser(req: FastifyRequest): AuthUser | null {
    return this.currentSession(req)?.user ?? null;
  }

  requireAuth(req: FastifyRequest, reply: FastifyReply): AuthUser | null {
    const user = this.currentUser(req);
    if (!user) {
      reply.code(401).send({ error: '未登录' });
      return null;
    }
    return user;
  }

  rawSession(req: IncomingMessage) {
    const cookies = parseCookies(req.headers.cookie);
    return this.applyCurrentRole(touchSession(cookies[this.sessionCookieName], this.rawRequestSessionMeta(req)));
  }

  trackSessionSocket(sessionId: string, socket: Socket): void {
    let sockets = this.sessionSockets.get(sessionId);
    if (!sockets) {
      sockets = new Set();
      this.sessionSockets.set(sessionId, sockets);
    }
    sockets.add(socket);
    socket.once('close', () => {
      sockets?.delete(socket);
      if (sockets?.size === 0) this.sessionSockets.delete(sessionId);
    });
  }

  closeSessionSockets(sessionId: string): void {
    const sockets = this.sessionSockets.get(sessionId);
    if (!sockets) return;
    this.sessionSockets.delete(sessionId);
    for (const socket of sockets) socket.destroy();
  }

  async login(req: FastifyRequest, reply: FastifyReply) {
    const config = await this.getOidcConfig();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const returnTo = normalizeReturnTo((req.query as any)?.returnTo);
    const flowToken = createLoginFlow({ state, nonce, codeVerifier, returnTo });

    reply.setCookie(this.flowCookieName, flowToken, this.flowCookieOptions(60 * 10));

    const redirectTo = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.config.oidc.redirectUri,
      scope: this.config.oidc.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return reply.redirect(redirectTo.href);
  }

  async callback(req: FastifyRequest, reply: FastifyReply, log: FastifyBaseLogger) {
    const flow = consumeLoginFlow(req.cookies?.[this.flowCookieName]);
    reply.clearCookie(this.flowCookieName, this.clearCookieOptions('/api/auth'));
    if (!flow) return loginError(reply, '登录请求已过期，请重新登录');

    const query = (req.query as any) ?? {};
    if (query.error) return loginError(reply, String(query.error_description || query.error || 'OIDC 登录失败'));

    try {
      const config = await this.getOidcConfig();
      const callbackUrl = new URL(req.raw.url || '/api/auth/callback', this.config.oidc.redirectUri);
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub) return loginError(reply, 'OIDC 返回缺少用户标识');

      const info = tokens.access_token
        ? await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)
        : {};
      const user = this.buildUser(claims, info);

      const token = createSession(user, this.requestSessionMeta(req));
      reply.setCookie(this.sessionCookieName, token, this.sessionCookieOptions(60 * 60 * 12));
      return reply.redirect(flow.returnTo);
    } catch (e: any) {
      if (e instanceof LoginFlowError) return loginError(reply, e.message);
      log.warn(`[auth] OIDC callback failed: ${e?.message || e}`);
      return loginError(reply, 'OIDC 登录失败，请重试');
    }
  }

  logout(req: FastifyRequest, reply: FastifyReply) {
    const current = this.currentSession(req);
    destroySession(req.cookies?.[this.sessionCookieName]);
    if (current) this.closeSessionSockets(current.id);
    reply.clearCookie(this.sessionCookieName, this.clearCookieOptions('/'));
    return { ok: true };
  }

  me(req: FastifyRequest, reply: FastifyReply) {
    const user = this.currentUser(req);
    if (!user) return reply.code(401).send({ error: '未登录' });
    return { user };
  }

  currentUserSessions(req: FastifyRequest, reply: FastifyReply) {
    const user = this.requireAuth(req, reply);
    if (!user) return undefined;
    const current = this.currentSession(req);
    const devices = listSessions()
      .filter((session) => user.isAdmin || session.user.sub === user.sub)
      .map((session) => this.publicSessionWithRole(session, session.id === current?.id));
    return { devices };
  }

  removeCurrentUserSession(req: FastifyRequest, reply: FastifyReply) {
    const user = this.requireAuth(req, reply);
    if (!user) return undefined;
    const id = String((req.params as any).id || '');
    if (!/^[0-9a-f]{16}$/.test(id)) return reply.code(400).send({ error: '会话 ID 不合法' });

    const target = findSessionById(id);
    if (!target) return reply.code(404).send({ error: '设备登录记录不存在或已过期' });
    if (!user.isAdmin && target.user.sub !== user.sub) return reply.code(403).send({ error: '不能移除其他账号的登录设备' });

    const currentId = this.currentSession(req)?.id;
    destroySessionById(id);
    this.closeSessionSockets(id);
    if (id === currentId) reply.clearCookie(this.sessionCookieName, this.clearCookieOptions('/'));
    return { ok: true, current: id === currentId };
  }

  private getOidcConfig() {
    this.oidcConfigPromise ??= oidc.discovery(
      new URL(this.config.oidc.issuer),
      this.config.oidc.clientId,
      this.config.oidc.clientSecret,
    );
    return this.oidcConfigPromise;
  }

  private requestSessionMeta(req: FastifyRequest): SessionMeta {
    return {
      ip: trustedClientIp(req.headers, req.raw.socket.remoteAddress, this.trustedProxies),
      userAgent: firstHeaderValue(req.headers['user-agent']),
    };
  }

  private rawRequestSessionMeta(req: IncomingMessage): SessionMeta {
    return {
      ip: trustedClientIp(req.headers, req.socket.remoteAddress, this.trustedProxies),
      userAgent: firstHeaderValue(req.headers['user-agent']),
    };
  }

  private sessionCookieOptions(maxAge: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      maxAge,
      secure: this.config.oidc.cookieSecure,
    };
  }

  private flowCookieOptions(maxAge: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/api/auth',
      maxAge,
      secure: this.config.oidc.cookieSecure,
    };
  }

  private clearCookieOptions(path: string) {
    return {
      sameSite: 'lax' as const,
      path,
      secure: this.config.oidc.cookieSecure,
    };
  }

  private applyCurrentRole<T extends Session | null>(session: T): T {
    if (session) session.user = this.userWithCurrentRole(session.user);
    return session;
  }

  private publicSessionWithRole(session: PublicSession, current: boolean) {
    return {
      ...session,
      user: this.userWithCurrentRole(session.user),
      current,
    };
  }

  private userWithCurrentRole(user: AuthUser): AuthUser {
    const isAdmin = isAdminEmail(user.email, this.config);
    return user.isAdmin === isAdmin ? user : { ...user, isAdmin };
  }

  private buildUser(claims: Record<string, any>, info: Record<string, any>): AuthUser {
    const email = String(info.email || claims.email || '').trim().toLowerCase();
    if (!email) throw new LoginFlowError('OIDC 返回缺少邮箱');

    const emailVerified = info.email_verified ?? claims.email_verified;
    if (this.config.oidc.requireEmailVerified && emailVerified !== true) {
      throw new LoginFlowError('邮箱未通过 OIDC 验证');
    }
    if (!isEmailAllowed(email, this.config)) throw new LoginFlowError('该邮箱未被允许访问');

    const name = String(info.name || claims.name || email).trim();
    return {
      sub: claims.sub,
      email,
      username: name || email,
      isAdmin: isAdminEmail(email, this.config),
      name: name || undefined,
      picture: String(info.picture || claims.picture || '').trim() || undefined,
    };
  }
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

class LoginFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginFlowError';
  }
}
