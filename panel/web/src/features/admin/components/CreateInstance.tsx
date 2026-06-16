import { APP_TYPES, appProfile } from '../../../domain/instances';
import { useCreateInstance } from '../useCreateInstance';

export function CreateInstance({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const form = useCreateInstance(onDone);

  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={form.submit}>
        <h2>新建实例</h2>
        <div className="field-label">应用类型</div>
        <div className="chip-row" style={{ marginTop: 8, marginBottom: 12 }}>
          {APP_TYPES.map((type) => {
            const profile = appProfile(type);
            return (
              <button
                key={type}
                type="button"
                className={'chip chip-toggle' + (form.appType === type ? ' on' : '')}
                onClick={() => form.setAppType(type)}
              >
                {profile.createLabel}
              </button>
            );
          })}
        </div>
        <input className="input" placeholder="实例名称（如：我的微信 / 我的 QQ / 工作浏览器）" value={form.name} onChange={(e) => form.setName(e.target.value)} />
        {form.orphans.length > 0 && (
          <>
            <div className="field-label" style={{ marginTop: 12 }}>数据卷（可选）</div>
            <select className="input" value={form.reuse} onChange={(e) => form.setReuse(e.target.value)}>
              <option value="">新建空卷（全新登录）</option>
              {form.orphans.map((v) => (
                <option key={v.name} value={v.name}>
                  复用 · {v.name}
                  {v.createdAt ? `（${v.createdAt.slice(0, 10)} 创建）` : ''}
                </option>
              ))}
            </select>
            <div className="muted small" style={{ marginTop: 4 }}>
              复用旧应用数据卷需使用原应用账号登录；浏览器实例建议使用新卷。
            </div>
          </>
        )}
        {form.err && <div className="error">{form.err}</div>}
        <div className="muted small" style={{ marginTop: 4 }}>
          创建后会拉起一个新的 {appProfile(form.appType).createLabel} 容器。
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!form.canSubmit}>
            创建
          </button>
        </div>
      </form>
    </div>
  );
}
