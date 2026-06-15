import type { DesktopClientReplacedEvent } from '../../api';

export const DESKTOP_CLIENT_REPLACED_EVENT = 'woc:desktop-client-replaced';

export function dispatchDesktopClientReplaced(event: DesktopClientReplacedEvent): void {
  window.dispatchEvent(new CustomEvent<DesktopClientReplacedEvent>(DESKTOP_CLIENT_REPLACED_EVENT, { detail: event }));
}
