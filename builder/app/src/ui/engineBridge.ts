// UI ↔ engine glue: feature-detected calls into the mobile-redesign engine API (so the UI keeps
// working while the engine lands them), haptics, inset reporting and editor actions.
import { useEffect } from 'react';
import type { BrickyardEngine, EngineFeedback } from '../engine/types';
import { useEditor } from '../model/store';
import { BRICK_H, PLATE_H, STUD } from '../model/types';
import { newId } from '../model/id';
import { showTip, usePrefs, useUi } from './prefs';
import { toast } from './toast';

type Partial2<T> = { [K in keyof T]?: T[K] };
const opt = (e: BrickyardEngine) => e as Partial2<BrickyardEngine>;


// ---------------------------------------------------------------- haptics

const PATTERNS: Record<string, number | number[]> = {
  pending: 8,
  step: 5,
  detent: 10,
  placed: 15,
  blocked: [10, 40, 10],
  select: 8,
  longpress: 20,
  tick: 4,
};
let lastBuzz = 0;
/** Android-only vibration (iOS Safari has no Vibration API). Never the only feedback. */
export function haptic(kind: keyof typeof PATTERNS): void {
  if (!usePrefs.getState().haptics) return;
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
  if (typeof nav.vibrate !== 'function') return;
  const now = performance.now();
  if (now - lastBuzz < 40) return;
  lastBuzz = now;
  try {
    nav.vibrate(PATTERNS[kind]);
  } catch {
    /* ignore */
  }
}
export const canVibrate = () => typeof (navigator as { vibrate?: unknown }).vibrate === 'function';

// ---------------------------------------------------------------- actions

export const actions = {
  duplicate(engine: BrickyardEngine) {
    const s = useEditor.getState();
    if (!s.selection.length) return;
    const fn = opt(engine).duplicateSelection;
    if (typeof fn === 'function') {
      fn.call(engine);
      return;
    }
    // Fallback until the engine ships duplicateSelection(): copy 1 stud along +X, as one undo step.
    const ids = new Set(s.selection);
    const copies = s.model.bricks
      .filter((b) => ids.has(b.id))
      .map((b) => ({ ...b, id: newId(), pos: [b.pos[0] + STUD, b.pos[1], b.pos[2]] as typeof b.pos }));
    s.setModel({ ...s.model, bricks: [...s.model.bricks, ...copies] });
    s.select(copies.map((c) => c.id));
  },
  frameSelection(engine: BrickyardEngine) {
    const fn = opt(engine).frameSelection;
    if (typeof fn === 'function') fn.call(engine);
    else engine.zoomToFit();
  },
  deleteSelection() {
    const s = useEditor.getState();
    const n = s.selection.length;
    if (!n) return;
    s.removeBricks(s.selection);
    toast(`Deleted ${n} brick${n === 1 ? '' : 's'}`, 'info', 4000, { label: 'Undo', run: () => useEditor.getState().undo() });
  },
  recolor(code: number) {
    const s = useEditor.getState();
    s.setActiveColor(code);
    // A pending brick / duplicate takes the active colour (engine); the originals stay as they are.
    if (useUi.getState().pending.active) return;
    if (s.selection.length) {
      const ids = new Set(s.selection);
      const patches = s.model.bricks.filter((b) => ids.has(b.id) && b.color !== code).map((b) => ({ id: b.id, color: code }));
      s.updateBricks(patches);
    }
  },
  /** Eyedropper on the selection: arm its part + colour. */
  usePartOfSelection() {
    const s = useEditor.getState();
    const b = s.model.bricks.find((x) => x.id === s.selection[0]);
    if (!b) {
      toast('Select a brick first', 'info', 2000);
      return;
    }
    s.select([]);
    s.setActiveColor(b.color);
    s.setActivePart(b.part);
    s.setTool('place');
  },
  selectSameColour() {
    const s = useEditor.getState();
    const colors = new Set(s.model.bricks.filter((b) => s.selection.includes(b.id)).map((b) => b.color));
    s.select(s.model.bricks.filter((b) => colors.has(b.color)).map((b) => b.id));
  },
  selectAll() {
    const s = useEditor.getState();
    if (!s.model.bricks.length) return;
    s.setTool('select');
    s.select(s.model.bricks.map((b) => b.id));
  },
  /** Camera-relative nudge with the current step setting. */
  nudge(engine: BrickyardEngine, axis: 'x' | 'y' | 'z', dir: '+' | '-', fineOverride?: boolean) {
    const step = usePrefs.getState().nudgeStep;
    if (axis === 'y') {
      const times = step === 'brick' ? BRICK_H / PLATE_H : 1;
      for (let i = 0; i < times; i++) engine.nudge('y', dir);
    } else engine.nudge(axis, dir, fineOverride ?? step === 'half');
    haptic('step');
  },
};

