#!/bin/bash
set -e

mkdir -p /run/dbus
chown messagebus:root /run/dbus 2>/dev/null || true
chmod 755 /run/dbus

if dbus-send --system --dest=org.freedesktop.DBus --type=method_call --print-reply \
  /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1; then
  echo "[woc-dbus] system bus 已就绪"
  exit 0
fi

rm -f /run/dbus/pid /run/dbus/system_bus_socket
dbus-daemon --system --fork
echo "[woc-dbus] system bus 已启动"
