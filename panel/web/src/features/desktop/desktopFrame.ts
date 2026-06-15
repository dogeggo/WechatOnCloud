export type ImeSubmitKey = 'enter' | 'ctrlEnter';
export type DesktopInputMode = 'forward' | 'seamless';

const IME_SUBMIT_KEY = 'woc_ime_submit_key';
const DESKTOP_INPUT_MODE_KEY = 'woc_input_mode';
const VNC_STYLE_ID = 'woc-vnc-style';

const VNC_CONTROL_STYLE =
  '#noVNC_control_bar_anchor{z-index:2147483647!important;}' +
  '#noVNC_control_bar{background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.55)!important;box-shadow:0 0 24px rgba(0,0,0,.55)!important;}' +
  '#noVNC_control_bar_handle{opacity:1!important;background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.5)!important;}' +
  '#noVNC_keyboardinput{width:1px!important;height:1px!important;opacity:0!important;overflow:hidden!important;}';

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
  const keyboardInput = frame?.contentDocument?.getElementById('noVNC_keyboardinput') as HTMLElement | null;
  keyboardInput?.focus();
}

export function blurVncFrame(frame: HTMLIFrameElement | null): void {
  frame?.contentWindow?.blur();
  frame?.blur();
}

export function injectVncStyle(frame: HTMLIFrameElement | null): void {
  const doc = frame?.contentDocument;
  if (!doc || doc.getElementById(VNC_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = VNC_STYLE_ID;
  style.textContent = VNC_CONTROL_STYLE;
  (doc.head || doc.documentElement).appendChild(style);
}

export function pushClipboardToRemote(frame: HTMLIFrameElement | null, text: string): boolean {
  const doc = frame?.contentDocument;
  const win = frame?.contentWindow;
  const textarea = doc?.getElementById('noVNC_clipboard_text') as HTMLTextAreaElement | null;
  if (!doc || !win || !textarea) return false;
  textarea.value = text;
  textarea.dispatchEvent(new win.Event('change', { bubbles: true }));
  return true;
}

export function pullClipboardFromRemote(frame: HTMLIFrameElement | null): string | null {
  const textarea = frame?.contentDocument?.getElementById('noVNC_clipboard_text') as HTMLTextAreaElement | null;
  return textarea ? textarea.value : null;
}