// ---------------------------------------------------------------- engine subscriptions

/** Wire engine events into the UI store: pending state, feedback → haptics/tips/tool switch. */
export function useEngineBridge(engine: BrickyardEngine) {
  useEffect(() => {
    const offs: Array<() => void> = [];
    useUi.setState({ pending: engine.getPending() });
    offs.push(
      engine.onPendingChange((st) => {
        const prev = useUi.getState().pending;
        useUi.setState({ pending: st, ...(st.active ? {} : { floating: false }) });
        if (st.active && !prev.active) {
          haptic('pending');
          showTip('pending');
        }
      }),
    );
    offs.push(
      engine.onPlaceBlocked(() => {
        useUi.setState((u) => ({ blockedPulse: u.blockedPulse + 1 }));
        toast('Overlaps a brick — move it first', 'error', 2200);
        haptic('blocked');
      }),
    );
    const onFeedback = opt(engine).onFeedback;
    if (typeof onFeedback === 'function') {
      offs.push(
        onFeedback.call(engine, (e: EngineFeedback) => {
          switch (e.type) {
            case 'placed':
              haptic('placed');
              break;
            case 'blocked':
              haptic('blocked');
              break;
            case 'selected':
              if (e.count) haptic('select');
              break;
            case 'long-press-select':
              haptic('longpress');
              useEditor.getState().setTool('select');
              break;
            case 'snap-detent':
              haptic('detent');
              break;
            case 'step':
              haptic('step');
              break;
            case 'floating':
              useUi.setState({ floating: e.floating });
              break;
          }
        }),
      );
    }
    // "Add more" multi-select: the engine treats taps as additive while it's on.
    const setAddMode = opt(engine).setAddMode;
    if (typeof setAddMode === 'function') {
      offs.push(useUi.subscribe((u, p) => u.addMore !== p.addMore && setAddMode.call(engine, u.addMore)));
    }
    return () => offs.forEach((f) => f());
  }, [engine]);

  // Tips driven by the store: first committed brick, first 2D entry, first selection.
  useEffect(() => {
    return useEditor.subscribe((s, p) => {
      if (s.readOnly || p.readOnly) return;
      if (s.model.bricks.length > p.model.bricks.length && s.model.name === p.model.name && s.past.length > p.past.length) {
        if (s.model.bricks.length - p.model.bricks.length === 1) showTip('placed');
      }
      if (s.viewMode === '2d' && p.viewMode !== '2d') showTip('2d');
      if (s.selection.length && !p.selection.length) showTip('select');
    });
  }, []);

  // First orbit: a one-finger / left-button drag on the canvas.
  useEffect(() => {
    let start: { x: number; y: number; id: number } | null = null;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      start = t?.tagName === 'CANVAS' && e.isPrimary ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
    };
    const move = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 40) {
        start = null;
        if (usePrefs.getState().tipsSeen.placed) showTip('orbit');
      }
    };
    const up = () => (start = null);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
    };
  }, []);
}

/**
 * Measure the chrome tagged `data-inset="top|bottom|left|right"` inside `root` and report the
 * covered screen edges to the engine (auto-pan, view cube) and to CSS (`--inset-*`).
 */
export function useInsetReporter(engine: BrickyardEngine, root: HTMLElement | null) {
  useEffect(() => {
    if (!root) return;
    let raf = 0;
    let last = '';
    const ro = new ResizeObserver(() => schedule());
    const observed = new Set<Element>();
    const measure = () => {
      raf = 0;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const ins = { top: 0, bottom: 0, left: 0, right: 0 };
      root.querySelectorAll<HTMLElement>('[data-inset]').forEach((el) => {
        if (!observed.has(el)) {
          observed.add(el);
          ro.observe(el);
        }
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const side = el.dataset.inset;
        if (side === 'top') ins.top = Math.max(ins.top, r.bottom);
        else if (side === 'bottom') ins.bottom = Math.max(ins.bottom, H - r.top);
        else if (side === 'left') ins.left = Math.max(ins.left, r.right);
        else if (side === 'right') ins.right = Math.max(ins.right, W - r.left);
      });
      for (const k of Object.keys(ins) as Array<keyof typeof ins>) ins[k] = Math.max(0, Math.round(ins[k]));
      const key = JSON.stringify(ins);
      if (key === last) return;
      last = key;
      for (const [k, v] of Object.entries(ins)) root.style.setProperty(`--inset-${k}`, `${v}px`);
      const fn = opt(engine).setInsets;
      if (typeof fn === 'function') fn.call(engine, ins);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    // Sheets animate with transforms (no resize event) → re-measure once they settle.
    let settle = 0;
    const mo = new MutationObserver(() => {
      schedule();
      window.clearTimeout(settle);
      settle = window.setTimeout(schedule, 260);
    });
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-inset'] });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [engine, root]);
}
