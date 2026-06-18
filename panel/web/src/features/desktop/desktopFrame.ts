export interface VncFrameStreamSettings {
  quality: number;
  compression: number;
}

const VNC_STYLE_ID = 'woc-vnc-style';
const VNC_KEYBOARD_INPUT_ID = 'noVNC_keyboardinput';
const IME_ANCHOR_MARGIN = 8;
const IME_ANCHOR_WIDTH = 2;
const IME_ANCHOR_HEIGHT = 24;
const DEFAULT_IME_ANCHOR_X = 24;
const DEFAULT_IME_ANCHOR_Y = 24;
const IME_REFOCUS_DELAYS = [0, 80, 240] as const;
const IME_FOCUS_SKIP_SELECTOR =
  'input,textarea,select,button,[contenteditable="true"],#noVNC_control_bar_anchor,#noVNC_control_bar,#noVNC_control_bar_handle';

const VNC_CONTROL_STYLE =
  '#noVNC_control_bar_anchor{z-index:2147483647!important;}' +
  '#noVNC_control_bar{background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.55)!important;box-shadow:0 0 24px rgba(0,0,0,.55)!important;}' +
  '#noVNC_control_bar_handle{opacity:1!important;background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.5)!important;}' +
  '#noVNC_keyboardinput{position:fixed!important;left:24px!important;top:24px!important;width:2px!important;height:24px!important;min-width:2px!important;min-height:24px!important;margin:0!important;padding:0!important;border:0!important;outline:0!important;opacity:.01!important;overflow:hidden!important;resize:none!important;background:transparent!important;color:transparent!important;caret-color:transparent!important;pointer-events:none!important;}';

export function enableKasmImeMode(): void {
  try {
    window.localStorage.setItem('enable_ime', 'true');
  } catch {
    // 浏览器禁用 localStorage 时不阻断桌面加载。
  }
}

export function focusVncFrame(frame: HTMLIFrameElement | null): void {
  frame?.focus();
  frame?.contentWindow?.focus();
  focusVncKeyboardInput(frame?.contentDocument || null);
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

export function requestVncFullRefresh(frame: HTMLIFrameElement | null): boolean {
  try {
    const win = frame?.contentWindow;
    const rfb = readNoVncRfb(win);
    if (!isObjectRecord(rfb)) return false;

    const sock = isObjectRecord(rfb._sock) ? rfb._sock : null;
    const width = typeof rfb._fbWidth === 'number' ? rfb._fbWidth : 0;
    const height = typeof rfb._fbHeight === 'number' ? rfb._fbHeight : 0;
    const messages = (rfb as {
      constructor?: {
        messages?: {
          fbUpdateRequest?: (...args: unknown[]) => void;
        };
      };
    }).constructor?.messages;

    if (!sock || !messages || typeof messages.fbUpdateRequest !== 'function') return false;
    if (width <= 0 || height <= 0) return false;

    messages.fbUpdateRequest(sock, false, 0, 0, width, height);
    return true;
  } catch {
    return false;
  }
}

export function syncVncFrameSize(frame: HTMLIFrameElement | null): boolean {
  try {
    const win = frame?.contentWindow;
    if (!win) return false;

    const ResizeEvent = (win as Window & typeof globalThis).Event;
    win.dispatchEvent(new ResizeEvent('resize'));

    const rfb = readNoVncRfb(win);
    if (isObjectRecord(rfb)) {
      // noVNC requests a remote desktop resize when resizeSession is enabled.
      // Flip it so returning from a hidden keep-alive iframe always recalculates.
      rfb.resizeSession = false;
      rfb.resizeSession = true;
    }

    const ui = readNoVncUi(win);
    if (ui) {
      callNoArgMethod(ui, 'applyResizeMode');
      callNoArgMethod(ui, 'updateViewClip');
    }

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
    rfb?: unknown;
  };
  return readNoVncUi(win)?.rfb ?? frameWindow.rfb;
}

function readNoVncUi(win: Window): Record<string, unknown> | null {
  const frameWindow = win as Window & { UI?: unknown };
  return isObjectRecord(frameWindow.UI) ? frameWindow.UI : null;
}

function callNoArgMethod(target: Record<string, unknown>, key: string): boolean {
  const fn = target[key];
  if (typeof fn !== 'function') return false;
  (fn as () => void).call(target);
  return true;
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
  let keyboardInput: HTMLElement | null = null;
  let focusTimers: number[] = [];
  const win = doc.defaultView;

  const applyAnchor = () => {
    const input = readVncKeyboardInput(doc);
    keyboardInput = input;
    if (!input) return false;
    setImeAnchorStyle(input, anchor.x, anchor.y);
    return true;
  };

  const moveAnchor = (clientX: number, clientY: number) => {
    anchor = clampImeAnchor(doc, clientX, clientY);
    applyAnchor();
  };

  const clearFocusTimers = () => {
    if (!win) return;
    focusTimers.forEach((timer) => win.clearTimeout(timer));
    focusTimers = [];
  };

  const focusKeyboardInput = () => {
    applyAnchor();
    focusVncKeyboardInput(doc);
  };

  const scheduleKeyboardFocus = () => {
    if (!win) return;
    clearFocusTimers();
    focusTimers = IME_REFOCUS_DELAYS.map((delay) =>
      win.setTimeout(() => {
        focusKeyboardInput();
      }, delay),
    );
  };

  const onPointerDown = (event: Event) => {
    const pointerEvent = event as PointerEvent;
    moveAnchor(pointerEvent.clientX, pointerEvent.clientY);
    if (shouldFocusImeFromPointer(pointerEvent.target)) {
      focusKeyboardInput();
      scheduleKeyboardFocus();
    }
  };
  const onReapply = () => applyAnchor();
  const onFrameFocus = () => scheduleKeyboardFocus();
  const onVisibilityChange = () => {
    if (!doc.hidden) scheduleKeyboardFocus();
  };
  const MutationObserverCtor = win?.MutationObserver ?? MutationObserver;
  const observer = new MutationObserverCtor(() => {
    if (readVncKeyboardInput(doc) === keyboardInput) return;
    applyAnchor();
    scheduleKeyboardFocus();
  });

  applyAnchor();
  scheduleKeyboardFocus();
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('focusin', onReapply, true);
  doc.addEventListener('compositionstart', onReapply, true);
  doc.addEventListener('visibilitychange', onVisibilityChange);
  win?.addEventListener('focus', onFrameFocus);
  win?.addEventListener('resize', onReapply);

  return () => {
    clearFocusTimers();
    observer.disconnect();
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('focusin', onReapply, true);
    doc.removeEventListener('compositionstart', onReapply, true);
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    win?.removeEventListener('focus', onFrameFocus);
    win?.removeEventListener('resize', onReapply);
  };
}

function readVncKeyboardInput(doc: Document | null): HTMLElement | null {
  return doc?.getElementById(VNC_KEYBOARD_INPUT_ID) as HTMLElement | null;
}

function focusVncKeyboardInput(doc: Document | null): boolean {
  const input = readVncKeyboardInput(doc);
  if (!input) return false;

  input.focus({ preventScroll: true });
  const textarea = input as HTMLTextAreaElement;
  if (typeof textarea.setSelectionRange === 'function') {
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }
  return doc?.activeElement === input;
}

function shouldFocusImeFromPointer(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return true;
  return !(target as Element).closest(IME_FOCUS_SKIP_SELECTOR);
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
