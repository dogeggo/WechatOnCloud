import type { InstanceWithStatus, PanelInstance } from '../../../api';
import { useInstanceRename } from '../useInstanceRename';

export function RenameInstance({
  inst,
  onClose,
  onDone,
}: {
  inst: InstanceWithStatus;
  onClose: () => void;
  onDone: (instance: PanelInstance) => void;
}) {
  const form = useInstanceRename(inst, onDone);
  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={form.submit}>
        <h2>重命名实例</h2>
        <input className="input" placeholder="实例名称" value={form.name} onChange={(e) => form.setName(e.target.value)} autoFocus />
        {form.err && <div className="error">{form.err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!form.canSubmit}>
            保存
          </button>
        </div>
      </form>
    </div>
  );
}
