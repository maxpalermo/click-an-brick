// Phone layout (UX_REVIEW §3.1–3.2): top bar (project menu · undo/redo · share), hotbar,
// resting bottom bar (Parts · Colour · Build/Select · 3D/2D), contextual bars and sheets.
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { hasUnsavedChanges, useEditor } from '../model/store';
import { useArchive } from './archive';
import { PhotoSheetButton } from '../photo/ui/EntryPoints';
import { partLabel } from './Catalog';
import { useColors, useEngine } from './context';
import { CAMERAS, UndoRedo, toggleView, type EditorCommands } from './EditorChrome';
import { actions, canVibrate } from './engineBridge';
import { partIndex, useCatalog } from './hooks';
import {
  IconBack, IconCheck, IconChevron, IconDuplicate, IconEyedropper, IconExport, IconFit, IconFocus, IconGrid, IconHand,
  IconImport, IconNew, IconPaint, IconPlace, IconShare, IconVibrate, Logo,
} from './Icons';
import { Sheet, Spinner } from './Overlays';
import { ColourSheetBody, Swatch, colorByCode } from './Palette';
import { Hotbar, PartPicker } from './PartPicker';
import { PhoneContextBar, useBarMode } from './PendingBar';
import { closeSheet, openSheet, usePrefs, useUi } from './prefs';
import { Thumb } from './Thumb';

/** "3 selected · 2x4 Brick ×2, 1x2 Plate" / "12 bricks" / "Loading 3 parts…" */
function useSubtitle(): string {
  const engine = useEngine();
  const count = useEditor((s) => s.model.bricks.length);
  const sel = useEditor((s) => s.selection);
  const bricks = useEditor((s) => s.model.bricks);
  const { parts } = useCatalog();
  const [loading, setLoading] = useState(0);
  useEffect(() => engine.onLoading(setLoading), [engine]);
  const saving = useArchive((s) => s.saving);
  const linked = useEditor((s) => !!s.buildId);
  const unsaved = useEditor((s) => hasUnsavedChanges(s));
  if (sel.length) {
    const idx = partIndex(parts);
    const ids = new Set(sel);
    const counts = new Map<string, number>();
    for (const b of bricks) if (ids.has(b.id)) counts.set(b.part, (counts.get(b.part) ?? 0) + 1);
    const desc = [...counts]
      .slice(0, 2)
      .map(([p, n]) => {
        const name = idx.get(p.toLowerCase())?.name;
        const l = name ? partLabel(name).split(' ').slice(0, 2).join(' ') : p.replace(/\.dat$/i, '');
        return n > 1 ? `${l} ×${n}` : l;
      })
      .join(', ');
    return `${sel.length} selected · ${desc}${counts.size > 2 ? '…' : ''}`;
  }
  if (loading) return `Loading ${loading} part${loading === 1 ? '' : 's'}…`;
  const status = saving ? 'Saving…' : linked ? (unsaved ? 'Unsaved changes' : 'Saved') : count ? 'Not saved yet' : 'tap for menu';
  return `${count.toLocaleString()} brick${count === 1 ? '' : 's'} · ${status}`;
}

function PhoneTopBar({ cmd }: { cmd: EditorCommands }) {
  const name = useEditor((s) => s.model.name);
  const subtitle = useSubtitle();
  return (
    <header className="topbar phone panel" data-inset="top">
      <button className="project-btn" onClick={() => openSheet('menu')} aria-label={`Project menu: ${name}`} aria-haspopup="dialog">
        <Logo size={30} />
        <span className="project-text">
          <strong>{name || 'My build'}</strong>
          <small>{subtitle.startsWith('Loading') && <Spinner size={10} />} {subtitle}</small>
        </span>
        <IconChevron size={16} />
      </button>
      <UndoRedo />
      <button className="icon-btn accent" onClick={cmd.share} aria-label="Share"><IconShare /></button>
    </header>
  );
}

function ModeSwitch() {
  const tool = useEditor((s) => s.tool);
  const set = (t: 'place' | 'select') => {
    const s = useEditor.getState();
    if (t === 'place') s.select([]);
    s.setTool(t);
  };
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Mode">
      <button role="radio" aria-checked={tool === 'place'} className={tool === 'place' ? 'active' : ''} onClick={() => set('place')}>
        <IconPlace size={20} /> Build
      </button>
      <button role="radio" aria-checked={tool === 'select'} className={tool === 'select' ? 'active' : ''} onClick={() => set('select')}>
        <IconHand size={20} /> Select
      </button>
    </div>
  );
}

