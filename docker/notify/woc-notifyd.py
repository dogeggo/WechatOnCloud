#!/usr/bin/env python3
import html
import glob
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
FALLBACK_ENABLED = os.environ.get("WOC_NOTIFY_FALLBACK", "1") != "0"
DISPLAY = os.environ.get("DISPLAY", ":1")
POLL_INTERVAL_SEC = 2
FALLBACK_COOLDOWN_SEC = 20
DBUS_DEDUPE_WINDOW_SEC = 4

next_notification_id = 1
last_dbus_notification_at = 0.0
last_fallback_notification_at = 0.0
last_fallback_key = ""
notification_lock = threading.Lock()


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


def post_fallback_notification(app_name, title, body, source, key):
    global last_fallback_key, last_fallback_notification_at
    now = time.monotonic()
    with notification_lock:
        if now - last_dbus_notification_at < DBUS_DEDUPE_WINDOW_SEC:
            return False
        if now - last_fallback_notification_at < FALLBACK_COOLDOWN_SEC:
            return False
        if key == last_fallback_key and now - last_fallback_notification_at < 300:
            return False
        last_fallback_key = key
        last_fallback_notification_at = now

    payload = {
        "appName": app_name,
        "summary": title,
        "body": body,
        "urgency": 1,
        "source": source,
        "createdAt": int(time.time() * 1000),
    }
    log(f"兜底通知 source={source} title={log_value(title, 120)} body={log_value(body, 160)}")
    if post_notification(payload):
        log(f"兜底通知已上报 source={source}")
        return True
    return False


def run_text(args, timeout=1.2):
    try:
        res = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
            env={**os.environ, "DISPLAY": DISPLAY},
            check=False,
        )
        return res.stdout or ""
    except Exception:
        return ""


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


def x_window_ids_by_class(pattern, only_visible=False):
    args = ["xdotool", "search"]
    if only_visible:
        args.append("--onlyvisible")
    args.extend(["--class", pattern])
    out = run_text(args)
    ids = []
    for line in out.splitlines():
        line = line.strip()
        if line.isdigit() and line not in ids:
            ids.append(line)
    return ids


def x_window_prop(window_id, *props):
    if not window_id:
        return ""
    return run_text(["xprop", "-id", str(window_id), *props])


def quoted_xprop_values(output):
    values = []
    for line in output.splitlines():
        values.extend(re.findall(r'"([^"]*)"', line))
    return values


def telegram_unread_count():
    best = 0
    best_title = ""
    for window_id in x_window_ids_by_class("Telegram|telegram-desktop"):
        props = x_window_prop(window_id, "_NET_WM_VISIBLE_NAME", "_NET_WM_NAME", "WM_NAME")
        for title in quoted_xprop_values(props):
            title = clean_text(title, 160)
            match = re.match(r"^\((\d{1,5})\)\s+(.+)$", title)
            if not match:
                continue
            count = int(match.group(1))
            if count > best:
                best = count
                best_title = clean_text(match.group(2), 80)
    return best, best_title


def watch_telegram_fallback():
    initialized = False
    previous_count = 0
    log("已启动 Telegram 未读标题兜底探测")
    while True:
        time.sleep(POLL_INTERVAL_SEC)
        count, title = telegram_unread_count()
        if not initialized:
            previous_count = count
            initialized = True
            log(f"Telegram 未读基线 count={count}")
            if count > 0:
                body = f"当前有 {count} 条未读消息"
                if title:
                    body = f"{body}，当前窗口：{title}"
                post_fallback_notification(
                    "Telegram",
                    "Telegram 有未读消息",
                    body,
                    "telegram-window-title",
                    f"telegram-initial:{count}",
                )
            continue
        if count <= previous_count:
            previous_count = count
            continue
        delta = count - previous_count
        previous_count = count
        if delta <= 0:
            continue
        body = f"未读消息增加到 {count} 条"
        if title:
            body = f"{body}，当前窗口：{title}"
        post_fallback_notification(
            "Telegram",
            "Telegram 有新消息",
            body,
            "telegram-window-title",
            f"telegram:{count}",
        )


