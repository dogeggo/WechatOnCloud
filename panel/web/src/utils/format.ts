const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(value: number): string {
  if (value === 0) return '0 B';
  const unitIndex = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / Math.pow(1024, unitIndex)).toFixed(unitIndex ? 1 : 0)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatDate(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatIsoDate(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatDate(ms) : '时间格式错误';
}

export function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
