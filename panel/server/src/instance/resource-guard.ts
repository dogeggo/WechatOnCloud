export const INSTANCE_ID_RE = /^[0-9a-f]{10}$/;
export const CONTAINER_NAME_RE = /^woc-app-[0-9a-f]{10}$/;
export const VOLUME_NAME_RE = /^woc-data-[0-9a-f]{10}$/;
export const NETWORK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const VIDEO_DEVICE_RE = /^\/dev\/video\d+$/;

export function isProjectContainerName(name: string): boolean {
  return CONTAINER_NAME_RE.test(name);
}

export function isProjectVolumeName(name: string): boolean {
  return VOLUME_NAME_RE.test(name);
}

export function assertProjectContainerName(name: string): string {
  if (!isProjectContainerName(name)) throw new Error(`拒绝操作非本项目容器：${name || '(empty)'}`);
  return name;
}

export function assertProjectVolumeName(name: string): string {
  if (!isProjectVolumeName(name)) throw new Error(`拒绝操作非本项目数据卷：${name || '(empty)'}`);
  return name;
}

export function assertInstanceId(id: string): string {
  if (!INSTANCE_ID_RE.test(id)) throw new Error(`实例 ID 不合法：${id || '(empty)'}`);
  return id;
}

export function parseIdFromVolumeName(name: string): string | null {
  const m = /^woc-data-([0-9a-f]{10})$/.exec(name);
  return m ? m[1] : null;
}

export function parseIdFromContainerName(name: string): string | null {
  const m = /^woc-app-([0-9a-f]{10})$/.exec(name);
  return m ? m[1] : null;
}

export function normalizeProjectContainerName(raw: string): string {
  const name = raw.replace(/^\//, '');
  return assertProjectContainerName(name);
}

export function normalizeDockerNetworkName(raw: string | null | undefined): string | null {
  const name = String(raw || '').trim();
  if (!name) return null;
  if (name === 'host' || name === 'none') throw new Error(`拒绝使用 Docker ${name} 网络`);
  if (!NETWORK_NAME_RE.test(name)) throw new Error(`Docker 网络名不合法：${name}`);
  return name;
}

export function assertVideoDevice(path: string): string {
  if (!VIDEO_DEVICE_RE.test(path)) throw new Error(`视频设备路径不合法：${path || '(empty)'}`);
  return path;
}
