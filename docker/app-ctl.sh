#!/bin/bash
# 多应用安装/状态控制（面板经 docker exec --user abc 调用）：
#   app-ctl.sh <appType> <install|update|status>
# 微信/QQ 委托给各自的 deb 安装脚本；Chromium 随镜像内置，状态格式复用。
set -u

APP="${1:-wechat}"
ACTION="${2:-status}"

case "$APP" in
  wechat) exec /woc/wechat-ctl.sh "$ACTION" ;;
  qq) exec /woc/qq-ctl.sh "$ACTION" ;;
esac

# shellcheck source=/dev/null
. /woc/app-defs.sh
woc_app_def "$APP" || exit 1

STATE_DIR="${WOC_STATE_DIR:-/config/.woc-state}"
STATUS_FILE="$STATE_DIR/status.json"

is_installed() { [ -n "${APP_BIN:-}" ] && [ -x "$APP_BIN" ]; }

write_status() {
  local phase="$1" percent="$2" message="$3" installed=false
  is_installed && installed=true
  mkdir -p "$STATE_DIR"
  cat > "$STATUS_FILE.tmp" <<EOF
{"phase":"$phase","percent":$percent,"installed":$installed,"version":"","message":"$message","updatedAt":$(date +%s)}
EOF
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

print_status() {
  if [ "$APP" = "chromium" ]; then
    if is_installed; then
      echo "{\"phase\":\"done\",\"percent\":100,\"installed\":true,\"version\":\"\",\"message\":\"已就绪\",\"updatedAt\":$(date +%s)}"
    else
      echo "{\"phase\":\"idle\",\"percent\":0,\"installed\":false,\"version\":\"\",\"message\":\"未安装\",\"updatedAt\":$(date +%s)}"
    fi
    return
  fi
  if [ -f "$STATUS_FILE" ]; then
    cat "$STATUS_FILE"
  elif is_installed; then
    echo "{\"phase\":\"done\",\"percent\":100,\"installed\":true,\"version\":\"\",\"message\":\"已就绪\",\"updatedAt\":$(date +%s)}"
  else
    echo "{\"phase\":\"idle\",\"percent\":0,\"installed\":false,\"version\":\"\",\"message\":\"未安装\",\"updatedAt\":$(date +%s)}"
  fi
}

case "$ACTION" in
  status)
    print_status
    ;;
  install | update)
    case "$APP" in
      chromium) write_status done 100 "Chromium 随镜像就绪" ;;
      *) echo "未知应用: $APP" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "用法: $0 <appType> {install|update|status}" >&2
    exit 1
    ;;
esac
