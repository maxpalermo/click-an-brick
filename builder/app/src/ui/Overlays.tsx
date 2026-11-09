import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { useToasts } from './toast';
import { IconClose } from './Icons';

/** Centered modal dialog with backdrop; Esc / backdrop click closes. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Focus the first [data-autofocus] element once it appears (content may load later).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tryFocus = () => {
      const target = el.querySelector<HTMLElement>('[data-autofocus]');
      if (target && !el.contains(document.activeElement)) target.focus();
      return !!target;
    };
    if (tryFocus()) return;
    const mo = new MutationObserver(() => tryFocus() && mo.disconnect());
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn ghost" onClick={onClose} aria-label="Close">
            <IconClose size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            data-autofocus
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}

/**
 * Bottom sheet for phones. `half` sheets start at ~55vh and can be dragged up to full height;
 * dragging the handle down closes. `see-through` keeps the canvas visible (no dimming) so live
 * previews (recolour) stay readable. The sheet reports itself as a bottom inset to the engine.
 */
export function Sheet({
  title,
  onClose,
  children,
  half,
  seeThrough,
  className,
  headExtra,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  half?: boolean;
  seeThrough?: boolean;
  className?: string;
  headExtra?: ReactNode;
}) {
  const [closing, setClosing] = useState(false);
  const [full, setFull] = useState(false);
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ y: number; id: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = () => {
    setClosing(true);
    window.setTimeout(() => closeRef.current(), 180);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onDown = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    drag.current = { y: e.clientY, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    if (drag.current?.id === e.pointerId) setDragY(e.clientY - drag.current.y);
  };
  const onUp = (e: RPointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    const dy = e.clientY - drag.current.y;
    drag.current = null;
    setDragY(0);
    if (Math.abs(dy) < 6) {
      if (half && !full) setFull(true);
      return;
    }
    if (dy < -40 && half) setFull(true);
    else if (dy > 60) {
      if (full && half) setFull(false);
      else close();
    }
  };
  return (
    <div
      className={`sheet-backdrop ${closing ? 'closing' : ''} ${seeThrough ? 'see-through' : ''}`}
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className={`sheet ${half ? 'half' : ''} ${full ? 'full' : ''} ${className ?? ''}`}
        role="dialog"
        aria-label={typeof title === 'string' ? title : undefined}
        data-inset="bottom"
        style={dragY ? { transform: `translateY(${Math.max(-80, dragY)}px)`, transition: 'none' } : undefined}
      >
        <div className="sheet-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="sheet-handle" />
          <div className="sheet-head">
            <h2>{title}</h2>
            {headExtra}
            <button className="icon-btn ghost" onClick={close} aria-label="Close">
              <IconClose size={18} />
            </button>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Toasts() {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} role="status">
          <span>{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation();
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}
