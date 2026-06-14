export interface PanelUser {
  sub: string;
  email: string;
  username: string;
  name?: string;
  picture?: string;
}

export type WechatPhase = 'idle' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error';
export interface WechatStatus {
  phase: WechatPhase;
  percent: number; // -1 表示进度不确定
  installed: boolean;
  version: string;
  message: string;
  updatedAt: number;
}

export type RuntimeState = 'running' | 'stopped' | 'missing';
export interface PanelInstance {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  memSoftLimitMB?: number;
  memHardLimitMB?: number;
}
export interface MemLimits {
  soft: number | null;
  hard: number | null;
  defaultSoft: number;
  defaultHard: number;
  currentMB: number;
  watchdogEnabled: boolean;
  intervalSec: number;
}
export interface InstanceWithStatus extends PanelInstance {
  runtime: RuntimeState;
  wechat: WechatStatus;
}

export interface VolEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number; // epoch ms
}

// 原始二进制上传（File 直传 application/octet-stream），用于数据卷上传/解压/恢复
async function rawUpload(url: string, file: File): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || `请求失败 (${res.status})`);
  return data;
}

async function req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  // 仅在有 body 时声明 JSON content-type：否则 Fastify 对「空 body + application/json」会报 400
  const headers = opts.body ? { 'content-type': 'application/json', ...opts.headers } : opts.headers;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 会话过期：除登录/探测接口外，任意接口收到 401 都说明 cookie 失效，直接回登录页（避免页面卡在错误态）
    const isAuthProbe = path.includes('/api/auth/login') || path.includes('/api/auth/me');
    if (res.status === 401 && !isAuthProbe && location.pathname !== '/login') {
      location.assign('/login');
    }
    throw new Error((data as any).error || `请求失败 (${res.status})`);
  }
  return data as T;
}

export const api = {
  me: () => req<{ user: PanelUser }>('/api/auth/me'),
  loginUrl: (returnTo = '/') => `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  logout: () => req('/api/auth/logout', { method: 'POST' }),

  // 微信实例
  listInstances: () => req<{ instances: InstanceWithStatus[] }>('/api/instances'),
  createInstance: (name: string, reuseVolume?: string) =>
    req<{ instance: PanelInstance }>('/api/admin/instances', {
      method: 'POST',
      body: JSON.stringify({ name, reuseVolume: reuseVolume || undefined }),
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
    req<{ volumes: { name: string; createdAt?: string; sizeBytes?: number }[] }>('/api/admin/orphan-volumes'),
  deleteOrphanVolume: (name: string) =>
    req(`/api/admin/orphan-volumes/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  listOrphanContainers: () =>
    req<{ containers: { id: string; name: string; status: string; volumeName?: string }[] }>('/api/admin/orphan-containers'),
  deleteOrphanContainer: (idOrName: string) =>
    req(`/api/admin/orphan-containers/${encodeURIComponent(idOrName)}`, { method: 'DELETE' }),
  renameInstance: (id: string, name: string) =>
    req<{ instance: PanelInstance }>(`/api/admin/instances/${id}/rename`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteInstance: (id: string, purge = false) =>
    req(`/api/admin/instances/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' }),
  instanceWechatStatus: (id: string) => req<{ status: WechatStatus }>(`/api/instances/${id}/wechat/status`),
  instanceWechatInstall: (id: string) => req(`/api/admin/instances/${id}/wechat/install`, { method: 'POST' }),
  instanceWechatUpdate: (id: string) => req(`/api/admin/instances/${id}/wechat/update`, { method: 'POST' }),
  instanceStart: (id: string) => req(`/api/admin/instances/${id}/start`, { method: 'POST' }),
  instanceStop: (id: string) => req(`/api/admin/instances/${id}/stop`, { method: 'POST' }),
  instanceRestart: (id: string) => req(`/api/admin/instances/${id}/restart`, { method: 'POST' }),
  instanceUpgrade: (id: string) => req(`/api/admin/instances/${id}/upgrade`, { method: 'POST' }),
  instanceLogsUrl: (id: string) => `/api/admin/instances/${id}/logs`,

  // 文件中转
  listFiles: (id: string) => req<{ files: { name: string; size: number }[] }>(`/api/instances/${id}/files`),
  uploadFile: async (id: string, file: File) => {
    const res = await fetch(`/api/instances/${id}/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error || '上传失败');
    return res.json();
  },
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
    rawUpload(`/api/admin/instances/${id}/volume/extract?path=${encodeURIComponent(path)}`, file),
  volumeRestore: (id: string, file: File) =>
    rawUpload(`/api/admin/instances/${id}/volume/restore`, file),

  // 多端协作：操作控制权
  controlStatus: (id: string) => req<{ free: boolean; mine: boolean; holder: string | null }>(`/api/instances/${id}/control`),
  controlBeat: (id: string) => req<{ mine: boolean; holder: string }>(`/api/instances/${id}/control/beat`, { method: 'POST' }),
  controlTake: (id: string) => req<{ mine: boolean; holder: string }>(`/api/instances/${id}/control/take`, { method: 'POST' }),
  typeInInstance: (id: string, text: string) => req(`/api/instances/${id}/type`, { method: 'POST', body: JSON.stringify({ text }) }),
};
