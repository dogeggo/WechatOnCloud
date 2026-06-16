# 应用定义（被 autostart 与 app-ctl.sh source）。给定应用类型，输出：
#   APP_BIN    — 可执行文件路径（autostart 据此判断是否已就绪）
#   APP_LAUNCH — 启动命令（可带参数；autostart 以 word-split 方式执行）
#   APP_NAME   — 显示名（日志用）
#   APP_WINDOW_CLASS_RE — 顶层主窗口 WM_CLASS 匹配，用于 autostart 最大化看守
# 缺省类型为微信；未知类型直接报错。
woc_chromium_software_flags() {
  printf '%s\n' \
    --no-sandbox \
    --disable-gpu \
    --disable-gpu-compositing \
    --disable-gpu-rasterization \
    --disable-vulkan \
    --disable-accelerated-video-decode \
    --disable-accelerated-video-encode \
    --disable-features=VaapiVideoDecoder,VaapiVideoEncoder,Vulkan \
    --enable-unsafe-swiftshader \
    --use-gl=swiftshader \
    --use-angle=swiftshader
}

woc_chromium_software_flags_inline() {
  local flags=()
  local flag
  while IFS= read -r flag; do
    flags+=("$flag")
  done < <(woc_chromium_software_flags)
  printf '%s' "${flags[*]}"
}

woc_app_def() {
  case "${1:-wechat}" in
    wechat)
      APP_BIN=/config/wechat/opt/wechat/wechat
      APP_LAUNCH="$APP_BIN"
      APP_NAME=微信
      APP_WINDOW_CLASS_RE='wechat|WeChat|weixin|Weixin'
      ;;
    chromium)
      # 容器内无 user namespace / GPU：--no-sandbox + 软件渲染；--password-store=basic 免 keyring 弹窗。
      # --disable-background-networking 关闭 GCM/组件更新等后台请求，不影响前台网页加载。
      APP_BIN=/usr/local/bin/woc-browser
      APP_LAUNCH="$APP_BIN"
      APP_NAME=Chromium
      APP_WINDOW_CLASS_RE='chromium|Chromium'
      ;;
    qq)
      APP_BIN=/config/qq/opt/QQ/qq
      APP_LAUNCH="$APP_BIN $(woc_chromium_software_flags_inline)"
      APP_NAME=QQ
      APP_WINDOW_CLASS_RE='QQ|qq'
      ;;
    *)
      echo "未知应用类型: ${1:-}" >&2
      return 1
      ;;
  esac
}
