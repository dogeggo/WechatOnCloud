import type { InstanceWithStatus } from '../../../api';
import { useDeleteInstance } from '../useDeleteInstance';

export function DeleteInstance({ inst, onClose, onDone }: { inst: InstanceWithStatus; onClose: () => void; onDone: () => void }) {
  const form = useDeleteInstance(inst, onDone);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
        <h2>删除实例「{inst.name}」？</h2>
        <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          容器会被移除。默认保留应用数据（数据卷），之后可重建同名实例恢复。
        </div>
        <label className={'purge-opt' + (form.purge ? ' on' : '')} onClick={() => form.setPurge((v) => !v)}>
          <span className="purge-check">{form.purge ? '✓' : ''}</span>
          <span>
            同时永久删除应用数据（数据卷）
            <span className="muted small" style={{ display: 'block' }}>不可恢复，请谨慎勾选</span>
          </span>
        </label>
        {form.err && <div className="error">{form.err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-danger" disabled={form.busy} onClick={form.submit}>
            {form.purge ? '连数据一起删除' : '删除实例'}
          </button>
        </div>
      </div>
    </div>
  );
}
