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
FALLBACK_ENABLED = os.environ.get("WOC_NOTIFY_FALLBACK", "1") != "0"
WECHAT_ACCESSIBILITY_ENABLED = os.environ.get("WOC_NOTIFY_WECHAT_ACCESSIBILITY", "1") != "0"
DISPLAY = os.environ.get("DISPLAY", ":1")
POLL_INTERVAL_SEC = 2
FALLBACK_COOLDOWN_SEC = 20
DBUS_DEDUPE_WINDOW_SEC = 4
WECHAT_BADGE_COOLDOWN_SEC = 6
WECHAT_GENERIC_BODY = "检测到微信消息提醒窗口"
WECHAT_IGNORED_TEXTS = {"微信", "wechat", "weixin"}

next_notification_id = 1
last_dbus_notification_at = 0.0
last_fallback_notification_at = 0.0
last_fallback_key = ""
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


def wechat_visible_utility_windows():
    visible = {}
    for window_id in x_window_ids_by_class("wechat|WeChat|weixin|Weixin", only_visible=True):
        geometry = run_text(["xdotool", "getwindowgeometry", "--shell", window_id])
        props = x_window_prop(window_id, "_NET_WM_WINDOW_TYPE", "_NET_WM_STATE", "_NET_WM_NAME", "WM_NAME")
        width = int_prop(geometry, "WIDTH")
        height = int_prop(geometry, "HEIGHT")
        title_values = dedupe_texts(quoted_xprop_values(props), 120)
        is_utility = "_NET_WM_WINDOW_TYPE_UTILITY" in props
        is_main = any(value == "微信" for value in title_values)
        if is_utility and not is_main and width >= 120 and height >= 80:
            visible[window_id] = {
                "id": window_id,
                "titles": title_values,
                "geometry": {
                    "x": int_prop(geometry, "X"),
                    "y": int_prop(geometry, "Y"),
                    "width": width,
                    "height": height,
                },
            }
    return visible


def int_prop(text, name):
    match = re.search(rf"^{re.escape(name)}=(\d+)$", text, re.MULTILINE)
    return int(match.group(1)) if match else 0


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


def useful_wechat_texts(values):
    texts = []
    for text in dedupe_texts(values, 240):
        if text.casefold() in WECHAT_IGNORED_TEXTS:
            continue
        texts.append(text)
    return texts


def get_pyatspi():
    global pyatspi_module, pyatspi_import_attempted
    if not WECHAT_ACCESSIBILITY_ENABLED:
        return None
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


def atspi_extents(obj, pyatspi):
    try:
        component = obj.queryComponent()
        extents = component.getExtents(pyatspi.DESKTOP_COORDS)
    except Exception:
        return None

    try:
        return {
            "x": int(extents.x),
            "y": int(extents.y),
            "width": int(extents.width),
            "height": int(extents.height),
        }
    except Exception:
        try:
            return {
                "x": int(extents[0]),
                "y": int(extents[1]),
                "width": int(extents[2]),
                "height": int(extents[3]),
            }
        except Exception:
            return None


def rect_overlap_ratio(a, b):
    if not a or not b:
        return 0.0
    ax2 = a["x"] + a["width"]
    ay2 = a["y"] + a["height"]
    bx2 = b["x"] + b["width"]
    by2 = b["y"] + b["height"]
    inter_width = max(0, min(ax2, bx2) - max(a["x"], b["x"]))
    inter_height = max(0, min(ay2, by2) - max(a["y"], b["y"]))
    inter_area = inter_width * inter_height
    min_area = min(a["width"] * a["height"], b["width"] * b["height"])
    return inter_area / min_area if min_area > 0 else 0.0


def atspi_matches_window(obj, window_geometry, pyatspi):
    extents = atspi_extents(obj, pyatspi)
    if not extents:
        return False
    width_delta = abs(extents["width"] - window_geometry["width"])
    height_delta = abs(extents["height"] - window_geometry["height"])
    return rect_overlap_ratio(extents, window_geometry) >= 0.75 and width_delta <= 80 and height_delta <= 80


