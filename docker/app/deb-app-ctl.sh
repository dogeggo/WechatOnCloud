#!/bin/bash
# 通用 .deb 应用下载/解压控制逻辑。由具体应用脚本设置 DEB_APP_* 变量并提供：
#   deb_app_download_urls          输出候选 .deb URL（一行一个）
#   deb_app_resolve_error_message  输出无法解析下载地址时的状态消息
set -u

STATE_DIR="${WOC_STATE_DIR:-/config/.woc-state}"
STATUS_FILE="$STATE_DIR/status.json"
DEB_APP_VERSION_FILE="${DEB_APP_VERSION_FILE:-$DEB_APP_INSTALL_DIR/.woc-version}"
DEB_APP_UA="${DEB_APP_UA:-Mozilla/5.0}"

deb_app_bin() { echo "$DEB_APP_INSTALL_DIR/$DEB_APP_BIN_REL"; }
deb_app_is_installed() { [ -x "$(deb_app_bin)" ]; }
deb_app_cur_version() { [ -f "$DEB_APP_VERSION_FILE" ] && cat "$DEB_APP_VERSION_FILE" || echo ""; }

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# write_status <phase> <percent> <message>
# phase: idle|downloading|extracting|installing|done|error
write_status() {
  local phase="$1" percent="$2" message="$3"
  local installed=false version
  deb_app_is_installed && installed=true
  version="$(deb_app_cur_version)"
  mkdir -p "$STATE_DIR"
  cat > "$STATUS_FILE.tmp" <<EOF
{"phase":"$(json_escape "$phase")","percent":$percent,"installed":$installed,"version":"$(json_escape "$version")","message":"$(json_escape "$message")","updatedAt":$(date +%s)}
EOF
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

print_status() {
  if [ -f "$STATUS_FILE" ]; then
    cat "$STATUS_FILE"
  elif deb_app_is_installed; then
    echo "{\"phase\":\"done\",\"percent\":100,\"installed\":true,\"version\":\"$(json_escape "$(deb_app_cur_version)")\",\"message\":\"已安装\",\"updatedAt\":$(date +%s)}"
  else
    echo "{\"phase\":\"idle\",\"percent\":0,\"installed\":false,\"version\":\"\",\"message\":\"未安装\",\"updatedAt\":$(date +%s)}"
  fi
}

content_length() {
  curl -fsSLI -A "$DEB_APP_UA" "$1" 2>/dev/null | tr -d '\r' \
    | awk 'tolower($1)=="content-length:"{v=$2} END{print v}'
}

do_install() {
  local urls_text
  if ! urls_text="$(deb_app_download_urls)" || [ -z "$urls_text" ]; then
    write_status error 0 "$(deb_app_resolve_error_message)"
    return
  fi

  local -a urls
  mapfile -t urls <<< "$urls_text"
  if [ "${#urls[@]}" -eq 0 ]; then
    write_status error 0 "$(deb_app_resolve_error_message)"
    return
  fi

  rm -rf "$DEB_APP_WORK_DIR"
  mkdir -p "$DEB_APP_WORK_DIR"

  local tmp="$DEB_APP_WORK_DIR/${DEB_APP_ID:-app}.deb"
  local pid total cur pct rc=1 i url

  for i in "${!urls[@]}"; do
    url="${urls[$i]}"
    [ -n "$url" ] || continue
    rm -f "$tmp"
    total="$(content_length "$url")"
    : "${total:=0}"

    write_status downloading 0 "正在下载${DEB_APP_NAME}安装包"
    curl -fSL --retry 3 -A "$DEB_APP_UA" -o "$tmp" "$url" & pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      if [ "${total:-0}" -gt 0 ] 2>/dev/null; then
        cur="$(stat -c%s "$tmp" 2>/dev/null || echo 0)"
        pct=$(( cur * 90 / total ))
        [ "$pct" -gt 90 ] && pct=90
        write_status downloading "$pct" "正在下载${DEB_APP_NAME}安装包"
      else
        write_status downloading -1 "正在下载${DEB_APP_NAME}安装包"
      fi
      sleep 1
    done
    wait "$pid"; rc=$?
    [ "$rc" -eq 0 ] && break
    if [ "$i" -lt $((${#urls[@]} - 1)) ]; then
      write_status downloading -1 "下载线路失败，尝试备用线路"
    fi
  done

  if [ "$rc" -ne 0 ]; then
    write_status error 0 "下载失败，请检查网络后重试"
    rm -rf "$DEB_APP_WORK_DIR"
    return
  fi

  write_status extracting 92 "正在解压安装"
  local newroot="$DEB_APP_WORK_DIR/new"
  rm -rf "$newroot"; mkdir -p "$newroot"
  if ! dpkg-deb -x "$tmp" "$newroot" 2>/dev/null; then
    write_status error 0 "解压失败，安装包可能损坏"
    rm -rf "$DEB_APP_WORK_DIR"
    return
  fi

  local ver
  ver="$(dpkg-deb -f "$tmp" Version 2>/dev/null || echo "")"

  if [ ! -x "$newroot/$DEB_APP_BIN_REL" ]; then
    write_status error 0 "解压后未找到${DEB_APP_NAME}可执行文件"
    rm -rf "$DEB_APP_WORK_DIR"
    return
  fi

  write_status installing 96 "正在安装"
  rm -rf "$DEB_APP_INSTALL_DIR.old"
  [ -e "$DEB_APP_INSTALL_DIR" ] && mv "$DEB_APP_INSTALL_DIR" "$DEB_APP_INSTALL_DIR.old"
  mv "$newroot" "$DEB_APP_INSTALL_DIR"
  echo "$ver" > "$DEB_APP_VERSION_FILE"
  rm -rf "$DEB_APP_INSTALL_DIR.old" "$DEB_APP_WORK_DIR"

  write_status done 100 "安装完成"
  pkill -f "${DEB_APP_PROCESS_PATTERN:-$DEB_APP_INSTALL_DIR/$DEB_APP_BIN_REL}" 2>/dev/null || true
}

deb_app_main() {
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
}
