import { useEffect, useRef, useState, type ReactNode } from 'react';
import { lang, setLang, t } from '../i18n';
import type { Tool } from '../model/types';
import { BRICK_H, PLATE_H } from '../model/types';
import { hasUnsavedChanges, useEditor } from '../model/store';
import { newBuild as startNewBuild, openMyBuilds, saveCurrent, useArchive } from './archive';
import { useEngine } from './context';
import { exportLdr, pickLdrFile } from './file';
import {
  IconBack, IconBricks, IconCamera, IconDown, IconDownDouble, IconErase, IconExport, IconFit, IconImport,
  IconLayers, IconMore, IconNew, IconPaint, IconPlace, IconRedo, IconRotate, IconSelect, IconShare, IconUndo,
  IconUp, IconUpDouble, IconKeyboard, IconGrid, IconCheck, IconDuplicate, Logo,
} from './Icons';
import { Spinner } from './Overlays';
import { toast } from './toast';
import { PhotoTopBarButton } from '../photo/ui/EntryPoints';
import { actions, haptic } from './engineBridge';
import { openSheet, usePrefs, useUi } from './prefs';

export const TOOLS: Array<{ id: Tool; label: string; key: string; Icon: (p: { size?: number }) => JSX.Element }> = [
  { id: 'place', label: 'Place', key: 'B', Icon: IconPlace },
  { id: 'select', label: 'Select', key: 'V', Icon: IconSelect },
  { id: 'paint', label: 'Paint', key: 'P', Icon: IconPaint },
  { id: 'erase', label: 'Erase', key: 'E', Icon: IconErase },
];

export const CAMERAS: Array<{ id: 'iso' | 'front' | 'side' | 'top'; label: string }> = [
  { id: 'iso', label: 'Isometric' },
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Side' },
  { id: 'top', label: 'Top' },
];

/** Shared editor commands used by both desktop and phone layouts. */
export function useEditorCommands(opts: { onShare(): void }) {
  const engine = useEngine();
  return {
    share() {
      const { model } = useEditor.getState();
      if (!model.bricks.length) {
        toast('Add a few bricks first, then share your build!', 'info');
        return;
      }
      opts.onShare();
    },
    /** New empty build (asks first about changes that aren't in My builds; Undo returns). */
    newBuild() {
      startNewBuild();
    },
    /** Save to My builds (create or update), with a fresh thumbnail. */
    save() {
      void saveCurrent();
    },
    saveAsCopy() {
      void saveCurrent({ asCopy: true });
    },
    myBuilds() {
      openMyBuilds();
    },
    async importFile() {
      try {
        const m = await pickLdrFile();
        if (!m) return;
        if (!m.bricks.length) {
          toast("That file doesn't contain any bricks.", 'error');
          return;
        }
        // A new build that is not in My builds yet: recorded as an import when first saved (not auto-saved).
        useEditor.getState().switchBuild(m, { buildSource: 'import' });
        toast(`Imported ${m.bricks.length.toLocaleString()} bricks — Undo to go back.`, 'success');
        window.setTimeout(() => engine.zoomToFit(), 50);
      } catch {
        toast("Couldn't read that file.", 'error');
      }
    },
    exportFile() {
      const { model } = useEditor.getState();
      exportLdr(model);
      toast(`Exported ${model.name || 'build'}.ldr`, 'success');
    },
    rotate(dir: 1 | -1 = 1) {
      engine.rotate(dir);
    },
    fit() {
      engine.zoomToFit();
    },
  };
}
export type EditorCommands = ReturnType<typeof useEditorCommands>;

export function Brand() {
  return (
    <a className="brand" href="#/" aria-label="Brickyard home">
      <Logo size={30} />
      <span className="brand-name">Brickyard</span>
    </a>
  );
}

