// Contextual action bars (UX_REVIEW §3.2): one for the pending (not yet placed) brick, one for a
// selection. Phone: docked in the thumb zone, replacing the hotbar + bottom bar. Desktop: a
// floating mini-toolbar over the canvas.
import type { ReactNode } from 'react';
import { t, tp } from '../i18n';
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
  return <ActBtn icon={c ? <Swatch color={c} size={24} /> : <span className="swatch" />} label={t('ctx.colour')} onClick={() => openSheet('colors')} />;
}

/** Status chips above the bar: "Overlaps a brick", "Floating", "Adding to selection". */
function BarTags() {
  const blocked = useUi((s) => s.pending.active && s.pending.blocked);
  const floating = useUi((s) => s.pending.active && s.floating);
  const addMore = useUi((s) => s.addMore);
  if (!blocked && !floating && !addMore) return null;
  return (
    <div className="bar-tags" aria-live="polite">
      {blocked && <span className="bar-tag danger">{t('ctx.blocked')}</span>}
      {!blocked && floating && <span className="bar-tag warn">{t('ctx.floating')}</span>}
      {addMore && (
        <span className="bar-tag info">
          {t('ctx.addmore')}
          <button onClick={() => useUi.setState({ addMore: false })}>{t('ctx.done')}</button>
        </span>
      )}
    </div>
  );
}

const STEP_KEY: Record<NudgeStep, string> = { stud: 'nudge.step.stud', half: 'nudge.step.half', brick: 'nudge.step.brick' };
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
      <NudgeBtn label={t('nudge.left')} axis="x" dir="-"><IconArrowLeft size={20} /></NudgeBtn>
      <NudgeBtn label={t('nudge.away')} axis="z" dir="+"><IconArrowUp size={20} /></NudgeBtn>
      <NudgeBtn label={t('nudge.closer')} axis="z" dir="-"><IconArrowDown size={20} /></NudgeBtn>
      <NudgeBtn label={t('nudge.right')} axis="x" dir="+"><IconArrowRight size={20} /></NudgeBtn>
      <span className="nudge-sep" />
      <NudgeBtn label={t('nudge.lift')} axis="y" dir="+"><IconLift size={20} /></NudgeBtn>
      <NudgeBtn label={t('nudge.lower')} axis="y" dir="-"><IconLower size={20} /></NudgeBtn>
      <button className="nudge-step" onClick={() => setPref('nudgeStep', NEXT_STEP[step])} title={t('nudge.step')}>
        <small>{t('nudge.step')}</small>
        <span>{t(STEP_KEY[step])}</span>
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
      title={blocked ? t('ctx.blocked.title') : `${t('ctx.place')} (Enter)`}
    >
      {blocked ? <IconClose size={20} /> : <IconCheck size={22} />}
      <span>{blocked ? t('ctx.overlaps') : t('ctx.place')}</span>
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
        <div className="context-bar panel pending" role="toolbar" aria-label={t('ctx.place')}>
          <ActBtn icon={<IconClose size={22} />} label={t('ctx.cancel')} onClick={() => engine.cancelPending()} />
          <ActBtn icon={<IconRotate size={22} />} label={t('ctx.rotate')} onClick={() => engine.rotate(1)} />
          <ColourAct />
          <PlaceBtn big />
        </div>
      ) : (
        <div className="context-bar panel selection" role="toolbar" aria-label={tp('status.selected', count)}>
          <ActBtn icon={<IconRotate size={22} />} label={t('ctx.rotate')} onClick={() => engine.rotate(1)} />
          <ActBtn icon={<IconDuplicate size={22} />} label={t('ctx.duplicate')} onClick={() => actions.duplicate(engine)} />
          <ColourAct />
          <ActBtn
            icon={<IconAddMore size={22} />}
            label={t('ctx.addmore.btn')}
            pressed={addMore}
            className={addMore ? 'on' : ''}
            onClick={() => {
              const s = useEditor.getState();
              if (s.tool !== 'select') s.setTool('select');
              useUi.setState({ addMore: !addMore });
            }}
          />
          <ActBtn icon={<IconTrash size={22} />} label={t('ctx.delete')} className="danger" onClick={actions.deleteSelection} />
          <ActBtn icon={<IconMore size={22} />} label={t('ctx.more')} onClick={() => openSheet('selection-more')} />
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
      <button className="icon-btn" onClick={() => actions.nudge(engine, 'y', '+')} title={t('ctx.lift')} aria-label={t('nudge.lift')}><IconLift /></button>
      <button className="icon-btn" onClick={() => actions.nudge(engine, 'y', '-')} title={t('ctx.lower')} aria-label={t('nudge.lower')}><IconLower /></button>
    </>
  );
  return (
    <div className="mini-toolbar panel" role="toolbar" aria-label={mode === 'pending' ? t('ctx.place') : t('ph.sheet.selection')}>
      <BarTags />
      {mode === 'pending' ? (
        <>
          <button className="icon-btn" onClick={() => engine.cancelPending()} title={`${t('ctx.cancel')} (Esc)`} aria-label={t('ctx.cancel')}><IconClose /></button>
          <button className="icon-btn" onClick={() => engine.rotate(1)} title={t('top.rotate')} aria-label={t('ctx.rotate')}><IconRotate /></button>
          {lift}
          <PlaceBtn />
        </>
      ) : (
        <>
          <span className="mini-count">{tp('status.selected', count)}</span>
          <button className="icon-btn" onClick={() => engine.rotate(1)} title={t('top.rotate')} aria-label={t('ctx.rotate')}><IconRotate /></button>
          <button className="icon-btn" onClick={() => actions.duplicate(engine)} title={`${t('ctx.duplicate')} (Ctrl+D)`} aria-label={t('ctx.duplicate')}><IconDuplicate /></button>
          {lift}
          <button className="icon-btn" onClick={() => actions.frameSelection(engine)} title={`${t('ctx.frame')} (Shift+F)`} aria-label={t('ctx.frame')}><IconFocus /></button>
          <button className="icon-btn danger" onClick={actions.deleteSelection} title={`${t('ctx.delete')} (Del)`} aria-label={t('ctx.delete')}><IconTrash /></button>
          <button className="icon-btn" onClick={() => useEditor.getState().select([])} title={`${t('ctx.deselect')} (Esc)`} aria-label={t('ctx.deselect')}><IconClose /></button>
        </>
      )}
    </div>
  );
}
