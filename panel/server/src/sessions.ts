import { randomBytes } from 'node:crypto';

export interface AuthUser {
  sub: string;
  email: string;
  username: string;
  name?: string;
  picture?: string;
}

interface Session {
  user: AuthUser;
  expires: number;
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

export function createSession(user: AuthUser) {
  const t = token();
  sessions.set(t, { user, expires: Date.now() + SESSION_TTL_MS });
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

export function destroySession(t?: string) {
  if (t) sessions.delete(t);
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
