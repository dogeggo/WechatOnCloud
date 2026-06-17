#!/bin/bash
# QQ 下载/解压控制脚本。运行时读取 QQ 官方 Linux 配置，按容器架构选择 .deb。
set -u

DEB_APP_ID=qq
DEB_APP_NAME=QQ
DEB_APP_INSTALL_DIR=/config/qq
DEB_APP_WORK_DIR=/config/.woc-dl/qq
DEB_APP_BIN_REL=opt/QQ/qq

QQ_CONFIG_URL="${QQ_CONFIG_URL:-https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js}"

qq_download_key() {
  case "$(dpkg --print-architecture 2>/dev/null)" in
    amd64) echo "x64DownloadUrl" ;;
    arm64) echo "armDownloadUrl" ;;
    *) echo "" ;;
  esac
}

qq_extract_deb_url() {
  local config="$1" key="$2"
  printf '%s' "$config" | tr -d '\r\n' \
    | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*{[^}]*\"deb\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

deb_app_download_urls() {
  if [ -n "${QQ_DEB_URL:-}" ]; then
    echo "$QQ_DEB_URL"
    return
  fi

  local key config url
  key="$(qq_download_key)"
  [ -n "$key" ] || return 1
  config="$(curl -fsSL -A "${DEB_APP_UA:-Mozilla/5.0}" "$QQ_CONFIG_URL")" || return 1
  url="$(qq_extract_deb_url "$config" "$key")"
  case "$url" in
    http*.deb*) echo "$url" ;;
    *) return 1 ;;
  esac
}

deb_app_resolve_error_message() {
  case "$(dpkg --print-architecture 2>/dev/null)" in
    amd64|arm64) echo "无法解析 QQ 下载地址，请检查网络或官方配置" ;;
    *) echo "不支持的架构：QQ 当前仅提供 amd64 / arm64 安装" ;;
  esac
}

# shellcheck source=/dev/null
. /woc/deb-app-ctl.sh
deb_app_main "${1:-status}"
