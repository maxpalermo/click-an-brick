import { create } from 'zustand';
import type { Brick, Model, Tool, ViewMode } from './types';
import type { BuildSource } from '../api/builds.types';
import { newId } from './id';

const AUTOSAVE_KEY = 'brickyard.autosave.v1';
/** Archive link of the autosaved build ("My builds"): which archived build it is and whether it changed since. */
const AUTOSAVE_META_KEY = 'brickyard.autosave.meta.v1';
const HISTORY_LIMIT = 200;

export interface EditorState {
  model: Model;
  selection: string[];
  tool: Tool;
  viewMode: ViewMode;
  /** Active catalog part for the place tool, e.g. "3001.dat". */
  activePart: string | null;
  activeColor: number;
  /** 2D mode: Y level being edited, in LDU (LDraw axes, so building up = more negative). */
  layerY: number;
  /** True when showing a shared model read-only. */
  readOnly: boolean;
  past: Model[];
  future: Model[];

  // --- "My builds" archive link (not undoable on its own; follows build switches through undo) ---
  /** Id of this build in My builds, or null when it was never saved there. */
  buildId: string | null;
  /** The model as last saved to My builds; the build has unsaved changes when `model !== savedModel`. */
  savedModel: Model | null;
  /** Source to record when this build is first saved (an import / Photo to Bricks result). */
  buildSource: BuildSource;
  photoJobId: string | null;
  /**
   * The build session: one object per build the editor switched to (mutable, identity = "same build").
   * The fields above mirror it. Saves capture it so a save that finishes after a switch updates the right build.
   */
  session: BuildMeta;

  // --- model edits (each one is an undo step) ---
  addBrick(b: Omit<Brick, 'id'> & { id?: string }): string;
  updateBricks(patches: Array<Partial<Brick> & { id: string }>): void;
  removeBricks(ids: string[]): void;
  setModel(m: Model, opts?: { resetHistory?: boolean }): void;
  /**
   * Replace the build with another one (new / open / import / photo / remix) as one undo step.
   * The archive link switches with it, and Undo / Redo across the switch restore the matching link.
   */
  switchBuild(m: Model, meta?: Partial<BuildMeta>): void;
  /**
   * Record a successful save of `saved` (the model that was sent) as archived build `buildId`.
   * `session` is the build session captured when the save started.
   */
  markSaved(buildId: string, saved: Model, session: BuildMeta): void;
  /** Forget the archive link (the archived build was deleted): the next save creates a new one. */
  unlinkBuild(): void;
  /** The archived build was renamed elsewhere (My builds): follow the name without marking changes. */
  applyArchivedName(name: string): void;
  rename(name: string): void;
  undo(): void;
  redo(): void;

  // --- editor state (not undoable) ---
  select(ids: string[], additive?: boolean): void;
  setTool(t: Tool): void;
  setViewMode(v: ViewMode): void;
  setActivePart(p: string | null): void;
  setActiveColor(c: number): void;
  setLayerY(y: number): void;
  setReadOnly(r: boolean): void;
}

export interface BuildMeta {
  buildId: string | null;
  savedModel: Model | null;
  buildSource: BuildSource;
  photoJobId: string | null;
}
const NO_META: BuildMeta = { buildId: null, savedModel: null, buildSource: 'editor', photoJobId: null };

/** Build session of the models on each side of a build switch, so Undo / Redo across it restore the right one. */
const sessionAt = new WeakMap<Model, BuildMeta>();

interface PersistedMeta {
  buildId: string | null;
  dirty: boolean;
  source: BuildSource;
  photoJobId: string | null;
}

function loadMeta(model: Model): BuildMeta {
  try {
    const raw = localStorage.getItem(AUTOSAVE_META_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedMeta>;
      const buildId = typeof p.buildId === 'string' ? p.buildId : null;
      const source: BuildSource = p.source === 'photo' || p.source === 'import' ? p.source : 'editor';
      return {
        buildId,
        savedModel: buildId && !p.dirty ? model : null,
        buildSource: source,
        photoJobId: typeof p.photoJobId === 'string' ? p.photoJobId : null,
      };
    }
  } catch { /* storage unavailable / corrupt */ }
  return { ...NO_META };
}

function loadAutosave(): Model {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) return JSON.parse(raw) as Model;
  } catch { /* storage unavailable */ }
  return { name: 'My build', bricks: [] };
}

