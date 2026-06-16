export type ImeSubmitKey = 'enter' | 'ctrlEnter';
export type DesktopInputMode = 'forward' | 'seamless';
export interface VncFrameStreamSettings {
  quality: number;
  compression: number;
}

const IME_SUBMIT_KEY = 'woc_ime_submit_key';
const DESKTOP_INPUT_MODE_KEY = 'woc_input_mode';
const VNC_STYLE_ID = 'woc-vnc-style';
const VNC_KEYBOARD_INPUT_ID = 'noVNC_keyboardinput';
const IME_ANCHOR_MARGIN = 8;
const IME_ANCHOR_WIDTH = 2;
const IME_ANCHOR_HEIGHT = 24;
const DEFAULT_IME_ANCHOR_X = 24;
const DEFAULT_IME_ANCHOR_Y = 24;

const VNC_CONTROL_STYLE =
  '#noVNC_control_bar_anchor{z-index:2147483647!important;}' +
  '#noVNC_control_bar{background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.55)!important;box-shadow:0 0 24px rgba(0,0,0,.55)!important;}' +
  '#noVNC_control_bar_handle{opacity:1!important;background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.5)!important;}' +
  '#noVNC_keyboardinput{position:fixed!important;left:24px!important;top:24px!important;width:2px!important;height:24px!important;min-width:2px!important;min-height:24px!important;margin:0!important;padding:0!important;border:0!important;outline:0!important;opacity:.01!important;overflow:hidden!important;resize:none!important;background:transparent!important;color:transparent!important;caret-color:transparent!important;pointer-events:none!important;}';

export function readImeSubmitKey(): ImeSubmitKey {
  return window.localStorage.getItem(IME_SUBMIT_KEY) === 'ctrlEnter' ? 'ctrlEnter' : 'enter';
}

export function writeImeSubmitKey(value: ImeSubmitKey): void {
  window.localStorage.setItem(IME_SUBMIT_KEY, value);
}

export function readDesktopInputMode(): DesktopInputMode {
  return window.localStorage.getItem(DESKTOP_INPUT_MODE_KEY) === 'seamless' ? 'seamless' : 'forward';
}

export function writeDesktopInputMode(value: DesktopInputMode): void {
  window.localStorage.setItem(DESKTOP_INPUT_MODE_KEY, value);
  writeKasmImeMode(value);
}

export function writeKasmImeMode(value: DesktopInputMode): void {
  window.localStorage.setItem('enable_ime', value === 'seamless' ? 'true' : 'false');
}

export function focusVncFrame(frame: HTMLIFrameElement | null): void {
  frame?.focus();
  frame?.contentWindow?.focus();
  const keyboardInput = frame?.contentDocument?.getElementById(VNC_KEYBOARD_INPUT_ID) as HTMLElement | null;
  keyboardInput?.focus();
}

export function blurVncFrame(frame: HTMLIFrameElement | null): void {
  frame?.contentWindow?.blur();
  frame?.blur();
}

export function isVncFrameDisconnected(frame: HTMLIFrameElement | null): boolean {
  try {
    const win = frame?.contentWindow;
    const doc = frame?.contentDocument;
    if (!win || !doc) return false;

    if (hasKasmFatalError(doc) || hasNoVncDisconnectedClass(doc)) return true;

    const state = readNoVncConnectionState(win);
    if (state === 'disconnected' || state === 'disconnecting') return true;
    if (state === 'connected' || state === 'connecting') return false;

    if (hasMissingRfbAfterLoad(win, doc)) return true;

    const status = doc.getElementById('noVNC_status')?.textContent?.trim().toLowerCase() || '';
    return /disconnected|disconnect|connection closed|failed|closed|已断开|断开|连接关闭|失败/.test(status);
  } catch {
    return false;
  }
}

