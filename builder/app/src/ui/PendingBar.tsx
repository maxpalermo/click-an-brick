// Contextual action bars (UX_REVIEW §3.2): one for the pending (not yet placed) brick, one for a
// selection. Phone: docked in the thumb zone, replacing the hotbar + bottom bar. Desktop: a
// floating mini-toolbar over the canvas.
import type { ReactNode } from 'react';
import { useEditor } from '../model/store';
import { useColors, useEngine } from './context';
import { actions } from './engineBridge';
import { useRepeat } from './gestures';
import {
  IconAddMore, IconArrowDown, IconArrowLeft, IconArrowRight, IconArrowUp, IconCheck, IconClose, IconDuplicate,
  IconFocus, IconLift, IconLower, IconMore, IconRotate, IconTrash,
} from './Icons';
import { Swatch, colorByCode } from './Palette';
import { openSheet, usePrefs, useUi, type NudgeStep } from './prefs';

export function useBarMode(): 'pending' | 'selection' | null {
  const pending = useUi((s) => s.pending.active);
  const sel = useEditor((s) => s.selection.length > 0);
  if (pending) return 'pending';
  return sel ? 'selection' : null;
}

function ActBtn({ icon, label, onClick, className, disabled, title, pressed }: {
  icon: ReactNode; label: string; onClick(): void; className?: string; disabled?: boolean; title?: string; pressed?: boolean;
}) {
  return (
    <button className={`act-btn ${className ?? ''}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-pressed={pressed}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ColourAct() {
  const colors = useColors();
  const pending = useUi((u) => u.pending.active);
  const code = useEditor((s) => {
    if (pending || !s.selection.length) return s.activeColor;
    const b = s.model.bricks.find((x) => x.id === s.selection[0]);
    return b?.color ?? s.activeColor;
  });
  const c = colorByCode(colors, code);
  return <ActBtn icon={c ? <Swatch color={c} size={24} /> : <span className="swatch" />} label="Colour" onClick={() => openSheet('colors')} />;
}

/** Status chips above the bar: "Overlaps a brick", "Floating", "Adding to selection". */
function BarTags() {
  const blocked = useUi((s) => s.pending.active && s.pending.blocked);
  const floating = useUi((s) => s.pending.active && s.floating);
  const addMore = useUi((s) => s.addMore);
  if (!blocked && !floating && !addMore) return null;
  return (
    <div className="bar-tags" aria-live="polite">
      {blocked && <span className="bar-tag danger">Overlaps a brick</span>}
      {!blocked && floating && <span className="bar-tag warn">Floating</span>}
      {addMore && (
        <span className="bar-tag info">
          Tap bricks to add
          <button onClick={() => useUi.setState({ addMore: false })}>Done</button>
        </span>
      )}
    </div>
  );
}

const STEP_LABEL: Record<NudgeStep, string> = { stud: '1 stud', half: '½ stud', brick: '1 brick' };
const NEXT_STEP: Record<NudgeStep, NudgeStep> = { stud: 'half', half: 'brick', brick: 'stud' };

function NudgeBtn({ label, children, axis, dir }: { label: string; children: ReactNode; axis: 'x' | 'y' | 'z'; dir: '+' | '-' }) {
  const engine = useEngine();
  const rep = useRepeat(() => actions.nudge(engine, axis, dir));
  return (
    <button className="nudge-btn" aria-label={label} title={label} {...rep}>
      {children}
    </button>
  );
}

/** Camera-relative nudge pad: ← ↑ ↓ → · Lift ▲▼ · Step. Tap = one step, hold = repeat. */
export function NudgePad() {
  const step = usePrefs((s) => s.nudgeStep);
  const setPref = usePrefs((s) => s.set);
  return (
    <div className="nudge-pad panel" role="toolbar" aria-label="Nudge">
      <NudgeBtn label="Move left" axis="x" dir="-"><IconArrowLeft size={20} /></NudgeBtn>
      <NudgeBtn label="Move away" axis="z" dir="+"><IconArrowUp size={20} /></NudgeBtn>
      <NudgeBtn label="Move closer" axis="z" dir="-"><IconArrowDown size={20} /></NudgeBtn>
      <NudgeBtn label="Move right" axis="x" dir="+"><IconArrowRight size={20} /></NudgeBtn>
      <span className="nudge-sep" />
      <NudgeBtn label="Lift" axis="y" dir="+"><IconLift size={20} /></NudgeBtn>
      <NudgeBtn label="Lower" axis="y" dir="-"><IconLower size={20} /></NudgeBtn>
      <button className="nudge-step" onClick={() => setPref('nudgeStep', NEXT_STEP[step])} title="Step size">
        <small>Step</small>
        <span>{STEP_LABEL[step]}</span>
      </button>
    </div>
  );
}

function PlaceBtn({ big }: { big?: boolean }) {
  const engine = useEngine();
  const blocked = useUi((s) => s.pending.blocked);
  const pulse = useUi((s) => s.blockedPulse);
  return (
    <button
      key={pulse}
      className={`place-btn ${big ? 'big' : ''} ${pulse ? 'shake' : ''}`}
      onClick={() => engine.confirmPending()}
      aria-disabled={blocked}
      data-blocked={blocked || undefined}
      title={blocked ? 'Overlaps a brick — move it first' : 'Place (Enter)'}
    >
      {blocked ? <IconClose size={20} /> : <IconCheck size={22} />}
      <span>{blocked ? 'Overlaps' : 'Place'}</span>
    </button>
  );
}

/** Phone: docked contextual bar (+ nudge pad / tags). Renders nothing at rest. */
export function PhoneContextBar() {
  const engine = useEngine();
  const mode = useBarMode();
  const addMore = useUi((s) => s.addMore);
  const nudgeSel = usePrefs((s) => s.nudgeForSelection);
  const count = useEditor((s) => s.selection.length);
  if (!mode) return null;
  return (
    <>
      <BarTags />
      {(mode === 'pending' || nudgeSel) && <NudgePad />}
      {mode === 'pending' ? (
        <div className="context-bar panel pending" role="toolbar" aria-label="Place brick">
          <ActBtn icon={<IconClose size={22} />} label="Cancel" onClick={() => engine.cancelPending()} />
          <ActBtn icon={<IconRotate size={22} />} label="Rotate" onClick={() => engine.rotate(1)} />
          <ColourAct />
          <PlaceBtn big />
        </div>
      ) : (
        <div className="context-bar panel selection" role="toolbar" aria-label={`${count} selected`}>
          <ActBtn icon={<IconRotate size={22} />} label="Rotate" onClick={() => engine.rotate(1)} />
          <ActBtn icon={<IconDuplicate size={22} />} label="Duplicate" onClick={() => actions.duplicate(engine)} />
          <ColourAct />
          <ActBtn
            icon={<IconAddMore size={22} />}
            label="Add more"
            pressed={addMore}
            className={addMore ? 'on' : ''}
            onClick={() => {
              const s = useEditor.getState();
              if (s.tool !== 'select') s.setTool('select');
              useUi.setState({ addMore: !addMore });
            }}
          />
          <ActBtn icon={<IconTrash size={22} />} label="Delete" className="danger" onClick={actions.deleteSelection} />
          <ActBtn icon={<IconMore size={22} />} label="More" onClick={() => openSheet('selection-more')} />
        </div>
      )}
    </>
  );
}

/** Desktop / tablet: floating mini-toolbar for the pending brick or the selection. */
export function DesktopContextBar() {
  const engine = useEngine();
  const mode = useBarMode();
  const count = useEditor((s) => s.selection.length);
  if (!mode) return null;
  const lift = (
    <>
      <button className="icon-btn" onClick={() => actions.nudge(engine, 'y', '+')} title="Lift one plate (PageUp)" aria-label="Lift"><IconLift /></button>
      <button className="icon-btn" onClick={() => actions.nudge(engine, 'y', '-')} title="Lower one plate (PageDown)" aria-label="Lower"><IconLower /></button>
    </>
  );
  return (
    <div className="mini-toolbar panel" role="toolbar" aria-label={mode === 'pending' ? 'Place brick' : 'Selection'}>
      <BarTags />
      {mode === 'pending' ? (
        <>
          <button className="icon-btn" onClick={() => engine.cancelPending()} title="Cancel (Esc)" aria-label="Cancel"><IconClose /></button>
          <button className="icon-btn" onClick={() => engine.rotate(1)} title="Rotate (R)" aria-label="Rotate"><IconRotate /></button>
          {lift}
          <PlaceBtn />
        </>
      ) : (
        <>
          <span className="mini-count">{count} selected</span>
          <button className="icon-btn" onClick={() => engine.rotate(1)} title="Rotate (R)" aria-label="Rotate"><IconRotate /></button>
          <button className="icon-btn" onClick={() => actions.duplicate(engine)} title="Duplicate (Ctrl+D)" aria-label="Duplicate"><IconDuplicate /></button>
          {lift}
          <button className="icon-btn" onClick={() => actions.frameSelection(engine)} title="Frame selection (Shift+F)" aria-label="Frame selection"><IconFocus /></button>
          <button className="icon-btn danger" onClick={actions.deleteSelection} title="Delete (Del)" aria-label="Delete"><IconTrash /></button>
          <button className="icon-btn" onClick={() => useEditor.getState().select([])} title="Deselect (Esc)" aria-label="Deselect"><IconClose /></button>
        </>
      )}
    </div>
  );
}
