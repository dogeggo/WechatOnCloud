import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// ── Toast ───────────────────────────────────────────────
type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

// ── Confirm ─────────────────────────────────────────────
interface ConfirmOpts {
  title: string;
  body?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface UICtx {
  toast: (text: string, kind?: ToastKind) => void;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
}

const Ctx = createContext<UICtx>(null!);

export function UIProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const seq = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++seq.current;
    setToasts((list) => [...list, { id, text, kind }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 2600);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve })),
    [],
  );

  const close = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={'toast toast-' + t.kind}>
            {t.text}
          </div>
        ))}
      </div>
      {confirmState && (
        <div className="modal-mask" onClick={() => close(false)}>
          <div className="card modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 340 }}>
            <h2>{confirmState.title}</h2>
            {confirmState.body && <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>{confirmState.body}</div>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => close(false)}>
                {confirmState.cancelText || '取消'}
              </button>
              <button
                type="button"
                className={'btn ' + (confirmState.danger ? 'btn-danger' : 'btn-primary')}
                onClick={() => close(true)}
              >
                {confirmState.confirmText || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useUI = () => useContext(Ctx);