function BottomBar() {
  const colors = useColors();
  const activeColor = useEditor((s) => s.activeColor);
  const activePart = useEditor((s) => s.activePart);
  const viewMode = useEditor((s) => s.viewMode);
  const color = colorByCode(colors, activeColor);
  return (
    <nav className="bottombar panel" aria-label="Editor">
      <button className="tb-btn" onClick={() => openSheet('parts')} aria-label="Parts">
        {activePart ? <Thumb part={activePart} color={activeColor} size={96} className="tb-thumb" /> : <span className="tb-thumb" />}
        <span>Parts</span>
      </button>
      <button className="tb-btn" onClick={() => openSheet('colors')} aria-label={`Colour: ${color?.name ?? activeColor}`}>
        {color ? <Swatch color={color} size={26} /> : <span className="swatch" />}
        <span>{color?.name ?? 'Colour'}</span>
      </button>
      <ModeSwitch />
      <button className="tb-btn" onClick={toggleView} aria-label={`View: ${viewMode.toUpperCase()} (tap to switch)`}>
        <span className="tb-mode">{viewMode.toUpperCase()}</span>
        <span>View</span>
      </button>
    </nav>
  );
}

/** Paint brush / eraser mode banner (power-user tools from the project menu). */
function ToolBanner() {
  const tool = useEditor((s) => s.tool);
  if (tool !== 'paint' && tool !== 'erase') return null;
  return (
    <div className="bar-tags">
      <span className="bar-tag info">
        {tool === 'paint' ? 'Paint brush · tap bricks to paint them' : 'Eraser · tap bricks to remove them'}
        <button onClick={() => useEditor.getState().setTool('place')}>Done</button>
      </span>
    </div>
  );
}

export function PhoneChrome({ cmd }: { cmd: EditorCommands }) {
  const sheet = useUi((s) => s.sheet);
  const mode = useBarMode();
  const tool = useEditor((s) => s.tool);
  const readOnly = useEditor((s) => s.readOnly);
  return (
    <>
      <PhoneTopBar cmd={cmd} />
      {!readOnly && (
        <div className="dock" data-inset="bottom">
          {mode ? (
            <PhoneContextBar />
          ) : (
            <>
              <ToolBanner />
              {tool === 'place' && <Hotbar variant="phone" />}
              <BottomBar />
            </>
          )}
        </div>
      )}
      {sheet === 'parts' && (
        <Sheet title="Parts" half onClose={closeSheet} className="sheet-parts">
          <PartPicker onPicked={closeSheet} />
        </Sheet>
      )}
      {sheet === 'colors' && (
        <Sheet title="Colour" half seeThrough onClose={closeSheet}>
          <ColourSheetBody onPicked={(keep) => !keep && !useUi.getState().pending.active && closeSheet()} />
        </Sheet>
      )}
      {sheet === 'menu' && <ProjectMenu cmd={cmd} />}
      {sheet === 'selection-more' && <SelectionMore />}
    </>
  );
}

function SelectionMore() {
  const engine = useEngine();
  const nudge = usePrefs((s) => s.nudgeForSelection);
  const setPref = usePrefs((s) => s.set);
  const run = (f: () => void) => () => {
    closeSheet();
    f();
  };
  return (
    <Sheet title="Selection" onClose={closeSheet}>
      <div className="list-buttons one">
        <button className="btn" onClick={run(actions.usePartOfSelection)}><IconEyedropper size={18} /> Use this part &amp; colour</button>
        <button className="btn" onClick={run(actions.selectSameColour)}><IconPaint size={18} /> Select same colour</button>
        <button className="btn" onClick={run(actions.selectAll)}><IconHand size={18} /> Select all</button>
        <button className="btn" onClick={run(() => actions.frameSelection(engine))}><IconFocus size={18} /> Frame selection</button>
        <label className="toggle-row">
          <input type="checkbox" checked={nudge} onChange={(e) => setPref('nudgeForSelection', e.target.checked)} />
          <span>Show the nudge pad for selections</span>
        </label>
        <button className="btn" onClick={run(() => useEditor.getState().select([]))}>Deselect</button>
      </div>
    </Sheet>
  );
}

