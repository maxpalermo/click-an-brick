// "My builds" glue: save / save as copy / open the current build, thumbnails, the unsaved-changes guard.
// The archive is optional: every failure leaves the editor (and its local autosave) untouched.
import { create } from 'zustand';
import {
  ApiError,
  buildsErrorMessage,
  createBuild,
  getBuild,
  updateBuild,
} from '../api/builds';
import { BUILD_NAME_MAX, BUILD_THUMB_MAX_BYTES, type BuildSource, type BuildSummary } from '../api/builds.types';
import type { BrickyardEngine } from '../engine/types';
import { fromLdr, toLdr } from '../model/ldraw';
import { hasUnsavedChanges, useEditor } from '../model/store';
import type { Brick, Model } from '../model/types';
import { toast } from './toast';

let engineRef: BrickyardEngine | null = null;
/** Called once by App: thumbnails are rendered by the engine. */
export function bindArchiveEngine(engine: BrickyardEngine): void {
  engineRef = engine;
}

// ---------------------------------------------------------------- UI state

interface Guard {
  /** What the user is about to do, e.g. "Open “Castle”". */
  title: string;
  message: string;
  proceed(): void;
}

interface ArchiveUi {
  /** The My builds screen is open. */
  open: boolean;
  /** A save of the current build is in flight. */
  saving: boolean;
  /** Unsaved-changes prompt (Save / Discard / Cancel). */
  guard: Guard | null;
  /** Bumped after every change to the archive, so an open list refreshes. */
  version: number;
}

export const useArchive = create<ArchiveUi>(() => ({ open: false, saving: false, guard: null, version: 0 }));

export const openMyBuilds = () => useArchive.setState({ open: true });
export const closeMyBuilds = () => useArchive.setState({ open: false });
export const archiveChanged = () => useArchive.setState((s) => ({ version: s.version + 1 }));

/** Run `proceed` now, or after asking when the current build has changes that are not in My builds. */
export function guardUnsaved(title: string, proceed: () => void): void {
  const s = useEditor.getState();
  if (s.readOnly || !hasUnsavedChanges(s)) {
    proceed();
    return;
  }
  const name = s.model.name || 'My build';
  useArchive.setState({
    guard: {
      title,
      message: s.buildId
        ? `“${name}” has changes that aren't in My builds yet.`
        : `“${name}” isn't in My builds yet. Save it first so you can come back to it.`,
      proceed,
    },
  });
}

// ---------------------------------------------------------------- thumbnails

const THUMB_SIZE = 256;
const THUMB_BG = '#ece6da';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { window.clearTimeout(t); resolve(v); }, (e) => { window.clearTimeout(t); reject(e); });
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });
}

/** ~256 px JPEG data URI of the bricks (off-screen render, framed to fit), within BUILD_THUMB_MAX_BYTES; null on failure. */
export async function makeThumb(bricks: ReadonlyArray<Brick>): Promise<string | null> {
  const engine = engineRef;
  if (!engine || !bricks.length) return null;
  try {
    const png = engine.renderModel
      ? await withTimeout(engine.renderModel(bricks, { width: THUMB_SIZE, height: THUMB_SIZE }), 25_000)
      : await engine.screenshot(THUMB_SIZE, THUMB_SIZE);
    const img = await loadImage(png);
    const c = document.createElement('canvas');
    c.width = THUMB_SIZE;
    c.height = THUMB_SIZE;
    const g = c.getContext('2d');
    if (!g) return null;
    const grad = g.createRadialGradient(THUMB_SIZE / 2, THUMB_SIZE * 0.35, 10, THUMB_SIZE / 2, THUMB_SIZE / 2, THUMB_SIZE * 0.75);
    grad.addColorStop(0, '#f6f2ea');
    grad.addColorStop(1, THUMB_BG);
    g.fillStyle = grad;
    g.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    g.drawImage(img, 0, 0, THUMB_SIZE, THUMB_SIZE);
    for (const q of [0.8, 0.65, 0.5, 0.35]) {
      const url = c.toDataURL('image/jpeg', q);
      // base64 → bytes; keep a little margin under the server limit.
      if (url.startsWith('data:image/jpeg') && url.length * 0.75 < BUILD_THUMB_MAX_BYTES * 0.95) return url;
    }
  } catch {
    /* no preview: the build is still saved */
  }
  return null;
}

// ---------------------------------------------------------------- errors

/** One toast for an archive failure; a 401 offers a reload (Cloudflare Access sign-in). */
export function archiveErrorToast(prefix: string, e: unknown): void {
  if (e instanceof ApiError && e.status === 401) {
    toast('Your sign-in has expired. Sign in again to use My builds.', 'error', 8000, { label: 'Sign in', run: () => location.reload() });
    return;
  }
  toast(`${prefix} ${buildsErrorMessage(e)}`, 'error', 5000);
}

const cleanName = (name: string) => (name.trim() || 'My build').slice(0, BUILD_NAME_MAX);
const SHARE_ID_RE = /^[a-z0-9]{8}$/i;
const PHOTO_JOB_RE = /^[a-z0-9]{12}$/i;

// ---------------------------------------------------------------- save

