// Keeps the user's own editor session safe while a shared model is shown in the viewer.
import { useEditor } from '../model/store';
import type { Model } from '../model/types';

interface Stash {
  model: Model;
  past: Model[];
  future: Model[];
}

let stash: Stash | null = null;

/** Show `shared` read-only. The editor model (and its history) is stashed first. */
export function enterViewer(shared: Model): void {
  const s = useEditor.getState();
  if (!stash && !s.readOnly) stash = { model: s.model, past: s.past, future: s.future };
  // readOnly first, so autosave never writes the shared model over the user's build.
  s.setReadOnly(true);
  s.select([]);
  s.setModel(shared, { resetHistory: true });
}

/** Mark viewer mode without a model yet (loading / error). */
export function beginViewer(): void {
  const s = useEditor.getState();
  if (!stash && !s.readOnly) stash = { model: s.model, past: s.past, future: s.future };
  s.setReadOnly(true);
  s.setModel({ name: '', bricks: [] }, { resetHistory: true });
}

/** Restore the stashed editor session (no-op when not in the viewer). */
export function leaveViewer(): void {
  const s = useEditor.getState();
  if (!s.readOnly) return;
  if (stash) {
    // Still readOnly while restoring → autosave skips; localStorage already holds this model.
    useEditor.setState({ model: stash.model, past: stash.past, future: stash.future, selection: [] });
    stash = null;
  }
  s.setReadOnly(false);
}

/** Copy the shared model into the editor as an undoable step on top of the user's own build. */
export function remix(shared: Model): void {
  leaveViewer();
  const copy: Model = {
    name: shared.name ? `${shared.name} (remix)` : 'Remix',
    author: shared.author,
    bricks: shared.bricks.map((b) => ({ ...b, pos: [...b.pos], rot: [...b.rot] }) as typeof b),
  };
  useEditor.getState().setReadOnly(false);
  // A new build (not in My builds until saved); Undo returns to the user's own build.
  useEditor.getState().switchBuild(copy);
}
