# 应用定义（被 autostart 与 app-ctl.sh source）。给定应用类型，输出：
#   APP_BIN    — 可执行文件路径（autostart 据此判断是否已就绪）
#   APP_LAUNCH — 启动命令（可带参数；autostart 以 word-split 方式执行）
#   APP_NAME   — 显示名（日志用）
#   APP_PROCESS_PATTERN — pgrep -f 进程匹配，用于避免重复拉起与隐藏窗口恢复
#   APP_WINDOW_CLASS_RE — 顶层主窗口 WM_CLASS 匹配，用于 autostart 最大化看守
#   APP_RESTART_ON_HIDE — 窗口隐藏后重启应用恢复界面（用于 QQ/Electron 白屏规避）
#   APP_RUNTIME_PROFILE — 运行时环境 profile（软件渲染、Electron/Telegram 内存收缩等）
# 缺省类型为微信；未知类型直接报错。

# shellcheck source=/dev/null
. /woc/app-runtime.sh

woc_app_def() {
  APP_REOPEN=
  APP_RESTART_ON_HIDE=
  APP_PROCESS_PATTERN=
  APP_RUNTIME_PROFILE=software
  case "${1:-wechat}" in
    wechat)
      APP_BIN=/config/wechat/opt/wechat/wechat
      APP_LAUNCH="$APP_BIN"
      APP_NAME=微信
      APP_PROCESS_PATTERN="$APP_BIN"
      APP_WINDOW_CLASS_RE='wechat|WeChat|weixin|Weixin'
      ;;
    chromium)
      # 容器内无 user namespace / GPU：--no-sandbox + 软件渲染；--password-store=basic 免 keyring 弹窗。
      # --disable-background-networking 关闭 GCM/组件更新等后台请求，不影响前台网页加载。
      APP_BIN=/usr/local/bin/woc-browser
      APP_LAUNCH="$APP_BIN"
      APP_NAME=Chromium
      APP_PROCESS_PATTERN='/usr/bin/chromium|chromium'
      APP_WINDOW_CLASS_RE='chromium|Chromium'
      ;;
    qq)
      APP_BIN=/config/qq/opt/QQ/qq
      APP_LAUNCH="$APP_BIN $(woc_qq_chromium_flags_inline)"
      APP_NAME=QQ
      APP_PROCESS_PATTERN="$APP_BIN"
      APP_WINDOW_CLASS_RE='QQ|qq'
      APP_RESTART_ON_HIDE=1
      APP_RUNTIME_PROFILE=qq
      ;;
    telegram)
      APP_BIN=/config/telegram/Telegram/Telegram
      APP_LAUNCH="$APP_BIN"
      APP_NAME=Telegram
      APP_PROCESS_PATTERN="$APP_BIN"
      APP_WINDOW_CLASS_RE='Telegram|telegram-desktop'
      APP_RUNTIME_PROFILE=telegram
      ;;
    *)
      echo "未知应用类型: ${1:-}" >&2
      return 1
      ;;
  esac
}
