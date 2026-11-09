// "Real size" (UX B, U3): on the frozen front photo the user drags a box over a real 2x2 brick lying
// next to the object, and adjusts the box around the object. Only pixel measurements are stored; the
// final lduPerUnit is computed after the GLB loads (scale.ts convertScale).
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { PhotoMode } from '../types';
import { Brick2x2Art, IconAlert, IconBack } from './icons';
import type { Rect01, Shot } from './image';
import { MIN_REF_PX, bricksTall, brickPx, estimateSize, measureFromShot, studsWide, type Measure } from './scale';

interface Props {
  shot: Shot;
  mode?: PhotoMode;
  initial: { brick?: Rect01; object?: Rect01 };
  onApply(v: { brick?: Rect01; object?: Rect01 }): void;
  onCancel(): void;
  /** Asked right after the front photo of a LEGO build: explain why, and offer to skip. */
  prompted?: boolean;
  onSkip?(): void;
}

type Tab = 'brick' | 'object';
type Drag = { kind: 'draw'; x: number; y: number } | { kind: 'corner'; cx: 0 | 1; cy: 0 | 1 } | null;

const norm = (r: Rect01): Rect01 => ({
  x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1),
});
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function RealSize({ shot, mode, initial, onApply, onCancel, prompted, onSkip }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const [tab, setTab] = useState<Tab>('brick');
  const [brick, setBrick] = useState<Rect01 | undefined>(initial.brick);
  const [object, setObject] = useState<Rect01>(initial.object ?? shot.guide);
  const drag = useRef<Drag>(null);

  // Fit the photo (contain) into the available area.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const aw = el.clientWidth, ah = el.clientHeight;
      const k = Math.min(aw / shot.width, ah / shot.height);
      setFit({ w: Math.floor(shot.width * k), h: Math.floor(shot.height * k) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [shot.width, shot.height]);

  const toFrac = (e: RPointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (tab !== 'brick') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toFrac(e);
    drag.current = { kind: 'draw', x: p.x, y: p.y };
    setBrick({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onCornerDown = (cx: 0 | 1, cy: 0 | 1) => (e: RPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    stageRef.current?.setPointerCapture(e.pointerId);
    drag.current = { kind: 'corner', cx, cy };
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toFrac(e);
    if (d.kind === 'draw') setBrick({ x0: d.x, y0: d.y, x1: p.x, y1: p.y });
    else
      setObject((o) => ({
        ...o,
        ...(d.cx ? { x1: p.x } : { x0: p.x }),
        ...(d.cy ? { y1: p.y } : { y0: p.y }),
      }));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'draw') setBrick((b) => (b ? norm(b) : b));
    if (d?.kind === 'corner') setObject((o) => norm(o));
  };

  const m: Measure = { ...measureFromShot(shot), object, brick: brick && brickPx({ ...measureFromShot(shot), brick }) > 2 ? norm(brick) : undefined };
  const refPx = brickPx(m);
  const est = estimateSize(m);
  const tooSmall = refPx > 0 && refPx < MIN_REF_PX;
  const pct = (r: Rect01) => {
    const n = norm(r);
    return { left: `${n.x0 * 100}%`, top: `${n.y0 * 100}%`, width: `${(n.x1 - n.x0) * 100}%`, height: `${(n.y1 - n.y0) * 100}%` };
  };

  return (
    <div className="pf-screen pf-realsize">
      <header className="pf-head">
        <button className="icon-btn pf-touch" onClick={onCancel} aria-label="Back"><IconBack size={22} /></button>
        <h2>Real size</h2>
        <span className="pf-touch" />
      </header>

      <div className="pf-seg wide" role="tablist" aria-label="What to mark">
        <button role="tab" aria-selected={tab === 'brick'} className={tab === 'brick' ? 'active' : ''} onClick={() => setTab('brick')}>1. Mark the 2×2 brick</button>
        <button role="tab" aria-selected={tab === 'object'} className={tab === 'object' ? 'active' : ''} onClick={() => setTab('object')}>2. Fit the object</button>
      </div>
      {prompted && (
        <div className="pf-ref-callout">
          <Brick2x2Art size={40} />
          <span>
            <strong>Mark your 2×2 brick for an exact size</strong>
            <small>Then the model comes out exactly as big as your {mode === 'object' ? 'object' : 'build'}, so a big castle keeps its windows and battlements. No brick in the photo? Skip, and the AI estimates the size from the studs.</small>
          </span>
        </div>
      )}
      <p className="pf-help">
        {tab === 'brick'
          ? 'Drag a box over the top of a real 2×2 brick lying next to your object (not in front of it).'
          : 'Drag the corners so the box just touches the edges of your object.'}
      </p>

      <div className="pf-rs-host" ref={hostRef}>
        <div className={`pf-rs-stage ${tab}`} ref={stageRef} style={{ width: fit.w, height: fit.h }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <img src={shot.dataUrl} alt="Front photo" draggable={false} />
          <div className={`pf-box object ${tab === 'object' ? 'editing' : ''}`} style={pct(object)}>
            <span className="pf-box-label">Object</span>
            {tab === 'object' && ([0, 1] as const).flatMap((cy) => ([0, 1] as const).map((cx) => (
              <button key={`${cx}${cy}`} className={`pf-handle c${cx}${cy}`} onPointerDown={onCornerDown(cx, cy)}
                aria-label={`Move ${cy ? 'bottom' : 'top'} ${cx ? 'right' : 'left'} corner`} />
            )))}
          </div>
          {brick && <div className="pf-box brick" style={pct(brick)}><span className="pf-box-label">2×2</span></div>}
        </div>
      </div>

      <div className="pf-rs-foot">
        {tooSmall && (
          <div className="pf-warn" role="alert"><IconAlert size={18} /> The brick is very small in this photo. Retake it closer for an accurate size.</div>
        )}
        <div className="pf-rs-readout" aria-live="polite">
          {refPx > 0 ? (
            <>1 stud ≈ <strong>{(refPx / 2).toFixed(0)} px</strong> · life size ≈ <strong>{studsWide(est)} studs</strong> wide, <strong>{bricksTall(est)} bricks</strong> tall</>
          ) : (
            mode === 'lego'
              ? <>No brick marked: the AI estimates the size from the studs.</>
              : <>No brick marked: you pick the size before building.</>
          )}
        </div>
        <div className="pf-row">
          {onSkip && !m.brick
            ? <button className="btn pf-big" onClick={onSkip}>Skip</button>
            : <button className="btn pf-big" onClick={() => { setBrick(undefined); setObject(shot.guide); }}>Reset</button>}
          <button className="btn primary pf-big grow" onClick={() => onApply({ brick: m.brick, object: norm(object) })}>Use this size</button>
        </div>
      </div>
    </div>
  );
}
