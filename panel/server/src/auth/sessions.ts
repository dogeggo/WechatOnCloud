import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuthUser {
  sub: string;
  email: string;
  username: string;
  isAdmin: boolean;
  name?: string;
  picture?: string;
}

export interface Session {
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
const TOUCH_PERSIST_INTERVAL_MS = 1000 * 60; // 最近活动最多延迟 1 分钟落盘
const FILE = '/data/sessions.json';
const sessions = new Map<string, Session>();
const loginFlows = new Map<string, LoginFlow>();

function token() {
  return randomBytes(32).toString('hex');
}

function sessionKey(t: string) {
  return createHash('sha256').update(t).digest('hex');
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

function persistSessions() {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  const data = {
    version: 1,
    sessions: [...sessions.entries()].map(([tokenHash, s]) => ({ tokenHash, ...s })),
  };
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, FILE);
}

function asTimestamp(v: unknown): number | null {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function asUser(v: any): AuthUser | null {
  if (!v || typeof v !== 'object') return null;
  const sub = String(v.sub || '').trim();
  const email = String(v.email || '').trim().toLowerCase();
  const username = String(v.username || v.name || email).trim();
  if (!sub || !email || !username) return null;
  const isAdmin = v.isAdmin === true;
  const name = String(v.name || '').trim() || undefined;
  const picture = String(v.picture || '').trim() || undefined;
  return { sub, email, username, isAdmin, name, picture };
}

function assertLoadedSession(row: any) {
  if (!row || typeof row !== 'object') throw new Error('会话数据格式不合法');
  const tokenHash = String(row.tokenHash || '').trim();
  const id = String(row.id || '').trim();
  const user = asUser(row.user);
  const createdAt = asTimestamp(row.createdAt);
  const lastSeenAt = asTimestamp(row.lastSeenAt);
  const expires = asTimestamp(row.expires);
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('会话 tokenHash 不合法');
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('会话 ID 不合法');
  if (!user) throw new Error('会话用户数据不合法');
  if (createdAt == null || lastSeenAt == null || expires == null) throw new Error('会话时间字段不合法');
  return {
    tokenHash,
    session: {
      id,
      user,
      createdAt,
      lastSeenAt,
      expires,
      ...cleanMeta({ ip: row.ip, userAgent: row.userAgent }),
    },
  };
}

function loadSessions() {
  if (!existsSync(FILE)) return;
  const raw = JSON.parse(readFileSync(FILE, 'utf8'));
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.sessions)) {
    throw new Error('会话数据文件格式不合法');
  }
  const now = Date.now();
  for (const row of raw.sessions) {
    const loaded = assertLoadedSession(row);
    if (loaded.session.expires < now) continue;
    sessions.set(loaded.tokenHash, loaded.session);
  }
}

function pruneExpired(persist = true) {
  const now = Date.now();
  let changed = false;
  for (const [t, s] of sessions) {
    if (s.expires < now) {
      sessions.delete(t);
      changed = true;
    }
  }
  if (changed && persist) persistSessions();
}

loadSessions();

export function createSession(user: AuthUser, meta?: SessionMeta) {
  const t = token();
  const now = Date.now();
  sessions.set(sessionKey(t), {
    id: shortId(),
    user,
    createdAt: now,
    lastSeenAt: now,
    expires: now + SESSION_TTL_MS,
    ...cleanMeta(meta),
  });
  persistSessions();
  return t;
}

export function getSession(t?: string) {
  if (!t) return null;
  const key = sessionKey(t);
  const s = sessions.get(key);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(key);
    persistSessions();
    return null;
  }
  return s;
}

export function touchSession(t?: string, meta?: SessionMeta) {
  const s = getSession(t);
  if (!s) return null;
  const m = cleanMeta(meta);
  const now = Date.now();
  // 管理页里的一个“设备”只对应一个 session cookie；IP/UA 仅作为最近访问元数据展示。
  const shouldPersist = now - s.lastSeenAt >= TOUCH_PERSIST_INTERVAL_MS || m.ip !== s.ip || m.userAgent !== s.userAgent;
  s.lastSeenAt = now;
  s.ip = m.ip;
  s.userAgent = m.userAgent;
  if (shouldPersist) persistSessions();
  return s;
}

export function destroySession(t?: string) {
  if (!t) return;
  if (sessions.delete(sessionKey(t))) persistSessions();
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
      persistSessions();
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
