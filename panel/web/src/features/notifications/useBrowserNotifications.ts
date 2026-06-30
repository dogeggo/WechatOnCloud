import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api,
  isUnauthorizedError,
  type DesktopClientReplacedEvent,
  type ExternalLinkEvent,
  type InstanceNotificationEvent,
} from '../../api';
import { browserClientId } from '../../browserClient';
import { useUI } from '../../ui';
import { ReconnectWatchdog } from '../../utils/connectionWatchdog';
import { dispatchDesktopClientReplaced } from '../desktop/desktopClientEvents';

const STORAGE_KEY = 'woc_browser_notifications';
const EXTERNAL_LINKS_STORAGE_KEY = 'woc_external_links';
const UNREAD_STORAGE_KEY = 'woc_notification_unread_instances';
const STREAM_RECONNECT_INITIAL_DELAY = 1000;
const STREAM_RECONNECT_MAX_DELAY = 15000;

export type BrowserNotificationStatus = 'unsupported' | 'blocked' | 'off' | 'on';
type UnreadInstance = { instanceId: string; count: number };

function isAppWindowFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function notificationPermission(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

function initialEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function initialExternalLinksEnabled(): boolean {
  try {
    return localStorage.getItem(EXTERNAL_LINKS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function loadUnreadInstances(): UnreadInstance[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(UNREAD_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const counts = new Map<string, number>();
    for (const item of parsed) {
      if (typeof item === 'string' && item) {
        counts.set(item, Math.max(1, counts.get(item) || 0));
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const instanceId = (item as { instanceId?: unknown }).instanceId;
      const count = (item as { count?: unknown }).count;
      if (typeof instanceId !== 'string' || !instanceId) continue;
      const normalizedCount = Number(count);
      if (!Number.isFinite(normalizedCount) || normalizedCount < 1) continue;
      counts.set(instanceId, (counts.get(instanceId) || 0) + Math.floor(normalizedCount));
    }
    return Array.from(counts, ([instanceId, count]) => ({ instanceId, count }));
  } catch {
    return [];
  }
}

function saveUnreadInstances(items: UnreadInstance[]): void {
  try {
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* ignore storage errors */
  }
}

function unreadInstanceIds(items: UnreadInstance[]): string[] {
  return items.map((item) => item.instanceId);
}

function unreadTotal(items: UnreadInstance[]): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}

function compact(text: string, max = 90): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function notificationBody(event: InstanceNotificationEvent): string {
  const lines = [event.instanceName, event.body].filter(Boolean);
  return lines.join('\n');
}

function toastText(event: InstanceNotificationEvent): string {
  const detail = event.body ? `：${event.body}` : '';
  return compact(`${event.instanceName} · ${event.title}${detail}`);
}

function updateDocumentTitle(unreadCount: number, baseTitle: string): void {
  document.title = unreadCount > 0 ? `(${unreadCount}) 未读` : baseTitle;
}

export function useBrowserNotifications() {
  const navigate = useNavigate();
  const { toast } = useUI();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [externalLinksEnabled, setExternalLinksEnabled] = useState(initialExternalLinksEnabled);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(notificationPermission);
  const [unreadInstances, setUnreadInstances] = useState<UnreadInstance[]>(loadUnreadInstances);
  const unreadIds = useMemo(() => unreadInstanceIds(unreadInstances), [unreadInstances]);
  const unreadCount = useMemo(() => unreadTotal(unreadInstances), [unreadInstances]);
  const enabledRef = useRef(enabled);
  const externalLinksEnabledRef = useRef(externalLinksEnabled);
  const permissionRef = useRef(permission);
  const titleRef = useRef(document.title || '云应用');
  const seenRef = useRef<Set<string>>(new Set());
  const openedExternalLinksRef = useRef<Set<string>>(new Set());
  const browserClientIdRef = useRef(browserClientId());
  const activeInstanceIdRef = useRef<string | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    externalLinksEnabledRef.current = externalLinksEnabled;
  }, [externalLinksEnabled]);

  useEffect(() => {
    permissionRef.current = permission;
  }, [permission]);

  const status: BrowserNotificationStatus = useMemo(() => {
    if (permission === 'unsupported') return 'unsupported';
    if (permission === 'denied') return 'blocked';
    return enabled && permission === 'granted' ? 'on' : 'off';
  }, [enabled, permission]);

  const setNotificationEnabled = useCallback((value: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      /* ignore storage errors */
    }
    setEnabled(value);
  }, []);

  const toggleBrowserNotifications = useCallback(async () => {
    if (!('Notification' in window)) {
      toast('当前浏览器不支持系统通知', 'error');
      setPermission('unsupported');
      return;
    }

    let nextPermission = Notification.permission;
    if (nextPermission === 'default') {
      nextPermission = await Notification.requestPermission();
    }
    setPermission(nextPermission);

    if (nextPermission === 'denied') {
      setNotificationEnabled(false);
      toast('浏览器已拒绝通知，请在浏览器设置中开启', 'error');
      return;
    }
    if (nextPermission !== 'granted') {
      setNotificationEnabled(false);
      return;
    }

    const next = !enabledRef.current;
    setNotificationEnabled(next);
    toast(next ? '已开启浏览器通知' : '已关闭浏览器通知', 'ok');
  }, [setNotificationEnabled, toast]);

  const setExternalLinkEnabled = useCallback((value: boolean) => {
    try {
      localStorage.setItem(EXTERNAL_LINKS_STORAGE_KEY, value ? '1' : '0');
    } catch {
      /* ignore storage errors */
    }
    setExternalLinksEnabled(value);
  }, []);

  const toggleExternalLinks = useCallback(() => {
    const next = !externalLinksEnabledRef.current;
    setExternalLinkEnabled(next);
    toast(next ? '已开启外链在本机打开' : '已关闭外链接管', 'ok');
  }, [setExternalLinkEnabled, toast]);

  const showNotification = useCallback(
    (event: InstanceNotificationEvent) => {
      if (seenRef.current.has(event.id)) return;
      seenRef.current.add(event.id);
      if (seenRef.current.size > 300) {
        const first = seenRef.current.values().next().value;
        if (first) seenRef.current.delete(first);
      }
      const currentAppFocused = activeInstanceIdRef.current === event.instanceId && isAppWindowFocused();
      if (!currentAppFocused) {
        setUnreadInstances((items) => {
          const current = items.find((item) => item.instanceId === event.instanceId);
          const next = current
            ? items.map((item) => item.instanceId === event.instanceId ? { ...item, count: item.count + 1 } : item)
            : [...items, { instanceId: event.instanceId, count: 1 }];
          saveUnreadInstances(next);
          return next;
        });
      }

      if ('Notification' in window) setPermission(Notification.permission);
      if (enabledRef.current && permissionRef.current === 'granted' && 'Notification' in window) {
        try {
          const options: NotificationOptions & { renotify: boolean } = {
            body: notificationBody(event),
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag: `woc:${event.instanceId}`,
            renotify: true,
            silent: event.urgency === 'low',
          };
          const n = new Notification(event.title || event.appName || event.instanceName, options);
          n.onclick = () => {
            window.focus();
            navigate(`/i/${event.instanceId}`);
            n.close();
          };
          return;
        } catch {
          setNotificationEnabled(false);
        }
      }

      toast(toastText(event), event.urgency === 'critical' ? 'error' : 'info');
    },
    [navigate, toast],
  );

  const openExternalLink = useCallback((event: ExternalLinkEvent) => {
    if (openedExternalLinksRef.current.has(event.id)) return;
    openedExternalLinksRef.current.add(event.id);
    if (openedExternalLinksRef.current.size > 300) {
      const first = openedExternalLinksRef.current.values().next().value;
      if (first) openedExternalLinksRef.current.delete(first);
    }
    if (!externalLinksEnabledRef.current) return;
    const opened = window.open('about:blank', '_blank');
    if (opened) {
      opened.opener = null;
      opened.location.href = event.url;
      toast(`${event.instanceName} 外链已在本机打开`, 'ok');
      return;
    }
    toast('浏览器拦截了新标签页，正在当前标签页打开外链', 'info');
    window.setTimeout(() => window.location.assign(event.url), 80);
  }, [toast]);

  const clearUnreadInstance = useCallback((instanceId: string) => {
    setUnreadInstances((items) => {
      const next = items.filter((item) => item.instanceId !== instanceId);
      if (next.length === items.length) return items;
      saveUnreadInstances(next);
      return next;
    });
  }, []);

  const setActiveInstanceForUnread = useCallback((instanceId: string | null) => {
    activeInstanceIdRef.current = instanceId;
    if (instanceId && isAppWindowFocused()) clearUnreadInstance(instanceId);
  }, [clearUnreadInstance]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === UNREAD_STORAGE_KEY) setUnreadInstances(loadUnreadInstances());
      if (event.key === EXTERNAL_LINKS_STORAGE_KEY) setExternalLinksEnabled(initialExternalLinksEnabled());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    updateDocumentTitle(unreadCount, titleRef.current);
  }, [unreadCount]);

  useEffect(() => {
    const onNotification = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as InstanceNotificationEvent;
        if (event?.type === 'instance-notification') showNotification(event);
      } catch {
        /* ignore malformed notification event */
      }
    };
    const onDesktopClientReplaced = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as DesktopClientReplacedEvent;
        if (event?.type === 'desktop-client-replaced') dispatchDesktopClientReplaced(event);
      } catch {
        /* ignore malformed desktop client event */
      }
    };
    const onExternalLink = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as ExternalLinkEvent;
        if (event?.type === 'external-link') openExternalLink(event);
      } catch {
        /* ignore malformed external link event */
      }
    };

    let stream: EventSource | null = null;
    let disposed = false;
    let authProbeRunning = false;
    const reconnectWatchdog = new ReconnectWatchdog({
      name: 'notifications-stream',
      initialDelayMs: STREAM_RECONNECT_INITIAL_DELAY,
      maxDelayMs: STREAM_RECONNECT_MAX_DELAY,
      reconnect: () => connect(),
      shouldReconnect: () => !disposed,
    });

    function closeStream() {
      if (!stream) return;
      stream.removeEventListener('notification', onNotification as EventListener);
      stream.removeEventListener('desktop-client-replaced', onDesktopClientReplaced as EventListener);
      stream.removeEventListener('external-link', onExternalLink as EventListener);
      stream.onopen = null;
      stream.onerror = null;
      stream.close();
      stream = null;
    }

    function scheduleReconnect() {
      if (disposed) return;
      closeStream();
      reconnectWatchdog.schedule();
    }

    async function probeAuth(): Promise<'ok' | 'unauthorized'> {
      try {
        await api.me();
        return 'ok';
      } catch (error) {
        if (isUnauthorizedError(error)) return 'unauthorized';
        throw error;
      }
    }

    async function handleStreamError() {
      if (disposed || authProbeRunning) return;
      authProbeRunning = true;
      try {
        const auth = await probeAuth();
        if (disposed) return;
        if (auth === 'unauthorized') {
          disposed = true;
          reconnectWatchdog.destroy();
          closeStream();
          navigate('/login', { replace: true });
          return;
        }
        scheduleReconnect();
      } catch {
        scheduleReconnect();
      } finally {
        authProbeRunning = false;
      }
    }

    function connect() {
      if (disposed) return;
      closeStream();
      const next = new EventSource(api.notificationsStreamUrl(externalLinksEnabled, browserClientIdRef.current));
      stream = next;
      next.onopen = () => {
        reconnectWatchdog.reset();
      };
      next.onerror = () => {
        void handleStreamError();
      };
      next.addEventListener('notification', onNotification as EventListener);
      next.addEventListener('desktop-client-replaced', onDesktopClientReplaced as EventListener);
      next.addEventListener('external-link', onExternalLink as EventListener);
    }

    connect();

    return () => {
      disposed = true;
      reconnectWatchdog.destroy();
      closeStream();
    };
  }, [externalLinksEnabled, navigate, openExternalLink, showNotification]);

  return {
    notificationStatus: status,
    externalLinksEnabled,
    unreadInstanceIds: unreadIds,
    clearUnreadInstance,
    setActiveInstanceForUnread,
    toggleBrowserNotifications,
    toggleExternalLinks,
  };
}
