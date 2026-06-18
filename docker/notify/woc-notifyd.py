#!/usr/bin/env python3
import html
import json
import os
import re
import subprocess
import sys
import threading
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
APP_TYPE = os.environ.get("WOC_APP_TYPE", "wechat").strip().lower()
POLL_INTERVAL_SEC = 2
DBUS_DEDUPE_WINDOW_SEC = 4
WECHAT_BADGE_COOLDOWN_SEC = 6

next_notification_id = 1
last_dbus_notification_at = 0.0
last_wechat_badge_notification_at = 0.0
notification_lock = threading.Lock()
pyatspi_module = None
pyatspi_import_attempted = False


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


def mark_dbus_notification():
    global last_dbus_notification_at
    with notification_lock:
        last_dbus_notification_at = time.monotonic()


def post_wechat_badge_notification(badge_count):
    global last_wechat_badge_notification_at
    now = time.monotonic()
    with notification_lock:
        if now - last_dbus_notification_at < DBUS_DEDUPE_WINDOW_SEC:
            return False
        if now - last_wechat_badge_notification_at < WECHAT_BADGE_COOLDOWN_SEC:
            return False
        last_wechat_badge_notification_at = now

    payload = {
        "appName": "微信",
        "summary": "微信有新消息",
        "body": f"有 {badge_count} 条微信新消息",
        "urgency": 1,
        "source": "wechat-main-window-unread-badge",
        "createdAt": int(time.time() * 1000),
    }
    log(
        "微信角标通知 "
        f"count={badge_count} "
        f"body={log_value(payload['body'], 160)}"
    )
    if post_notification(payload):
        log("微信角标通知已上报")
        return True
    return False


def stop_competing_notification_daemons():
    # Debian image ships dunst with D-Bus activation. If woc-notifyd is restarted
    # while an app sends a notification, dunst can auto-start and occupy the name.
    for proc in ("dunst",):
        try:
            subprocess.run(
                ["pkill", "-x", proc],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=1,
                check=False,
            )
        except Exception:
            pass


def dedupe_texts(values, limit=240):
    seen = set()
    texts = []
    for value in values:
        text = clean_text(value, limit)
        if not text or text in seen:
            continue
        seen.add(text)
        texts.append(text)
    return texts


def get_pyatspi():
    global pyatspi_module, pyatspi_import_attempted
    if pyatspi_import_attempted:
        return pyatspi_module
    pyatspi_import_attempted = True
    try:
        import pyatspi

        pyatspi_module = pyatspi
    except Exception as e:
        log(f"微信可访问性文本读取不可用：{e}")
        pyatspi_module = None
    return pyatspi_module


def atspi_children(obj):
    try:
        count = int(getattr(obj, "childCount", 0) or 0)
    except Exception:
        return []
    children = []
    for index in range(count):
        try:
            child = obj.getChildAtIndex(index)
        except Exception:
            child = None
        if child is not None:
            children.append(child)
    return children


def wechat_accessibility_desktop():
    pyatspi = get_pyatspi()
    if pyatspi is None:
        return None
    try:
        return pyatspi.Registry.getDesktop(0)
    except Exception as e:
        log(f"读取微信可访问性桌面失败：{e}")
        return None


def wechat_app_roots():
    desktop = wechat_accessibility_desktop()
    if desktop is None:
        return []
    roots = []
    for child in atspi_children(desktop):
        try:
            name = clean_text(getattr(child, "name", ""), 120).casefold()
        except Exception:
            name = ""
        if "wechat" in name or "微信" in name:
            roots.append(child)
    return roots


def atspi_node_text(obj):
    values = []
    for attr in ("name", "description"):
        try:
            values.append(getattr(obj, attr, ""))
        except Exception:
            pass
    try:
        text_iface = obj.queryText()
        char_count = int(getattr(text_iface, "characterCount", 0) or 0)
        if char_count > 0:
            values.append(text_iface.getText(0, min(char_count, 240)))
    except Exception:
        pass
    return " | ".join(dedupe_texts(values, 240))


def wechat_unread_badge_count():
    total = 0
    stack = [(root, 0) for root in wechat_app_roots()]
    visited = 0
    while stack and visited < 260:
        obj, depth = stack.pop(0)
        visited += 1
        text = atspi_node_text(obj)
        for match in re.finditer(r"(\d+)\s*条新消息", text):
            total += int(match.group(1))
        if depth < 8:
            for child in atspi_children(obj):
                stack.append((child, depth + 1))
    return total


def watch_wechat_unread_badge():
    previous_badge_count = 0
    log("已启动微信主窗口未读角标探测")
    while True:
        time.sleep(POLL_INTERVAL_SEC)
        badge_count = wechat_unread_badge_count()
        if badge_count <= 0:
            previous_badge_count = 0
            continue
        if badge_count > previous_badge_count:
            post_wechat_badge_notification(badge_count)
        previous_badge_count = badge_count


def start_wechat_badge_watcher():
    if APP_TYPE == "wechat":
        start_thread(watch_wechat_unread_badge, "wechat-unread-badge")


def start_thread(target, name):
    thread = threading.Thread(target=target, name=name, daemon=True)
    thread.start()


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
        mark_dbus_notification()
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
    stop_competing_notification_daemons()
    bus = dbus.SessionBus()
    WocNotificationServer(bus)
    log("已接管 org.freedesktop.Notifications")
    start_wechat_badge_watcher()
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
