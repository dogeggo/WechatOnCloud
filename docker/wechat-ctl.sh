#!/bin/bash
# 微信下载/解压控制脚本。由面板经 docker exec 触发：
#   install / update   下载官方 deb、dpkg-deb -x 解压到 /config/wechat
#   status             输出当前状态 JSON（面板轮询用）
set -u

DEB_APP_ID=wechat
DEB_APP_NAME=微信
DEB_APP_INSTALL_DIR=/config/wechat
DEB_APP_WORK_DIR=/config/.woc-dl/wechat
DEB_APP_BIN_REL=opt/wechat/wechat

CDN_MAIN="${WECHAT_CDN:-https://dldir1v6.qq.com/weixin/Universal/Linux}"
CDN_FALLBACK="${WECHAT_CDN_FALLBACK:-https://dldir1.qq.com/weixin/Universal/Linux}"

deb_filename() {
  case "$(dpkg --print-architecture 2>/dev/null)" in
    amd64) echo "WeChatLinux_x86_64.deb" ;;
    arm64) echo "WeChatLinux_arm64.deb" ;;
    *) echo "" ;;
  esac
}

deb_app_download_urls() {
  local file
  file="$(deb_filename)"
  [ -n "$file" ] || return 1
  echo "$CDN_MAIN/$file"
  [ "$CDN_FALLBACK" = "$CDN_MAIN" ] || echo "$CDN_FALLBACK/$file"
}

deb_app_resolve_error_message() {
  echo "不支持的架构：微信仅提供 x86_64 / arm64"
}

# shellcheck source=/dev/null
. /woc/deb-app-ctl.sh
deb_app_main "${1:-status}"