function ProjectMenu({ cmd }: { cmd: EditorCommands }) {
  const engine = useEngine();
  const name = useEditor((s) => s.model.name);
  const count = useEditor((s) => s.model.bricks.length);
  const viewMode = useEditor((s) => s.viewMode);
  const rename = useEditor((s) => s.rename);
  const prefs = usePrefs();
  const [draft, setDraft] = useState(name);
  const commitName = () => {
    const v = draft.trim() || 'My build';
    if (v !== name) rename(v);
  };
  const run = (f: () => void) => () => {
    commitName();
    closeSheet();
    f();
  };
  return (
    <Sheet title="Project" onClose={() => { commitName(); closeSheet(); }}>
      <div className="sheet-section">
        <label className="sheet-label" htmlFor="pm-name">Name · {count.toLocaleString()} brick{count === 1 ? '' : 's'}</label>
        <input
          id="pm-name"
          className="text-input"
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          spellCheck={false}
        />
      </div>
      <div className="sheet-section">
        <div className="sheet-label">Build</div>
        <button className="btn mybuilds-sheet-btn" onClick={run(cmd.myBuilds)}>
          <span className="mybuilds-sheet-icon"><IconGrid size={22} /></span>
          <span className="mybuilds-sheet-text">
            <strong>My builds</strong>
            <small>Your saved builds, on every device</small>
          </span>
        </button>
        <div className="list-buttons">
          <button className="btn" onClick={run(cmd.save)}><IconCheck size={18} /> Save</button>
          <button className="btn" onClick={run(cmd.saveAsCopy)}><IconDuplicate size={18} /> Save as copy</button>
          <button className="btn" onClick={run(cmd.newBuild)}><IconNew size={18} /> New build</button>
          <button className="btn primary" onClick={run(cmd.share)}><IconShare size={18} /> Share link</button>
        </div>
      </div>
      <div className="sheet-section">
        <div className="sheet-label">Create</div>
        <PhotoSheetButton onBefore={() => { commitName(); closeSheet(); }} />
      </div>
      <div className="sheet-section">
        <div className="sheet-label">Camera</div>
        <div className="grid-buttons">
          {CAMERAS.map((c) => (
            <button key={c.id} className="btn" disabled={viewMode === '2d'} onClick={run(() => engine.setCameraPreset(c.id))}>
              {c.label}
            </button>
          ))}
          <button className="btn" onClick={run(cmd.fit)}><IconFit size={18} /> Fit all</button>
        </div>
      </div>
      <div className="sheet-section">
        <div className="sheet-label">File</div>
        <div className="list-buttons">
          <button className="btn" onClick={run(cmd.importFile)}><IconImport size={18} /> Import .ldr</button>
          <button className="btn" onClick={run(cmd.exportFile)}><IconExport size={18} /> Export .ldr</button>
          <a className="btn" href="/"><IconBack size={18} /> {t('nav.scanner')}</a>
        </div>
      </div>
      <div className="sheet-section">
        <div className="sheet-label">Tools</div>
        <div className="list-buttons">
          <button className="btn" onClick={run(() => useEditor.getState().setTool('paint'))}><IconPaint size={18} /> Paint brush</button>
          <button className="btn" onClick={run(actions.selectAll)}><IconHand size={18} /> Select all</button>
        </div>
      </div>
      <div className="sheet-section">
        <div className="sheet-label">Settings</div>
        <label className="toggle-row">
          <input type="checkbox" checked={prefs.haptics} onChange={(e) => prefs.set('haptics', e.target.checked)} />
          <IconVibrate size={18} />
          <span>Vibration feedback{canVibrate() ? '' : ' (not supported on this device)'}</span>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={prefs.showAllParts} onChange={(e) => prefs.set('showAllParts', e.target.checked)} />
          <span>Show Duplo, Modulex &amp; other systems in the part picker</span>
        </label>
        <button className="btn" onClick={() => { prefs.resetTips(); closeSheet(); }}>Show tips again</button>
      </div>
    </Sheet>
  );
}
