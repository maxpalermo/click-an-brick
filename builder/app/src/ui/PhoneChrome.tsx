// Phone layout (UX_REVIEW §3.1–3.2): top bar (project menu · undo/redo · share), hotbar,
// resting bottom bar (Parts · Colour · Build/Select · 3D/2D), contextual bars and sheets.
import { useEffect, useState } from 'react';
import { t, tp } from '../i18n';
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
function useSubtitle(): { text: string; loading: boolean } {
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
    return { text: `${tp('status.selected', sel.length)} · ${desc}${counts.size > 2 ? '…' : ''}`, loading: false };
  }
  if (loading) return { text: t('status.loading', { n: loading }), loading: true };
  const status = saving ? t('save.saving') : linked ? (unsaved ? t('save.unsaved') : t('save.saved')) : count ? t('save.notsaved') : t('ph.tapmenu');
  return { text: `${tp('status.bricks', count)} · ${status}`, loading: false };
}

function PhoneTopBar({ cmd }: { cmd: EditorCommands }) {
  const name = useEditor((s) => s.model.name);
  const subtitle = useSubtitle();
  return (
    <header className="topbar phone panel" data-inset="top">
      <button className="project-btn" onClick={() => openSheet('menu')} aria-label={`${t('pm.project')}: ${name}`} aria-haspopup="dialog">
        <Logo size={30} />
        <span className="project-text">
          <strong>{name || 'My build'}</strong>
          <small>{subtitle.loading && <Spinner size={10} />} {subtitle.text}</small>
        </span>
        <IconChevron size={16} />
      </button>
      <UndoRedo />
      <button className="icon-btn accent" onClick={cmd.share} aria-label={t('nav.share')}><IconShare /></button>
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
    <div className="mode-switch" role="radiogroup" aria-label={t('view.mode')}>
      <button role="radio" aria-checked={tool === 'place'} className={tool === 'place' ? 'active' : ''} onClick={() => set('place')}>
        <IconPlace size={20} /> {t('ph.build')}
      </button>
      <button role="radio" aria-checked={tool === 'select'} className={tool === 'select' ? 'active' : ''} onClick={() => set('select')}>
        <IconHand size={20} /> {t('ph.select')}
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
      <button className="tb-btn" onClick={() => openSheet('parts')} aria-label={t('ph.parts')}>
        {activePart ? <Thumb part={activePart} color={activeColor} size={96} className="tb-thumb" /> : <span className="tb-thumb" />}
        <span>{t('ph.parts')}</span>
      </button>
      <button className="tb-btn" onClick={() => openSheet('colors')} aria-label={`${t('ph.colour')}: ${color?.name ?? activeColor}`}>
        {color ? <Swatch color={color} size={26} /> : <span className="swatch" />}
        <span>{color?.name ?? t('ph.colour')}</span>
      </button>
      <ModeSwitch />
      <button className="tb-btn" onClick={toggleView} aria-label={`${t('ph.view')}: ${viewMode.toUpperCase()}`}>
        <span className="tb-mode">{viewMode.toUpperCase()}</span>
        <span>{t('ph.view')}</span>
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
        {tool === 'paint' ? t('ph.paint.banner') : t('ph.erase.banner')}
        <button onClick={() => useEditor.getState().setTool('place')}>{t('ctx.done')}</button>
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
        <Sheet title={t('ph.parts')} half onClose={closeSheet} className="sheet-parts">
          <PartPicker onPicked={closeSheet} />
        </Sheet>
      )}
      {sheet === 'colors' && (
        <Sheet title={t('ph.colour')} half seeThrough onClose={closeSheet}>
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
    <Sheet title={t('ph.sheet.selection')} onClose={closeSheet}>
      <div className="list-buttons one">
        <button className="btn" onClick={run(actions.usePartOfSelection)}><IconEyedropper size={18} /> {t('sel.use')}</button>
        <button className="btn" onClick={run(actions.selectSameColour)}><IconPaint size={18} /> {t('sel.same')}</button>
        <button className="btn" onClick={run(actions.selectAll)}><IconHand size={18} /> {t('sel.all')}</button>
        <button className="btn" onClick={run(() => actions.frameSelection(engine))}><IconFocus size={18} /> {t('sel.frame')}</button>
        <label className="toggle-row">
          <input type="checkbox" checked={nudge} onChange={(e) => setPref('nudgeForSelection', e.target.checked)} />
          <span>{t('sel.nudge')}</span>
        </label>
        <button className="btn" onClick={run(() => useEditor.getState().select([]))}>{t('sel.deselect')}</button>
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
    <Sheet title={t('pm.project')} onClose={() => { commitName(); closeSheet(); }}>
      <div className="sheet-section">
        <label className="sheet-label" htmlFor="pm-name">{t('pm.name')} · {tp('status.bricks', count)}</label>
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
        <div className="sheet-label">{t('pm.build')}</div>
        <button className="btn mybuilds-sheet-btn" onClick={run(cmd.myBuilds)}>
          <span className="mybuilds-sheet-icon"><IconGrid size={22} /></span>
          <span className="mybuilds-sheet-text">
            <strong>{t('nav.builds')}</strong>
            <small>{t('pm.subtitle')}</small>
          </span>
        </button>
        <div className="list-buttons">
          <button className="btn" onClick={run(cmd.save)}><IconCheck size={18} /> {t('file.save')}</button>
          <button className="btn" onClick={run(cmd.saveAsCopy)}><IconDuplicate size={18} /> {t('file.savecopy')}</button>
          <button className="btn" onClick={run(cmd.newBuild)}><IconNew size={18} /> {t('file.new')}</button>
          <button className="btn primary" onClick={run(cmd.share)}><IconShare size={18} /> {t('pm.sharelink')}</button>
        </div>
      </div>
      <div className="sheet-section">
        <div className="sheet-label">{t('pm.create')}</div>
        <PhotoSheetButton onBefore={() => { commitName(); closeSheet(); }} />
      </div>
      <div className="sheet-section">
        <div className="sheet-label">{t('pm.camera')}</div>
        <div className="grid-buttons">
          {CAMERAS.map((c) => (
            <button key={c.id} className="btn" disabled={viewMode === '2d'} onClick={run(() => engine.setCameraPreset(c.id))}>
              {t(c.labelKey)}
            </button>
          ))}
          <button className="btn" onClick={run(cmd.fit)}><IconFit size={18} /> {t('pm.fitall')}</button>
        </div>
      </div>
      <div className="sheet-section">
        <div className="sheet-label">{t('pm.file')}</div>
        <div className="list-buttons">
          <button className="btn" onClick={run(cmd.importFile)}><IconImport size={18} /> {t('file.import')}</button>
          <button className="btn" onClick={run(cmd.exportFile)}><IconExport size={18} /> {t('file.export')}</button>
          <a className="btn" href="/"><IconBack size={18} /> {t('nav.scanner')}</a>
        </div>
      </div>
      <div className="sheet-section">
        <div className="sheet-label">{t('pm.tools')}</div>
        <div className="list-buttons">
          <button className="btn" onClick={run(() => useEditor.getState().setTool('paint'))}><IconPaint size={18} /> {t('pm.paintbrush')}</button>
          <button className="btn" onClick={run(actions.selectAll)}><IconHand size={18} /> {t('pm.selectall')}</button>
        </div>
      </div>
      <div className="sheet-section">
        <div className="sheet-label">{t('pm.settings')}</div>
        <label className="toggle-row">
          <input type="checkbox" checked={prefs.haptics} onChange={(e) => prefs.set('haptics', e.target.checked)} />
          <IconVibrate size={18} />
          <span>{t('pm.haptics')}{canVibrate() ? '' : t('pm.haptics.no')}</span>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={prefs.showAllParts} onChange={(e) => prefs.set('showAllParts', e.target.checked)} />
          <span>{t('pm.showallparts')}</span>
        </label>
        <button className="btn" onClick={() => { prefs.resetTips(); closeSheet(); }}>{t('pm.tips')}</button>
      </div>
    </Sheet>
  );
}
