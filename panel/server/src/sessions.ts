import { randomBytes } from 'node:crypto';

export interface AuthUser {
  sub: string;
  email: string;
  username: string;
  name?: string;
  picture?: string;
}

interface Session {
  id: string;
  user: AuthUser;
  createdAt: number;
  lastSeenAt: number;
  expires: number;
  ip: string;
  userAgent: string;
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface PublicSession {
  id: string;
  user: AuthUser;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
}

export interface LoginFlow {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expires: number;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 小时
const FLOW_TTL_MS = 1000 * 60 * 10; // 10 分钟
const sessions = new Map<string, Session>();
const loginFlows = new Map<string, LoginFlow>();

function token() {
  return randomBytes(32).toString('hex');
}

function shortId() {
  for (let i = 0; i < 20; i++) {
    const id = randomBytes(8).toString('hex');
    if (!findSessionById(id)) return id;
  }
  throw new Error('无法生成唯一会话 ID');
}

function cleanMeta(meta?: SessionMeta) {
  const ip = String(meta?.ip || '').trim().slice(0, 128) || 'unknown';
  const userAgent = String(meta?.userAgent || '').trim().slice(0, 512) || 'unknown';
  return { ip, userAgent };
}

function toPublicSession(s: Session): PublicSession {
  return {
    id: s.id,
    user: s.user,
    createdAt: new Date(s.createdAt).toISOString(),
    lastSeenAt: new Date(s.lastSeenAt).toISOString(),
    expiresAt: new Date(s.expires).toISOString(),
    ip: s.ip,
    userAgent: s.userAgent,
  };
}

function pruneExpired() {
  const now = Date.now();
  for (const [t, s] of sessions) {
    if (s.expires < now) sessions.delete(t);
  }
}

export function createSession(user: AuthUser, meta?: SessionMeta) {
  const t = token();
  const now = Date.now();
  sessions.set(t, {
    id: shortId(),
    user,
    createdAt: now,
    lastSeenAt: now,
    expires: now + SESSION_TTL_MS,
    ...cleanMeta(meta),
  });
  return t;
}

export function getSession(t?: string) {
  if (!t) return null;
  const s = sessions.get(t);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(t);
    return null;
  }
  return s;
}

export function touchSession(t?: string, meta?: SessionMeta) {
  const s = getSession(t);
  if (!s) return null;
  s.lastSeenAt = Date.now();
  const m = cleanMeta(meta);
  s.ip = m.ip;
  s.userAgent = m.userAgent;
  return s;
}

export function destroySession(t?: string) {
  if (t) sessions.delete(t);
}

export function listSessions() {
  pruneExpired();
  return [...sessions.values()].map(toPublicSession).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function findSessionById(id: string) {
  pruneExpired();
  for (const s of sessions.values()) {
    if (s.id === id) return toPublicSession(s);
  }
  return null;
}

export function destroySessionById(id: string) {
  pruneExpired();
  for (const [t, s] of sessions) {
    if (s.id === id) {
      sessions.delete(t);
      return toPublicSession(s);
    }
  }
  return null;
}

export function createLoginFlow(flow: Omit<LoginFlow, 'expires'>) {
  const t = token();
  loginFlows.set(t, { ...flow, expires: Date.now() + FLOW_TTL_MS });
  return t;
}

export function consumeLoginFlow(t?: string) {
  if (!t) return null;
  const flow = loginFlows.get(t);
  loginFlows.delete(t);
  if (!flow || flow.expires < Date.now()) return null;
  return flow;
}
