import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import type { DesktopClientReplacedEvent, InstanceWithStatus } from "../api";
import { api } from "../api";
import { Icons } from "../components/icons";
import {
  appProfile,
  desktopUrl,
  isAppBusy,
  isAppInstalled,
  isRuntimeOffline,
} from "../domain/instances";
import { VNC_STREAM_PROFILES } from "../domain/vncStream";
import { DESKTOP_CLIENT_REPLACED_EVENT } from "../features/desktop/desktopClientEvents";
import { useDesktopFiles } from "../features/desktop/useDesktopFiles";
import { InstanceLogs } from "../features/admin/components/InstanceLogs";
import { useInstanceRuntimeActions } from "../features/desktop/useInstanceRuntimeActions";
import { useSeamlessIme } from "../features/desktop/useSeamlessIme";
import { useVncFrame } from "../features/desktop/useVncFrame";
import { enableKasmImeMode } from "../features/desktop/desktopFrame";
import {
  useVncPerformanceStats,
  type VncPerformanceStats,
} from "../features/desktop/useVncPerformanceStats";
import { useVncStreamSettings } from "../features/desktop/useVncStreamSettings";
import { useInstances } from "../features/instances/instances-context";
import { useUI } from "../ui";
import { formatBytes } from "../utils/format";
import {
  idFromVncKeepAliveKey,
  isVncKeepAliveEnabled,
  isVncKeepAliveKey,
  setVncKeepAliveEnabled,
  VNC_KEEP_ALIVE_EVENT,
  type VncKeepAliveChange,
} from "../vncKeepAlive";

function createDesktopClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export default function InstanceView({
  onOpenMenu,
  instanceId,
  active = true,
}: {
  onOpenMenu: () => void;
  instanceId?: string;
  active?: boolean;
}) {
  const params = useParams<{ id: string }>();
  const id = instanceId ?? params.id;
  const nav = useNavigate();
  const { alert: showAlert, toast } = useUI();
  const { instances, loaded, reload } = useInstances();
  const [logsInst, setLogsInst] = useState<InstanceWithStatus | null>(null);
  const [vncKeepAlive, setVncKeepAlive] = useState(() =>
    id ? isVncKeepAliveEnabled(id) : false,
  );

  const frameRef = useRef<HTMLIFrameElement>(null);
  const [desktopClientId, setDesktopClientId] = useState(createDesktopClientId);
  const [clientReplaced, setClientReplaced] = useState(false);
  const stream = useVncStreamSettings();
  const streamRef = useRef(stream.settings);
  streamRef.current = stream.settings;

  const inst = instances.find((i) => i.id === id);
  const profile = appProfile(inst?.appType);
  // 进入实例时，共享列表可能尚未同步（管理页新建/安装后），先按"探测中"显示加载态，
  // 等列表刷新到该实例或超时后再判定是否真的不存在，避免从管理页跳转时误报"实例不存在"。
  const [probing, setProbing] = useState(true);
  const offline = inst ? isRuntimeOffline(inst.runtime) : false;
  const installed = !!inst && isAppInstalled(inst);
  const showVnc = !!inst && !offline && installed;
  const effectiveShowVnc = showVnc && !clientReplaced;
  const vnc = useVncFrame({
    active,
    showVnc: effectiveShowVnc,
    id,
    frameRef,
    stream: stream.settings,
  });
  const performanceStats = useVncPerformanceStats({
    active,
    showVnc: effectiveShowVnc,
    frameLoaded: vnc.frameLoaded,
    frameRef,
    instanceId: id,
  });
  const targetFps = stream.settings.frameRate;
  const desktopFiles = useDesktopFiles({
    active,
    showVnc: effectiveShowVnc,
    id,
  });
  useSeamlessIme({
    active,
    showVnc: effectiveShowVnc,
    id,
    frameLoaded: vnc.frameLoaded,
    frameRef,
  });
  const runtime = useInstanceRuntimeActions({ id, reload });
  const desktopFrameSrc = useMemo(() => {
    if (!id) return "about:blank";
    enableKasmImeMode();
    return desktopUrl(id, desktopClientId, streamRef.current);
  }, [id, desktopClientId, vnc.vncNonce]);

  useEffect(() => {
    setVncKeepAlive(id ? isVncKeepAliveEnabled(id) : false);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<VncKeepAliveChange>).detail;
      if (detail?.id === id) setVncKeepAlive(detail.enabled);
    };
    const onStorage = (event: StorageEvent) => {
      if (!isVncKeepAliveKey(event.key)) return;
      if (idFromVncKeepAliveKey(event.key!) === id) {
        setVncKeepAlive(event.newValue === "1");
      }
    };
    window.addEventListener(VNC_KEEP_ALIVE_EVENT, onChanged as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(
        VNC_KEEP_ALIVE_EVENT,
        onChanged as EventListener,
      );
      window.removeEventListener("storage", onStorage);
    };
  }, [id]);

  useEffect(() => {
    setProbing(true);
    setClientReplaced(false);
    setDesktopClientId(createDesktopClientId());
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const onReplaced = (event: Event) => {
      const detail = (event as CustomEvent<DesktopClientReplacedEvent>).detail;
      if (detail?.instanceId !== id || detail.clientId !== desktopClientId)
        return;
      setClientReplaced(true);
      void showAlert({
        title: detail.title || `${profile.label}连接已断开`,
        body:
          detail.body || "同一个应用只能保留一个客户端连接，新客户端已接入。",
        confirmText: "知道了",
      });
    };
    window.addEventListener(DESKTOP_CLIENT_REPLACED_EVENT, onReplaced);
    return () =>
      window.removeEventListener(DESKTOP_CLIENT_REPLACED_EVENT, onReplaced);
  }, [desktopClientId, id, profile.label, showAlert]);

  // 探测态收敛：找到实例即结束；否则给共享列表一点刷新时间（AppShell 已在导航时拉取），超时仍无则判定不存在。
  useEffect(() => {
    if (inst) {
      setProbing(false);
      return;
    }
    if (!probing) return;
    const t = window.setTimeout(() => setProbing(false), 2500);
    return () => window.clearTimeout(t);
  }, [inst, probing, id]);

  // 实例未就绪（启动中 / 安装中 / 上下文状态未刷新）时，每 3s 拉取最新状态：
  // 就绪后自动进入桌面，无需手动刷新（修复"安装完进度 100% 仍提示无实例"）。
  useEffect(() => {
    if (showVnc || !id) return;
    const t = window.setInterval(() => {
      if (!document.hidden) void reload();
    }, 3000);
    return () => window.clearInterval(t);
  }, [showVnc, id, reload]);

  if (!id) {
    return <Navigate to="/" replace />;
  }

  const title = inst?.name || `${profile.label}实例`;
  const reconnectDesktopClient = () => {
    setDesktopClientId(createDesktopClientId());
    setClientReplaced(false);
    vnc.reconnect();
  };
  const toggleVncKeepAlive = (enabled: boolean) => {
    if (!id) return;
    setVncKeepAliveEnabled(id, enabled);
    setVncKeepAlive(enabled);
    toast(enabled ? "已开启 VNC 常驻" : "已关闭 VNC 常驻", "ok");
  };

  return (
    <div className="ws-page">
      <header className="ws-head">
        <button className="ws-menu" onClick={onOpenMenu} aria-label="菜单">
          {Icons.menu}
        </button>
        <span className="ws-title">{title}</span>
        {effectiveShowVnc && (
          <>
            <VncPerformanceBadges
              stats={performanceStats}
              targetFps={targetFps}
            />
            <button
              className="ws-action"
              title="文件传输"
              onClick={desktopFiles.toggleFiles}
            >
              文件
            </button>
            <button
              className="ws-action"
              title="重新连接桌面"
              onClick={vnc.reconnect}
            >
              重连
            </button>
            <div className="ws-mode ws-keep" role="group" aria-label="VNC 常驻">
              <button
                className={"ws-mode-btn" + (!vncKeepAlive ? " on" : "")}
                title="切换到其他页面时断开 VNC 连接"
                onClick={() => toggleVncKeepAlive(false)}
              >
                临时
              </button>
              <button
                className={"ws-mode-btn" + (vncKeepAlive ? " on" : "")}
                title="切换到其他页面时保留 VNC 连接"
                onClick={() => toggleVncKeepAlive(true)}
              >
                常驻
              </button>
            </div>
            <div
              className="ws-mode ws-stream"
              role="group"
              aria-label="画质档位"
            >
              {VNC_STREAM_PROFILES.map((option) => (
                <button
                  key={option.profile}
                  className={
                    "ws-mode-btn" +
                    (stream.settings.profile === option.profile ? " on" : "")
                  }
                  title={option.title}
                  onClick={() => {
                    if (stream.settings.profile === option.profile) return;
                    const nextStream = stream.setProfile(option.profile);
                    if (nextStream) streamRef.current = nextStream;
                    toast(
                      option.settings.audio
                        ? `${option.label}模式已启用，正在重连`
                        : `${option.label}模式已启用，音频已关闭，正在重连`,
                      "ok",
                    );
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </>
        )}
      </header>

      {/* —— 各种态 —— */}
      {!loaded || (probing && !inst) ? (
        <div className="iv-stage iv-center">
          <div className="spinner" />
        </div>
      ) : !inst ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">实例不存在</div>
            <button
              className="btn btn-primary iv-notice-btn"
              onClick={() => nav("/")}
            >
              返回主页
            </button>
          </div>
        </div>
      ) : offline ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">
              {inst.runtime === "missing" ? "容器尚未创建" : "实例已停止"}
            </div>
            <button
              className="btn btn-primary iv-notice-btn"
              disabled={runtime.starting}
              onClick={runtime.start}
            >
              {runtime.starting
                ? "启动中…"
                : inst.runtime === "missing"
                  ? "创建并启动"
                  : "启动实例"}
            </button>
            <button className="btn-text" onClick={() => setLogsInst(inst)}>
              查看日志
            </button>
          </div>
        </div>
      ) : isAppBusy(inst.app.phase) ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="spinner" />
            <div className="iv-notice-title">{profile.label}就绪中…</div>
            <div className="iv-notice-sub">
              {inst.app.message || "请稍候"}
              {inst.app.percent >= 0 ? ` · ${inst.app.percent}%` : ""}{" "}
              ——完成后自动进入，无需刷新
            </div>
          </div>
        </div>
      ) : !installed ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">
              {inst.app.phase === "error"
                ? `${profile.label}就绪出错`
                : profile.installTitle}
            </div>
            <div className="iv-notice-sub">
              {inst.app.phase === "error"
                ? inst.app.message || "就绪失败，可在「管理」重试"
                : `该实例容器已就绪，但${profile.needsInstall ? "尚未下载安装" : "尚未完成初始化"}${profile.label}`}
            </div>
            <button
              className="btn btn-primary iv-notice-btn"
              onClick={() => nav("/admin")}
            >
              去「管理」
              {inst.app.phase === "error"
                ? "重试 / 处理"
                : profile.needsInstall
                  ? "下载安装"
                  : "查看状态"}
            </button>
            <button className="btn-text" onClick={() => setLogsInst(inst)}>
              查看日志
            </button>
          </div>
        </div>
      ) : clientReplaced ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">{profile.label}连接已断开</div>
            <div className="iv-notice-sub">
              同一个应用只能保留一个客户端连接，新客户端已接入。
            </div>
            <button
              className="btn btn-primary iv-notice-btn"
              onClick={reconnectDesktopClient}
            >
              重新连接
            </button>
          </div>
        </div>
      ) : (
        <div className="iv-stage iv-stage--vnc">
          <div className="iv-canvas">
            <iframe
              key={`${id}:${desktopClientId}:${vnc.vncNonce}`}
              ref={frameRef}
              className="iv-frame"
              src={desktopFrameSrc}
              title={`${profile.label}桌面`}
              allow="clipboard-read; clipboard-write; autoplay"
              onLoad={vnc.handleFrameLoad}
              onFocus={() => vnc.reconnectIfDisconnected()}
              onMouseDown={() => vnc.reconnectIfDisconnected()}
            />

            {!vnc.frameLoaded && !vnc.loadStuck && (
              <div className="iv-loading">
                <div className="spinner" />
                <div className="iv-loading-text">正在连接桌面…</div>
                <div className="iv-loading-sub">{profile.enterHint}</div>
                <div className="iv-loading-sub">
                  拖文件到窗口任意位置即可上传到 ~/Downloads；
                  {stream.settings.audio
                    ? "声音自动开启，点一下画面即可出声"
                    : "省流模式已关闭音频"}
                </div>
              </div>
            )}

            {!vnc.frameLoaded && vnc.loadStuck && (
              <div className="iv-loading">
                <div className="iv-loading-text">桌面无响应</div>
                <div className="iv-loading-sub">
                  连接超时。请先重新连接；如仍无效，可到「管理」处理该实例。
                </div>
                <div className="iv-stuck-actions">
                  <button className="btn btn-primary" onClick={vnc.reconnect}>
                    重新连接
                  </button>
                </div>
                <div className="iv-loading-sub" style={{ marginTop: 8 }}>
                  也可稍候，面板会自动检测无响应实例并尝试自愈。
                </div>
              </div>
            )}

            {desktopFiles.dragging && (
              <div className="iv-drop" onDragOver={(e) => e.preventDefault()}>
                <div className="drop-card">
                  <div className="drop-icon">⬇</div>
                  <div className="drop-title">松开上传到 ~/Downloads</div>
                  <div className="drop-sub">
                    上传后在应用的下载目录中选择即可
                  </div>
                </div>
              </div>
            )}

            {desktopFiles.showFiles && (
              <div className="iv-files">
                <div className="files-head">
                  <span>文件传输</span>
                  <button
                    className="btn-text"
                    onClick={() => desktopFiles.setShowFiles(false)}
                  >
                    关闭
                  </button>
                </div>
                <div className="files-hint">
                  {desktopFiles.uploading
                    ? "上传中…"
                    : "把文件拖到窗口任意位置即可自动上传。"}
                  下方为下载目录（~/Downloads）里的文件，应用收到的文件另存到下载目录即可在此下载。
                </div>
                <div className="files-list">
                  {desktopFiles.files.length === 0 && (
                    <div
                      className="muted small"
                      style={{ padding: "10px 2px" }}
                    >
                      暂无文件
                    </div>
                  )}
                  {desktopFiles.files.map((f) => (
                    <div key={f.name} className="files-item">
                      <a
                        className="files-dl"
                        href={api.downloadFileUrl(id, f.name)}
                        download={f.name}
                        title="下载"
                      >
                        <span className="files-name">{f.name}</span>
                        <span className="files-size">
                          {formatBytes(f.size)} ↓
                        </span>
                      </a>
                      <button
                        className="files-del"
                        title="删除"
                        onClick={() => desktopFiles.deleteFile(f.name)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {logsInst && (
        <InstanceLogs inst={logsInst} onClose={() => setLogsInst(null)} />
      )}
    </div>
  );
}

const PERF_POPOVER_WIDTH = 360;
const PERF_POPOVER_MARGIN = 12;

function VncPerformanceBadges({
  stats,
  targetFps,
}: {
  stats: VncPerformanceStats;
  targetFps: number | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const latency = stats.latencyMs === null ? "--" : `${stats.latencyMs}ms`;
  const jitter =
    stats.latencyJitterMs === null ? "--" : `${stats.latencyJitterMs}ms`;
  const measuredFps = capMeasuredFps(stats.fps);
  const liveFps = formatFps(measuredFps);
  const fps = targetFps === null ? liveFps : `${targetFps}fps`;
  const resolution = stats.resolution
    ? `${stats.resolution.width}x${stats.resolution.height}`
    : "--";
  const viewport = stats.viewport
    ? `${stats.viewport.width}x${stats.viewport.height}`
    : "--";
  const scale = stats.scalePercent === null ? "--" : `${stats.scalePercent}%`;
  const appMemory =
    stats.appMemoryUsedBytes === null
      ? "--"
      : formatBytes(stats.appMemoryUsedBytes);
  const appMemoryMax =
    stats.appMemoryMaxBytes === null ? "不限制" : formatBytes(stats.appMemoryMaxBytes);
  const buffer =
    stats.websocketBufferedBytes === null
      ? null
      : formatBytes(stats.websocketBufferedBytes);
  const summary = `${latency} · ${liveFps}`;
  const items = [
    { key: "latency", label: "延迟", value: latency },
    { key: "jitter", label: "抖动", value: jitter },
    { key: "fps", label: "帧率", value: fps },
    { key: "liveFps", label: "绘制", value: liveFps },
    { key: "resolution", label: "分辨率", value: resolution },
    { key: "viewport", label: "视窗", value: viewport },
    { key: "scale", label: "缩放", value: scale },
    ...(stats.appMemoryUsedBytes === null
      ? []
      : [
        { key: "appMemory", label: "应用内存", value: appMemory },
        { key: "appMemoryMax", label: "最大内存", value: appMemoryMax },
      ]),
    ...(buffer === null
      ? []
      : [{ key: "buffer", label: "缓冲", value: buffer }]),
  ];
  const title = items.map((item) => `${item.label}：${item.value}`).join("；");
  const popoverStyle = popoverPosition
    ? { left: `${popoverPosition.left}px`, top: `${popoverPosition.top}px` }
    : undefined;

  const syncPopoverPosition = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(
      PERF_POPOVER_WIDTH,
      window.innerWidth - PERF_POPOVER_MARGIN * 2,
    );
    const minLeft = PERF_POPOVER_MARGIN;
    const maxLeft = Math.max(
      minLeft,
      window.innerWidth - width - PERF_POPOVER_MARGIN,
    );
    setPopoverPosition({
      left: Math.round(Math.min(Math.max(rect.left, minLeft), maxLeft)),
      top: Math.round(rect.bottom + 8),
    });
  };
  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const openPopover = () => {
    clearCloseTimer();
    syncPopoverPosition();
    setPopoverOpen(true);
  };
  const closePopover = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => setPopoverOpen(false), 120);
  };

  useEffect(() => {
    if (!popoverOpen) return;
    const sync = () => syncPopoverPosition();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [popoverOpen]);

  useEffect(() => () => clearCloseTimer(), []);

  return (
    <div
      ref={rootRef}
      className={"ws-perf" + (popoverOpen ? " open" : "")}
      tabIndex={0}
      aria-label={`性能数据，${title}`}
      onBlur={closePopover}
      onFocus={openPopover}
      onMouseEnter={openPopover}
      onMouseLeave={closePopover}
      onPointerDown={openPopover}
    >
      <span className="ws-perf-summary">
        <span className="ws-perf-dot" />
        <span className="ws-perf-name">性能</span>
        <span className="ws-perf-summary-value">{summary}</span>
      </span>
      <div
        className="ws-perf-popover"
        role="list"
        aria-label="性能数据详情"
        style={popoverStyle}
        onMouseEnter={openPopover}
        onMouseLeave={closePopover}
      >
        {items.map((item) => (
          <span key={item.key} className="ws-perf-row" role="listitem">
            <span className="ws-perf-k">{item.label}</span>
            <span className="ws-perf-v">{item.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function capMeasuredFps(fps: number | null): number | null {
  if (fps === null) return null;
  if (fps <= 0) return 0;
  return fps;
}

function formatFps(fps: number | null): string {
  if (fps === null) return "--";
  return fps <= 0 ? "静止" : `${fps}fps`;
}
