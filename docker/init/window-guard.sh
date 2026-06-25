# openbox 应用窗口守护。
# autostart 负责生命周期编排，本文件只处理窗口查找、恢复、重启隐藏窗口和尺寸同步。

app_window_ids() {
    local visible_arg=() class_ids pattern pid
    if [ "${1:-}" = "visible" ]; then
        visible_arg=(--onlyvisible)
    fi

    if [ -n "${APP_WINDOW_CLASS_RE:-}" ]; then
        class_ids="$(xdotool search "${visible_arg[@]}" --class "${APP_WINDOW_CLASS_RE}" 2>/dev/null || true)"
        if [ -n "${class_ids}" ]; then
            printf '%s\n' "${class_ids}" | awk 'NF && !seen[$0]++'
            return 0
        fi
    fi

    pattern="${APP_PROCESS_PATTERN:-${APP_BIN:-}}"
    [ -n "${pattern}" ] || return 0
    for pid in $(pgrep -f "${pattern}" 2>/dev/null || true); do
        xdotool search "${visible_arg[@]}" --pid "${pid}" 2>/dev/null || true
    done | awk 'NF && !seen[$0]++'
}

window_is_visible() {
    local w="$1"
    [ -n "${w}" ] || return 1
    xdotool search --onlyvisible --name '.*' 2>/dev/null | grep -qx "${w}"
}

window_matches_app() {
    local w="$1" class pid pattern
    [ -n "${w}" ] || return 1
    if [ -n "${APP_WINDOW_CLASS_RE:-}" ]; then
        class="$(xdotool getwindowclassname "${w}" 2>/dev/null || true)"
        printf '%s\n' "${class}" | grep -Eiq "${APP_WINDOW_CLASS_RE}" && return 0
    fi

    pattern="${APP_PROCESS_PATTERN:-${APP_BIN:-}}"
    [ -n "${pattern}" ] || return 1
    pid="$(xdotool getwindowpid "${w}" 2>/dev/null || true)"
    [ -n "${pid}" ] || return 1
    pgrep -f "${pattern}" 2>/dev/null | grep -qx "${pid}"
}

active_non_app_window() {
    local w
    w="$(xdotool getactivewindow 2>/dev/null || true)"
    [ -n "${w}" ] || return 1
    window_is_visible "${w}" || return 1
    window_matches_app "${w}" && return 1
    return 0
}

active_app_window_id() {
    local w
    w="$(xdotool getactivewindow 2>/dev/null || true)"
    [ -n "${w}" ] || return 1
    window_is_visible "${w}" || return 1
    window_matches_app "${w}" || return 1
    printf '%s\n' "${w}"
}

app_process_running() {
    local pattern
    pattern="${APP_PROCESS_PATTERN:-${APP_BIN:-}}"
    [ -n "${pattern}" ] || return 1
    pgrep -f "${pattern}" >/dev/null 2>&1
}

app_process_max_age_seconds() {
    local pattern pid age max_age=0
    pattern="${APP_PROCESS_PATTERN:-${APP_BIN:-}}"
    [ -n "${pattern}" ] || return 1
    for pid in $(pgrep -f "${pattern}" 2>/dev/null || true); do
        age="$(ps -o etimes= -p "${pid}" 2>/dev/null | awk 'NF{print $1; exit}')"
        case "${age:-}" in
            ''|*[!0-9]* ) continue ;;
        esac
        [ "${age}" -gt "${max_age}" ] && max_age="${age}"
    done
    printf '%s\n' "${max_age}"
}

largest_window_id() {
    local w width height area best= best_area=0
    while IFS= read -r w; do
        [ -n "${w}" ] || continue
        read -r width height < <(
            xdotool getwindowgeometry --shell "${w}" 2>/dev/null \
                | awk -F= '/^WIDTH=/{w=$2} /^HEIGHT=/{h=$2} END{print w, h}'
        )
        case "${width:-}:${height:-}" in
            *[!0-9:]* | : | *: ) continue ;;
        esac
        [ "${width}" -ge 160 ] 2>/dev/null || continue
        [ "${height}" -ge 120 ] 2>/dev/null || continue
        area=$((width * height))
        if [ "${area}" -gt "${best_area}" ]; then
            best="${w}"
            best_area="${area}"
        fi
    done
    [ -n "${best}" ] && printf '%s\n' "${best}"
}

maximize_window() {
    local w="$1" wm_w dw dh
    [ -n "${w}" ] || return 0
    xdotool windowmap "${w}" windowraise "${w}" windowactivate "${w}" 2>/dev/null || true
    if command -v wmctrl >/dev/null 2>&1; then
        case "${w}" in
            *[!0-9]* ) wm_w="${w}" ;;
            * ) printf -v wm_w '0x%08x' "${w}" ;;
        esac
        wmctrl -i -r "${wm_w}" -b remove,hidden,shaded 2>/dev/null || true
        wmctrl -i -r "${wm_w}" -b add,maximized_vert,maximized_horz 2>/dev/null || true
        xdotool windowraise "${w}" windowactivate "${w}" 2>/dev/null || true
    fi

    read -r dw dh < <(xdotool getdisplaygeometry 2>/dev/null || true)
    [ -n "${dw:-}" ] && [ -n "${dh:-}" ] || return 0
    xdotool windowmove "${w}" 0 0 windowsize "${w}" "${dw}" "${dh}" 2>/dev/null || true
}

