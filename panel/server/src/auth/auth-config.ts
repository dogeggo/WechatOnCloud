import { existsSync, readFileSync } from 'node:fs';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  requireEmailVerified: boolean;
  cookieSecure: boolean;
}

export interface AuthConfig {
  file: string;
  allowedEmails: string[];
  adminEmails: string[];
  oidc: OidcSettings;
}

const DEFAULT_FILE = '/data/auth.json';

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`认证配置 ${name} 不能为空`);
  return v.trim();
}

function asOptionalBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function normalizeEmailList(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const emails = parts
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(emails)];
}

export function loadAuthConfig(file = DEFAULT_FILE): AuthConfig {
  if (!existsSync(file)) {
    throw new Error(`认证配置文件不存在：${file}。请创建该 JSON 文件并配置 allowedEmails 与 oidc。`);
  }

  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e: any) {
    throw new Error(`认证配置文件解析失败：${e?.message || e}`);
  }

  const oidc = raw?.oidc;
  if (!oidc || typeof oidc !== 'object') throw new Error('认证配置缺少 oidc 对象');

  const allowedEmails = normalizeEmailList(raw.allowedEmails);
  const adminEmails = normalizeEmailList(raw.adminEmails);
  if (allowedEmails.length === 0 && adminEmails.length === 0) {
    throw new Error('认证配置 allowedEmails 或 adminEmails 至少要包含一个邮箱');
  }

  const redirectUri = asString(oidc.redirectUri, 'oidc.redirectUri');
  const redirectUrl = new URL(redirectUri);
  const cookieSecure =
    asOptionalBoolean(raw.cookieSecure) ??
    asOptionalBoolean(oidc.cookieSecure) ??
    redirectUrl.protocol === 'https:';

  return {
    file,
    allowedEmails,
    adminEmails,
    oidc: {
      issuer: asString(oidc.issuer, 'oidc.issuer'),
      clientId: asString(oidc.clientId, 'oidc.clientId'),
      clientSecret: asString(oidc.clientSecret, 'oidc.clientSecret'),
      redirectUri,
      scope: typeof oidc.scope === 'string' && oidc.scope.trim() ? oidc.scope.trim() : 'openid email profile',
      requireEmailVerified: oidc.requireEmailVerified !== false,
      cookieSecure,
    },
  };
}

export function isEmailAllowed(email: string, config: AuthConfig): boolean {
  const normalized = email.trim().toLowerCase();
  return config.allowedEmails.includes(normalized) || config.adminEmails.includes(normalized);
}

export function isAdminEmail(email: string, config: AuthConfig): boolean {
  return config.adminEmails.includes(email.trim().toLowerCase());
}
