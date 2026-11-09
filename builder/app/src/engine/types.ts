// Public API of the render engine. The UI only talks to the engine through this interface.
// Implementation: app/src/engine/Engine.ts → `export function createEngine(opts): BrickyardEngine`.

import type { BrickColor } from '../model/types';

export interface EngineOptions {
  /** Base URL of the backend, '' = same origin. Parts come from `${apiBase}/api/parts/:id/packed`. */
  apiBase?: string;
  colors: BrickColor[];
}

export interface PendingState {
  /** A pending (not yet placed) brick exists. */
  active: boolean;
  /** It overlaps another brick / the ground, so it can't be placed where it is. */
  blocked: boolean;
  /** 'brick' = place-tool brick, 'duplicate' = pending copy of the selection (any tool). */
  kind?: 'brick' | 'duplicate';
  /** Number of pending bricks (1 for 'brick'). */
  count?: number;
}

export interface BrickyardEngine {
  /** Attach the canvas into `el` (fills it, handles resize) and start rendering. */
  mount(el: HTMLElement): void;
  dispose(): void;

  /**
   * The engine subscribes to `useEditor` (app/src/model/store.ts) itself:
   * - renders `model.bricks`, highlights `selection`
   * - `tool === 'place'`: ghost of `activePart` in `activeColor` follows the pointer, snapping
   *   to the grid / top of existing bricks; click places via `addBrick`.
   * - `tool === 'select'`: click/tap selects (shift = additive); mouse drag moves bricks; touch moves via the gizmo.
   * - `tool === 'paint'`: click sets brick colour to `activeColor`.
   * - `tool === 'erase'`: click removes the brick.
   * - `viewMode === '2d'`: orthographic top-down view of the layer at `layerY`; bricks above it
   *   hidden, bricks below drawn faded; placement happens on that layer.
   * - `readOnly`: orbit only, no editing.
   */

  /**
   * Rotate around the vertical (LDraw Y) axis by `stepDeg` degrees (default 90; buttons / R key):
   * the pending brick, else the ghost (place tool), else the selection. `dir` 1 = clockwise seen
   * from above. Any angle is allowed: the exact matrix (cos/sin rounded to 1e-6) is stored in
   * `Brick.rot`; a single brick pivots on its origin, which stays on the stud grid.
   * The gizmo ring rotates in 5° steps with a ±3° detent (tick + haptic) at every 90°;
   * multi-brick selections rotate in 90° steps only.
   */
  rotate(dir?: 1 | -1, stepDeg?: number): void;

  /**
   * Two-step placement (place tool). On touch (and Shift+click with a mouse) a tap drops a
   * PENDING brick with a move/rotate gizmo; tapping the pending brick (or `confirmPending`)
   * commits it with `addBrick` (one undo step); tapping elsewhere moves it there.
   * A plain mouse click still places immediately. The same gizmo is shown on the selection in
   * the select tool (each handle drag = one undo step). Gizmo: 6 cones (tap = one step, drag =
   * continuous along that axis, snapped to studs / plates; Alt or Shift = half stud), a ring knob
   * (rotate), and the pending / selected brick itself can be dragged on the horizontal plane.
   * On touch, one-finger drags anywhere else orbit.
   */
  getPending(): PendingState;
  /** Commit the pending brick. Returns false when there is none or it overlaps another brick. */
  confirmPending(): boolean;
  /** Discard the pending brick. */
  cancelPending(): void;
  /**
   * Move the pending brick (else the selection) one step: 'y' = vertical ('+' = up, 1 plate);
   * 'x' / 'z' = the horizontal stud axis closest to screen-right / into the screen (1 stud,
   * half a stud with `fine`). Camera-relative so on-screen arrow buttons always match.
   */
  nudge(axis: 'x' | 'y' | 'z', dir: '+' | '-', fine?: boolean): void;
  /** Fires whenever the pending brick appears, disappears or becomes blocked / unblocked. */
  onPendingChange(cb: (s: PendingState) => void): () => void;
  /** Fires when the user tries to place a pending brick that overlaps (UI: toast "Overlaps a brick"). */
  onPlaceBlocked(cb: () => void): () => void;
  /** Frame the whole model in view. */
  zoomToFit(): void;
  /** Camera presets for 3D. */
  setCameraPreset(p: 'iso' | 'front' | 'side' | 'top'): void;
  /** Render a small transparent PNG thumbnail of a part (cached). */
  renderThumbnail(partId: string, color: number, size?: number): Promise<string>;
  /**
   * Render a whole brick list (not the editor model) with real part geometry, off-screen, framed to fit.
   * `yawDeg` turns the camera around the model (0 = front 3/4 view). PNG data URL. Used by the photo
   * result preview; must not disturb the editor scene.
   */
  renderModel?(
    bricks: ReadonlyArray<{ part: string; color: number; pos: [number, number, number]; rot: number[] }>,
    opts?: { width?: number; height?: number; yawDeg?: number; elevationDeg?: number },
  ): Promise<string>;
  /** Snapshot of the current view as a PNG data URL (used as share preview). */
  screenshot(width?: number, height?: number): Promise<string>;
  /** Fires when part geometry loading starts/ends — for a spinner. */
  onLoading(cb: (pending: number) => void): () => void;

  // ---- Mobile redesign (docs/UX_REVIEW.md §3, §5) ----

  /** Make a pending copy of the selection, offset by one stud, to confirm like a new brick. */
  duplicateSelection(): void;
  /** Frame the selection (or the pending brick); falls back to the whole model. */
  frameSelection(): void;
  /**
   * Screen areas covered by UI (px from each edge). The engine keeps the pending/selected
   * brick clear of them (auto-pan) and places the view cube inside the free area.
   */
  setInsets(insets: { top: number; bottom: number; left: number; right: number }): void;
  /** Interaction feedback so the UI can add haptics, sounds or tips. */
  onFeedback(cb: (e: EngineFeedback) => void): () => void;
  /**
   * Optional (engine addition): "Add more" multi-select. While on, taps in the select tool add /
   * remove bricks and a tap on empty space keeps the selection (mouse: like holding Shift).
   */
  setAddMode?(on: boolean): void;
  /** Optional (engine addition): current value of the last 'floating' feedback. */
  isFloating?(): boolean;
}

export type EngineFeedback =
  | { type: 'placed' }
  | { type: 'blocked' }
  | { type: 'selected'; count: number }
  /** Long-press on a brick in place mode selected it (UI switches to Select). */
  | { type: 'long-press-select'; id: string }
  /** Ring rotation hit a 90° detent (or the ring knob was tapped). */
  | { type: 'snap-detent' }
  /** Engine addition: a cone / body drag or nudge moved one step (throttled to ≥ 40 ms). */
  | { type: 'step' }
  /** Pending brick rests on nothing (shows the "Floating" tag). */
  | { type: 'floating'; floating: boolean };