def atspi_text_values(root):
    texts = []
    stack = [root]
    visited = 0
    while stack and visited < 160:
        obj = stack.pop(0)
        visited += 1
        for attr in ("name", "description"):
            try:
                texts.append(getattr(obj, attr, ""))
            except Exception:
                pass
        try:
            text_iface = obj.queryText()
            char_count = int(getattr(text_iface, "characterCount", 0) or 0)
            if char_count > 0:
                texts.append(text_iface.getText(0, min(char_count, 500)))
        except Exception:
            pass
        stack.extend(atspi_children(obj))
    return dedupe_texts(texts, 240)


def wechat_accessibility_texts(window_info):
    pyatspi = get_pyatspi()
    if pyatspi is None:
        return []
    geometry = window_info.get("geometry") or {}
    if not geometry:
        return []
    try:
        desktop = pyatspi.Registry.getDesktop(0)
    except Exception as e:
        log(f"读取微信可访问性桌面失败：{e}")
        return []

    for child in atspi_children(desktop):
        if atspi_matches_window(child, geometry, pyatspi):
            return atspi_text_values(child)
    return []


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


def wechat_notification_body(window_info):
    texts = []
    texts.extend(window_info.get("titles") or [])
    texts.extend(wechat_accessibility_texts(window_info))
    filtered = useful_wechat_texts(texts)
    return clean_text(" ".join(filtered), 500) if filtered else WECHAT_GENERIC_BODY


def wechat_notification_snapshot(window_info):
    body = wechat_notification_body(window_info)
    has_body = body != WECHAT_GENERIC_BODY
    return {
        "body": body,
        "signature": body if has_body else WECHAT_GENERIC_BODY,
    }


def watch_wechat_fallback():
    initialized = False
    previous_window_signatures = {}
    previous_badge_count = 0
    last_badge_notification_at = 0.0
    log("已启动微信提醒窗口兜底探测")
    while True:
        time.sleep(POLL_INTERVAL_SEC)
        utility_windows = wechat_visible_utility_windows()
        window_snapshots = {}
        current_window_signatures = {}
        for window_id, window_info in utility_windows.items():
            snapshot = wechat_notification_snapshot(window_info)
            window_snapshots[window_id] = snapshot
            current_window_signatures[window_id] = snapshot["signature"]

        if not initialized:
            previous_window_signatures = current_window_signatures
            initialized = True
            log(f"微信提醒窗口基线 utilityWindows={len(utility_windows)}")
            continue

        changed_window_ids = [
            window_id
            for window_id in sorted(current_window_signatures)
            if previous_window_signatures.get(window_id) != current_window_signatures[window_id]
        ]
        previous_window_signatures = current_window_signatures
        if changed_window_ids:
            snapshots = [window_snapshots[window_id] for window_id in changed_window_ids]
            bodies = [snapshot["body"] for snapshot in snapshots]
            body = clean_text("；".join(dedupe_texts(bodies, 240)), 500) or WECHAT_GENERIC_BODY
            source = "wechat-utility-window-accessibility" if body != WECHAT_GENERIC_BODY else "wechat-utility-window"
            signature = ",".join(
                f"{window_id}:{current_window_signatures[window_id]}"
                for window_id in changed_window_ids
            )
            post_fallback_notification(
                "微信",
                "微信有新消息",
                body,
                source,
                f"wechat-window:{signature[:180]}",
            )
            continue

        badge_count = wechat_unread_badge_count()
        if badge_count <= 0:
            previous_badge_count = 0
            continue
        now = time.monotonic()
        if badge_count > previous_badge_count and now - last_badge_notification_at >= WECHAT_BADGE_COOLDOWN_SEC:
            previous_badge_count = badge_count
            last_badge_notification_at = now
            post_fallback_notification(
                "微信",
                "微信有新消息",
                f"检测到 {badge_count} 条微信新消息",
                "wechat-main-window-unread-badge",
                f"wechat-badge:{badge_count}",
            )
            continue
        previous_badge_count = badge_count


def start_fallback_watchers():
    if not FALLBACK_ENABLED:
        log("通知兜底探测已关闭")
        return
    if APP_TYPE == "wechat":
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
