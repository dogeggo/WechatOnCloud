import type { DesktopClientReplacedEvent } from '../../api';

export const DESKTOP_CLIENT_REPLACED_EVENT = 'woc:desktop-client-replaced';
export const DESKTOP_INSTANCE_FOCUSED_EVENT = 'woc:desktop-instance-focused';

export interface DesktopInstanceFocusedEvent {
  instanceId: string;
}

export function dispatchDesktopClientReplaced(event: DesktopClientReplacedEvent): void {
  window.dispatchEvent(new CustomEvent<DesktopClientReplacedEvent>(DESKTOP_CLIENT_REPLACED_EVENT, { detail: event }));
}

export function dispatchDesktopInstanceFocused(instanceId: string): void {
  window.dispatchEvent(new CustomEvent<DesktopInstanceFocusedEvent>(DESKTOP_INSTANCE_FOCUSED_EVENT, { detail: { instanceId } }));
}
