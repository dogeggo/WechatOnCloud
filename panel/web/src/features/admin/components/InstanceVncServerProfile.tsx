import { useState, type FormEvent } from 'react';
import { api, type InstanceWithStatus, type PanelInstance, type VncServerProfile } from '../../../api';
import { VNC_SERVER_PROFILE_OPTIONS } from '../../../domain/vncServerProfile';
import { useUI } from '../../../ui';
import { errorMessage } from '../../../utils/errors';

export function InstanceVncServerProfile({
  inst,
  onClose,
  onDone,
}: {
  inst: InstanceWithStatus;
  onClose: () => void;
  onDone: (instance: PanelInstance) => void;
}) {
  const { toast } = useUI();
  const [profile, setProfile] = useState<VncServerProfile>(inst.vncServerProfile);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const { instance } = await api.setInstanceVncServerProfile(inst.id, profile);
      toast('VNC 服务端档位已保存，实例正在重启', 'ok');
      onDone(instance);
      onClose();
    } catch (error) {
      setErr(errorMessage(error, '保存失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="card modal" onClick={(event) => event.stopPropagation()} onSubmit={submit} style={{ maxWidth: 500 }}>
        <h2>VNC服务端 · {inst.name}</h2>
        <div className="muted small" style={{ lineHeight: 1.6 }}>
          这里调整 KasmVNC 服务端编码参数。保存后会重建该实例容器，当前远程连接会断开，数据卷和应用数据保留。
        </div>

        <div className="vnc-profile-list">
          {VNC_SERVER_PROFILE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.profile}
              className={'vnc-profile-option' + (profile === option.profile ? ' on' : '')}
              onClick={() => setProfile(option.profile)}
              disabled={busy}
            >
              <span className="vnc-profile-top">
                <b>{option.label}</b>
                {inst.vncServerProfile === option.profile && <span className="tag tag-on">当前</span>}
              </span>
              <span className="muted small">{option.description}</span>
              <span className="vnc-profile-detail">{option.detail}</span>
            </button>
          ))}
        </div>

        {err && <div className="error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || profile === inst.vncServerProfile}>
            {busy ? '保存并重启中...' : '保存并重启实例'}
          </button>
        </div>
      </form>
    </div>
  );
}
