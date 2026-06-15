export function parseOptionalMiB(value: string): number | null {
  const normalized = value.trim();
  if (normalized === '') return null;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed)) throw new Error('阈值需为整数（MiB）');
  return parsed;
}

export function validateMemLimits(soft: number | null, hard: number | null): void {
  if (soft != null && hard != null && soft >= hard) throw new Error('soft 阈值需小于 hard 阈值');
}