def wechat_message_paths():
    patterns = [
        "/config/xwechat_files/*/db_storage/session/session.db-wal",
        "/config/xwechat_files/*/db_storage/session/session.db",
        "/config/xwechat_files/*/db_storage/message/message_*.db-wal",
        "/config/xwechat_files/*/db_storage/message/biz_message_*.db-wal",
    ]
    paths = []
    for pattern in patterns:
        paths.extend(glob.glob(pattern))
    return sorted(set(paths))


def file_signature(paths):
    signature = []
    newest_mtime = 0
    for path in paths:
        try:
            st = os.stat(path)
        except OSError:
            continue
        signature.append((path, st.st_size, st.st_mtime_ns))
        if st.st_mtime_ns > newest_mtime:
            newest_mtime = st.st_mtime_ns
    return tuple(signature), newest_mtime


def wechat_visible_utility_windows():
    visible = set()
    for window_id in x_window_ids_by_class("wechat|WeChat|weixin|Weixin", only_visible=True):
        geometry = run_text(["xdotool", "getwindowgeometry", "--shell", window_id])
        props = x_window_prop(window_id, "_NET_WM_WINDOW_TYPE", "_NET_WM_STATE", "_NET_WM_NAME", "WM_NAME")
        width = int_prop(geometry, "WIDTH")
        height = int_prop(geometry, "HEIGHT")
        title_values = quoted_xprop_values(props)
        is_utility = "_NET_WM_WINDOW_TYPE_UTILITY" in props
        is_main = any(value == "微信" for value in title_values)
        if is_utility and not is_main and width >= 120 and height >= 80:
            visible.add(window_id)
    return visible


def int_prop(text, name):
    match = re.search(rf"^{re.escape(name)}=(\d+)$", text, re.MULTILINE)
    return int(match.group(1)) if match else 0


def watch_wechat_fallback():
    initialized = False
    previous_signature = tuple()
    previous_newest_mtime = 0
    previous_utility_windows = set()
    log("已启动微信消息活动兜底探测")
    while True:
        time.sleep(POLL_INTERVAL_SEC)
        paths = wechat_message_paths()
        signature, newest_mtime = file_signature(paths)
        utility_windows = wechat_visible_utility_windows()
        if not initialized:
            previous_signature = signature
            previous_newest_mtime = newest_mtime
            previous_utility_windows = utility_windows
            initialized = True
            log(f"微信消息活动基线 files={len(signature)} utilityWindows={len(utility_windows)}")
            continue

        new_utility_windows = utility_windows - previous_utility_windows
        previous_utility_windows = utility_windows
        if new_utility_windows:
            post_fallback_notification(
                "微信",
                "微信有新消息",
                "检测到微信消息提醒窗口",
                "wechat-utility-window",
                f"wechat-window:{','.join(sorted(new_utility_windows))}",
            )
            continue

        if signature != previous_signature and newest_mtime >= previous_newest_mtime:
            previous_signature = signature
            previous_newest_mtime = newest_mtime
            post_fallback_notification(
                "微信",
                "微信有新消息",
                "检测到微信消息数据更新",
                "wechat-message-store",
                f"wechat-store:{newest_mtime}",
            )
            continue

        previous_signature = signature
        previous_newest_mtime = newest_mtime


def start_fallback_watchers():
    if not FALLBACK_ENABLED:
        log("通知兜底探测已关闭")
        return
    if APP_TYPE == "telegram":
        start_thread(watch_telegram_fallback, "telegram-fallback")
    elif APP_TYPE == "wechat":
        start_thread(watch_wechat_fallback, "wechat-fallback")


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
    start_fallback_watchers()
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