sync_visible_window_size() {
    local w="$1" wm_w dw dh x y width height
    [ -n "${w}" ] || return 0
    read -r dw dh < <(xdotool getdisplaygeometry 2>/dev/null || true)
    [ -n "${dw:-}" ] && [ -n "${dh:-}" ] || return 0
    read -r x y width height < <(
        xdotool getwindowgeometry --shell "${w}" 2>/dev/null \
            | awk -F= '/^X=/{x=$2} /^Y=/{y=$2} /^WIDTH=/{w=$2} /^HEIGHT=/{h=$2} END{print x, y, w, h}'
    )
    case "${x:-}:${y:-}:${width:-}:${height:-}" in
        *[!0-9:]* | *::* | :* | *: ) return 0 ;;
    esac
    [ "${x}" -eq 0 ] 2>/dev/null \
        && [ "${y}" -eq 0 ] 2>/dev/null \
        && [ "${width}" -eq "${dw}" ] 2>/dev/null \
        && [ "${height}" -eq "${dh}" ] 2>/dev/null \
        && return 0

    if command -v wmctrl >/dev/null 2>&1; then
        case "${w}" in
            *[!0-9]* ) wm_w="${w}" ;;
            * ) printf -v wm_w '0x%08x' "${w}" ;;
        esac
        wmctrl -i -r "${wm_w}" -b add,maximized_vert,maximized_horz 2>/dev/null || true
    fi

    xdotool windowmove "${w}" 0 0 windowsize "${w}" "${dw}" "${dh}" 2>/dev/null || true
}

restore_minimized_app_windows() {
    # 防“最小化后丢失”：本桌面（openbox）无任务栏，窗口被最小化就无处恢复。
    # 只处理当前应用窗口；若浏览器/文件选择器等非应用窗口在前台，不抢焦点。
    local w
    active_non_app_window && return 0
    w="$(app_window_ids visible | largest_window_id)"
    [ -n "${w}" ] && return 0

    restart_hidden_app_window && return 0

    w="$(app_window_ids | largest_window_id)"
    [ -n "${w}" ] && maximize_window "${w}"
}

last_app_reopen_at=0
last_app_hidden_restart_at=0
reopen_app_window() {
    local now
    active_non_app_window && return 0
    [ -n "${APP_REOPEN:-}" ] || return 0
    app_process_running || return 0
    now="$(date +%s)"
    [ $((now - last_app_reopen_at)) -ge 6 ] || return 0
    last_app_reopen_at="${now}"
    echo "[autostart] ${APP_NAME} 进程仍在但窗口不可见，尝试重新打开主界面"
    "${APP_REOPEN}" >/dev/null 2>&1 &
}

restart_hidden_app_window() {
    local now age grace pattern pids pid
    [ "${APP_RESTART_ON_HIDE:-}" = "1" ] || return 1
    app_process_running || return 1

    grace="${APP_RESTART_ON_HIDE_GRACE:-15}"
    age="$(app_process_max_age_seconds)"
    [ "${age:-0}" -ge "${grace}" ] 2>/dev/null || return 0

    now="$(date +%s)"
    [ $((now - last_app_hidden_restart_at)) -ge 10 ] || return 0
    last_app_hidden_restart_at="${now}"

    pattern="${APP_PROCESS_PATTERN:-${APP_BIN:-}}"
    pids="$(pgrep -f "${pattern}" 2>/dev/null || true)"
    [ -n "${pids}" ] || return 0

    echo "[autostart] ${APP_NAME} 窗口不可见，重启应用以恢复界面"
    kill -TERM ${pids} 2>/dev/null || true
    sleep 2
    for pid in ${pids}; do
        kill -0 "${pid}" 2>/dev/null && kill -KILL "${pid}" 2>/dev/null || true
    done
    return 0
}

sync_app_window_size() {
    local w active_w
    active_non_app_window && return 0

    w="$(app_window_ids visible | largest_window_id)"
    if [ -n "${w}" ]; then
        # 微信/QQ 的图片预览等窗口通常仍属于同一个应用进程/窗口类。
        # 当前台是这类同应用子窗口时，不要把最大的主窗口重新激活，否则会来回抢焦点。
        active_w="$(active_app_window_id || true)"
        if [ -n "${active_w}" ] && [ "${active_w}" != "${w}" ]; then
            return 0
        fi
        sync_visible_window_size "${w}"
        return 0
    fi

    restart_hidden_app_window && return 0

    w="$(app_window_ids | largest_window_id)"
    if [ -n "${w}" ]; then
        active_w="$(active_app_window_id || true)"
        if [ -n "${active_w}" ] && [ "${active_w}" != "${w}" ]; then
            return 0
        fi
        maximize_window "${w}"
        return 0
    fi

    reopen_app_window
}

woc_start_window_guard() {
    local autostart_pid_file="$1"
    local watcher_pid_file="$2"
    (
        export DISPLAY="${DISPLAY:-:1}"
        while sleep 2; do
            [ -f "${autostart_pid_file}" ] || exit 0
            [ "$(cat "${autostart_pid_file}" 2>/dev/null || true)" = "$$" ] || exit 0
            restore_minimized_app_windows
            sync_app_window_size
        done
    ) &
    printf '%s\n' "$!" > "${watcher_pid_file}"
}
