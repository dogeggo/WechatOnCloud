export interface VncFrameStreamSettings {
  quality: number;
  compression: number;
  dynamicQualityMin: number;
  dynamicQualityMax: number;
  treatLossless: number;
  jpegVideoQuality: number;
  webpVideoQuality: number;
  videoQuality: number;
  videoArea: number;
  videoTime: number;
  videoOutTime: number;
  videoScaling: number;
  maxVideoResolutionX: number;
  maxVideoResolutionY: number;
  frameRate: number;
  enableWebP: boolean;
}

const VNC_STYLE_ID = 'woc-vnc-style';
const VNC_KEYBOARD_INPUT_ID = 'noVNC_keyboardinput';
const IME_PREVIEW_ID = 'woc-ime-preview';
const IME_ANCHOR_MARGIN = 8;
const IME_ANCHOR_HEIGHT = 34;
const IME_HIDDEN_INPUT_WIDTH = 2;
const IME_HIDDEN_INPUT_HEIGHT = 24;
const IME_PREVIEW_MIN_WIDTH = 1;
const IME_PREVIEW_MAX_WIDTH = 360;
const IME_PREVIEW_HORIZONTAL_PADDING = 0;
const IME_PREVIEW_HEIGHT = 22;
const IME_PREVIEW_FONT = '14px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';
const IME_PREVIEW_BOX_FONT = '14px/18px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';
const IME_CANDIDATE_OFFSET_Y = 0;
const IME_PREVIEW_OFFSET_Y = -6;
const DEFAULT_IME_ANCHOR_X = 24;
const DEFAULT_IME_ANCHOR_Y = 24;
const IME_REFOCUS_DELAYS = [0, 80, 240] as const;
const IME_FOCUS_SKIP_SELECTOR =
  'input,textarea,select,button,[contenteditable="true"],#noVNC_control_bar_anchor,#noVNC_control_bar,#noVNC_control_bar_handle';

const VNC_CONTROL_STYLE =
  '#noVNC_control_bar_anchor{z-index:2147483647!important;}' +
  '#noVNC_control_bar{background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.55)!important;box-shadow:0 0 24px rgba(0,0,0,.55)!important;}' +
  '#noVNC_control_bar_handle{opacity:1!important;background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.5)!important;}' +
  '#noVNC_keyboardinput{position:fixed!important;left:24px!important;top:24px!important;width:2px!important;height:24px!important;min-width:2px!important;min-height:24px!important;margin:0!important;padding:0!important;border:0!important;outline:0!important;opacity:.01!important;overflow:hidden!important;resize:none!important;background:transparent!important;color:transparent!important;caret-color:transparent!important;pointer-events:none!important;}' +
  '#woc-ime-preview{position:fixed!important;left:24px!important;top:2px!important;width:1px!important;height:22px!important;min-width:1px!important;min-height:22px!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;outline:0!important;opacity:0!important;overflow:visible!important;background:transparent!important;color:#111!important;font-weight:400!important;text-shadow:none!important;box-shadow:none!important;pointer-events:none!important;z-index:2147483647!important;font:16px/22px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif!important;white-space:pre!important;transition:opacity .06s ease!important;}' +
  '#woc-ime-preview.woc-ime-preview--active{opacity:1!important;}';

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
    rfb.dynamicQualityMin = clampVncLevel(settings.dynamicQualityMin);
    rfb.dynamicQualityMax = clampVncLevel(settings.dynamicQualityMax);
    rfb.treatLossless = clampVncLevel(settings.treatLossless);
    rfb.jpegVideoQuality = clampVncLevel(settings.jpegVideoQuality);
    rfb.webpVideoQuality = clampVncLevel(settings.webpVideoQuality);
    rfb.videoQuality = clampInteger(settings.videoQuality, 0, 10);
    rfb.videoArea = clampInteger(settings.videoArea, 0, 100);
    rfb.videoTime = clampInteger(settings.videoTime, 0, 100);
    rfb.videoOutTime = clampInteger(settings.videoOutTime, 1, 100);
    rfb.videoScaling = clampInteger(settings.videoScaling, 0, 2);
    rfb.maxVideoResolutionX = clampInteger(settings.maxVideoResolutionX, 100, 7680);
    rfb.maxVideoResolutionY = clampInteger(settings.maxVideoResolutionY, 100, 4320);
    rfb.frameRate = clampInteger(settings.frameRate, 1, 120);
    rfb.enableWebP = settings.enableWebP;
    rfb.preferBandwidth = false;
    callNoArgMethod(rfb, 'updateConnectionSettings');
    return true;
  } catch {
    return false;
  }
}

