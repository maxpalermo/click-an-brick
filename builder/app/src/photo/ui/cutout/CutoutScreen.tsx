// "Cut-out" step (after each photo, front and back): the AI finds the object and removes the background.
// The user checks the highlighted selection, taps to fix it (add / remove points → SAM 2), toggles the
// LEGO baseplate, then uses the cut-out (subject on white → 3D AI) or the full photo.
// Server: POST /api/photo/segment (server/src/photo/segment.ts). Maths: mask.ts. Drawing: canvas.ts.
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { segment } from '../../../api/photo';
import { Spinner } from '../../../ui/Overlays';
import type { PhotoApiView, PhotoMode, SegmentPoint } from '../../types';
import { IconAlert } from '../icons';
import type { Shot } from '../image';
import { FlowHeader } from '../screens';
import { composeCutout, decodeMask, drawOverlay, loadImage, photoPixels, type Cutout } from './canvas';
import { area, dropSpecks, findBaseplate, pointsKey, requestPoints, type BaseplateResult, type Mask } from './mask';

/** Per-photo state kept by the flow, so going back and forth never pays for the same mask twice. */
export interface CutoutSession {
  shot: Shot;
  auto: Mask | null;
  /** Masks by request-points key (Undo / Reset are free). */
  masks: Map<string, Mask>;
  taps: SegmentPoint[];
  includeBase: boolean;
  /** Automatic mask request in flight (StrictMode / remount must not pay twice). */
  autoPending?: Promise<Mask>;
}

export function newCutoutSession(shot: Shot): CutoutSession {
  return { shot, auto: null, masks: new Map(), taps: [], includeBase: true };
}

type Tool = 'add' | 'remove';
const LONG_PRESS_MS = 450;

interface Props {
  which: PhotoApiView;
  mode: PhotoMode;
  session: CutoutSession;
  onDone(cut: Cutout | null): void;
  onBack(): void;
  onClose(): void;
}

function errorText(e: unknown): string {
  const status = (e as { status?: unknown } | null)?.status;
  const msg = e instanceof Error ? e.message : '';
  if (status === 503) return "Automatic cut-out isn't available right now. You can use the full photo.";
  if (status === 429) return msg || "You've used today's cut-outs. You can use the full photo.";
  if (status === 0 || e instanceof TypeError) return "You're offline. Check your connection, or use the full photo.";
  if (status === 413) return 'This photo is too big to cut out. Use the full photo.';
  return "Couldn't find the object. Try again, or use the full photo.";
}