export function injectVncStyle(frame: HTMLIFrameElement | null): void {
  const doc = frame?.contentDocument;
  if (!doc || doc.getElementById(VNC_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = VNC_STYLE_ID;
  style.textContent = VNC_CONTROL_STYLE;
  (doc.head || doc.documentElement).appendChild(style);
}

export function applyVncStreamSettings(
  frame: HTMLIFrameElement | null,
  settings: VncFrameStreamSettings,
): boolean {
  try {
    const win = frame?.contentWindow;
    if (!win) return false;
    const rfb = readNoVncRfb(win);
    if (!isObjectRecord(rfb)) return false;
    rfb.qualityLevel = clampVncLevel(settings.quality);
    rfb.compressionLevel = clampVncLevel(settings.compression);
    return true;
  } catch {
    return false;
  }
}

function readNoVncConnectionState(win: Window): 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | null {
  const rfb = readNoVncRfb(win);
  if (!isObjectRecord(rfb)) return null;

  const rawState = rfb._rfbConnectionState ?? rfb._rfb_connection_state ?? rfb.connectionState;
  if (typeof rawState === 'string') {
    const state = rawState.toLowerCase();
    if (state === 'connecting' || state === 'connected' || state === 'disconnecting' || state === 'disconnected') return state;
  }

  const sock = isObjectRecord(rfb._sock) ? rfb._sock : null;
  const websocket = sock
    ? sock._websocket ?? sock._webSocket ?? sock.websocket ?? sock.webSocket
    : null;
  if (!isObjectRecord(websocket) || typeof websocket.readyState !== 'number') return null;

  if (websocket.readyState === WebSocket.OPEN) return 'connected';
  if (websocket.readyState === WebSocket.CONNECTING) return 'connecting';
  if (websocket.readyState === WebSocket.CLOSING) return 'disconnecting';
  if (websocket.readyState === WebSocket.CLOSED) return 'disconnected';
  return null;
}

function readNoVncRfb(win: Window): unknown {
  const frameWindow = win as Window & {
    UI?: { rfb?: unknown };
    rfb?: unknown;
  };
  return frameWindow.UI?.rfb ?? frameWindow.rfb;
}

function hasNoVncDisconnectedClass(doc: Document): boolean {
  return doc.documentElement.classList.contains('noVNC_disconnected');
}

function hasKasmFatalError(doc: Document): boolean {
  const text = [
    doc.title,
    doc.getElementById('noVNC_status')?.textContent || '',
    (doc.body?.innerText || '').slice(0, 4000),
  ].join('\n').toLowerCase();

  return (
    text.includes('kasmvnc 遇到错误') ||
    text.includes('kasmvnc encountered an error') ||
    text.includes('cannot read properties of undefined') ||
    text.includes('lastactiveat') ||
    text.includes('session disconnected') ||
    text.includes('something went wrong, connection is closed') ||
    text.includes('failed to connect to server')
  );
}

function hasMissingRfbAfterLoad(win: Window, doc: Document): boolean {
  if (doc.readyState !== 'complete') return false;
  const frameWindow = win as Window & { UI?: unknown };
  if (!isObjectRecord(frameWindow.UI)) return false;
  if (!('rfb' in frameWindow.UI)) return false;
  if (isObjectRecord(frameWindow.UI.rfb)) return false;
  return frameWindow.UI.connected === false || hasNoVncDisconnectedClass(doc);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function clampVncLevel(value: number): number {
  if (!Number.isFinite(value)) return 6;
  return Math.max(0, Math.min(9, Math.round(value)));
}

export function installImeCandidateAnchor(doc: Document): () => void {
  let anchor = clampImeAnchor(doc, DEFAULT_IME_ANCHOR_X, DEFAULT_IME_ANCHOR_Y);

  const applyAnchor = () => {
    const input = doc.getElementById(VNC_KEYBOARD_INPUT_ID) as HTMLElement | null;
    if (!input) return;
    setImeAnchorStyle(input, anchor.x, anchor.y);
  };

  const moveAnchor = (clientX: number, clientY: number) => {
    anchor = clampImeAnchor(doc, clientX, clientY);
    applyAnchor();
  };

  const onPointerDown = (event: Event) => {
    const pointerEvent = event as PointerEvent;
    moveAnchor(pointerEvent.clientX, pointerEvent.clientY);
  };
  const onReapply = () => applyAnchor();
  const win = doc.defaultView;

  applyAnchor();
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('focusin', onReapply, true);
  doc.addEventListener('compositionstart', onReapply, true);
  win?.addEventListener('resize', onReapply);

  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('focusin', onReapply, true);
    doc.removeEventListener('compositionstart', onReapply, true);
    win?.removeEventListener('resize', onReapply);
  };
}

function clampImeAnchor(doc: Document, clientX: number, clientY: number): { x: number; y: number } {
  const win = doc.defaultView;
  const viewportWidth = doc.documentElement.clientWidth || win?.innerWidth || 0;
  const viewportHeight = doc.documentElement.clientHeight || win?.innerHeight || 0;
  const maxX = viewportWidth
    ? Math.max(IME_ANCHOR_MARGIN, viewportWidth - IME_ANCHOR_MARGIN - IME_ANCHOR_WIDTH)
    : clientX;
  const maxY = viewportHeight
    ? Math.max(IME_ANCHOR_MARGIN, viewportHeight - IME_ANCHOR_MARGIN - IME_ANCHOR_HEIGHT)
    : clientY;
  return {
    x: Math.round(Math.min(Math.max(clientX, IME_ANCHOR_MARGIN), maxX)),
    y: Math.round(Math.min(Math.max(clientY, IME_ANCHOR_MARGIN), maxY)),
  };
}

function setImeAnchorStyle(input: HTMLElement, x: number, y: number): void {
  input.style.setProperty('position', 'fixed', 'important');
  input.style.setProperty('left', `${x}px`, 'important');
  input.style.setProperty('top', `${y}px`, 'important');
  input.style.setProperty('width', `${IME_ANCHOR_WIDTH}px`, 'important');
  input.style.setProperty('height', `${IME_ANCHOR_HEIGHT}px`, 'important');
  input.style.setProperty('min-width', `${IME_ANCHOR_WIDTH}px`, 'important');
  input.style.setProperty('min-height', `${IME_ANCHOR_HEIGHT}px`, 'important');
  input.style.setProperty('margin', '0', 'important');
  input.style.setProperty('padding', '0', 'important');
  input.style.setProperty('border', '0', 'important');
  input.style.setProperty('outline', '0', 'important');
  input.style.setProperty('opacity', '.01', 'important');
  input.style.setProperty('overflow', 'hidden', 'important');
  input.style.setProperty('resize', 'none', 'important');
  input.style.setProperty('background', 'transparent', 'important');
  input.style.setProperty('color', 'transparent', 'important');
  input.style.setProperty('caret-color', 'transparent', 'important');
  input.style.setProperty('pointer-events', 'none', 'important');
}

export function pushClipboardToRemote(frame: HTMLIFrameElement | null, text: string): boolean {
  const doc = frame?.contentDocument;
  const win = frame?.contentWindow;
  const textarea = doc?.getElementById('noVNC_clipboard_text') as HTMLTextAreaElement | null;
  if (!doc || !win || !textarea) return false;
  textarea.value = text;
  const ChangeEvent = (win as Window & typeof globalThis).Event;
  textarea.dispatchEvent(new ChangeEvent('change', { bubbles: true }));
  return true;
}

export function pullClipboardFromRemote(frame: HTMLIFrameElement | null): string | null {
  const textarea = frame?.contentDocument?.getElementById('noVNC_clipboard_text') as HTMLTextAreaElement | null;
  return textarea ? textarea.value : null;
}
