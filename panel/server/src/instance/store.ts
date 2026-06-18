import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  assertInstanceId,
  assertProjectContainerName,
  assertProjectVolumeName,
  parseIdFromContainerName,
  parseIdFromVolumeName,
} from './resource-guard.js';

export interface Instance {
  id: string; // 短 id，用于容器/卷命名
  name: string; // 显示名
  appType: AppType; // 承载的应用类型
  icon?: string; // 自定义图标：data:image/... 或 builtin:<key>
  containerName: string; // woc-app-<id>
  volumeName: string; // woc-data-<id>
  kasmUser: string; // 随机生成，服务端注入反代，永不下发前端
  kasmPassword: string;
  createdAt: string;
  createdBy: string; // OIDC 邮箱
  // 自愈 watchdog 的 per-instance 覆盖；缺省时使用 env / 内置默认。
  memSoftLimitMB?: number;
  memHardLimitMB?: number;
}

export interface InstanceActor {
  email: string;
  isAdmin: boolean;
}

export interface UnusedVolumeOwnership {
  name: string;
  appType: AppType;
  retainedAt: string;
}

interface Data {
  instances: Instance[];
  unusedVolumes: UnusedVolumeOwnership[];
}

const FILE = '/data/accounts.json';

let data: Data = { instances: [], unusedVolumes: [] };

export type AppType = 'wechat' | 'chromium' | 'qq' | 'telegram';
export const APP_TYPES: AppType[] = ['wechat', 'qq', 'telegram', 'chromium'];

export function normalizeAppType(value: unknown): AppType {
  if (typeof value === 'string' && APP_TYPES.includes(value as AppType)) return value as AppType;
  throw new Error('应用类型不合法');
}

export function normalizeInstanceName(name: string): string {
  const n = String(name || '').trim();
  if (!n || n.length > 30) throw new Error('实例名称为 1-30 个字符');
  return n;
}

function newInstanceId(): string {
  for (let i = 0; i < 20; i++) {
    const id = randomBytes(5).toString('hex');
    if (!findInstance(id)) return id;
  }
  throw new Error('无法生成唯一实例 ID');
}

function assertResourceIdMatch(id: string, containerName: string, volumeName: string): string {
  assertInstanceId(id);
  assertProjectContainerName(containerName);
  assertProjectVolumeName(volumeName);
  const containerId = parseIdFromContainerName(containerName);
  const volumeId = parseIdFromVolumeName(volumeName);
  if (containerId !== id || volumeId !== id) {
    throw new Error('实例 ID、容器名与数据卷名不一致');
  }
  return id;
}

