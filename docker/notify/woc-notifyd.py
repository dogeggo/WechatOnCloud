#!/usr/bin/env python3
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

BUS_NAME = "org.freedesktop.Notifications"
OBJECT_PATH = "/org/freedesktop/Notifications"
IFACE = "org.freedesktop.Notifications"

INSTANCE_ID = os.environ.get("WOC_INSTANCE_ID", "").strip()
TOKEN = os.environ.get("WOC_NOTIFY_TOKEN", "")
PANEL_URL = os.environ.get("WOC_PANEL_INTERNAL_URL", "http://aoc-panel:8080").rstrip("/")
PANEL_HOST = os.environ.get("WOC_PANEL_INTERNAL_HOST", "127.0.0.1").strip()

next_notification_id = 1


def log(message):
    print(f"[woc-notifyd] {message}", file=sys.stderr, flush=True)


def log_value(value, limit=160):
    return json.dumps(clean_text(value, limit), ensure_ascii=False)


def clean_text(value, limit):
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\s+", " ", text.replace("\x00", " ")).strip()
    return text[:limit]


def dbus_value(value):
    if isinstance(value, (dbus.Byte, dbus.Int16, dbus.Int32, dbus.Int64, dbus.UInt16, dbus.UInt32, dbus.UInt64)):
        return int(value)
    if isinstance(value, dbus.Boolean):
        return bool(value)
    if isinstance(value, (dbus.String, dbus.ObjectPath, dbus.Signature)):
        return str(value)
    return value


def post_notification(payload):
    if not INSTANCE_ID or not TOKEN:
        log("缺少 WOC_INSTANCE_ID 或 WOC_NOTIFY_TOKEN，跳过上报")
        return False

    url = f"{PANEL_URL}/_woc/internal/instances/{INSTANCE_ID}/notifications"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "content-type": "application/json; charset=utf-8",
        "authorization": f"Bearer {TOKEN}",
    }
    if PANEL_HOST:
        headers["host"] = PANEL_HOST
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=2) as res:
            res.read(256)
        return True
    except urllib.error.HTTPError as e:
        log(f"面板拒绝通知上报：HTTP {e.code}")
    except Exception as e:
        log(f"通知上报失败：{e}")
    return False


class WocNotificationServer(dbus.service.Object):
    def __init__(self, bus):
        name = dbus.service.BusName(BUS_NAME, bus=bus, do_not_queue=True)
        super().__init__(name, OBJECT_PATH)

    @dbus.service.method(IFACE, in_signature="", out_signature="as")
    def GetCapabilities(self):
        return ["body", "body-markup"]

    @dbus.service.method(IFACE, in_signature="susssasa{sv}i", out_signature="u")
    def Notify(self, app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout):
        global next_notification_id
        notification_id = int(replaces_id) if int(replaces_id) > 0 else next_notification_id
        next_notification_id = max(next_notification_id + 1, notification_id + 1)

        clean_hints = {str(k): dbus_value(v) for k, v in dict(hints).items()}
        payload = {
            "appName": clean_text(app_name, 40),
            "summary": clean_text(summary, 120),
            "body": clean_text(body, 500),
            "urgency": clean_hints.get("urgency", 1),
            "source": "freedesktop-notifications",
            "createdAt": int(time.time() * 1000),
        }
        log(
            "收到通知 "
            f"id={notification_id} "
            f"app={log_value(payload['appName'], 40)} "
            f"summary={log_value(payload['summary'], 120)} "
            f"body={log_value(payload['body'], 160)} "
            f"urgency={payload['urgency']} "
            f"actions={len(actions)} "
            f"expireMs={int(expire_timeout)}"
        )
        if post_notification(payload):
            log(f"通知已上报 id={notification_id}")
        return dbus.UInt32(notification_id)

    @dbus.service.method(IFACE, in_signature="u", out_signature="")
    def CloseNotification(self, notification_id):
        self.NotificationClosed(notification_id, 2)

    @dbus.service.method(IFACE, in_signature="", out_signature="ssss")
    def GetServerInformation(self):
        return ("WOC Notify Bridge", "WechatOnCloud", "1.0", "1.2")

    @dbus.service.signal(IFACE, signature="uu")
    def NotificationClosed(self, notification_id, reason):
        pass

    @dbus.service.signal(IFACE, signature="us")
    def ActionInvoked(self, notification_id, action_key):
        pass


def main():
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    WocNotificationServer(bus)
    log("已接管 org.freedesktop.Notifications")
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
