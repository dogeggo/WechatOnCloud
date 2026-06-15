import type { VolEntry } from '../api';

export function joinVolumePath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export function parentVolumePath(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

export function splitVolumePath(path: string): string[] {
  return path ? path.split('/') : [];
}

export function normalizeMoveTarget(currentPath: string, value: string): string {
  const name = value.trim();
  return name.includes('/') ? name.replace(/^\/+/, '') : joinVolumePath(currentPath, name);
}

export function sortVolumeEntries(entries: VolEntry[]): VolEntry[] {
  return [...entries].sort((left, right) => {
    if ((left.type === 'dir') !== (right.type === 'dir')) return left.type === 'dir' ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh');
  });
}
