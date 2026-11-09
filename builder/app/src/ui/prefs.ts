// Persisted UI preferences (recent/pinned parts, recent colours, tips seen, settings) and
// transient UI state shared between phone and desktop chrome. Never part of the model / undo.
import { create } from 'zustand';
import type { PendingState } from '../engine/types';
import { useEditor } from '../model/store';

const PREFS_KEY = 'brickyard.prefs.v1';
const HOTBAR_SIZE = 6;
/** Shown in the hotbar until the user has picked a few parts of their own. */
export const DEFAULT_HOTBAR = ['3001.dat', '3003.dat', '3004.dat', '3020.dat', '3022.dat', '3039.dat'];

export type TipId = 'pending' | 'placed' | 'orbit' | '2d' | 'select';
export type NudgeStep = 'stud' | 'half' | 'brick';

interface Persisted {
  recentParts: string[];
  pinnedParts: string[];
  recentColors: number[];
  tipsSeen: Partial<Record<TipId, true>>;
  haptics: boolean;
  /** Show Duplo / Modulex / Quatro / Primo parts in the picker. */
  showAllParts: boolean;
  nudgeStep: NudgeStep;
  /** Show the nudge pad for selections too (always shown for a pending brick on touch). */
  nudgeForSelection: boolean;
}

export interface PrefsState extends Persisted {
  pushRecentPart(id: string): void;
  togglePin(id: string): void;
  pushRecentColor(code: number): void;
  markTip(id: TipId): void;
  resetTips(): void;
  set<K extends keyof Persisted>(k: K, v: Persisted[K]): void;
}

const DEFAULTS: Persisted = {
  recentParts: [],
  pinnedParts: [],
  recentColors: [],
  tipsSeen: {},
  haptics: true,
  showAllParts: false,
  nudgeStep: 'stud',
  nudgeForSelection: false,
};

function load(): Persisted {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) };
  } catch {
    /* storage unavailable / corrupt */
  }
  return { ...DEFAULTS };
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...load(),
  pushRecentPart(id) {
    const cur = get().recentParts;
    if (cur[0] === id) return;
    // Already on the hotbar → keep the slot order stable (keys 1–6 / muscle memory).
    const bar = hotbarParts(get());
    if (bar.includes(id)) {
      const pins = get().pinnedParts;
      const stable = bar.filter((p) => !pins.includes(p));
      set({ recentParts: [...stable, ...cur.filter((p) => !stable.includes(p))].slice(0, 12) });
      return;
    }
    set({ recentParts: [id, ...cur.filter((p) => p !== id)].slice(0, 12) });
  },
  togglePin(id) {
    const pins = get().pinnedParts;
    if (pins.includes(id)) set({ pinnedParts: pins.filter((p) => p !== id) });
    else set({ pinnedParts: [...pins, id].slice(-HOTBAR_SIZE) });
  },
  pushRecentColor(code) {
    const cur = get().recentColors;
    if (cur[0] === code) return;
    set({ recentColors: [code, ...cur.filter((c) => c !== code)].slice(0, 6) });
  },
  markTip(id) {
    if (get().tipsSeen[id]) return;
    set({ tipsSeen: { ...get().tipsSeen, [id]: true } });
  },
  resetTips: () => set({ tipsSeen: {} }),
  set: (k, v) => set({ [k]: v } as Partial<PrefsState>),
}));

usePrefs.subscribe((s) => {
  const out: Persisted = {
    recentParts: s.recentParts,
    pinnedParts: s.pinnedParts,
    recentColors: s.recentColors,
    tipsSeen: s.tipsSeen,
    haptics: s.haptics,
    showAllParts: s.showAllParts,
    nudgeStep: s.nudgeStep,
    nudgeForSelection: s.nudgeForSelection,
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(out));
  } catch {
    /* ignore */
  }
});

/** Pinned first, then recents, padded with defaults: always HOTBAR_SIZE parts. */
export function hotbarParts(s: Pick<Persisted, 'recentParts' | 'pinnedParts'>): string[] {
  const out: string[] = [];
  for (const p of [...s.pinnedParts, ...s.recentParts, ...DEFAULT_HOTBAR]) {
    if (!out.includes(p)) out.push(p);
    if (out.length === HOTBAR_SIZE) break;
  }
  return out;
}

// Track recents from the editor store (works for every way a part / colour gets picked).
useEditor.subscribe((s, p) => {
  if (s.readOnly) return;
  if (s.activePart && s.activePart !== p.activePart) usePrefs.getState().pushRecentPart(s.activePart);
  if (s.activeColor !== p.activeColor) usePrefs.getState().pushRecentColor(s.activeColor);
});

// ---------------------------------------------------------------- transient UI state

export type SheetId = 'parts' | 'colors' | 'menu' | 'selection-more' | 'shortcuts' | null;

interface UiState {
  pending: PendingState;
  floating: boolean;
  /** Increments on every blocked placement attempt (drives the shake animation). */
  blockedPulse: number;
  /** "Add more" multi-select mode on touch. */
  addMore: boolean;
  sheet: SheetId;
  /** Tip currently on screen. */
  tip: TipId | null;
}

export const useUi = create<UiState>(() => ({
  pending: { active: false, blocked: false },
  floating: false,
  blockedPulse: 0,
  addMore: false,
  sheet: null,
  tip: null,
}));

export const openSheet = (sheet: SheetId) => useUi.setState({ sheet });
export const closeSheet = () => useUi.setState({ sheet: null });

/** Show a one-time tip (no-op when it was seen, or another tip is up). */
export function showTip(id: TipId): void {
  if (usePrefs.getState().tipsSeen[id] || useUi.getState().tip) return;
  useUi.setState({ tip: id });
}
export function dismissTip(): void {
  const t = useUi.getState().tip;
  if (t) usePrefs.getState().markTip(t);
  useUi.setState({ tip: null });
}

// "Add more": a touch tap replaces the selection with one brick → turn that into a toggle-add.
let adjusting = false;
useEditor.subscribe((s, p) => {
  if (adjusting || !useUi.getState().addMore || s.selection === p.selection) return;
  const prev = p.selection;
  const next = s.selection;
  if (next.length === 1 && prev.length > 0 && !prev.includes(next[0])) {
    adjusting = true;
    useEditor.getState().select([...prev, next[0]]);
    adjusting = false;
  }
});
// Leaving select mode or clearing the selection ends "Add more".
useEditor.subscribe((s) => {
  if (useUi.getState().addMore && (s.selection.length === 0 || s.tool !== 'select')) useUi.setState({ addMore: false });
});
