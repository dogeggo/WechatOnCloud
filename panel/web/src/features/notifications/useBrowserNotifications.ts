import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type InstanceNotificationEvent } from '../../api';
import { useUI } from '../../ui';

const STORAGE_KEY = 'woc_browser_notifications';

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

      if ('Notification' in window) setPermission(Notification.permission);
      if (enabledRef.current && permissionRef.current === 'granted' && 'Notification' in window) {
        try {
          const n = new Notification(event.title || event.appName || event.instanceName, {
            body: notificationBody(event),
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag: `woc:${event.instanceId}`,
            renotify: true,
            silent: event.urgency === 'low',
          });
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

  useEffect(() => {
    const stream = new EventSource(api.notificationsStreamUrl());
    const onNotification = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as InstanceNotificationEvent;
        if (event?.type === 'instance-notification') showNotification(event);
      } catch {
        /* ignore malformed notification event */
      }
    };
    stream.addEventListener('notification', onNotification as EventListener);
    return () => {
      stream.removeEventListener('notification', onNotification as EventListener);
      stream.close();
    };
  }, [showNotification]);

  return {
    notificationStatus: status,
    toggleBrowserNotifications,
  };
}
