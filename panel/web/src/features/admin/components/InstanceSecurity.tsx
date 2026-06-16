import type { InstanceWithStatus, PanelInstance } from '../../../api';
import { useInstanceSecurity } from '../useInstanceSecurity';

export function InstanceSecurity({
  inst,
  onClose,
  onDone,
}: {
  inst: InstanceWithStatus;
  onClose: () => void;
  onDone: (instance?: PanelInstance) => void;
}) {
  const panel = useInstanceSecurity({ inst, onClose, onDone });

  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={panel.submit} style={{ maxWidth: 460 }}>
        <h2>安全 · {inst.name}</h2>
        {!panel.loaded ? (
          <div className="muted small" style={{ padding: '14px 0' }}>读取中…</div>
        ) : !panel.data ? (
          <div className="error">{panel.err || '读取失败'}</div>
        ) : (
          <>
            <div className="muted small" style={{ lineHeight: 1.6 }}>
              当 KasmVNC/Xvnc 长跑泄漏内存时，面板的 watchdog 会自动重启实例。两档阈值（单位 MiB）：
              <br />
              <b>soft</b>：超过且<b>无人在远程会话</b>时柔和重启（不打扰使用者）。
              <br />
              <b>hard</b>：超过即<b>强制重启</b>，无视会话，防止 OOM 拖垮宿主。
            </div>

            <div className="security-status">
              <div className="security-row">
                <span>当前内存</span>
                <b>{panel.data.currentMB > 0 ? `${panel.data.currentMB} MiB` : '—'}</b>
              </div>
              <div className="security-row">
                <span>面板默认</span>
                <span className="muted">soft {panel.data.defaultSoft} · hard {panel.data.defaultHard}</span>
              </div>
              <div className="security-row">
                <span>巡检间隔</span>
                <span className="muted">
                  {panel.data.watchdogEnabled ? `每 ${panel.data.intervalSec}s` : 'watchdog 已关闭'}
                </span>
              </div>
            </div>

            <div className="field-label" style={{ marginTop: 12 }}>soft 阈值（留空 = 用默认 {panel.data.defaultSoft}）</div>
            <input
              className="input"
              inputMode="numeric"
              placeholder={`${panel.data.defaultSoft}`}
              value={panel.softStr}
              onChange={(e) => panel.setSoftStr(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <div className="field-label" style={{ marginTop: 8 }}>hard 阈值（留空 = 用默认 {panel.data.defaultHard}）</div>
            <input
              className="input"
              inputMode="numeric"
              placeholder={`${panel.data.defaultHard}`}
              value={panel.hardStr}
              onChange={(e) => panel.setHardStr(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <div className="muted small" style={{ marginTop: 6 }}>
              提示：日常活跃内存约 1500 MiB；soft 建议略高于此（如 2000），hard 建议远低于宿主可用内存（如 3000~4000）。
            </div>

            <div className="field-label" style={{ marginTop: 16 }}>设备身份（machine-id）</div>
            <div className="muted small" style={{ lineHeight: 1.6 }}>
              客户端可能会用设备标识做风控。若该账号被判定<b>设备风险</b>、登录后被强制退出且反复循环，
              可重置为一个全新的唯一设备 ID（相当于换台新设备），再重新登录。会重启该实例。
            </div>
            <button
              type="button"
              className="btn"
              style={{ marginTop: 8, alignSelf: 'flex-start' }}
              onClick={panel.regenMachineId}
              disabled={panel.regenBusy || panel.busy}
            >
              {panel.regenBusy ? '重置中…' : '↻ 重置设备 ID 并重启'}
            </button>

            {panel.err && <div className="error">{panel.err}</div>}
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-text" onClick={panel.resetToDefault} disabled={panel.busy}>
            ↺ 恢复默认
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={panel.busy}>
            取消
          </button>
          <button className="btn btn-primary" disabled={panel.busy || !panel.loaded || !panel.data}>
            保存
          </button>
        </div>
      </form>
    </div>
  );
}
