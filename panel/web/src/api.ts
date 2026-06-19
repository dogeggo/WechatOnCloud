import { payloadErrorMessage } from './utils/errors';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly data: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export interface PanelUser {
  sub: string;
  email: string;
  username: string;
  isAdmin: boolean;
  name?: string;
  picture?: string;
}

export interface LoggedInDevice {
  id: string;
  user: PanelUser;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
  current: boolean;
}
export interface LoginWallpaper {
  imageUrl: string;
  title: string;
  copyright: string;
  copyrightLink: string;
  fetchedAt: number;
}
export interface DesktopFile {
  name: string;
  size: number;
}

export type AppPhase = 'idle' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error';
export interface AppStatus {
  phase: AppPhase;
  percent: number; // -1 表示进度不确定
  installed: boolean;
  version: string;
  message: string;
  updatedAt: number;
}

export type RuntimeState = 'running' | 'stopped' | 'missing';
export type AppType = 'wechat' | 'chromium' | 'qq' | 'telegram';
export interface PanelInstance {
  id: string;
  name: string;
  appType: AppType;
  icon?: string;
  createdAt: string;
  createdBy: string;
  memSoftLimitMB?: number;
  memHardLimitMB?: number;
}
export interface OrphanVolume {
  name: string;
  appType?: AppType;
  createdAt?: string;
  sizeBytes?: number;
}
export interface OrphanContainer {
  id: string;
  name: string;
  status: string;
  volumeName?: string;
}
export interface MemLimits {
  soft: number | null;
  hard: number | null;
  defaultSoft: number;
  defaultHard: number;
  hardMax: number | null;
  currentMB: number;
  watchdogEnabled: boolean;
  intervalSec: number;
}
export interface InstanceWithStatus extends PanelInstance {
  runtime: RuntimeState;
  app: AppStatus;
}

export type NotificationUrgency = 'low' | 'normal' | 'critical';
export interface InstanceNotificationEvent {
  type: 'instance-notification';
  id: string;
  instanceId: string;
  instanceName: string;
  appType: AppType;
  appName: string;
  title: string;
  body: string;
  urgency: NotificationUrgency;
  source: string;
  createdAt: number;
}

export interface DesktopClientReplacedEvent {
  type: 'desktop-client-replaced';
  id: string;
  clientId: string;
  instanceId: string;
  instanceName: string;
  appType: AppType;
  appName: string;
  title: string;
  body: string;
  createdAt: number;
}

export interface VolEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number; // epoch ms
}

function responseTextMessage(data: unknown): string | null {
  if (typeof data !== 'string') return null;
  const text = data.trim().replace(/\s+/g, ' ');
  if (!text || text.startsWith('<')) return null;
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

// 错误响应也走这里读取，解析失败不能覆盖 HTTP 状态。
async function readResponseData(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json') || contentType.includes('+json');
  if (isJson) {
    try {
      return await res.json();
    } catch {
      if (res.ok) throw new ApiError(res.status, `响应解析失败 (${res.status})`, undefined);
      return undefined;
    }
  }
  try {
    const text = await res.text();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function buildError(data: unknown, status: number, fallback = '请求失败'): ApiError {
  const message = payloadErrorMessage(data) || responseTextMessage(data) || fallback;
  return new ApiError(status, `${message} (${status})`, data);
}

// 原始二进制上传（File 直传 application/octet-stream），用于数据卷上传/解压/恢复
async function rawUpload<T = unknown>(url: string, file: File, errorText = '上传失败'): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const data = await readResponseData(res);
  if (!res.ok) throw buildError(data, res.status, errorText);
  return data as T;
}

async function req<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  // 仅在有 body 时声明 JSON content-type：否则 Fastify 对「空 body + application/json」会报 400
  const headers = opts.body ? { 'content-type': 'application/json', ...opts.headers } : opts.headers;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers,
  });
  const data = await readResponseData(res);
  if (!res.ok) {
    // 会话过期：除登录/探测接口外，任意接口收到 401 都说明 cookie 失效，直接回登录页（避免页面卡在错误态）
    const isAuthProbe = path.includes('/api/auth/login') || path.includes('/api/auth/me');
    if (res.status === 401 && !isAuthProbe && location.pathname !== '/login') {
      location.assign('/login');
    }
    throw buildError(data, res.status);
  }
  return data as T;
}

