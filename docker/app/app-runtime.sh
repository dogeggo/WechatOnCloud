# 应用运行时环境 profile。
# 这里只负责环境变量、进程资源策略和启动前清理，不定义具体应用。

# shellcheck source=/dev/null
. /woc/chromium-flags.sh

woc_append_env_word() {
  local name="$1"
  local word="$2"
  local current="${!name:-}"
  case " ${current} " in
    *" ${word} "*) ;;
    *) export "${name}=${current:+$current }$word" ;;
  esac
}

woc_apply_software_rendering_env() {
  local flag
  export LIBGL_ALWAYS_SOFTWARE=1
  export GALLIUM_DRIVER=llvmpipe
  export MESA_LOADER_DRIVER_OVERRIDE=llvmpipe
  export QT_OPENGL=software
  export QT_QUICK_BACKEND=software
  export QT_XCB_FORCE_SOFTWARE_OPENGL=1
  export QTWEBENGINE_DISABLE_SANDBOX=1
  export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
  export GTK_MODULES="${GTK_MODULES:+$GTK_MODULES:}gail:atk-bridge"
  while IFS= read -r flag; do
    woc_append_env_word QTWEBENGINE_CHROMIUM_FLAGS "$flag"
  done < <(woc_chromium_software_flags)
}

woc_apply_malloc_trim_env() {
  export MALLOC_ARENA_MAX=2
  export MALLOC_TRIM_THRESHOLD_=131072
  export MALLOC_MMAP_THRESHOLD_=131072
}

woc_apply_qq_runtime_env() {
  woc_apply_software_rendering_env
  woc_apply_malloc_trim_env
}

woc_apply_telegram_runtime_env() {
  unset LIBGL_ALWAYS_SOFTWARE
  unset GALLIUM_DRIVER
  unset MESA_LOADER_DRIVER_OVERRIDE
  unset QT_OPENGL
  unset QT_QUICK_BACKEND
  unset QT_XCB_FORCE_SOFTWARE_OPENGL
  unset QTWEBENGINE_DISABLE_SANDBOX
  unset QTWEBENGINE_CHROMIUM_FLAGS
  unset QT_LINUX_ACCESSIBILITY_ALWAYS_ON
  unset GTK_MODULES
  woc_apply_malloc_trim_env
}

woc_disable_core_dumps() {
  ulimit -c 0 2>/dev/null || true
}

woc_cleanup_telegram_core_files() {
  local dir=/config/.local/share/TelegramDesktop
  [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -type f \( -name core -o -name 'core.*' \) -delete 2>/dev/null || true
}

woc_apply_app_runtime_env() {
  case "${1:-software}" in
    software)
      woc_apply_software_rendering_env
      ;;
    qq)
      woc_apply_qq_runtime_env
      ;;
    telegram)
      woc_apply_telegram_runtime_env
      ;;
    *)
      echo "未知运行时 profile: ${1:-}" >&2
      return 1
      ;;
  esac
}

woc_prepare_app_runtime() {
  case "${1:-}" in
    telegram)
      woc_disable_core_dumps
      woc_cleanup_telegram_core_files
      ;;
  esac
}
