import { useRef, type PointerEvent as RPointerEvent } from 'react';

/**
 * Tap + long-press on the same button. Long-press (default 450 ms, finger kept within 10 px)
 * fires `onLong` and swallows the following click.
 */
export function useLongPress(onTap: () => void, onLong: () => void, ms = 450) {
  const st = useRef<{ t: number; x: number; y: number; fired: boolean } | null>(null);
  const clear = () => {
    if (st.current) window.clearTimeout(st.current.t);
  };
  return {
    onPointerDown(e: RPointerEvent) {
      clear();
      const s = { t: 0, x: e.clientX, y: e.clientY, fired: false };
      s.t = window.setTimeout(() => {
        s.fired = true;
        onLong();
      }, ms);
      st.current = s;
    },
    onPointerMove(e: RPointerEvent) {
      const s = st.current;
      if (s && !s.fired && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) {
        clear();
        st.current = null;
      }
    },
    onPointerUp: clear,
    onPointerCancel() {
      clear();
      st.current = null;
    },
    /** Right-click (mouse) = long-press. On touch the timer usually fired first. */
    onContextMenu(e: { preventDefault(): void }) {
      e.preventDefault();
      if (st.current?.fired) return;
      clear();
      st.current = null;
      onLong();
    },
    onClick() {
      const s = st.current;
      st.current = null;
      if (s?.fired) return;
      onTap();
    },
  };
}

/** Press-and-hold repeat (nudge pad): fires once on press, then every `every` ms after `delay`. */
export function useRepeat(fn: () => void, delay = 380, every = 110) {
  const t = useRef<{ a: number; b: number } | null>(null);
  const stop = () => {
    if (t.current) {
      window.clearTimeout(t.current.a);
      window.clearInterval(t.current.b);
      t.current = null;
    }
  };
  return {
    onPointerDown(e: RPointerEvent) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      stop();
      fn();
      const rec = { a: 0, b: 0 };
      rec.a = window.setTimeout(() => {
        rec.b = window.setInterval(fn, every);
      }, delay);
      t.current = rec;
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onContextMenu(e: { preventDefault(): void }) {
      e.preventDefault();
    },
    onKeyDown(e: { key: string; preventDefault(): void }) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    },
  };
}