export function requestVncFullRefresh(frame: HTMLIFrameElement | null): boolean {
  try {
    const win = frame?.contentWindow;
    if (!win) return false;
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

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function installImeCandidateAnchor(doc: Document): () => void {
  let anchor = clampImeAnchor(doc, DEFAULT_IME_ANCHOR_X, DEFAULT_IME_ANCHOR_Y);
  let keyboardInput: HTMLElement | null = null;
  let focusTimers: number[] = [];
  const win = doc.defaultView;

  const applyAnchor = () => {
    anchor = clampImeAnchor(doc, anchor.x, anchor.y);
    setImePreviewStyle(ensureImePreview(doc), anchor);
    const input = readVncKeyboardInput(doc);
    keyboardInput = input;
    if (!input) return false;
    setImeAnchorStyle(input, anchor);
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

  const setPreviewText = (text: string, keepVisible: boolean) => {
    const preview = ensureImePreview(doc);
    preview.textContent = text;
    applyAnchor();
    preview.classList.toggle('woc-ime-preview--active', keepVisible || text.length > 0);
  };

  const hidePreview = () => {
    const preview = readImePreview(doc);
    if (!preview) return;
    preview.textContent = '';
    preview.classList.remove('woc-ime-preview--active');
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
    if (!shouldFocusImeFromPointer(pointerEvent.target)) return;
    moveAnchor(pointerEvent.clientX, pointerEvent.clientY);
    hidePreview();
    focusKeyboardInput();
    scheduleKeyboardFocus();
  };
  const onReapply = () => applyAnchor();
  const onCompositionStart = (event: Event) => {
    if (!isVncKeyboardInputTarget(event.target)) return;
    applyAnchor();
    setPreviewText('', true);
  };
  const onCompositionUpdate = (event: Event) => {
    if (!isVncKeyboardInputTarget(event.target)) return;
    setPreviewText((event as CompositionEvent).data || '', true);
  };
  const onCompositionEnd = (event: Event) => {
    if (!isVncKeyboardInputTarget(event.target)) return;
    hidePreview();
  };
  const onFrameFocus = () => scheduleKeyboardFocus();
  const onVisibilityChange = () => {
    if (!doc.hidden) scheduleKeyboardFocus();
    else hidePreview();
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
  doc.addEventListener('compositionstart', onCompositionStart, true);
  doc.addEventListener('compositionupdate', onCompositionUpdate, true);
  doc.addEventListener('compositionend', onCompositionEnd, true);
  doc.addEventListener('visibilitychange', onVisibilityChange);
  win?.addEventListener('focus', onFrameFocus);
  win?.addEventListener('resize', onReapply);

  return () => {
    clearFocusTimers();
    readImePreview(doc)?.remove();
    observer.disconnect();
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('focusin', onReapply, true);
    doc.removeEventListener('compositionstart', onCompositionStart, true);
    doc.removeEventListener('compositionupdate', onCompositionUpdate, true);
    doc.removeEventListener('compositionend', onCompositionEnd, true);
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    win?.removeEventListener('focus', onFrameFocus);
    win?.removeEventListener('resize', onReapply);
  };
}

function readVncKeyboardInput(doc: Document | null): HTMLElement | null {
  return doc?.getElementById(VNC_KEYBOARD_INPUT_ID) as HTMLElement | null;
}

function isVncKeyboardInputTarget(target: EventTarget | null): boolean {
  return !!target && (target as HTMLElement).id === VNC_KEYBOARD_INPUT_ID;
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

function ensureImePreview(doc: Document): HTMLElement {
  const existing = readImePreview(doc);
  if (existing) return existing;
  const preview = doc.createElement('div');
  preview.id = IME_PREVIEW_ID;
  preview.setAttribute('aria-hidden', 'true');
  (doc.body || doc.documentElement).appendChild(preview);
  return preview;
}

function readImePreview(doc: Document | null): HTMLElement | null {
  return doc?.getElementById(IME_PREVIEW_ID);
}

function clampImeAnchor(doc: Document, clientX: number, clientY: number): { x: number; y: number } {
  const win = doc.defaultView;
  const viewportWidth = doc.documentElement.clientWidth || win?.innerWidth || 0;
  const viewportHeight = doc.documentElement.clientHeight || win?.innerHeight || 0;
  const maxX = viewportWidth
    ? Math.max(IME_ANCHOR_MARGIN, viewportWidth - IME_ANCHOR_MARGIN - IME_HIDDEN_INPUT_WIDTH)
    : clientX;
  const maxY = viewportHeight
    ? Math.max(
        IME_ANCHOR_MARGIN - IME_PREVIEW_OFFSET_Y,
        viewportHeight - IME_ANCHOR_MARGIN - IME_CANDIDATE_OFFSET_Y - IME_HIDDEN_INPUT_HEIGHT,
      )
    : clientY;
  return {
    x: Math.round(Math.min(Math.max(clientX, IME_ANCHOR_MARGIN), maxX)),
    y: Math.round(Math.min(Math.max(clientY, IME_ANCHOR_MARGIN), maxY)),
  };
}

function offsetImePoint(
  doc: Document,
  anchor: { x: number; y: number },
  offsetX: number,
  offsetY: number,
): { x: number; y: number } {
  const win = doc.defaultView;
  const viewportWidth = doc.documentElement.clientWidth || win?.innerWidth || 0;
  const viewportHeight = doc.documentElement.clientHeight || win?.innerHeight || 0;
  const maxX = viewportWidth ? Math.max(IME_ANCHOR_MARGIN, viewportWidth - IME_ANCHOR_MARGIN) : anchor.x + offsetX;
  const maxY = viewportHeight ? Math.max(IME_ANCHOR_MARGIN, viewportHeight - IME_ANCHOR_MARGIN) : anchor.y + offsetY;
  return {
    x: Math.round(Math.min(Math.max(anchor.x + offsetX, IME_ANCHOR_MARGIN), maxX)),
    y: Math.round(Math.min(Math.max(anchor.y + offsetY, IME_ANCHOR_MARGIN), maxY)),
  };
}

function setImeAnchorStyle(input: HTMLElement, anchor: { x: number; y: number }): void {
  const inputPosition = offsetImePoint(input.ownerDocument, anchor, 0, IME_CANDIDATE_OFFSET_Y);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  if (input.tagName.toLowerCase() === 'textarea') {
    input.setAttribute('wrap', 'off');
    input.setAttribute('rows', '1');
  }
  input.style.setProperty('position', 'fixed', 'important');
  input.style.setProperty('left', `${inputPosition.x}px`, 'important');
  input.style.setProperty('top', `${inputPosition.y}px`, 'important');
  input.style.setProperty('width', `${IME_HIDDEN_INPUT_WIDTH}px`, 'important');
  input.style.setProperty('height', `${IME_HIDDEN_INPUT_HEIGHT}px`, 'important');
  input.style.setProperty('min-width', `${IME_HIDDEN_INPUT_WIDTH}px`, 'important');
  input.style.setProperty('min-height', `${IME_HIDDEN_INPUT_HEIGHT}px`, 'important');
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

function setImePreviewStyle(preview: HTMLElement, anchor: { x: number; y: number }): void {
  const previewWidth = readImePreviewWidth(preview.ownerDocument, preview.textContent || '');
  const previewPosition = offsetImePoint(preview.ownerDocument, anchor, 0, IME_PREVIEW_OFFSET_Y);
  preview.style.setProperty('position', 'fixed', 'important');
  preview.style.setProperty('left', `${previewPosition.x}px`, 'important');
  preview.style.setProperty('top', `${previewPosition.y}px`, 'important');
  preview.style.setProperty('width', `${previewWidth}px`, 'important');
  preview.style.setProperty('height', `${IME_PREVIEW_HEIGHT}px`, 'important');
  preview.style.setProperty('min-width', `${IME_PREVIEW_MIN_WIDTH}px`, 'important');
  preview.style.setProperty('min-height', `${IME_PREVIEW_HEIGHT}px`, 'important');
  preview.style.setProperty('margin', '0', 'important');
  preview.style.setProperty('padding', '0', 'important');
  preview.style.setProperty('border', '0', 'important');
  preview.style.setProperty('border-radius', '0', 'important');
  preview.style.setProperty('outline', '0', 'important');
  preview.style.setProperty('overflow', 'visible', 'important');
  preview.style.setProperty('background', 'transparent', 'important');
  preview.style.setProperty('color', '#111', 'important');
  preview.style.setProperty('font-weight', '400', 'important');
  preview.style.setProperty('text-shadow', 'none', 'important');
  preview.style.setProperty('box-shadow', 'none', 'important');
  preview.style.setProperty('pointer-events', 'none', 'important');
  preview.style.setProperty('z-index', '2147483647', 'important');
  preview.style.setProperty(
    'font',
    IME_PREVIEW_BOX_FONT,
    'important',
  );
  preview.style.setProperty('white-space', 'pre', 'important');
  preview.style.setProperty('transition', 'opacity .06s ease', 'important');
}

function readImePreviewWidth(doc: Document, text = readImePreview(doc)?.textContent || ''): number {
  const win = doc.defaultView;
  const viewportWidth = doc.documentElement.clientWidth || win?.innerWidth || 0;
  const available = Math.max(IME_PREVIEW_MIN_WIDTH, viewportWidth - IME_ANCHOR_MARGIN * 2);
  const maxWidth = Math.min(IME_PREVIEW_MAX_WIDTH, available);
  const measuredWidth = Math.ceil(measureImeTextWidth(doc, text) + IME_PREVIEW_HORIZONTAL_PADDING);
  return Math.max(IME_PREVIEW_MIN_WIDTH, Math.min(maxWidth, measuredWidth));
}

function measureImeTextWidth(doc: Document, text: string): number {
  if (!text) return 0;
  const canvas = doc.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return text.length * 16;
  context.font = IME_PREVIEW_FONT;
  return context.measureText(text).width;
}
