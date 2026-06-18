import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, isUnauthorizedError, type DesktopClientReplacedEvent, type InstanceNotificationEvent } from '../../api';
import { useUI } from '../../ui';
import { ReconnectWatchdog } from '../../utils/connectionWatchdog';
import { dispatchDesktopClientReplaced } from '../desktop/desktopClientEvents';

const STORAGE_KEY = 'woc_browser_notifications';
const UNREAD_STORAGE_KEY = 'woc_notification_unread_instances';
const STREAM_RECONNECT_INITIAL_DELAY = 1000;
const STREAM_RECONNECT_MAX_DELAY = 15000;

export type BrowserNotificationStatus = 'unsupported' | 'blocked' | 'off' | 'on';

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

function loadUnreadInstanceIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(UNREAD_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
}

function saveUnreadInstanceIds(ids: string[]): void {
  try {
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* ignore storage errors */
  }
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

export function useBrowserNotifications() {
  const navigate = useNavigate();
  const { toast } = useUI();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(notificationPermission);
  const [unreadInstanceIds, setUnreadInstanceIds] = useState<string[]>(loadUnreadInstanceIds);
  const enabledRef = useRef(enabled);
  const permissionRef = useRef(permission);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

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

  const showNotification = useCallback(
    (event: InstanceNotificationEvent) => {
      if (seenRef.current.has(event.id)) return;
      seenRef.current.add(event.id);
      if (seenRef.current.size > 300) {
        const first = seenRef.current.values().next().value;
        if (first) seenRef.current.delete(first);
      }
      setUnreadInstanceIds((ids) => {
        if (ids.includes(event.instanceId)) return ids;
        const next = [...ids, event.instanceId];
        saveUnreadInstanceIds(next);
        return next;
      });

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

  const clearUnreadInstance = useCallback((instanceId: string) => {
    setUnreadInstanceIds((ids) => {
      const next = ids.filter((id) => id !== instanceId);
      if (next.length === ids.length) return ids;
      saveUnreadInstanceIds(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === UNREAD_STORAGE_KEY) setUnreadInstanceIds(loadUnreadInstanceIds());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

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
      const next = new EventSource(api.notificationsStreamUrl());
      stream = next;
      next.onopen = () => {
        reconnectWatchdog.reset();
      };
      next.onerror = () => {
        void handleStreamError();
      };
      next.addEventListener('notification', onNotification as EventListener);
      next.addEventListener('desktop-client-replaced', onDesktopClientReplaced as EventListener);
    }

    connect();

    return () => {
      disposed = true;
      reconnectWatchdog.destroy();
      closeStream();
    };
  }, [navigate, showNotification]);

  return {
    notificationStatus: status,
    unreadInstanceIds,
    clearUnreadInstance,
    toggleBrowserNotifications,
  };
}
