// Result screen (U5 + U6): preview, brick/colour counts, Detail / size / Hollow tweaks that re-run ONLY the
// converter on the cached GLB, parts list with thumbnails, and "Open in editor".
import { useEffect, useMemo, useRef, useState } from 'react';
import { newId } from '../../model/id';
import { useEditor } from '../../model/store';
import { saveCurrent } from '../../ui/archive';
import type { BrickColor } from '../../model/types';
import { useColors, useEngine } from '../../ui/context';
import { partIndex, useCatalog } from '../../ui/hooks';
import { Spinner } from '../../ui/Overlays';
import { Swatch, colorByCode } from '../../ui/Palette';
import { Thumb } from '../../ui/Thumb';
import { toast } from '../../ui/toast';
import type { ConvertOptions, ConvertResult, DetailLevel, PhotoConverter, PhotoMode } from '../types';
import { DETAIL_SCALE } from '../convert/simplify';
import type { FeatureKind, PhotoAnalysis } from '../convert/contracts';
import { IconAlert, IconTurn } from './icons';
import { brickBox, modelExtent, partLabel } from './parts';
import { MAX_STUDS, MIN_STUDS, clampStuds } from './scale';
import { PHONE_WARN_STUDS, SIZE_SOURCE_LABEL, studsScale, type SizeSource } from './size';
import { friendly, type FlowError } from './service';
import { clearResume, reloadAndResume } from './resume';
import type { BuildOutput } from './screens';
import { FlowHeader } from './screens';

interface Props {
  output: BuildOutput;
  mode: PhotoMode;
  converter: PhotoConverter;
  hollow: boolean;
  setHollow(h: boolean): void;
  onRetake(): void;
  onDone(): void;
  onClose(): void;
}

const DETAILS: Array<{ id: DetailLevel; label: string; help: string }> = [
  { id: 'simple', label: 'Simple', help: 'Smooth shape, few colours, big bricks. Quick and cheap to build.' },
  { id: 'balanced', label: 'Balanced', help: 'Clean shape and colours, details that still read at this size.' },
  { id: 'detailed', label: 'Detailed', help: 'Closest to the photo. More colours and more small parts.' },
];

const FEATURE_LABEL: Partial<Record<FeatureKind, [string, string]>> = {
  windscreen: ['windscreen', 'windscreens'], window: ['window', 'windows'], headlight: ['headlight', 'headlights'],
  taillight: ['taillight', 'taillights'], grille: ['grille', 'grilles'], bumper: ['bumper', 'bumpers'], door: ['door', 'doors'],
  roof: ['roof', 'roofs'], eye: ['eye', 'eyes'], mouth: ['mouth', 'mouths'], ear: ['ear', 'ears'], leg: ['leg', 'legs'],
  arm: ['arm', 'arms'], handle: ['handle', 'handles'], spout: ['spout', 'spouts'], 'text-or-logo': ['logo', 'logos'],
};

/** "Recognised: car · 4 wheels · windscreen · headlights" from the vision analysis (null when there is none). */
function recognisedLine(a: PhotoAnalysis | undefined): string | null {
  if (!a) return null;
  const front = a.features.filter((f) => f.view === 'front' && f.confidence >= 0.4);
  const parts: string[] = [];
  if (a.category && a.category !== 'other') parts.push(a.category);
  else if (a.isBrickBuilt) parts.push('LEGO model');
  const wheels = front.filter((f) => f.kind === 'wheel');
  if (wheels.length) {
    // A 3/4 photo shows one side (plus maybe a far wheel); mirrored wheels have a hidden twin.
    const n = wheels.some((w) => w.mirrored) ? Math.max(wheels.length, 2 * Math.ceil(wheels.length / 2)) : wheels.length;
    parts.push(`${n} wheel${n === 1 ? '' : 's'}`);
  }
  const seen = new Set<FeatureKind>();
  for (const f of front) {
    const label = FEATURE_LABEL[f.kind];
    if (!label || seen.has(f.kind)) continue;
    seen.add(f.kind);
    const many = f.mirrored || front.filter((g) => g.kind === f.kind).length > 1;
    parts.push(label[many ? 1 : 0]);
  }
  if (!parts.length) return null;
  return `Recognised: ${parts.slice(0, 5).join(' · ')}`;
}

const longestStuds = (r: ConvertResult) => {
  const e = modelExtent(r.bricks);
  return Math.max(e.w, e.d, Math.round(e.hLdu / 20));
};

