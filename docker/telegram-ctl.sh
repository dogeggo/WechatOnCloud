#!/bin/bash
# Telegram 下载/解压控制脚本。由面板经 docker exec 触发：
#   install / update   下载官方 Linux x64 tar.xz、解压到 /config/telegram
#   status             输出当前状态 JSON（面板轮询用）
set -u

APP_ID=telegram
APP_NAME=Telegram
INSTALL_DIR=/config/telegram
WORK_DIR=/config/.woc-dl/telegram
BIN_REL=Telegram/Telegram
VERSION_FILE="$INSTALL_DIR/.woc-version"
STATE_DIR="${WOC_STATE_DIR:-/config/.woc-state}"
STATUS_FILE="$STATE_DIR/status.json"
UA="${TELEGRAM_UA:-Mozilla/5.0}"
DOWNLOAD_URL="${TELEGRAM_TARBALL_URL:-https://telegram.org/dl/desktop/linux}"

app_bin() { echo "$INSTALL_DIR/$BIN_REL"; }
is_installed() { [ -x "$(app_bin)" ]; }
cur_version() { [ -f "$VERSION_FILE" ] && cat "$VERSION_FILE" || echo ""; }

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_status() {
  local phase="$1" percent="$2" message="$3"
  local installed=false version
  is_installed && installed=true
  version="$(cur_version)"
  mkdir -p "$STATE_DIR"
  cat > "$STATUS_FILE.tmp" <<EOF
{"phase":"$(json_escape "$phase")","percent":$percent,"installed":$installed,"version":"$(json_escape "$version")","message":"$(json_escape "$message")","updatedAt":$(date +%s)}
EOF
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

print_status() {
  if [ -f "$STATUS_FILE" ]; then
    cat "$STATUS_FILE"
  elif is_installed; then
    echo "{\"phase\":\"done\",\"percent\":100,\"installed\":true,\"version\":\"$(json_escape "$(cur_version)")\",\"message\":\"已安装\",\"updatedAt\":$(date +%s)}"
  else
    echo "{\"phase\":\"idle\",\"percent\":0,\"installed\":false,\"version\":\"\",\"message\":\"未安装\",\"updatedAt\":$(date +%s)}"
  fi
}

download_url() {
  case "$(dpkg --print-architecture 2>/dev/null)" in
    amd64) echo "$DOWNLOAD_URL" ;;
    *) return 1 ;;
  esac
}

resolve_error_message() {
  case "$(dpkg --print-architecture 2>/dev/null)" in
    amd64) echo "无法解析 Telegram 官方下载地址，请检查网络" ;;
    *) echo "不支持的架构：Telegram 官方 Linux 桌面包当前仅接入 x64" ;;
  esac
}

content_length() {
  curl -fsSLI -A "$UA" "$1" 2>/dev/null | tr -d '\r' \
    | awk 'tolower($1)=="content-length:"{v=$2} END{print v}'
}

effective_url() {
  curl -fsSLI -o /dev/null -w '%{url_effective}' -A "$UA" "$1" 2>/dev/null || true
}

version_from_url() {
  local url="$1" base
  base="${url%%\?*}"
  base="${base##*/}"
  case "$base" in
    tsetup.*.tar.xz) printf '%s\n' "${base#tsetup.}" | sed 's/\.tar\.xz$//' ;;
    *) echo "" ;;
  esac
}

do_install() {
  local url
  if ! url="$(download_url)" || [ -z "$url" ]; then
    write_status error 0 "$(resolve_error_message)"
    return
  fi

  rm -rf "$WORK_DIR"
  mkdir -p "$WORK_DIR"

  local tmp="$WORK_DIR/$APP_ID.tar.xz"
  local pid total cur pct rc=1

  total="$(content_length "$url")"
  : "${total:=0}"

  write_status downloading 0 "正在下载${APP_NAME}官方安装包"
  curl -fSL --retry 3 -A "$UA" -o "$tmp" "$url" & pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "${total:-0}" -gt 0 ] 2>/dev/null; then
      cur="$(stat -c%s "$tmp" 2>/dev/null || echo 0)"
      pct=$(( cur * 90 / total ))
      [ "$pct" -gt 90 ] && pct=90
      write_status downloading "$pct" "正在下载${APP_NAME}官方安装包"
    else
      write_status downloading -1 "正在下载${APP_NAME}官方安装包"
    fi
    sleep 1
  done
  wait "$pid"; rc=$?

  if [ "$rc" -ne 0 ]; then
    write_status error 0 "下载失败，请检查网络后重试"
    rm -rf "$WORK_DIR"
    return
  fi

  write_status extracting 92 "正在解压安装"
  local newroot="$WORK_DIR/new"
  rm -rf "$newroot"; mkdir -p "$newroot"
  if ! tar -xJf "$tmp" -C "$newroot" 2>/dev/null; then
    write_status error 0 "解压失败，安装包可能损坏"
    rm -rf "$WORK_DIR"
    return
  fi

  if [ ! -f "$newroot/$BIN_REL" ]; then
    write_status error 0 "解压后未找到${APP_NAME}可执行文件"
    rm -rf "$WORK_DIR"
    return
  fi
  chmod +x "$newroot/$BIN_REL"

  local ver final_url
  final_url="$(effective_url "$url")"
  ver="$(version_from_url "$final_url")"

  write_status installing 96 "正在安装"
  rm -rf "$INSTALL_DIR.old"
  [ -e "$INSTALL_DIR" ] && mv "$INSTALL_DIR" "$INSTALL_DIR.old"
  mv "$newroot" "$INSTALL_DIR"
  echo "$ver" > "$VERSION_FILE"
  rm -rf "$INSTALL_DIR.old" "$WORK_DIR"

  write_status done 100 "安装完成"
  pkill -f "$INSTALL_DIR/$BIN_REL" 2>/dev/null || true
}

case "${1:-status}" in
  status)
    print_status
    ;;
  install|update)
    do_install
    ;;
  *)
    echo "用法: $0 {install|update|status}" >&2
    exit 1
    ;;
esac
