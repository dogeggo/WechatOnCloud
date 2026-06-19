export const MIB = 1024 * 1024;

function envNumber(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === '' ? defaultValue : Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 之间的数字`);
  }
  return n;
}

// 每个实例容器的 cgroup 内存硬上限。0 = 不限制。
export const instanceMemoryLimitGB = envNumber('WOC_INSTANCE_MEM_GB', 0, 0, 64);
export const instanceMemoryLimitBytes =
  instanceMemoryLimitGB > 0 ? Math.floor(instanceMemoryLimitGB * 1024 * MIB) : 0;
export const instanceMemoryLimitMB =
  instanceMemoryLimitBytes > 0 ? Math.floor(instanceMemoryLimitBytes / MIB) : 0;