export const api = {
  me: () => req<{ user: PanelUser }>('/api/auth/me'),
  ping: () => req<{ ok: true; now: number }>(`/api/ping?t=${Date.now()}`),
  loginWallpaper: () => req<LoginWallpaper>('/api/login-wallpaper'),
  loginUrl: (returnTo = '/') => `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  logout: () => req('/api/auth/logout', { method: 'POST' }),
  listLoggedInDevices: () => req<{ devices: LoggedInDevice[] }>('/api/admin/sessions'),
  removeLoggedInDevice: (id: string) => req<{ ok: boolean; current?: boolean }>(`/api/admin/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // 应用实例
  listInstances: () => req<{ instances: InstanceWithStatus[] }>('/api/instances'),
  createInstance: (name: string, reuseVolume?: string, appType: AppType = 'wechat') =>
    req<{ instance: PanelInstance }>('/api/admin/instances', {
      method: 'POST',
      body: JSON.stringify({ name, reuseVolume: reuseVolume || undefined, appType }),
    }),
  regenMachineId: (id: string) =>
    req(`/api/admin/instances/${id}/regen-machine-id`, { method: 'POST' }),
  getInstanceMemLimits: (id: string) =>
    req<MemLimits>(`/api/admin/instances/${id}/mem-limits`),
  setInstanceMemLimits: (id: string, soft: number | null | undefined, hard: number | null | undefined) =>
    req<{ instance: PanelInstance }>(`/api/admin/instances/${id}/mem-limits`, {
      method: 'PUT',
      body: JSON.stringify({ soft, hard }),
    }),
  listOrphanVolumes: () =>
    req<{ volumes: OrphanVolume[] }>('/api/admin/orphan-volumes'),
  deleteOrphanVolume: (name: string) =>
    req(`/api/admin/orphan-volumes/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  listOrphanContainers: () =>
    req<{ containers: OrphanContainer[] }>('/api/admin/orphan-containers'),
  deleteOrphanContainer: (idOrName: string) =>
    req(`/api/admin/orphan-containers/${encodeURIComponent(idOrName)}`, { method: 'DELETE' }),
  setInstanceIcon: (id: string, icon: string | null) =>
    req<{ instance: PanelInstance }>(`/api/admin/instances/${id}/icon`, { method: 'POST', body: JSON.stringify({ icon }) }),
  renameInstance: (id: string, name: string) =>
    req<{ instance: PanelInstance }>(`/api/admin/instances/${id}/rename`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteInstance: (id: string, purge = false) =>
    req(`/api/admin/instances/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' }),
  instanceAppStatus: (id: string) => req<{ status: AppStatus }>(`/api/instances/${id}/app/status`),
  instanceAppInstall: (id: string) => req(`/api/admin/instances/${id}/app/install`, { method: 'POST' }),
  instanceAppUpdate: (id: string) => req(`/api/admin/instances/${id}/app/update`, { method: 'POST' }),
  notificationsStreamUrl: () => '/api/notifications/stream',
  instanceStart: (id: string) => req(`/api/admin/instances/${id}/start`, { method: 'POST' }),
  instanceStop: (id: string) => req(`/api/admin/instances/${id}/stop`, { method: 'POST' }),
  instanceRestart: (id: string) => req(`/api/admin/instances/${id}/restart`, { method: 'POST' }),
  instanceUpgrade: (id: string) => req(`/api/admin/instances/${id}/upgrade`, { method: 'POST' }),
  instanceLogsUrl: (id: string) => `/api/admin/instances/${id}/logs`,
  instanceLogs: (id: string) => req<string>(`/api/admin/instances/${id}/logs`),

  // 文件中转
  listFiles: (id: string) => req<{ files: DesktopFile[] }>(`/api/instances/${id}/files`),
  uploadFile: (id: string, file: File) =>
    rawUpload(`/api/instances/${id}/upload?name=${encodeURIComponent(file.name)}`, file, '上传失败'),
  downloadFileUrl: (id: string, name: string) => `/api/instances/${id}/download?name=${encodeURIComponent(name)}`,
  deleteFile: (id: string, name: string) => req(`/api/instances/${id}/files?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // 数据卷管理
  volumeList: (id: string, path = '') =>
    req<{ path: string; entries: VolEntry[] }>(`/api/admin/instances/${id}/volume?path=${encodeURIComponent(path)}`),
  volumeMkdir: (id: string, path: string) =>
    req(`/api/admin/instances/${id}/volume/mkdir`, { method: 'POST', body: JSON.stringify({ path }) }),
  volumeMove: (id: string, from: string, to: string) =>
    req(`/api/admin/instances/${id}/volume/move`, { method: 'POST', body: JSON.stringify({ from, to }) }),
  volumeDelete: (id: string, path: string) =>
    req(`/api/admin/instances/${id}/volume?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  volumeDownloadUrl: (id: string, path: string) =>
    `/api/admin/instances/${id}/volume/download?path=${encodeURIComponent(path)}`,
  volumeBackupUrl: (id: string) => `/api/admin/instances/${id}/volume/backup`,
  volumeUpload: (id: string, path: string, file: File) =>
    rawUpload(`/api/admin/instances/${id}/volume/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}`, file),
  volumeExtract: (id: string, path: string, file: File) =>
    rawUpload(`/api/admin/instances/${id}/volume/extract?path=${encodeURIComponent(path)}&gzip=${file.name.endsWith('.gz') ? '1' : '0'}`, file),
  volumeRestore: (id: string, file: File) =>
    rawUpload(`/api/admin/instances/${id}/volume/restore?gzip=${file.name.endsWith('.gz') ? '1' : '0'}`, file),

  typeInInstance: (id: string, text: string) =>
    req(`/api/instances/${id}/type`, { method: 'POST', body: JSON.stringify({ text }) }),
  keyInInstance: (id: string, key: string) =>
    req(`/api/instances/${id}/key`, { method: 'POST', body: JSON.stringify({ key }) }),
};
