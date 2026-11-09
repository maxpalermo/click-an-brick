// "My builds": the per-user archive of builds (api/builds.ts), as a full-screen page over the editor.
import { useEffect, useRef, useState } from 'react';
import { ApiError, buildsErrorMessage, createBuild, deleteBuild, getBuild, listBuilds, updateBuild } from '../api/builds';
import { BUILD_NAME_MAX, type BuildSummary } from '../api/builds.types';
import { hasUnsavedChanges, useEditor } from '../model/store';
import { IconPhoto } from '../photo/ui/icons';
import {
  archiveChanged, archiveErrorToast, closeMyBuilds, copyName, newBuild, openBuild, saveCurrent, useArchive,
} from './archive';
import { useIsPhone } from './hooks';
import { IconBack, IconCheck, IconCopy, IconDuplicate, IconMore, IconNew, IconPencil, IconShare, IconTrash, Logo } from './Icons';
import { ConfirmDialog, Modal, Sheet, Spinner } from './Overlays';
import { copyText, shareUrl } from './ShareDialog';
import { toast } from './toast';

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'ready'; builds: BuildSummary[]; limit: number };

/** "just now" · "5 min ago" · "3 h ago" · "yesterday" · "4 days ago" · "12 Mar" · "12 Mar 2024". */
export function relativeDate(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(t);
  const today = new Date(now);
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days === 0) return `${Math.floor(s / 3600)} h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

export function MyBuildsScreen() {
  const open = useArchive((s) => s.open);
  if (!open) return null;
  return <MyBuilds />;
}

function MyBuilds() {
  const version = useArchive((s) => s.version);
  const saving = useArchive((s) => s.saving);
  const currentId = useEditor((s) => s.buildId);
  const unsaved = useEditor((s) => hasUnsavedChanges(s));
  const currentName = useEditor((s) => s.model.name);
  const isPhone = useIsPhone();
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [actionsFor, setActionsFor] = useState<BuildSummary | null>(null);
  const [renaming, setRenaming] = useState<BuildSummary | null>(null);
  const [deleting, setDeleting] = useState<BuildSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listBuilds()
      .then((l) => alive && setState({ kind: 'ready', builds: l.builds, limit: l.limit }))
      .catch((e: unknown) => alive && setState({ kind: 'error', status: e instanceof ApiError ? e.status : -1, message: buildsErrorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [version, attempt]);

  // Esc closes (unless a dialog / sheet on top handles it first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.backdrop, .sheet-backdrop')) return;
      closeMyBuilds();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const doOpen = (b: BuildSummary) => openBuild(b, closeMyBuilds);

  const doDuplicate = async (b: BuildSummary) => {
    setBusyId(b.id);
    try {
      const full = await getBuild(b.id);
      await createBuild({
        name: copyName(full.name),
        ldr: full.ldr,
        thumb: full.thumb,
        source: full.source,
        ...(full.photoJobId ? { photoJobId: full.photoJobId } : {}),
      });
      archiveChanged();
      toast(`Duplicated “${full.name}”`, 'success', 2200);
    } catch (e) {
      archiveErrorToast("Couldn't duplicate it:", e);
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async (b: BuildSummary) => {
    setBusyId(b.id);
    try {
      await deleteBuild(b.id);
      if (useEditor.getState().buildId === b.id) useEditor.getState().unlinkBuild();
      // Drop it right away; the refresh confirms.
      setState((s) => (s.kind === 'ready' ? { ...s, builds: s.builds.filter((x) => x.id !== b.id) } : s));
      archiveChanged();
      toast(`Deleted “${b.name}”`, 'info', 2600);
    } catch (e) {
      archiveErrorToast("Couldn't delete it:", e);
    } finally {
      setBusyId(null);
    }
  };

  const doCopyLink = async (b: BuildSummary) => {
    if (!b.shareId) return;
    if (await copyText(shareUrl(b.shareId))) toast('Share link copied', 'success', 2000);
    else toast(shareUrl(b.shareId), 'info', 8000);
  };

  const count = state.kind === 'ready' ? state.builds.length : 0;
  const hasBricks = useEditor((s) => s.model.bricks.length > 0);

  return (
    <div className="mb-screen" role="dialog" aria-modal="true" aria-label="My builds">
      <header className="mb-head">
        <button className="icon-btn mb-back" onClick={closeMyBuilds} aria-label="Back to the editor" title="Back to the editor (Esc)">
          <IconBack />
        </button>
        <div className="mb-title">
          <h1>My builds</h1>
          <small>
            {state.kind === 'ready'
              ? `${count} build${count === 1 ? '' : 's'}${count >= state.limit * 0.8 ? ` of ${state.limit}` : ''} · on all your devices`
              : 'On all your devices'}
          </small>
        </div>
        <button className="btn mb-new" onClick={() => { closeMyBuilds(); newBuild(); }} title="Start a new build">
          <IconNew size={18} /> <span className="mb-hide-phone">New build</span><span className="mb-show-phone">New</span>
        </button>
      </header>

      <div className="mb-body">
        {hasBricks && unsaved && (
          <div className="mb-current">
            <div>
              <strong>{currentName || 'My build'}</strong>
              <small>{currentId ? 'Open in the editor · unsaved changes' : 'Open in the editor · not saved yet'}</small>
            </div>
            <button className="btn primary" disabled={saving} onClick={() => void saveCurrent()}>
              {saving ? <Spinner size={16} /> : null} Save
            </button>
          </div>
        )}

        {state.kind === 'loading' && (
          <div className="mb-center">
            <Spinner size={26} />
            <p className="muted">Loading your builds…</p>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="mb-center">
            <Logo size={44} />
            {state.status === 401 ? (
              <>
                <h2>Sign in again</h2>
                <p className="muted">Your sign-in has expired. Reload to sign in, then your builds come back. Your current build is kept on this device.</p>
                <button className="btn primary" onClick={() => location.reload()}>Reload and sign in</button>
              </>
            ) : (
              <>
                <h2>Couldn't load your builds</h2>
                <p className="muted">{state.message} Your current build is safe on this device.</p>
                <button className="btn primary" onClick={() => { setState({ kind: 'loading' }); setAttempt((n) => n + 1); }}>Try again</button>
              </>
            )}
          </div>
        )}

        {state.kind === 'ready' && state.builds.length === 0 && (
          <div className="mb-center mb-empty">
            <div className="mb-empty-art" aria-hidden="true"><span /><span /><span /></div>
            <h2>No builds here yet</h2>
            <p className="muted">
              Builds you save show up here, on this phone and on your computer. Photo to Bricks builds and builds you
              share are added automatically.
            </p>
            {hasBricks ? (
              <button className="btn primary" disabled={saving} onClick={() => void saveCurrent()}>
                {saving ? <Spinner size={16} /> : null} Save “{currentName || 'My build'}”
              </button>
            ) : (
              <button className="btn" onClick={closeMyBuilds}>Start building</button>
            )}
          </div>
        )}

        {state.kind === 'ready' && state.builds.length > 0 && (
          <ul className="mb-grid">
            {state.builds.map((b) => (
              <BuildCard
                key={b.id}
                build={b}
                current={b.id === currentId}
                busy={busyId === b.id}
                onOpen={() => doOpen(b)}
                onMore={() => setActionsFor(b)}
              />
            ))}
          </ul>
        )}
      </div>

      {actionsFor && (
        <CardActions
          build={actionsFor}
          phone={isPhone}
          current={actionsFor.id === currentId}
          onClose={() => setActionsFor(null)}
          onOpen={() => doOpen(actionsFor)}
          onRename={() => setRenaming(actionsFor)}
          onDuplicate={() => void doDuplicate(actionsFor)}
          onDelete={() => setDeleting(actionsFor)}
          onCopyLink={() => void doCopyLink(actionsFor)}
        />
      )}
      {renaming && <RenameDialog build={renaming} onClose={() => setRenaming(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete this build?"
          message={
            <>
              “{deleting.name}” will be removed from My builds on all your devices. This can't be undone.
              {deleting.id === currentId ? ' It stays open in the editor until you start another build.' : ''}
              {deleting.shareId ? ' Its share link keeps working.' : ''}
            </>
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => void doDelete(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function BuildCard({ build: b, current, busy, onOpen, onMore }: {
  build: BuildSummary;
  current: boolean;
  busy: boolean;
  onOpen(): void;
  onMore(): void;
}) {
  return (
    <li className={`mb-card ${current ? 'current' : ''}`}>
      <button className="mb-card-open" onClick={onOpen} aria-label={`Open ${b.name}`}>
        <div className="mb-thumb">
          {b.thumb ? <img src={b.thumb} alt="" loading="lazy" draggable={false} /> : <span className="mb-thumb-empty"><Logo size={40} /></span>}
          <div className="mb-badges">
            {current && <span className="mb-badge open">Open</span>}
            {b.source === 'photo' && <span className="mb-badge photo" title="From a photo"><IconPhoto size={13} /> Photo</span>}
            {b.shareId && <span className="mb-badge shared" title="Shared with a link"><IconShare size={13} /> Shared</span>}
          </div>
          {busy && <span className="mb-busy"><Spinner size={22} /></span>}
        </div>
        <div className="mb-meta">
          <strong>{b.name}</strong>
          <small>{b.parts.toLocaleString()} part{b.parts === 1 ? '' : 's'} · {relativeDate(b.updatedAt)}</small>
        </div>
      </button>
      <button className="icon-btn mb-more" onClick={onMore} aria-label={`More actions for ${b.name}`} title="More">
        <IconMore />
      </button>
    </li>
  );
}

function CardActions({ build: b, phone, current, onClose, onOpen, onRename, onDuplicate, onDelete, onCopyLink }: {
  build: BuildSummary;
  phone: boolean;
  current: boolean;
  onClose(): void;
  onOpen(): void;
  onRename(): void;
  onDuplicate(): void;
  onDelete(): void;
  onCopyLink(): void;
}) {
  const run = (f: () => void) => () => {
    onClose();
    f();
  };
  const body = (
    <div className="mb-actions">
      <div className="mb-actions-head">
        {b.thumb ? <img src={b.thumb} alt="" /> : <span className="mb-thumb-empty small"><Logo size={26} /></span>}
        <div>
          <strong>{b.name}</strong>
          <small>{b.parts.toLocaleString()} parts · saved {relativeDate(b.updatedAt)}</small>
        </div>
      </div>
      <div className="list-buttons one">
        <button className="btn primary" onClick={run(onOpen)} data-autofocus>{current ? 'Back to this build' : 'Open'}</button>
        <button className="btn" onClick={run(onRename)}><IconPencil size={18} /> Rename</button>
        <button className="btn" onClick={run(onDuplicate)}><IconDuplicate size={18} /> Duplicate</button>
        {b.shareId && <button className="btn" onClick={run(onCopyLink)}><IconCopy size={18} /> Copy share link</button>}
        <button className="btn mb-danger" onClick={run(onDelete)}><IconTrash size={18} /> Delete…</button>
      </div>
    </div>
  );
  return phone ? (
    <Sheet title="Build" onClose={onClose}>{body}</Sheet>
  ) : (
    <Modal title="Build" onClose={onClose} className="mb-actions-modal">{body}</Modal>
  );
}

function RenameDialog({ build, onClose }: { build: BuildSummary; onClose(): void }) {
  const [name, setName] = useState(build.name);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const submit = async () => {
    const v = name.trim();
    if (!v || v === build.name) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const saved = await updateBuild(build.id, { name: v });
      if (useEditor.getState().buildId === build.id) useEditor.getState().applyArchivedName(saved.name);
      archiveChanged();
      onClose();
    } catch (e) {
      archiveErrorToast("Couldn't rename it:", e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Rename build"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? <Spinner size={16} /> : <IconCheck size={18} />} Rename
          </button>
        </>
      }
    >
      <input
        ref={ref}
        className="text-input"
        value={name}
        maxLength={BUILD_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        aria-label="Build name"
        spellCheck={false}
      />
    </Modal>
  );
}

/** Save / Discard / Cancel before leaving a build whose changes are not in My builds. */
export function UnsavedGuard() {
  const guard = useArchive((s) => s.guard);
  const saving = useArchive((s) => s.saving);
  if (!guard) return null;
  const close = () => useArchive.setState({ guard: null });
  return (
    <Modal
      title={guard.title}
      onClose={close}
      className="mb-guard"
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn" onClick={() => { close(); guard.proceed(); }}>Discard</button>
          <button
            className="btn primary"
            data-autofocus
            disabled={saving}
            onClick={async () => {
              const ok = await saveCurrent();
              close();
              if (ok) guard.proceed();
            }}
          >
            {saving ? <Spinner size={16} /> : null} Save
          </button>
        </>
      }
    >
      <p>{guard.message}</p>
      <p className="mb-guard-note">Discard keeps it one Undo away while this tab stays open.</p>
    </Modal>
  );
}