export function ProjectName({ className }: { className?: string }) {
  const name = useEditor((s) => s.model.name);
  const rename = useEditor((s) => s.rename);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const v = draft.trim() || 'My build';
    if (v !== name) rename(v);
    else setDraft(name);
  };
  return (
    <input
      className={`project-name ${className ?? ''}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(name);
          e.currentTarget.blur();
        }
      }}
      aria-label="Project name"
      maxLength={80}
      spellCheck={false}
    />
  );
}

/** "Saved" / "Unsaved changes" next to the build name (click to save). */
export function SaveState({ compact }: { compact?: boolean }) {
  const saving = useArchive((s) => s.saving);
  const linked = useEditor((s) => !!s.buildId);
  const unsaved = useEditor((s) => hasUnsavedChanges(s));
  const empty = useEditor((s) => !s.model.bricks.length);
  if (saving) return <span className="save-state saving"><Spinner size={12} /> {compact ? '' : 'Saving…'}</span>;
  if (!unsaved && linked) return <span className="save-state saved" title="Saved to My builds"><IconCheck size={14} />{!compact && <span className="save-label">Saved</span>}</span>;
  if (empty || !unsaved) return null;
  return (
    <button className="save-state unsaved" onClick={() => void saveCurrent()} title="Save to My builds (Ctrl+S)">
      <span className="dot" /> {linked ? 'Unsaved changes' : 'Not saved yet'}
    </button>
  );
}

export function UndoRedo() {
  const engine = useEngine();
  const pending = useUi((s) => s.pending.active);
  const canUndo = useEditor((s) => s.past.length > 0) || pending;
  const canRedo = useEditor((s) => s.future.length > 0);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  return (
    <div className="btn-group">
      <button
        className="icon-btn"
        onClick={() => (engine.getPending().active ? engine.cancelPending() : undo())}
        disabled={!canUndo}
        title={pending ? 'Cancel the pending brick' : 'Undo (Ctrl+Z)'}
        aria-label="Undo"
      >
        <IconUndo />
      </button>
      <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
        <IconRedo />
      </button>
    </div>
  );
}

export function ToolPicker({ big, onPicked }: { big?: boolean; onPicked?: () => void }) {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  return (
    <div className={`segmented ${big ? 'big' : ''}`} role="radiogroup" aria-label="Tool">
      {TOOLS.map(({ id, label, key, Icon }) => (
        <button
          key={id}
          role="radio"
          aria-checked={tool === id}
          className={tool === id ? 'active' : ''}
          onClick={() => {
            setTool(id);
            onPicked?.();
          }}
          title={`${label} (${key})`}
        >
          <Icon size={big ? 24 : 18} />
          <span className="seg-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

export function ViewToggle() {
  const viewMode = useEditor((s) => s.viewMode);
  const setViewMode = useEditor((s) => s.setViewMode);
  return (
    <div className="segmented" role="radiogroup" aria-label="View">
      {(['3d', '2d'] as const).map((v) => (
        <button key={v} role="radio" aria-checked={viewMode === v} className={viewMode === v ? 'active' : ''} onClick={() => (v === '2d' ? enter2D() : setViewMode(v))}>
          <span className="seg-label always">{v.toUpperCase()}</span>
        </button>
      ))}
    </div>
  );
}

/** Small dropdown menu anchored to a button. */
export function Menu({ label, icon, children, title }: { label?: string; icon: ReactNode; children: (close: () => void) => ReactNode; title: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`icon-btn ${label ? 'with-label' : ''} ${open ? 'pressed' : ''}`} onClick={() => setOpen((o) => !o)} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open}>
        {icon}
        {label && <span>{label}</span>}
      </button>
      {open && (
        <div className="menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function CameraMenu() {
  const engine = useEngine();
  const viewMode = useEditor((s) => s.viewMode);
  return (
    <Menu title="Camera" icon={<IconCamera />}>
      {(close) =>
        CAMERAS.map((c) => (
          <button
            key={c.id}
            role="menuitem"
            disabled={viewMode === '2d'}
            onClick={() => {
              engine.setCameraPreset(c.id);
              close();
            }}
          >
            {c.label}
          </button>
        ))
      }
    </Menu>
  );
}

export function DesktopTopBar({ cmd }: { cmd: EditorCommands }) {
  return (
    <header className="topbar panel" data-inset="top">
      <Brand />
      <ProjectName />
      <SaveState />
      <div className="divider" />
      <UndoRedo />
      <div className="divider" />
      <ToolPicker />
      <button className="icon-btn" onClick={() => cmd.rotate(1)} title="Rotate (R)" aria-label="Rotate">
        <IconRotate />
      </button>
      <div className="divider" />
      <ViewToggle />
      <CameraMenu />
      <button className="icon-btn" onClick={cmd.fit} title="Zoom to fit (F)" aria-label="Zoom to fit">
        <IconFit />
      </button>
      <div className="spacer" />
      <button className="icon-btn shortcuts-btn" onClick={() => openSheet('shortcuts')} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><IconKeyboard /></button>
      <button className="btn mybuilds-btn" onClick={cmd.myBuilds} title={t('nav.builds')} aria-label={t('nav.builds')}><IconGrid size={18} /> <span className="mybuilds-label">{t('nav.builds')}</span></button>
      <PhotoTopBarButton />
      <a className="icon-btn with-label" href="/" title={t('nav.scanner')} aria-label={t('nav.scanner')}>
        <IconBack />
        <span>{t('nav.scanner')}</span>
      </a>
      <Menu title="File" label={t('nav.file')} icon={<IconMore />}>
        {(close) => (
          <>
            <button role="menuitem" onClick={() => { close(); cmd.newBuild(); }}><IconNew size={18} /> New build</button>
            <button role="menuitem" onClick={() => { close(); cmd.myBuilds(); }}><IconGrid size={18} /> {t('nav.builds')}…</button>
            <button role="menuitem" onClick={() => { close(); cmd.save(); }}><IconCheck size={18} /> Save <span className="menu-key">Ctrl+S</span></button>
            <button role="menuitem" onClick={() => { close(); cmd.saveAsCopy(); }}><IconDuplicate size={18} /> Save as copy</button>
            <div className="menu-sep" role="separator" />
            <button role="menuitem" onClick={() => { close(); cmd.importFile(); }}><IconImport size={18} /> Import .ldr…</button>
            <button role="menuitem" onClick={() => { close(); cmd.exportFile(); }}><IconExport size={18} /> Export .ldr</button>
            <div className="menu-sep" role="separator" />
            <button role="menuitem" onClick={() => { close(); usePrefs.getState().set('showAllParts', !usePrefs.getState().showAllParts); }}>
              <IconBricks size={18} /> {usePrefs.getState().showAllParts ? 'Hide' : 'Show'} Duplo &amp; Modulex parts
            </button>
            <button role="menuitem" onClick={() => { close(); usePrefs.getState().resetTips(); }}><IconLayers size={18} /> Show tips again</button>
            <button role="menuitem" onClick={() => { close(); openSheet('shortcuts'); }}><IconKeyboard size={18} /> Keyboard shortcuts (?)</button>
          </>
        )}
      </Menu>
      <button className="btn primary" onClick={cmd.share}>
        <IconShare size={18} /> {t('nav.share')}
      <button className="icon-btn" onClick={() => { setLang(lang() === 'it' ? 'en' : 'it'); location.reload(); }} title={t('lang.label')} aria-label={t('lang.label')} style={{ fontWeight: 700, fontSize: 11 }}>{lang().toUpperCase()}</button>
      </button>
    </header>
  );
}

/** "4" → "1⅓": plates expressed in bricks. */
export function platesAsBricks(plates: number): string {
  const sign = plates < 0 ? '-' : '';
  const a = Math.abs(plates);
  const whole = Math.floor(a / 3);
  const frac = ['', '⅓', '⅔'][a % 3];
  return `${sign}${whole || !frac ? whole : ''}${frac}`;
}

/** 2D layer rail (UX_REVIEW §3.8): +1 brick / +1 plate / readout (drag to scrub) / −1 plate / −1 brick. */
export function LayerStepper() {
  const layerY = useEditor((s) => s.layerY);
  const setLayerY = useEditor((s) => s.setLayerY);
  // LDraw -Y is up: going UP means layerY decreases. Layer 0 = ground.
  const plates = Math.round(-layerY / PLATE_H);
  const go = (deltaUp: number) => setLayerY(Math.min(0, layerY - deltaUp));
  const scrub = useRef<{ y: number; start: number; id: number } | null>(null);
  return (
    <div className="layer-stepper panel" aria-label="Layer" data-inset="right">
      <button className="icon-btn" onClick={() => go(BRICK_H)} title="Up one brick (Shift+PageUp)" aria-label="Up one brick"><IconUpDouble /><small>+1 B</small></button>
      <button className="icon-btn" onClick={() => go(PLATE_H)} title="Up one plate (PageUp)" aria-label="Up one plate"><IconUp /><small>+1 P</small></button>
      <div
        className="layer-readout"
        title={`Layer ${plates} (plates) — drag to scrub`}
        role="slider"
        aria-label="Layer"
        aria-valuenow={plates}
        aria-valuemin={0}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') go(PLATE_H);
          if (e.key === 'ArrowDown') go(-PLATE_H);
        }}
        onPointerDown={(e) => {
          scrub.current = { y: e.clientY, start: plates, id: e.pointerId };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const sc = scrub.current;
          if (!sc || sc.id !== e.pointerId) return;
          const next = Math.max(0, sc.start + Math.round((sc.y - e.clientY) / 14));
          if (next !== Math.round(-useEditor.getState().layerY / PLATE_H)) {
            setLayerY(-next * PLATE_H);
            haptic('tick');
          }
        }}
        onPointerUp={() => (scrub.current = null)}
        onPointerCancel={() => (scrub.current = null)}
      >
        <IconLayers size={16} />
        <strong>{plates}</strong>
        <small>plates</small>
        <em>{plates ? `= ${platesAsBricks(plates)} brick${plates === 3 ? '' : 's'}` : 'ground'}</em>
      </div>
      <button className="icon-btn" onClick={() => go(-PLATE_H)} disabled={layerY >= 0} title="Down one plate (PageDown)" aria-label="Down one plate"><IconDown /><small>-1 P</small></button>
      <button className="icon-btn" onClick={() => go(-BRICK_H)} disabled={layerY >= 0} title="Down one brick (Shift+PageDown)" aria-label="Down one brick"><IconDownDouble /><small>-1 B</small></button>
    </div>
  );
}

/** Enter 2D at a useful layer: on top of the selection, else on top of the build. */
export function enter2D() {
  const s = useEditor.getState();
  if (s.viewMode === '2d') return;
  const sel = s.model.bricks.filter((b) => s.selection.includes(b.id));
  if (sel.length) {
    // On top of the selection: ready to build onto it.
    const top = Math.min(...sel.map((b) => b.pos[1]));
    s.setLayerY(Math.min(0, Math.round(top / PLATE_H) * PLATE_H));
  } else if (s.model.bricks.length) {
    // The highest course in use (one brick below the top surface), so there is something to see.
    const top = Math.min(...s.model.bricks.map((b) => b.pos[1]));
    s.setLayerY(Math.min(0, Math.round((top + BRICK_H) / PLATE_H) * PLATE_H));
  } else s.setLayerY(0);
  s.setViewMode('2d');
}
export function toggleView() {
  const s = useEditor.getState();
  if (s.viewMode === '3d') enter2D();
  else s.setViewMode('3d');
}

export function StatusPill() {
  const engine = useEngine();
  const count = useEditor((s) => s.model.bricks.length);
  const selected = useEditor((s) => s.selection.length);
  const [pending, setPending] = useState(0);
  useEffect(() => engine.onLoading(setPending), [engine]);
  return (
    <div className="status panel">
      <IconBricks size={16} />
      <span>
        {count.toLocaleString()} brick{count === 1 ? '' : 's'}
        {selected > 0 && <> · {selected} selected</>}
      </span>
      {pending > 0 && (
        <span className="status-loading">
          <Spinner size={14} /> Loading {pending} part{pending === 1 ? '' : 's'}…
        </span>
      )}
    </div>
  );
}

export const SHORTCUTS: Array<[string, string]> = [
  ['B / V / P / E', 'Place / Select / Paint / Erase'],
  ['1 – 6', 'Arm a hotbar part'],
  ['R / Shift+R', 'Rotate pending brick or selection ±90°'],
  ['Arrow keys', 'Nudge 1 stud (camera-relative) · Alt = ½ stud'],
  ['PageUp / PageDown', '2D: change layer · 3D: lift / lower one plate (Shift = brick)'],
  ['Enter / Esc', 'Place the pending brick / cancel it, else deselect'],
  ['Shift+click', 'Preview a brick before placing (pending)'],
  ['Delete', 'Delete the selection'],
  ['Ctrl+D', 'Duplicate the selection'],
  ['Ctrl+A', 'Select all'],
  ['I', "Eyedropper: use the selected brick's part + colour"],
  ['F / Shift+F', 'Frame all / frame the selection'],
  ['T · Shift+2 / Shift+3', 'Toggle 2D/3D · 2D / 3D'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
  ['Ctrl+S / Ctrl+Shift+S', 'Save to My builds / Save as copy'],
  ['?', 'This cheat-sheet'],
];

export function ShortcutsBody() {
  return (
    <table className="shortcuts">
      <tbody>
        {SHORTCUTS.map(([k, v]) => (
          <tr key={k}>
            <td><kbd>{k}</kbd></td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Global keyboard shortcuts for the editor. */
export function useShortcuts(cmd: EditorCommands, enabled: boolean, extra: { onHelp(): void; armHotbar(n: number): void }) {
  const engine = useEngine();
  const cmdRef = useRef(cmd);
  cmdRef.current = cmd;
  const extraRef = useRef(extra);
  extraRef.current = extra;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Ctrl+S works everywhere in the editor (also while typing the name), never the browser's "Save page".
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (useEditor.getState().readOnly || document.querySelector('.backdrop, .sheet-backdrop, .photo-flow')) return;
        if (t && t.tagName === 'INPUT') t.blur(); // commit a name being typed first
        if (e.shiftKey) cmdRef.current.saveAsCopy();
        else cmdRef.current.save();
        return;
      }
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (document.querySelector('.backdrop, .sheet-backdrop, .photo-flow, .mb-screen')) return;
      const s = useEditor.getState();
      if (s.readOnly) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const pending = engine.getPending().active;
      const hasTarget = pending || s.selection.length > 0;
      if (mod) {
        if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) s.redo();
          else if (pending) engine.cancelPending();
          else s.undo();
        } else if (k === 'y') {
          e.preventDefault();
          s.redo();
        } else if (k === 'd') {
          e.preventDefault();
          actions.duplicate(engine);
        } else if (k === 'a') {
          e.preventDefault();
          actions.selectAll();
        }
        return;
      }
      // Arrow keys nudge the pending brick / selection (camera-relative); Alt = half a stud.
      if (k.startsWith('arrow') && hasTarget) {
        e.preventDefault();
        const map: Record<string, ['x' | 'z', '+' | '-']> = {
          arrowleft: ['x', '-'],
          arrowright: ['x', '+'],
          arrowup: ['z', '+'],
          arrowdown: ['z', '-'],
        };
        const [axis, dir] = map[k];
        engine.nudge(axis, dir, e.altKey);
        return;
      }
      if (e.altKey) return;
      // Digits: 1–6 arm hotbar parts; Shift+2 / Shift+3 switch 2D / 3D.
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (digit) {
        if (e.shiftKey && digit === '2') enter2D();
        else if (e.shiftKey && digit === '3') s.setViewMode('3d');
        else if (!e.shiftKey && +digit <= 6) extraRef.current.armHotbar(+digit);
        else return;
        e.preventDefault();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        extraRef.current.onHelp();
        return;
      }
      switch (k) {
        case 'r':
          cmdRef.current.rotate(e.shiftKey ? -1 : 1);
          break;
        case 'f':
          if (e.shiftKey) actions.frameSelection(engine);
          else cmdRef.current.fit();
          break;
        case 't':
          toggleView();
          break;
        case 'i':
          actions.usePartOfSelection();
          break;
        case 'b':
          s.setTool('place');
          break;
        case 'v':
          s.setTool('select');
          break;
        case 'p':
          s.setTool('paint');
          break;
        case 'e':
          s.setTool('erase');
          break;
        case 'enter':
          if (!pending) return;
          e.preventDefault();
          engine.confirmPending();
          break;
        case 'escape':
          if (pending) engine.cancelPending();
          else s.select([]);
          break;
        case 'delete':
        case 'backspace':
          if (s.selection.length) {
            e.preventDefault();
            actions.deleteSelection();
          }
          break;
        case 'pageup':
        case 'pagedown': {
          e.preventDefault();
          const up = k === 'pageup';
          if (s.viewMode === '2d' && !hasTarget) {
            s.setLayerY(Math.min(0, s.layerY + (up ? -1 : 1) * (e.shiftKey ? BRICK_H : PLATE_H)));
          } else if (hasTarget) {
            const n = e.shiftKey ? BRICK_H / PLATE_H : 1;
            for (let i = 0; i < n; i++) engine.nudge('y', up ? '+' : '-');
          }
          break;
        }
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, engine]);
}
