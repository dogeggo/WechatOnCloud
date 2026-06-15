import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useInstances } from '../AppShell';
import { Icons } from '../components/icons';
import { appProfile, desktopUrl, isAppBusy, isAppInstalled, isRuntimeOffline } from '../domain/instances';
import { useClipboardBridge } from '../features/desktop/useClipboardBridge';
import { useDesktopControl } from '../features/desktop/useDesktopControl';
import { useDesktopFiles } from '../features/desktop/useDesktopFiles';
import { useImeComposer } from '../features/desktop/useImeComposer';
import { useInstanceRuntimeActions } from '../features/desktop/useInstanceRuntimeActions';
import { useSeamlessIme } from '../features/desktop/useSeamlessIme';
import { useVncFrame } from '../features/desktop/useVncFrame';
import { formatBytes } from '../utils/format';

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
  const { instances, loaded, reload } = useInstances();

  const frameRef = useRef<HTMLIFrameElement>(null);

  const inst = instances.find((i) => i.id === id);
  const profile = appProfile(inst?.appType);
  // 进入实例时，共享列表可能尚未同步（管理页新建/安装后），先按"探测中"显示加载态，
  // 等列表刷新到该实例或超时后再判定是否真的不存在，避免从管理页跳转时误报"实例不存在"。
  const [probing, setProbing] = useState(true);
  const offline = inst ? isRuntimeOffline(inst.runtime) : false;
  const installed = !!inst && isAppInstalled(inst);
  const showVnc = !!inst && !offline && installed;
  const vnc = useVncFrame({ active, showVnc, id, frameRef });
  const desktopFiles = useDesktopFiles({ active, showVnc, id });
  const desktopControl = useDesktopControl({
    active,
    showVnc,
    id,
    frameLoaded: vnc.frameLoaded,
    frameRef,
    focusFrame: vnc.focusFrame,
  });
  const clipboard = useClipboardBridge({ id, frameRef });
  const imeLocked = !!desktopControl.control && !desktopControl.control.free && !desktopControl.control.mine;
  const ime = useImeComposer({
    id,
    controlLocked: imeLocked,
    ensureControl: desktopControl.ensureControl,
    focusFrame: vnc.focusFrame,
  });
  useSeamlessIme({
    active,
    showVnc,
    id,
    frameLoaded: vnc.frameLoaded,
    frameRef,
    inputMode: ime.inputMode,
  });
  const runtime = useInstanceRuntimeActions({ id, reload, reconnect: vnc.reconnect });

  useEffect(() => {
    setProbing(true);
  }, [id]);

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
    nav('/', { replace: true });
    return null;
  }

  const title = inst?.name || `${profile.label}实例`;

  return (
    <div className="ws-page">
      <header className="ws-head">
        <button className="ws-menu" onClick={onOpenMenu} aria-label="菜单">
          {Icons.menu}
        </button>
        <span className="ws-title">{title}</span>
        {showVnc && (
          <>
            <button
              className="ws-action"
              title="文件传输"
              onClick={desktopFiles.toggleFiles}
            >
              文件
            </button>
            <div className="ws-mode" role="group" aria-label="输入模式">
              <button
                className={'ws-mode-btn' + (ime.inputMode === 'seamless' ? ' on' : '')}
                title="无感输入：直接在应用里打中文，候选提交后转发到远端"
                onClick={() => ime.switchInputMode('seamless')}
              >
                无感
              </button>
              <button
                className={'ws-mode-btn' + (ime.inputMode === 'forward' ? ' on' : '')}
                title="转发输入：使用底部输入条发送文本，最稳定"
                onClick={() => ime.switchInputMode('forward')}
              >
                转发
              </button>
            </div>
            <button
              className="ws-action"
              title="把文本发送到容器剪贴板（局域网 http 下也可用）"
              onClick={() => clipboard.setShowClip((v) => !v)}
            >
              剪贴板
            </button>
            <button className="ws-action" title="重启实例（修复卡死/最小化丢失）" onClick={runtime.restartInstance}>
              重启
            </button>
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
            <button className="btn btn-primary iv-notice-btn" onClick={() => nav('/')}>
              返回主页
            </button>
          </div>
        </div>
      ) : offline ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">{inst.runtime === 'missing' ? '容器尚未创建' : '实例已停止'}</div>
            <button className="btn btn-primary iv-notice-btn" disabled={runtime.starting} onClick={runtime.start}>
              {runtime.starting ? '启动中…' : inst.runtime === 'missing' ? '创建并启动' : '启动实例'}
            </button>
            <button className="btn-text" onClick={() => window.open(api.instanceLogsUrl(id), '_blank')}>
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
              {inst.app.message || '请稍候'}
              {inst.app.percent >= 0 ? ` · ${inst.app.percent}%` : ''} ——完成后自动进入，无需刷新
            </div>
          </div>
        </div>
      ) : !installed ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">{inst.app.phase === 'error' ? `${profile.label}就绪出错` : profile.installTitle}</div>
            <div className="iv-notice-sub">
              {inst.app.phase === 'error'
                ? inst.app.message || '就绪失败，可在「管理」重试'
                : `该实例容器已就绪，但${profile.needsInstall ? '尚未下载安装' : '尚未完成初始化'}${profile.label}`}
            </div>
            <button className="btn btn-primary iv-notice-btn" onClick={() => nav('/admin')}>
              去「管理」{inst.app.phase === 'error' ? '重试 / 处理' : profile.needsInstall ? '下载安装' : '查看状态'}
            </button>
            <button className="btn-text" onClick={() => window.open(api.instanceLogsUrl(id), '_blank')}>
              查看日志
            </button>
          </div>
        </div>
      ) : (
        <div className="iv-stage iv-stage--vnc">
          <div className="iv-canvas">
          <iframe
            key={`${id}:${vnc.vncNonce}`}
            ref={frameRef}
            className="iv-frame"
            src={desktopUrl(id)}
            title={`${profile.label}桌面`}
            allow="clipboard-read; clipboard-write; microphone; camera; autoplay"
            onLoad={vnc.handleFrameLoad}
          />

          {!vnc.frameLoaded && !vnc.loadStuck && (
            <div className="iv-loading">
              <div className="spinner" />
              <div className="iv-loading-text">正在连接桌面…</div>
              <div className="iv-loading-sub">{profile.enterHint}</div>
              <div className="iv-loading-sub">拖文件到此处即可上传；声音自动开启，点一下画面即可出声</div>
              {!window.isSecureContext && (
                <div className="iv-loading-warn">当前非 HTTPS 访问，浏览器将禁用麦克风与摄像头（音频播放不受影响）</div>
              )}
            </div>
          )}

          {!vnc.frameLoaded && vnc.loadStuck && (
            <div className="iv-loading">
              <div className="iv-loading-text">桌面无响应</div>
              <div className="iv-loading-sub">连接超时。可能是实例临时卡住，先「重新连接」；若仍无效请「重启实例」。</div>
              <div className="iv-stuck-actions">
                <button
                  className="btn btn-primary"
                  onClick={vnc.reconnect}
                >
                  重新连接
                </button>
                <button className="btn" onClick={runtime.restartInstance}>
                  重启实例
                </button>
              </div>
              <div className="iv-loading-sub" style={{ marginTop: 8 }}>
                也可稍候，面板会自动检测无响应实例并重启自愈。
              </div>
            </div>
          )}

          {desktopFiles.dragging && (
            <div className="iv-drop" onDrop={desktopFiles.onDrop} onDragOver={(e) => e.preventDefault()}>
              <div className="drop-card">
                <div className="drop-icon">⬇</div>
                <div className="drop-title">松开上传到应用桌面</div>
                <div className="drop-sub">上传后在应用里选择即可</div>
              </div>
            </div>
          )}

          {desktopControl.control && !desktopControl.control.free && !desktopControl.control.mine && (
            <div className="iv-lock">
              <div className="iv-lock-card">
                <div className="iv-lock-title">「{desktopControl.control.holder}」正在操作</div>
                <div className="iv-lock-sub">为避免多端互相干扰，你当前为只读模式。</div>
                <button className="btn btn-primary iv-notice-btn" onClick={desktopControl.takeControl}>
                  申请控制
                </button>
              </div>
            </div>
          )}

          {desktopFiles.showFiles && (
            <div className="iv-files">
              <div className="files-head">
                <span>文件传输</span>
                <button className="btn-text" onClick={() => desktopFiles.setShowFiles(false)}>
                  关闭
                </button>
              </div>
              <input
                ref={desktopFiles.fileInput}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files) void desktopFiles.uploadFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button className="btn btn-primary files-upload" disabled={desktopFiles.uploading} onClick={() => desktopFiles.fileInput.current?.click()}>
                {desktopFiles.uploading ? '上传中…' : '＋ 选择文件上传'}
              </button>
              <div className="files-hint">也可直接把文件拖进来。下方为桌面（~/Desktop）里的文件，应用收到的文件另存到桌面即可在此下载。</div>
              <div className="files-list">
                {desktopFiles.files.length === 0 && (
                  <div className="muted small" style={{ padding: '10px 2px' }}>
                    暂无文件
                  </div>
                )}
                {desktopFiles.files.map((f) => (
                  <div key={f.name} className="files-item">
                    <a className="files-dl" href={api.downloadFileUrl(id, f.name)} download={f.name} title="下载">
                      <span className="files-name">{f.name}</span>
                      <span className="files-size">{formatBytes(f.size)} ↓</span>
                    </a>
                    <button className="files-del" title="删除" onClick={() => desktopFiles.deleteFile(f.name)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {clipboard.showClip && (
            <div className="iv-files">
              <div className="files-head">
                <span>文本剪贴板</span>
                <button className="btn-text" onClick={() => clipboard.setShowClip(false)}>
                  关闭
                </button>
              </div>
              <textarea
                className="clip-area"
                value={clipboard.clipText}
                onChange={(e) => clipboard.setClipText(e.target.value)}
                placeholder="在此输入或粘贴文本，点「发送到应用」后到应用输入框按 Ctrl+V 粘贴"
                rows={5}
              />
              <button className="btn btn-primary files-upload" onClick={clipboard.sendClip}>
                发送到应用（容器剪贴板）
              </button>
              <button className="btn-text" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={clipboard.pullClip}>
                ↓ 读取容器剪贴板到此框
              </button>
              <div className="files-hint">
                局域网 http 访问时浏览器会禁用系统级剪贴板同步，故用此框中转：文本→容器剪贴板，再在应用里 Ctrl+V。
              </div>
            </div>
          )}
          </div>

          {ime.inputMode === 'forward' && (
            <div className="iv-imebar">
              <textarea
                className="iv-imebar-input"
                value={ime.imeText}
                onChange={(e) => ime.setImeText(e.target.value)}
                onKeyDown={(e) => {
                  const native = e.nativeEvent as KeyboardEvent;
                  if (native.isComposing || e.keyCode === 229) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void ime.sendImeText(true);
                  }
                }}
                placeholder={imeLocked ? `「${desktopControl.control?.holder}」正在操作，申请控制后可输入` : '文本输入，Enter 发送。Shift+Enter 换行。'}
                disabled={ime.imeDisabled}
                rows={1}
              />
              <select
                className="iv-imebar-key"
                value={ime.imeSubmitKey}
                onChange={(e) => ime.setImeSubmitKey(e.target.value === 'ctrlEnter' ? 'ctrlEnter' : 'enter')}
                disabled={ime.imeDisabled}
                title="应用发送快捷键"
              >
                <option value="enter">Enter发送</option>
                <option value="ctrlEnter">Ctrl+Enter发送</option>
              </select>
              <button
                className="btn iv-imebar-input-only"
                disabled={ime.imeDisabled || !ime.imeText.trim()}
                onClick={() => void ime.sendImeText(false)}
                title="只粘贴到应用输入框，不发送"
              >
                {ime.imeSending === 'input' ? '输入中' : '输入'}
              </button>
              <button
                className="btn btn-primary iv-imebar-send"
                disabled={ime.imeDisabled || !ime.imeText.trim()}
                onClick={() => void ime.sendImeText(true)}
                title="粘贴到应用输入框并发送"
              >
                {ime.imeSending === 'send' ? '发送中' : '发送'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