export interface SaveOptions {
  /** Save as a new build even when this one is already in My builds. */
  asCopy?: boolean;
  /** Share link made from this build (ShareDialog). */
  shareId?: string;
  /** Automatic save (photo result, share): no success toast, and failures only one short toast. */
  quiet?: boolean;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Save the current build to My builds (create, or update its archived copy) with a fresh thumbnail.
 * Resolves with the summary, or null when it failed (a toast says why; the local autosave is untouched).
 */
export function saveCurrent(opts: SaveOptions = {}): Promise<BuildSummary | null> {
  const job = queue.then(() => doSave(opts));
  queue = job.catch(() => undefined);
  return job;
}

async function doSave(opts: SaveOptions): Promise<BuildSummary | null> {
  const s = useEditor.getState();
  if (s.readOnly) return null;
  const model = s.model;
  const session = s.session;
  if (!model.bricks.length) {
    if (!opts.quiet) toast('Add a few bricks first, then save your build.', 'info');
    return null;
  }
  useArchive.setState({ saving: true });
  try {
    const ldr = toLdr(model);
    const thumb = await makeThumb(model.bricks);
    const name = cleanName(model.name);
    const shareId = opts.shareId && SHARE_ID_RE.test(opts.shareId) ? opts.shareId : undefined;
    let saved: BuildSummary | null = null;
    // The build this save belongs to may have been saved meanwhile (queued saves): read its id now.
    const buildId = session.buildId;
    if (buildId && !opts.asCopy) {
      try {
        saved = await updateBuild(buildId, { name, ldr, thumb, ...(shareId ? { shareId } : {}) });
      } catch (e) {
        // Deleted from My builds (maybe on another device): save it again as a new build.
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
    }
    if (!saved) {
      const source: BuildSource = opts.asCopy ? 'editor' : session.buildSource;
      saved = await createBuild({
        name: opts.asCopy ? copyName(name) : name,
        ldr,
        thumb,
        source,
        ...(shareId ? { shareId } : {}),
        ...(source === 'photo' && session.photoJobId && PHOTO_JOB_RE.test(session.photoJobId) && !opts.asCopy ? { photoJobId: session.photoJobId } : {}),
      });
    }
    if (opts.asCopy) {
      // Keep editing the copy: it becomes the current build (same bricks, new archive id).
      const st = useEditor.getState();
      if (st.session === session) {
        const copy: Model = st.model === model ? { ...model, name: saved.name } : { ...st.model, name: saved.name };
        st.switchBuild(copy, { buildId: saved.id, savedModel: st.model === model ? copy : null });
      }
    } else {
      useEditor.getState().markSaved(saved.id, model, session);
    }
    archiveChanged();
    if (!opts.quiet) toast(opts.asCopy ? `Saved a copy: ${saved.name}` : 'Saved to My builds', 'success', 2200);
    return saved;
  } catch (e) {
    // The build stays in this browser's autosave; the toast says what went wrong.
    archiveErrorToast(opts.quiet ? "Couldn't add it to My builds:" : "Couldn't save to My builds:", e);
    return null;
  } finally {
    useArchive.setState({ saving: false });
  }
}

export function copyName(name: string): string {
  const base = name.replace(/ \(copy( \d+)?\)$/, '');
  return `${base} (copy)`.slice(0, BUILD_NAME_MAX);
}

// ---------------------------------------------------------------- open

/** Load an archived build into the editor (asks first about unsaved changes); `onOpened` runs once it is open. */
export function openBuild(summary: Pick<BuildSummary, 'id' | 'name'>, onOpened?: () => void): void {
  const s = useEditor.getState();
  if (s.buildId === summary.id && !hasUnsavedChanges(s)) {
    onOpened?.();
    return;
  }
  guardUnsaved(`Open “${summary.name}”?`, () => void loadBuild(summary.id, onOpened));
}

async function loadBuild(id: string, onOpened?: () => void): Promise<void> {
  try {
    const b = await getBuild(id);
    const model = fromLdr(b.ldr);
    model.name = b.name;
    // One undo step: Undo returns to the build that was open before.
    useEditor.getState().switchBuild(model, { buildId: b.id, savedModel: model });
    useEditor.getState().setViewMode('3d');
    onOpened?.();
    window.setTimeout(() => engineRef?.zoomToFit(), 80);
  } catch (e) {
    archiveErrorToast("Couldn't open that build:", e);
  }
}

/** Start an empty build (asks first about unsaved changes). Undo returns to the previous build. */
export function newBuild(): void {
  guardUnsaved('Start a new build?', () => {
    useEditor.getState().switchBuild({ name: 'My build', bricks: [] });
  });
}

/** Save a model that is not the editor's (a shared build in the viewer) as a new build. */
export async function saveModelAsNew(model: Model, extra: { shareId?: string; ldr?: string } = {}): Promise<BuildSummary | null> {
  try {
    const thumb = await makeThumb(model.bricks);
    const saved = await createBuild({
      name: cleanName(model.name),
      ldr: extra.ldr ?? toLdr(model),
      thumb,
      source: 'editor',
      ...(extra.shareId && SHARE_ID_RE.test(extra.shareId) ? { shareId: extra.shareId } : {}),
    });
    archiveChanged();
    return saved;
  } catch (e) {
    archiveErrorToast("Couldn't save to My builds:", e);
    return null;
  }
}
