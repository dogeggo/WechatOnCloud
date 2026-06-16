import { useEffect, useState } from 'react';
import { api, type InstanceWithStatus } from '../../../api';

export function InstanceLogs({
  inst,
  onClose,
}: {
  inst: InstanceWithStatus;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api.instanceLogs(inst.id)
      .then((value) => {
        if (!alive) return;
        setText(value || '（暂无日志）');
      })
      .catch((err) => {
        if (!alive) return;
        setText('');
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [inst.id, reloadKey]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="card modal logs-modal" onClick={(event) => event.stopPropagation()}>
        <div className="logs-head">
          <div>
            <h2>实例日志 · {inst.name}</h2>
            <div className="muted small">最近 600 行容器 stdout / stderr</div>
          </div>
          <button className="btn-text" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            {loading ? '刷新中' : '刷新'}
          </button>
        </div>

        <div className="logs-box">
          {loading ? (
            <div className="logs-state">
              <div className="spinner" />
              <span>正在读取日志…</span>
            </div>
          ) : error ? (
            <div className="error">{error}</div>
          ) : (
            <pre>{text}</pre>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