export function Result({ output, mode, converter, hollow, setHollow, onRetake, onDone, onClose }: Props) {
  const engine = useEngine();
  const colors = useColors();
  const [result, setResult] = useState(output.result);
  const initialStuds = useMemo(() => clampStuds(longestStuds(output.result)), [output.result]);
  const [studs, setStuds] = useState(initialStuds);
  /** Until the user touches the size, keep the exact measured scale (lduPerUnit). */
  const [sizeTouched, setSizeTouched] = useState(false);
  const [detail, setDetail] = useState<DetailLevel>('balanced');
  /** Part count before the last re-run, to show what a tweak changed. */
  const [delta, setDelta] = useState<{ from: number; to: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FlowError | null>(null);
  /** Preview camera yaw in degrees (multiples of 15: turn button = next side, drag = 15° steps). */
  const [yaw, setYaw] = useState(0);
  const [showParts, setShowParts] = useState(false);
  const runId = useRef(0);
  const shown = useRef(result);
  shown.current = result;
  const first = useRef(true);

  // Re-run the converter (debounced) when hollow or size change. GLB comes from memory (also cached in IDB).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = ++runId.current;
    const t = window.setTimeout(async () => {
      converter.cancel();
      setBusy(true);
      setError(null);
      // Object mode, size untouched: the level also scales the measured size (the main approximation knob, see
      // research/photo2brick/approx/report.md). LEGO mode keeps the real size.
      let k = mode === 'object' ? DETAIL_SCALE[detail] : 1;
      if (k !== 1) k = Math.min(k, MAX_STUDS / Math.max(1, initialStuds));
      const base = output.scale.options;
      const analysis = output.analysis;
      const options: ConvertOptions = sizeTouched
        ? { ...studsScale(studs, output.bounds).options, mode, hollow, detail, analysis }
        : base.lduPerUnit !== undefined
          ? { lduPerUnit: base.lduPerUnit * k, mode, hollow, detail, analysis }
          : base.sizeStuds === undefined && mode === 'lego'
            // Real size from the vision stud count (scale.ts preferBrickSize): let the converter keep it.
            ? { mode, hollow, detail, analysis }
            : { ...studsScale((base.sizeStuds ?? initialStuds) * k, output.bounds).options, mode, hollow, detail, analysis };
      try {
        const r = await converter.convert(output.glb.slice(0), options);
        if (id !== runId.current) return;
        if (!r.bricks.length) throw new Error('The model came out empty at this size. Try a bigger size.');
        const before = shown.current.stats.parts;
        setDelta(before !== r.stats.parts ? { from: before, to: r.stats.parts } : null);
        setResult(r);
      } catch (e) {
        if (id === runId.current) setError(friendly(e, 'convert'));
      } finally {
        if (id === runId.current) setBusy(false);
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [studs, hollow, detail, sizeTouched, converter, mode, output, initialStuds]);

  const recognised = useMemo(() => recognisedLine(output.analysis), [output.analysis]);
  const ext = useMemo(() => modelExtent(result.bricks), [result]);
  const bricksTall = Math.round(ext.hLdu / 24);
  /** Size shown on the slider: the user's choice, or the size of the current result until they touch it. */
  const shownStuds = sizeTouched ? studs : clampStuds(longestStuds(result));
  /** Where the current size came from: the Confirm screen's choice / brick / AI until the slider is touched. */
  const source: SizeSource | undefined = sizeTouched ? 'choice' : output.sizeSource;
  const changeStuds = (n: number) => {
    setSizeTouched(true);
    setStuds(clampStuds(n));
  };

  const open = () => {
    const bricks = result.bricks.map((b) => ({ ...b, id: newId() }));
    // A new build (one undo step), added to My builds right away as a photo build.
    useEditor.getState().switchBuild({ name: 'Photo build', bricks }, { buildSource: 'photo', photoJobId: output.jobId });
    void saveCurrent({ quiet: true });
    clearResume();
    useEditor.getState().setViewMode('3d');
    onDone();
    window.setTimeout(() => engine.zoomToFit(), 80);
    toast(`Loaded ${bricks.length.toLocaleString()} bricks. Undo to go back.`, 'success', 4200);
  };

  return (
    <div className="pf-screen">
      <FlowHeader title="Your photo build" onBack={onRetake} onClose={onClose} />
      <div className="pf-body">
        <div className="pf-preview">
          <ModelPreview result={result} colors={colors} yaw={yaw} setYaw={setYaw} />
          <button className="pf-round light pf-turn" onClick={() => setYaw((y) => ((Math.floor(normYaw(y) / 90) + 1) * 90) % 360)}
            aria-label="Turn the preview">
            <IconTurn size={20} />
          </button>
          <span className="pf-view-label">{SIDES[sideOf(yaw)]}</span>
          {busy && <div className="pf-preview-busy"><Spinner size={26} /><span>Rebuilding…</span></div>}
        </div>

        <div className="pf-stats">
          <div>
            <strong>{result.stats.parts.toLocaleString()}</strong>
            <small>parts</small>
            {delta && !busy && (
              <small className={`pf-delta ${delta.to < delta.from ? 'down' : 'up'}`} aria-live="polite">
                {delta.to < delta.from ? '−' : '+'}{Math.abs(delta.to - delta.from).toLocaleString()} ({delta.to < delta.from ? '−' : '+'}{Math.round((Math.abs(delta.to - delta.from) / Math.max(1, delta.from)) * 100)}%)
              </small>
            )}
          </div>
          <div><strong>{result.stats.colours}</strong><small>colours</small></div>
          <div><strong>{ext.w}×{ext.d}</strong><small>studs</small></div>
          <div><strong>{bricksTall}</strong><small>bricks tall</small></div>
        </div>

        {recognised && <p className="pf-help pf-recognised">{recognised}</p>}

        {output.fallback && !error && <div className="pf-warn" role="status"><IconAlert size={18} /> {output.fallback}</div>}
        {error && <div className="pf-warn" role="alert"><IconAlert size={18} /> <span>{error.title}. {error.detail}{error.retry === 'reload' && <> <button className="pf-inline-link" onClick={reloadAndResume}>Reload and continue</button></>}</span></div>}

        <div className="pf-tweaks">
          <div className="pf-detail-row">
            <span className="pf-size-label">Detail</span>
            <div className="pf-seg wide" role="radiogroup" aria-label="Level of detail">
              {DETAILS.map((d) => (
                <button key={d.id} role="radio" aria-checked={detail === d.id} className={detail === d.id ? 'active' : ''}
                  onClick={() => setDetail(d.id)}>{d.label}</button>
              ))}
            </div>
          </div>
          <p className="pf-help">{DETAILS.find((d) => d.id === detail)!.help}</p>
          <div className="pf-size-row light">
            <span className="pf-size-label">Size</span>
            <button className="pf-step" onClick={() => changeStuds(shownStuds - 2)} aria-label="Smaller">−</button>
            <input type="range" className="pf-range" min={MIN_STUDS} max={MAX_STUDS} step={1} value={shownStuds}
              onChange={(e) => changeStuds(Number(e.target.value))} aria-label="Longest side in studs" aria-valuetext={`${shownStuds} studs`} />
            <button className="pf-step" onClick={() => changeStuds(shownStuds + 2)} aria-label="Bigger">+</button>
            <span className="pf-size-readout"><strong>{shownStuds}</strong> studs<br /><small>longest side</small></span>
          </div>
          {source && (
            <p className={`pf-size-source ${source}`} aria-live="polite">
              Size: <strong>{SIZE_SOURCE_LABEL[source]}</strong>
              {source === 'ai' && <> · drag to change</>}
            </p>
          )}
          {shownStuds > PHONE_WARN_STUDS && sizeTouched && <p className="pf-help">Big sizes can take a while to build on a phone.</p>}
          <label className="pf-switch-row">
            <span>
              <strong>Hollow inside</strong>
              <small>Only a shell of bricks. Fewer bricks inside, but more small parts.</small>
            </span>
            <input type="checkbox" role="switch" className="pf-switch" checked={hollow} onChange={(e) => setHollow(e.target.checked)} />
          </label>
          {mode === 'lego' && <p className="pf-help">Rebuilt with basic bricks and plates on the real stud grid. Slopes and special parts become steps.</p>}
          {output.scale.capped && !sizeTouched && <p className="pf-help">Capped at {MAX_STUDS} studs so it stays buildable.</p>}
          {!output.scale.capped && !sizeTouched && result.stats.cappedFrom !== undefined && (
            <p className="pf-help">At its real size this would be about {result.stats.cappedFrom} studs long, so it was shrunk to fit.</p>
          )}
        </div>

        <div className="pf-parts">
          <button className="pf-parts-toggle" onClick={() => setShowParts((s) => !s)} aria-expanded={showParts}>
            <span>Parts list</span>
            <span className="muted">{result.bom.length} lines · {result.stats.parts.toLocaleString()} parts {showParts ? '▲' : '▼'}</span>
          </button>
          {showParts && <PartsList result={result} colors={colors} />}
        </div>
      </div>
      <div className="pf-foot">
        <button className="btn primary pf-big pf-cta" onClick={open} disabled={busy}>Open in editor</button>
      </div>
    </div>
  );
}

function PartsList({ result, colors }: { result: ConvertResult; colors: BrickColor[] }) {
  const { parts } = useCatalog();
  const idx = partIndex(parts);
  const lines = useMemo(() => [...result.bom].sort((a, b) => b.count - a.count), [result.bom]);
  return (
    <ul className="parts-list pf-bom">
      {lines.map((l) => {
        const c = colorByCode(colors, l.color);
        return (
          <li key={`${l.part}|${l.color}`}>
            <Thumb part={l.part} color={l.color} size={88} className="small" />
            <span className="pl-text">
              <span className="pl-name">{idx.get(l.part.toLowerCase())?.name ?? partLabel(l.part)}</span>
              <span className="pl-color">{c && <Swatch color={c} size={12} />} {c?.name ?? `Colour ${l.color}`}</span>
            </span>
            <span className="pl-count">×{l.count}</span>
          </li>
        );
      })}
    </ul>
  );
}

const SIDES = ['Front', 'Right side', 'Back', 'Left side'];
const normYaw = (y: number) => ((y % 360) + 360) % 360;
const sideOf = (y: number) => Math.round(normYaw(y) / 90) % 4;
/** Horizontal drag distance (px) per 15° preview step. */
const DRAG_STEP_PX = 22;
const CARDINALS = [0, 90, 180, 270];

/**
 * 3D preview with real part geometry (slopes, curves, wheels, trans glass) from `engine.renderModel`,
 * cached per result / yaw / size. One render at a time: the newest wanted view wins, then the four sides
 * are pre-rendered so turning is instant. Falls back to the 2D footprint preview when renderModel is
 * missing or fails.
 */
function ModelPreview({ result, colors, yaw, setYaw }: {
  result: ConvertResult; colors: BrickColor[]; yaw: number; setYaw(f: (y: number) => number): void;
}) {
  const engine = useEngine();
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(!engine.renderModel);
  const caches = useRef(new WeakMap<ConvertResult, Map<string, string>>());
  const wanted = useRef<{ result: ConvertResult; yaw: number; w: number; h: number } | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  const drag = useRef<{ x: number; yaw: number; id: number } | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Render size in device pixels (rounded so small layout jitters don't re-render).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round((el.clientWidth * dpr) / 16) * 16, h = Math.round((el.clientHeight * dpr) / 16) * 16;
      if (w > 0 && h > 0) setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [failed]);

  useEffect(() => {
    if (failed || !size || !engine.renderModel) return;
    const want = { result, yaw: normYaw(yaw), w: size.w, h: size.h };
    wanted.current = want;
    const cacheOf = (r: ConvertResult) => {
      let c = caches.current.get(r);
      if (!c) caches.current.set(r, (c = new Map()));
      return c;
    };
    const keyOf = (y: number, w: { w: number; h: number }) => `${y}|${w.w}x${w.h}`;
    const hit = cacheOf(result).get(keyOf(want.yaw, want));
    if (hit) {
      setImg(hit);
      setLoading(false);
    }
    if (running.current) return; // the loop below picks up the new wanted view
    running.current = true;
    (async () => {
      try {
        for (;;) {
          if (!alive.current) return;
          const w = wanted.current!;
          const cache = cacheOf(w.result);
          // next job: the wanted view, else an un-rendered side of the same result
          const yawToDo = !cache.has(keyOf(w.yaw, w)) ? w.yaw : CARDINALS.find((y) => !cache.has(keyOf(y, w)));
          if (yawToDo === undefined) return;
          if (yawToDo === w.yaw) setLoading(true);
          const url = await engine.renderModel!(w.result.bricks, { width: w.w, height: w.h, yawDeg: yawToDo });
          cache.set(keyOf(yawToDo, w), url);
          const now = wanted.current!;
          const shown = cacheOf(now.result).get(keyOf(now.yaw, now));
          if (alive.current && shown) {
            setImg(shown);
            setLoading(false);
          }
        }
      } catch (e) {
        console.warn('[photo] 3D preview failed, using the 2D preview', e);
        if (alive.current) setFailed(true);
      } finally {
        running.current = false;
        if (alive.current) setLoading(false);
      }
    })();
  }, [result, yaw, size, failed, engine]);

  if (failed) return <BrickPreview result={result} colors={colors} view={sideOf(yaw)} />;

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { x: e.clientX, yaw, id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const steps = Math.round((e.clientX - d.x) / DRAG_STEP_PX);
    if (steps !== 0 && !e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
    // drag right = turn the model right = camera goes left
    setYaw(() => normYaw(d.yaw - steps * 15));
  };
  const onUp = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  return (
    <div ref={wrap} className="pf-preview-3d" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      role="img" aria-label={`3D preview of the brick model, ${result.stats.parts} parts, ${SIDES[sideOf(yaw)]}. Drag sideways to turn.`}>
      {img && <img className={`pf-preview-img${loading ? ' stale' : ''}`} src={img} alt="" draggable={false} />}
      {loading && <div className="pf-preview-rendering"><Spinner size={22} />{!img && <span>Drawing preview…</span>}</div>}
    </div>
  );
}

/** Orthographic side view of the result, painter-sorted, with stud bumps. Fallback when the 3D render is unavailable. */
function BrickPreview({ result, colors, view }: { result: ConvertResult; colors: BrickColor[]; view: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // per view: screen u + depth d (bigger d = further away, drawn first)
      const items = result.bricks.map((b) => {
        const r = brickBox(b);
        const [u0, u1, d] =
          view === 0 ? [r.x0, r.x1, (r.z0 + r.z1) / 2]
            : view === 1 ? [r.z0, r.z1, -(r.x0 + r.x1) / 2]
              : view === 2 ? [-r.x1, -r.x0, -(r.z0 + r.z1) / 2]
                : [-r.z1, -r.z0, (r.x0 + r.x1) / 2];
        return { u0, u1, d, y0: r.y0, y1: r.y1, color: b.color };
      });
      if (!items.length) return;
      let umin = Infinity, umax = -Infinity, ymin = Infinity, ymax = -Infinity, dmin = Infinity, dmax = -Infinity;
      for (const it of items) {
        umin = Math.min(umin, it.u0); umax = Math.max(umax, it.u1);
        ymin = Math.min(ymin, it.y0 - 4); ymax = Math.max(ymax, it.y1);
        dmin = Math.min(dmin, it.d); dmax = Math.max(dmax, it.d);
      }
      items.sort((a, b) => b.d - a.d || b.y0 - a.y0);
      const pad = 16;
      const k = Math.min((W - 2 * pad) / (umax - umin), (H - 2 * pad) / (ymax - ymin));
      const ox = (W - (umax - umin) * k) / 2 - umin * k;
      const oy = (H - (ymax - ymin) * k) / 2 - ymin * k;
      const hex = new Map<number, string>();
      const colOf = (code: number) => {
        let h = hex.get(code);
        if (!h) {
          h = colorByCode(colors, code)?.hex ?? '#A0A5A9';
          hex.set(code, h);
        }
        return h;
      };
      const span = Math.max(1, dmax - dmin);
      for (const it of items) {
        const x = ox + it.u0 * k, w = (it.u1 - it.u0) * k;
        const y = oy + it.y0 * k, h = (it.y1 - it.y0) * k;
        ctx.fillStyle = colOf(it.color);
        ctx.fillRect(x, y, w, h);
        // studs on top (covered by any brick drawn above later)
        if (k * 12 >= 3) {
          const n = Math.round((it.u1 - it.u0) / 20);
          for (let i = 0; i < n; i++) ctx.fillRect(x + (i * 20 + 4) * k, y - 4 * k, 12 * k, 4 * k);
        }
        // depth shading: further = darker
        const fog = ((it.d - dmin) / span) * 0.35;
        if (fog > 0.01) {
          ctx.fillStyle = `rgba(0,0,0,${fog.toFixed(3)})`;
          ctx.fillRect(x, y - 4 * k, w, h + 4 * k);
        }
        if (w > 3) {
          ctx.strokeStyle = 'rgba(0,0,0,0.28)';
          ctx.lineWidth = 0.75;
          ctx.strokeRect(x + 0.375, y + 0.375, w - 0.75, h - 0.75);
        }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [result, colors, view]);
  return <canvas ref={ref} className="pf-preview-canvas" role="img" aria-label={`Preview of the brick model, ${result.stats.parts} parts`} />;
}
