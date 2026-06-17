#!/bin/bash
# /custom-cont-init.d 钩子（02）：把容器环境里的应用类型写入数据卷 /config/.woc-app，
# 供 autostart（桌面会话）读取。缺 WOC_APP_TYPE 时不写文件，autostart 使用默认应用。
APP_TYPE="${WOC_APP_TYPE:-}"
[ -z "$APP_TYPE" ] && exit 0

case "$APP_TYPE" in
  wechat | chromium | qq | telegram) ;;
  *) exit 0 ;;
esac

TMP=/config/.woc-app.tmp
{
  echo "WOC_APP_TYPE='${APP_TYPE}'"
} > "$TMP"
mv -f "$TMP" /config/.woc-app
chown abc:abc /config/.woc-app 2>/dev/null || true
echo "[woc-app] 实例应用类型 = ${APP_TYPE}"
