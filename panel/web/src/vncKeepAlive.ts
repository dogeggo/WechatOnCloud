const VNC_KEEP_ALIVE_PREFIX = 'woc_vnc_keep_alive_';

export const VNC_KEEP_ALIVE_EVENT = 'woc:vnc-keep-alive';

export interface VncKeepAliveChange {
  id: string;
  enabled: boolean;
}

function keyOf(id: string) {
  return `${VNC_KEEP_ALIVE_PREFIX}${id}`;
}

export function isVncKeepAliveKey(key: string | null): boolean {
  return !!key && key.startsWith(VNC_KEEP_ALIVE_PREFIX);
}

export function idFromVncKeepAliveKey(key: string): string {
  return key.slice(VNC_KEEP_ALIVE_PREFIX.length);
}

export function isVncKeepAliveEnabled(id: string): boolean {
  return window.localStorage.getItem(keyOf(id)) === '1';
}

export function setVncKeepAliveEnabled(id: string, enabled: boolean): void {
  if (enabled) window.localStorage.setItem(keyOf(id), '1');
  else window.localStorage.removeItem(keyOf(id));
  window.dispatchEvent(new CustomEvent<VncKeepAliveChange>(VNC_KEEP_ALIVE_EVENT, { detail: { id, enabled } }));
}