export const useEditor = create<EditorState>((set, get) => {
  const commit = (next: Model) => {
    const { model, past } = get();
    set({ model: next, past: [...past, model].slice(-HISTORY_LIMIT), future: [] });
  };

  const initial = loadAutosave();
  const initialSession = loadMeta(initial);
  /** Make `session` current and mirror its fields into the state. */
  const apply = (session: BuildMeta) =>
    set({ session, buildId: session.buildId, savedModel: session.savedModel, buildSource: session.buildSource, photoJobId: session.photoJobId });
  /** After undo / redo: if the model landed on one side of a build switch, go back to that side's session. */
  const followSwitch = (m: Model) => {
    const at = sessionAt.get(m);
    if (at && at !== get().session) apply(at);
  };

  return {
    model: initial,
    session: initialSession,
    buildId: initialSession.buildId,
    savedModel: initialSession.savedModel,
    buildSource: initialSession.buildSource,
    photoJobId: initialSession.photoJobId,
    selection: [],
    tool: 'place',
    viewMode: '3d',
    activePart: '3001.dat',
    activeColor: 4,
    layerY: 0,
    readOnly: false,
    past: [],
    future: [],

    addBrick(b) {
      const id = b.id ?? newId();
      const { model } = get();
      commit({ ...model, bricks: [...model.bricks, { ...b, id }] });
      return id;
    },
    updateBricks(patches) {
      if (!patches.length) return;
      const byId = new Map(patches.map((p) => [p.id, p]));
      const { model } = get();
      commit({ ...model, bricks: model.bricks.map((b) => (byId.has(b.id) ? { ...b, ...byId.get(b.id)! } : b)) });
    },
    removeBricks(ids) {
      if (!ids.length) return;
      const drop = new Set(ids);
      const { model, selection } = get();
      commit({ ...model, bricks: model.bricks.filter((b) => !drop.has(b.id)) });
      set({ selection: selection.filter((id) => !drop.has(id)) });
    },
    setModel(m, opts) {
      if (opts?.resetHistory) set({ model: m, past: [], future: [], selection: [] });
      else { commit(m); set({ selection: [] }); }
    },
    switchBuild(m, partial) {
      const cur = get();
      const next: BuildMeta = { ...NO_META, ...partial };
      sessionAt.set(cur.model, cur.session);
      sessionAt.set(m, next);
      commit(m);
      set({ selection: [] });
      apply(next);
    },
    markSaved(buildId, saved, session) {
      Object.assign(session, { buildId, savedModel: saved, buildSource: 'editor', photoJobId: null });
      if (get().session === session) apply(session);
    },
    unlinkBuild() {
      const { session } = get();
      Object.assign(session, { buildId: null, savedModel: null });
      apply(session);
    },
    applyArchivedName(name) {
      const { model, savedModel, session } = get();
      if (model.name === name) return;
      if (savedModel && model === savedModel) {
        const m = { ...model, name };
        session.savedModel = m;
        set({ model: m });
        apply(session);
      } else {
        get().rename(name);
      }
    },
    rename(name) {
      commit({ ...get().model, name });
    },
    undo() {
      const { past, model, future } = get();
      if (!past.length) return;
      const m = past[past.length - 1];
      set({ model: m, past: past.slice(0, -1), future: [model, ...future], selection: [] });
      followSwitch(m);
    },
    redo() {
      const { past, model, future } = get();
      if (!future.length) return;
      const m = future[0];
      set({ model: m, past: [...past, model], future: future.slice(1), selection: [] });
      followSwitch(m);
    },

    select(ids, additive) {
      set({ selection: additive ? Array.from(new Set([...get().selection, ...ids])) : ids });
    },
    setTool: (tool) => set({ tool }),
    setViewMode: (viewMode) => set({ viewMode }),
    setActivePart: (activePart) => set({ activePart, tool: activePart ? 'place' : get().tool }),
    setActiveColor: (activeColor) => set({ activeColor }),
    setLayerY: (layerY) => set({ layerY }),
    setReadOnly: (readOnly) => set({ readOnly }),
  };
});

/** True when the current build has changes that are not in My builds (an empty, never-saved build has none). */
export function hasUnsavedChanges(s: Pick<EditorState, 'model' | 'savedModel' | 'buildId'> = useEditor.getState()): boolean {
  if (s.savedModel) return s.model !== s.savedModel;
  return s.model.bricks.length > 0;
}

// Autosave the editor model (not the read-only viewer), and its archive link.
useEditor.subscribe((s, prev) => {
  if (s.readOnly) return;
  if (s.model !== prev.model) {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(s.model)); } catch { /* ignore */ }
  }
  if (s.model !== prev.model || s.buildId !== prev.buildId || s.savedModel !== prev.savedModel || s.buildSource !== prev.buildSource || s.photoJobId !== prev.photoJobId || s.readOnly !== prev.readOnly) {
    const out: PersistedMeta = { buildId: s.buildId, dirty: !!s.buildId && s.model !== s.savedModel, source: s.buildSource, photoJobId: s.photoJobId };
    try { localStorage.setItem(AUTOSAVE_META_KEY, JSON.stringify(out)); } catch { /* ignore */ }
  }
});
