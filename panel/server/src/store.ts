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
  containerName: string; // woc-wx-<id>
  volumeName: string; // woc-data-<id>
  kasmUser: string; // 随机生成，服务端注入反代，永不下发前端
  kasmPassword: string;
  createdAt: string;
  createdBy: string; // OIDC 邮箱
  // 自愈 watchdog 的 per-instance 覆盖；缺省时使用 env / 内置默认。
  memSoftLimitMB?: number;
  memHardLimitMB?: number;
}

interface Data {
  instances: Instance[];
}

const FILE = '/data/accounts.json';

let data: Data = { instances: [] };

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

export function initStore() {
  if (existsSync(FILE)) {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    data = { instances: Array.isArray(raw.instances) ? raw.instances : [] };
  } else {
    data = { instances: [] };
  }
  persist();
}

export function publicInstance(i: Instance) {
  return {
    id: i.id,
    name: i.name,
    createdAt: i.createdAt,
    createdBy: i.createdBy,
    memSoftLimitMB: i.memSoftLimitMB,
    memHardLimitMB: i.memHardLimitMB,
  };
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
) {
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
  const inst: Instance = {
    id,
    name: name.trim() || `微信-${id.slice(0, 4)}`,
    containerName: `woc-wx-${id}`,
    volumeName,
    kasmUser: 'woc',
    // 用 hex（仅 0-9a-f）：容器内 init 脚本以 `openssl passwd -apr1 ${PASSWORD}` 未加引号方式生成 .htpasswd。
    kasmPassword: randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
    createdBy,
  };
  assertResourceIdMatch(inst.id, inst.containerName, inst.volumeName);
  data.instances.push(inst);
  persist();
  return inst;
}

export function renameInstance(id: string, name: string) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const n = (name || '').trim();
  if (!n || n.length > 30) throw new Error('实例名称为 1-30 个字符');
  inst.name = n;
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

// 已登记一个实例（迁移用：复用旧 ./data 卷）。返回是否新建。
export function registerExistingInstance(opts: {
  name: string;
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
  const inst: Instance = { id, createdAt: new Date().toISOString(), ...opts };
  data.instances.push(inst);
  persist();
  return inst;
}