export function CutoutScreen({ which, mode, session, onDone, onBack, onClose }: Props) {
  const { shot } = session;
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const [auto, setAuto] = useState<Mask | null>(session.auto);
  const [taps, setTaps] = useState<SegmentPoint[]>(session.taps);
  const [includeBase, setIncludeBase] = useState(session.includeBase);
  const [tool, setTool] = useState<Tool>('add');
  /** Last mask shown for the taps (kept on screen while the next one loads). */
  const [refined, setRefined] = useState<Mask | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [tapBusy, setTapBusy] = useState(false);
  const busy = autoBusy || tapBusy;
  const [autoError, setAutoError] = useState<string | null>(null);
  const [tapError, setTapError] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [pixels, setPixels] = useState<Uint8ClampedArray | null>(null);
  const [announce, setAnnounce] = useState('');
  /** Latest tap request; older responses are cached but not shown. */
  const reqId = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const lego = mode === 'lego';

  // Persist edits in the session (survives Back → camera → same photo).
  useEffect(() => { session.taps = taps; }, [session, taps]);
  useEffect(() => { session.includeBase = includeBase; }, [session, includeBase]);

  // Photo pixels for the baseplate heuristic and the final composite.
  useEffect(() => {
    let alive = true;
    loadImage(shot.dataUrl).then((i) => {
      if (!alive) return;
      setImg(i);
      setPixels(photoPixels(i, shot));
    }, () => {});
    return () => { alive = false; };
  }, [shot]);

  // Fit the photo (contain) into the available area.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const k = Math.min(el.clientWidth / shot.width, el.clientHeight / shot.height);
      setFit({ w: Math.floor(shot.width * k), h: Math.floor(shot.height * k) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [shot.width, shot.height]);

  // 1. automatic mask (once per photo)
  const runAuto = async () => {
    setAutoError(null);
    setAutoBusy(true);
    try {
      session.autoPending ??= segment({ image: shot.dataUrl })
        .then((r) => decodeMask(r.mask, shot))
        .then((m) => dropSpecks(m))
        .finally(() => { session.autoPending = undefined; });
      const m = await session.autoPending;
      session.auto = m;
      if (!alive.current) return;
      setAuto(m);
      setAnnounce(area(m) ? 'Object found. Check the highlighted area.' : 'No object found. Tap the object.');
    } catch (e) {
      if (alive.current) setAutoError(errorText(e));
    } finally {
      if (alive.current) setAutoBusy(false);
    }
  };
  useEffect(() => {
    if (!session.auto) void runAuto();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. tap refinement: one SAM call per distinct set of points (cached), latest request wins.
  const reqPoints = useMemo(() => requestPoints(auto, taps), [auto, taps]);
  const key = pointsKey(reqPoints);
  useEffect(() => {
    const id = ++reqId.current;
    if (!taps.length || !reqPoints.length) {
      // No taps (auto mask shows), or only "remove" taps with nothing selected yet (wait for an "add").
      setRefined(null);
      setTapBusy(false);
      return;
    }
    const cached = session.masks.get(key);
    if (cached) {
      setRefined(cached);
      setTapBusy(false);
      return;
    }
    setTapBusy(true);
    setTapError(null);
    segment({ image: shot.dataUrl, points: reqPoints })
      .then((r) => decodeMask(r.mask, shot))
      .then((m) => {
        const clean = dropSpecks(m);
        session.masks.set(key, clean);
        if (id === reqId.current) {
          setRefined(clean);
          setAnnounce('Selection updated.');
        }
      })
      .catch((e) => {
        if (id !== reqId.current) return;
        setTapError(errorText(e));
        setTaps((t) => t.slice(0, -1)); // drop the tap that failed
      })
      .finally(() => {
        if (id === reqId.current) setTapBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, taps.length]);

  const base: Mask | null = taps.length ? (refined ?? auto) : auto;
  const plate: BaseplateResult | null = useMemo(
    () => (lego && !includeBase && base && pixels ? findBaseplate(base, pixels) : null),
    [lego, includeBase, base, pixels],
  );
  const shown: Mask | null = plate ? plate.mask : base;
  const empty = !shown || area(shown) === 0;

  useEffect(() => {
    if (overlayRef.current && shown) drawOverlay(overlayRef.current, shown, plate?.plate);
  }, [shown, plate]);

  // ---- gestures: tap = current tool, long-press = remove
  const press = useRef<{ x: number; y: number; t: number; timer: number; fired: boolean } | null>(null);
  const toFrac = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)) };
  };
  const addTap = (x: number, y: number, label: 0 | 1) => {
    if (autoError && !auto && label === 0) return;
    setTapError(null);
    setTaps((t) => [...t, { x, y, label }].slice(-20));
  };
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { clientX, clientY } = e;
    const timer = window.setTimeout(() => {
      const p = press.current;
      if (!p) return;
      p.fired = true;
      navigator.vibrate?.(12);
      const f = toFrac(p.x, p.y);
      addTap(f.x, f.y, 0);
    }, LONG_PRESS_MS);
    press.current = { x: clientX, y: clientY, t: Date.now(), timer, fired: false };
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) {
      window.clearTimeout(p.timer);
      press.current = null;
    }
  };
  const onUp = () => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    window.clearTimeout(p.timer);
    if (p.fired) return;
    const f = toFrac(p.x, p.y);
    addTap(f.x, f.y, tool === 'add' ? 1 : 0);
  };
  const onCancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => () => { if (press.current) window.clearTimeout(press.current.timer); }, []);

  const useCutout = () => {
    if (!img || !shown || empty) return;
    onDone(composeCutout(img, shot, shown, !!plate));
  };

  const loadingAuto = !auto && !autoError;
  const waitingForAdd = taps.length > 0 && !reqPoints.length;

  return (
    <div className="pf-screen pf-cutout">
      <FlowHeader title={`Cut out: ${which}`} onBack={onBack} onClose={onClose} />
      <p className="pf-help pf-cut-help" id="pf-cut-help">
        {autoError && !auto && !refined
          ? 'Tap the object to select it, or use the full photo.'
          : <>The highlighted part is sent to the 3D AI. <strong>Wrong?</strong> Tap the object to fix the selection.</>}
      </p>

      <div className="pf-rs-host" ref={hostRef}>
        <div
          className={`pf-rs-stage pf-cut-stage ${tool}`}
          ref={stageRef}
          style={{ width: fit.w, height: fit.h }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
          onContextMenu={(e) => e.preventDefault()}
          aria-describedby="pf-cut-help"
          aria-label={`${which[0].toUpperCase()}${which.slice(1)} photo. Tap to ${tool === 'add' ? 'add to' : 'remove from'} the selection.`}
          role="img"
        >
          <img src={shot.dataUrl} alt="" draggable={false} />
          <canvas ref={overlayRef} className={`pf-cut-overlay ${shown ? '' : 'hidden'}`} aria-hidden="true" />
          {taps.map((t, i) => (
            <span key={i} className={`pf-cut-pt ${t.label ? 'add' : 'remove'}`} style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }} aria-hidden="true">
              {t.label ? '+' : '−'}
            </span>
          ))}
          {busy && (
            <div className="pf-cut-busy" role="status">
              <Spinner size={18} /> {loadingAuto ? 'Finding the object…' : 'Updating…'}
            </div>
          )}
        </div>
      </div>

      <div className="pf-rs-foot">
        {autoError && !auto && !refined && (
          <div className="pf-warn" role="alert">
            <IconAlert size={18} />
            <span className="grow">{autoError}</span>
            <button className="btn pf-cut-retry" onClick={() => void runAuto()}>Try again</button>
          </div>
        )}
        {tapError && <div className="pf-warn" role="alert"><IconAlert size={18} /> {tapError}</div>}
        {waitingForAdd && <div className="pf-help center">Now tap the object with “Add” to select it.</div>}

        <div className="pf-cut-tools">
          <div className="pf-seg wide pf-cut-seg" role="radiogroup" aria-label="Tap to">
            <button role="radio" aria-checked={tool === 'add'} className={tool === 'add' ? 'active' : ''} onClick={() => setTool('add')}>+ Add</button>
            <button role="radio" aria-checked={tool === 'remove'} className={tool === 'remove' ? 'active' : ''} onClick={() => setTool('remove')}>− Remove</button>
          </div>
          <button className="btn pf-cut-btn" onClick={() => setTaps((t) => t.slice(0, -1))} disabled={!taps.length}>Undo</button>
          <button className="btn pf-cut-btn" onClick={() => { setTaps([]); setTapError(null); }} disabled={!taps.length}>Reset</button>
        </div>
        <p className="pf-help center pf-cut-tip">Tip: press and hold to remove a bit.</p>

        {lego && (
          <label className="pf-switch-row pf-cut-switch">
            <span>
              <strong>Include baseplate</strong>
              <small>
                {includeBase
                  ? 'The plate under your build is part of the model.'
                  : plate
                    ? 'The plate (red) is left out: only the build on top is made.'
                    : base ? 'No plate found. Tap it with “Remove” to leave it out.' : 'Leave the plate under your build out of the model.'}
              </small>
            </span>
            <input type="checkbox" className="pf-switch" checked={includeBase} onChange={(e) => setIncludeBase(e.target.checked)} />
          </label>
        )}

        <div className="pf-row">
          <button className="btn pf-big" onClick={() => onDone(null)}>Use full photo</button>
          <button className="btn primary pf-big grow" onClick={useCutout} disabled={!img || empty || busy}>
            Use cut-out
          </button>
        </div>
        <p className="pf-privacy center">To find the object, the photo is sent to fal.ai (USA). It isn't kept.</p>
        <span className="sr-only" aria-live="polite">{announce}</span>
      </div>
    </div>
  );
}