function persist() {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, FILE);
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} 不能为空`);
  return v.trim();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function asOptionalLimit(v: unknown, name: string): number | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 20480) {
    throw new Error(`${name} 需为 1-20480 之间的整数（MiB）`);
  }
  return v;
}

function normalizeInstanceIcon(icon: unknown): string | undefined {
  if (icon == null) return undefined;
  if (typeof icon !== 'string') throw new Error('图标格式不合法');
  const value = icon.trim();
  if (!value) return undefined;
  if (/^builtin:[a-z0-9_-]{1,32}$/.test(value)) return value;
  if (value.startsWith('data:image/') && value.length <= 300000) return value;
  throw new Error('图标格式不合法或过大');
}

function parseInstance(raw: any): Instance {
  if (!raw || typeof raw !== 'object') throw new Error('实例数据格式不合法');
  const id = asString(raw.id, '实例 ID');
  const name = normalizeInstanceName(asString(raw.name, '实例名称'));
  const appType = normalizeAppType(raw.appType);
  const icon = normalizeInstanceIcon(raw.icon);
  const containerName = asString(raw.containerName, '容器名');
  const volumeName = asString(raw.volumeName, '数据卷名');
  const kasmUser = asString(raw.kasmUser, 'Kasm 用户名');
  const kasmPassword = asString(raw.kasmPassword, 'Kasm 密码');
  const createdAt = new Date(asString(raw.createdAt, '创建时间')).toISOString();
  const createdBy = normalizeEmail(asString(raw.createdBy, '创建者'));
  const memSoftLimitMB = asOptionalLimit(raw.memSoftLimitMB, 'soft 阈值');
  const memHardLimitMB = asOptionalLimit(raw.memHardLimitMB, 'hard 阈值');
  const inst: Instance = {
    id,
    name,
    appType,
    icon,
    containerName,
    volumeName,
    kasmUser,
    kasmPassword,
    createdAt,
    createdBy,
    memSoftLimitMB,
    memHardLimitMB,
  };
  assertResourceIdMatch(inst.id, inst.containerName, inst.volumeName);
  if (inst.memSoftLimitMB != null && inst.memHardLimitMB != null && inst.memSoftLimitMB >= inst.memHardLimitMB) {
    throw new Error('soft 阈值需小于 hard 阈值');
  }
  return inst;
}

function parseUnusedVolumeOwnership(raw: any): UnusedVolumeOwnership {
  if (!raw || typeof raw !== 'object') throw new Error('保留数据卷记录格式不合法');
  const name = asString(raw.name, '数据卷名');
  assertProjectVolumeName(name);
  return {
    name,
    appType: normalizeAppType(raw.appType),
    retainedAt: new Date(asString(raw.retainedAt, '保留时间')).toISOString(),
  };
}

function normalizeStoreData(raw: unknown): Data {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).instances)) {
    throw new Error('账户数据文件格式不合法');
  }
  data = {
    instances: (raw as any).instances.map(parseInstance),
    unusedVolumes: Array.isArray((raw as any).unusedVolumes)
      ? (raw as any).unusedVolumes.map(parseUnusedVolumeOwnership)
      : [],
  };
  return data;
}

export function initStore() {
  if (existsSync(FILE)) {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    normalizeStoreData(raw);
  } else {
    data = { instances: [], unusedVolumes: [] };
  }
  persist();
}

export function publicInstance(i: Instance) {
  return {
    id: i.id,
    name: i.name,
    appType: i.appType,
    icon: i.icon,
    createdAt: i.createdAt,
    createdBy: i.createdBy,
    memSoftLimitMB: i.memSoftLimitMB,
    memHardLimitMB: i.memHardLimitMB,
  };
}

export function canAccessInstance(inst: Instance, actor: InstanceActor): boolean {
  return actor.isAdmin || normalizeEmail(inst.createdBy) === normalizeEmail(actor.email);
}

export function setInstanceMemLimits(
  id: string,
  softMB: number | null,
  hardMB: number | null,
) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const norm = (v: number | null): number | undefined => {
    if (v == null) return undefined;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 20480) {
      throw new Error('阈值需为 1-20480 之间的整数（MiB）');
    }
    return v;
  };
  const s = norm(softMB);
  const h = norm(hardMB);
  if (s != null && h != null && s >= h) throw new Error('soft 阈值需小于 hard 阈值');
  inst.memSoftLimitMB = s;
  inst.memHardLimitMB = h;
  persist();
  return publicInstance(inst);
}

export function listInstances() {
  return data.instances.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findInstance(id: string) {
  return data.instances.find((i) => i.id === id);
}

export function createInstance(
  name: string,
  createdBy: string,
  reuseVolumeName?: string,
  appType: AppType = 'wechat',
) {
  const type = normalizeAppType(appType);
  let id = newInstanceId(); // 10 hex chars
  let volumeName = `woc-data-${id}`;
  if (reuseVolumeName) {
    assertProjectVolumeName(reuseVolumeName);
    const reusedId = parseIdFromVolumeName(reuseVolumeName);
    if (!reusedId) throw new Error('复用卷名不合法');
    if (findInstance(reusedId)) {
      throw new Error('该数据卷对应的实例 ID 已存在，不能复用');
    }
    id = reusedId;
    volumeName = reuseVolumeName;
  }
  const displayName = normalizeInstanceName(name);
  const inst: Instance = {
    id,
    name: displayName,
    appType: type,
    containerName: `woc-app-${id}`,
    volumeName,
    kasmUser: 'woc',
    // 用 hex（仅 0-9a-f）：容器内 init 脚本以 `openssl passwd -apr1 ${PASSWORD}` 未加引号方式生成 .htpasswd。
    kasmPassword: randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
    createdBy: normalizeEmail(createdBy),
  };
  assertResourceIdMatch(inst.id, inst.containerName, inst.volumeName);
  data.instances.push(inst);
  persist();
  return inst;
}

export function renameInstance(id: string, name: string) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  inst.name = normalizeInstanceName(name);
  persist();
  return publicInstance(inst);
}

export function setInstanceIcon(id: string, icon: unknown) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const value = normalizeInstanceIcon(icon);
  if (value) inst.icon = value;
  else delete inst.icon;
  persist();
  return publicInstance(inst);
}

export function removeInstance(id: string) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  data.instances = data.instances.filter((i) => i.id !== id);
  persist();
  return inst;
}

export function listUnusedVolumeOwnerships() {
  return data.unusedVolumes.slice().sort((a, b) => a.retainedAt.localeCompare(b.retainedAt));
}

export function findUnusedVolumeOwnership(name: string) {
  assertProjectVolumeName(name);
  return data.unusedVolumes.find((volume) => volume.name === name);
}

export function rememberUnusedVolume(name: string, appType: AppType) {
  assertProjectVolumeName(name);
  const type = normalizeAppType(appType);
  const retainedAt = new Date().toISOString();
  const existing = data.unusedVolumes.find((volume) => volume.name === name);
  if (existing) {
    existing.appType = type;
    existing.retainedAt = retainedAt;
  } else {
    data.unusedVolumes.push({ name, appType: type, retainedAt });
  }
  persist();
}

export function forgetUnusedVolume(name: string) {
  assertProjectVolumeName(name);
  const next = data.unusedVolumes.filter((volume) => volume.name !== name);
  if (next.length === data.unusedVolumes.length) return;
  data.unusedVolumes = next;
  persist();
}

// 已登记一个实例（迁移用：复用旧 ./data 卷）。返回是否新建。
export function registerExistingInstance(opts: {
  name: string;
  appType: AppType;
  containerName: string;
  volumeName: string;
  kasmUser: string;
  kasmPassword: string;
  createdBy: string;
}) {
  assertProjectContainerName(opts.containerName);
  assertProjectVolumeName(opts.volumeName);
  const containerId = parseIdFromContainerName(opts.containerName);
  const volumeId = parseIdFromVolumeName(opts.volumeName);
  if (!containerId || !volumeId || containerId !== volumeId) {
    throw new Error('迁移实例的容器名与数据卷名不一致');
  }
  if (findInstance(containerId)) throw new Error('实例已存在');
  const id = containerId;
  assertResourceIdMatch(id, opts.containerName, opts.volumeName);
  const inst: Instance = {
    id,
    name: normalizeInstanceName(opts.name),
    appType: normalizeAppType(opts.appType),
    containerName: opts.containerName,
    volumeName: opts.volumeName,
    kasmUser: asString(opts.kasmUser, 'Kasm 用户名'),
    kasmPassword: asString(opts.kasmPassword, 'Kasm 密码'),
    createdAt: new Date().toISOString(),
    createdBy: normalizeEmail(asString(opts.createdBy, '创建者')),
  };
  data.instances.push(inst);
  persist();
  return inst;
}
