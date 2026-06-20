const BROWSER_CLIENT_STORAGE_KEY = 'woc_browser_client_id';
const BROWSER_CLIENT_ID_RE = /^[0-9a-f]{32}$/;

function createBrowserClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function browserClientId(): string {
  try {
    const saved = sessionStorage.getItem(BROWSER_CLIENT_STORAGE_KEY);
    if (saved && BROWSER_CLIENT_ID_RE.test(saved)) return saved;
    const next = createBrowserClientId();
    sessionStorage.setItem(BROWSER_CLIENT_STORAGE_KEY, next);
    return next;
  } catch {
    return createBrowserClientId();
  }
}
