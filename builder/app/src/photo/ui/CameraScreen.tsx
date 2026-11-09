// Camera screen (U1 + U2): live rear-camera preview with the brick-grid overlay (UX A), a pixelated
// LEGO-colour mosaic preview, pinch/slider detail, 1x1/2x2 cells, file-input fallback, and the
// front→back flow with a mirrored ghost of the front photo. Quality builds walk round the object (front, right, back,
// left, top) with a top-down orbit diagram and the front photo as an unmirrored ghost on the sides.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { IconClose } from '../../ui/Icons';
import { Spinner } from '../../ui/Overlays';
import { IconBack, IconGallery, IconGhost, IconGrid, IconLock, IconPhoto } from './icons';
import { encodeJpeg, fileToCanvas, type Shot } from './image';
import { shade, type LiveMatcher } from './legoColors';
import { CAMERA_MAX_STUDS, MIN_STUDS } from './scale';
import type { PhotoApiView } from '../types';

export interface Sizing {
  /** Studs across the framing guide. */
  studs: number;
  /** Each grid cell is a 2x2 (else 1x1). */
  big: boolean;
}

type CamState = 'starting' | 'live' | 'denied' | 'unavailable' | 'error' | 'still';

interface Props {
  which: PhotoApiView;
  /** Quality build: 5 steps round the object (QUALITY_STEPS) with the orbit diagram. */
  quality?: boolean;
  sizing: Sizing;
  setSizing(s: Sizing): void;
  matcher: LiveMatcher;
  /** Front photo as a framing ghost (mirrored for the back) so the user keeps the same distance and height. */
  ghost?: string;
  /** Overrides the default framing hint (LEGO mode asks for a reference brick). */
  hint?: ReactNode;
  onShot(s: Shot): void;
  onSkip?(): void;
  onBack(): void;
  onClose(): void;
}

interface Layout {
  /** Source drawn into the view: scale + offset. */
  s: number;
  ox: number;
  oy: number;
  /** Visible part of the source, in view px. */
  vis: { x: number; y: number; w: number; h: number };
  guide: { x: number; y: number; w: number; h: number };
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  gx: number;
  gy: number;
}

const SAMPLE = 3; // sub-samples per cell side for averaging

/** Title and default hint of each camera step; quick builds: front, back, side (3 steps). */
const QUICK_TITLE: Partial<Record<PhotoApiView, string>> = { front: 'Front photo', back: 'Back photo', side: 'Side photo' };
const QUICK_STEPS: PhotoApiView[] = ['front', 'back', 'side'];
/** Quality builds: walk round the object (right / left = its right / left as you face its front), then from above. */
export const QUALITY_STEPS: PhotoApiView[] = ['front', 'right', 'back', 'left', 'top'];
const QUALITY_HINT: Partial<Record<PhotoApiView, { title: string; hint: string; sub: string }>> = {
  front: { title: 'Front photo', hint: 'Shoot it from the front', sub: 'Fit the whole object inside the frame' },
  right: { title: 'Right side', hint: 'Now walk round to its right', sub: 'A quarter turn. Same distance and height as the front' },
  back: { title: 'Back photo', hint: 'Keep going round to the back', sub: 'Line it up with the outline of the front' },
  left: { title: 'Left side', hint: 'Last side: its left', sub: 'One more quarter turn, same distance and height' },
  top: { title: 'Top photo', hint: 'From above (optional)', sub: 'Phone over the middle, looking down. Helps the AI read roofs and the layout' },
};

export function CameraScreen({ which, quality, sizing, setSizing, matcher, ghost, hint, onShot, onSkip, onBack, onClose }: Props) {
  const viewRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stillRef = useRef<HTMLCanvasElement | null>(null);
  const takeInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const [cam, setCam] = useState<CamState>('starting');
  const [stillUrl, setStillUrl] = useState<string | null>(null);
  const [showBricks, setShowBricks] = useState(false);
  const [showGhost, setShowGhost] = useState(true);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readout, setReadout] = useState<{ w: number; h: number } | null>(null);
  const [ghostBox, setGhostBox] = useState<Layout['vis'] | null>(null);
  const sizingRef = useRef(sizing);
  sizingRef.current = sizing;
  const showBricksRef = useRef(showBricks);
  showBricksRef.current = showBricks;

  // ---------- camera lifecycle ----------
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async () => {
    stopCamera();
    setCam('starting');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCam('unavailable');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1920 } },
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      setCam('live');
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') setCam('denied');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') setCam('unavailable');
      else setCam('error');
    }
  }, [stopCamera]);

  useEffect(() => {
    void startCamera();
    return stopCamera;
  }, [startCamera, stopCamera]);

  // Pause the camera while the tab is hidden (battery), resume on return.
  useEffect(() => {
    const on = () => {
      if (document.hidden) stopCamera();
      else if (!stillRef.current) void startCamera();
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [startCamera, stopCamera]);

  // ---------- layout + live grid ----------
  const computeLayout = useCallback((): Layout | null => {
    const view = viewRef.current;
    if (!view) return null;
    const vw = view.clientWidth, vh = view.clientHeight;
    const still = stillRef.current;
    const video = videoRef.current;
    const sw = still ? still.width : video?.videoWidth ?? 0;
    const sh = still ? still.height : video?.videoHeight ?? 0;
    if (!vw || !vh || !sw || !sh) return null;
    const s = still ? Math.min(vw / sw, vh / sh) : Math.max(vw / sw, vh / sh); // still: contain, live: cover
    const dw = sw * s, dh = sh * s;
    const ox = (vw - dw) / 2, oy = (vh - dh) / 2;
    const vx = Math.max(0, ox), vy = Math.max(0, oy);
    const vis = { x: vx, y: vy, w: Math.min(vw, ox + dw) - vx, h: Math.min(vh, oy + dh) - vy };
    const m = Math.min(vis.w, vis.h) * 0.07;
    const guide = { x: vis.x + m, y: vis.y + m, w: vis.w - 2 * m, h: vis.h - 2 * m };
    const { studs, big } = sizingRef.current;
    const k = big ? 2 : 1;
    const cols = Math.max(2, Math.round(studs / k));
    const cellW = guide.w / cols;
    const cellH = cellW * 1.2; // a 1x1 brick seen from the front is 20 wide × 24 high
    const rows = Math.max(1, Math.floor(guide.h / cellH));
    const gx = guide.x;
    const gy = guide.y + (guide.h - rows * cellH) / 2;
    return { s, ox, oy, vis, guide, cols, rows, cellW, cellH, gx, gy };
  }, []);

  useEffect(() => {
    const sampleCanvas = document.createElement('canvas');
    const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    let timer = 0;
    let lastKey = '';
    const tick = () => {
      timer = window.setTimeout(tick, 100);
      if (document.hidden) return;
      const L = computeLayout();
      const overlay = overlayRef.current;
      const view = viewRef.current;
      if (!L || !overlay || !view || !sctx) return;
      const src: CanvasImageSource | null = stillRef.current ?? (videoRef.current?.readyState && videoRef.current.readyState >= 2 ? videoRef.current : null);
      if (!src) return;

      // 1. downsample the grid area: GPU scales to cols*S × rows*S, we box-average S×S per cell.
      const W = L.cols * SAMPLE, H = L.rows * SAMPLE;
      if (sampleCanvas.width !== W || sampleCanvas.height !== H) {
        sampleCanvas.width = W;
        sampleCanvas.height = H;
      }
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(src, (L.gx - L.ox) / L.s, (L.gy - L.oy) / L.s, (L.cols * L.cellW) / L.s, (L.rows * L.cellH) / L.s, 0, 0, W, H);
      let data: Uint8ClampedArray;
      try {
        data = sctx.getImageData(0, 0, W, H).data;
      } catch {
        return;
      }
      const cells = new Int16Array(L.cols * L.rows);
      for (let r = 0; r < L.rows; r++)
        for (let c = 0; c < L.cols; c++) {
          let R = 0, G = 0, B = 0;
          for (let y = 0; y < SAMPLE; y++)
            for (let x = 0; x < SAMPLE; x++) {
              const i = ((r * SAMPLE + y) * W + c * SAMPLE + x) * 4;
              R += data[i]; G += data[i + 1]; B += data[i + 2];
            }
          const n = SAMPLE * SAMPLE;
          cells[r * L.cols + c] = matcher.match(R / n, G / n, B / n);
        }

      // 2. overlay
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vw = view.clientWidth, vh = view.clientHeight;
      if (overlay.width !== Math.round(vw * dpr) || overlay.height !== Math.round(vh * dpr)) {
        overlay.width = Math.round(vw * dpr);
        overlay.height = Math.round(vh * dpr);
      }
      const ctx = overlay.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vw, vh);
      // dim outside the guide
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.beginPath();
      ctx.rect(0, 0, vw, vh);
      ctx.rect(L.guide.x, L.guide.y, L.guide.w, L.guide.h);
      ctx.fill('evenodd');
      const big = sizingRef.current.big;
      if (showBricksRef.current) drawMosaic(ctx, L.gx, L.gy, L.cellW, L.cellH, L.cols, L.rows, cells, matcher, big, 0.92);
      else drawGrid(ctx, L);
      drawBrackets(ctx, L.guide);

      // 3. little preview card
      const pv = previewRef.current;
      if (pv) {
        const maxW = 112, maxH = 132;
        const cw = Math.min(maxW, (maxH * L.cols) / (L.rows * 1.2));
        const cellPx = cw / L.cols;
        const pw = Math.round(cellPx * L.cols), ph = Math.round(cellPx * 1.2 * L.rows);
        if (pv.width !== Math.round(pw * dpr) || pv.height !== Math.round(ph * dpr)) {
          pv.width = Math.round(pw * dpr);
          pv.height = Math.round(ph * dpr);
          pv.style.width = `${pw}px`;
          pv.style.height = `${ph}px`;
        }
        const p = pv.getContext('2d');
        if (p) {
          p.setTransform(dpr, 0, 0, dpr, 0, 0);
          p.clearRect(0, 0, pw, ph);
          drawMosaic(p, 0, 0, cellPx, cellPx * 1.2, L.cols, L.rows, cells, matcher, big, 1);
        }
      }

      const k = big ? 2 : 1;
      const key = `${L.cols * k}x${L.rows * k}|${L.vis.x},${L.vis.y},${L.vis.w},${L.vis.h}`;
      if (key !== lastKey) {
        lastKey = key;
        setReadout({ w: L.cols * k, h: L.rows * k });
        setGhostBox({ ...L.vis });
      }
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [computeLayout, matcher]);

  // ---------- pinch to change detail ----------
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const pts = new Map<number, { x: number; y: number }>();
    let start: { d: number; studs: number } | null = null;
    const dist = () => {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const down = (e: PointerEvent) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) start = { d: dist(), studs: sizingRef.current.studs };
    };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && start && start.d > 10) {
        // Spreading fingers = bigger cells = fewer studs (less detail).
        const s = sizingRef.current;
        const step = s.big ? 2 : 1;
        const next = clampSize(Math.round((start.studs * start.d) / dist() / step) * step);
        if (next !== s.studs) setSizing({ ...s, studs: next });
      }
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) start = null;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, [setSizing]);

  // ---------- capture ----------
  const capture = () => {
    const L = computeLayout();
    const src: CanvasImageSource | null = stillRef.current ?? videoRef.current;
    if (!L || !src) return;
    try {
      const sx = (L.vis.x - L.ox) / L.s, sy = (L.vis.y - L.oy) / L.s;
      const sw = L.vis.w / L.s, sh = L.vis.h / L.s;
      const img = encodeJpeg(src, sx, sy, sw, sh);
      const k = sizing.big ? 2 : 1;
      onShot({
        ...img,
        guide: {
          x0: (L.guide.x - L.vis.x) / L.vis.w,
          y0: (L.guide.y - L.vis.y) / L.vis.h,
          x1: (L.guide.x + L.guide.w - L.vis.x) / L.vis.w,
          y1: (L.guide.y + L.guide.h - L.vis.y) / L.vis.h,
        },
        studsW: L.cols * k,
      });
      setFlash(true);
      window.setTimeout(() => setFlash(false), 180);
    } catch {
      setCam('error');
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const c = await fileToCanvas(file);
      stopCamera();
      stillRef.current = c;
      setStillUrl(c.toDataURL('image/jpeg', 0.9));
      setCam('still');
    } catch {
      setCam((s) => (s === 'still' ? s : 'error'));
    } finally {
      setBusy(false);
    }
  };

  const backToCamera = () => {
    stillRef.current = null;
    setStillUrl(null);
    void startCamera();
  };

  const step = sizing.big ? 2 : 1;
  const steps = quality ? QUALITY_STEPS : QUICK_STEPS;
  const stepNo = Math.max(0, steps.indexOf(which)) + 1;
  const optional = quality ? which === 'top' : which !== 'front';
  const q = quality ? QUALITY_HINT[which] : undefined;
  const title = q?.title ?? QUICK_TITLE[which] ?? 'Photo';
  const setStuds = (n: number) => setSizing({ ...sizing, studs: clampSize(Math.round(n / step) * step) });
  const canShoot = cam === 'live' || cam === 'still';
  const blocked = cam === 'denied' || cam === 'unavailable' || cam === 'error';

  return (
    <div className="pf-camera">
      <header className="pf-cam-top">
        <button className="pf-round" onClick={onBack} aria-label="Back"><IconBack size={22} /></button>
        <div className="pf-cam-title">
          <strong>{title}</strong>
          <small>Step {stepNo} of {steps.length}{optional ? ' · optional' : ''}</small>
        </div>
        <button className="pf-round" onClick={onClose} aria-label="Close"><IconClose size={20} /></button>
      </header>

      <div className="pf-viewport" ref={viewRef}>
        <video ref={videoRef} className={`pf-video ${cam === 'live' ? '' : 'hidden'}`} playsInline muted autoPlay />
        {stillUrl && <img className="pf-still" src={stillUrl} alt="Chosen photo" />}
        {ghost && showGhost && ghostBox && canShoot && (
          <img className={`pf-ghost${which === 'back' ? '' : ' plain'}`} src={ghost} alt="" aria-hidden="true"
            style={{ left: ghostBox.x, top: ghostBox.y, width: ghostBox.w, height: ghostBox.h }} />
        )}
        <canvas ref={overlayRef} className={`pf-overlay ${canShoot ? '' : 'hidden'}`} aria-hidden="true" />
        {canShoot && (
          <>
            <div className={`pf-hint-pill${hint || q || which === 'side' ? ' multi' : ''}`}>
              {hint ?? (q ? <span>{q.hint}<small>{q.sub}</small></span> : which === 'front' ? 'Fit the whole object inside the frame'
                : which === 'back' ? 'Walk around and shoot it from behind'
                  : <span>Add a side photo (optional)<small>Helps the AI with hidden sides. Shoot from the left or right.</small></span>)}
            </div>
            <button className="pf-preview-card" onClick={() => setShowBricks((b) => !b)}
              aria-label={showBricks ? 'Show the photo with grid' : 'Show the brick preview over the photo'} aria-pressed={showBricks}>
              <canvas ref={previewRef} />
              <span>{readout ? `${readout.w} × ${readout.h}` : '…'}</span>
            </button>
            {quality && <OrbitCard which={which} />}
          </>
        )}
        {cam === 'starting' && <div className="pf-cam-msg"><Spinner size={28} /><p>Starting the camera…</p></div>}
        {blocked && (
          <div className="pf-cam-msg">
            <div className="pf-cam-msg-icon"><IconLock size={28} /></div>
            <h2>
              {cam === 'denied' ? 'Camera access is blocked' : cam === 'unavailable' ? 'No camera found' : "The camera didn't start"}
            </h2>
            <p>
              {cam === 'denied'
                ? 'To use the live brick grid, allow the camera for this site in your browser settings. Or just take or choose a photo.'
                : 'You can still take a photo with your camera app or choose one from your gallery.'}
            </p>
            <div className="pf-col">
              <button className="btn primary pf-big" onClick={() => takeInput.current?.click()}><IconPhoto size={20} /> Take a photo</button>
              <button className="btn pf-big" onClick={() => galleryInput.current?.click()}><IconGallery size={20} /> Choose from gallery</button>
              {cam !== 'unavailable' && <button className="link-btn pf-link" onClick={() => void startCamera()}>Try the camera again</button>}
            </div>
          </div>
        )}
        {busy && <div className="pf-cam-msg"><Spinner size={28} /><p>Opening photo…</p></div>}
        {flash && <div className="pf-flash" />}
      </div>

      <div className="pf-cam-controls">
        <div className="pf-size-row">
          <span className="pf-size-label">Size</span>
          <button className="pf-step" onClick={() => setStuds(sizing.studs - step)} aria-label="Smaller (fewer studs)">−</button>
          <input type="range" className="pf-range" min={MIN_STUDS} max={CAMERA_MAX_STUDS} step={step} value={sizing.studs}
            onChange={(e) => setStuds(Number(e.target.value))} aria-label="Studs across the frame"
            aria-valuetext={`${sizing.studs} studs wide`} />
          <button className="pf-step" onClick={() => setStuds(sizing.studs + step)} aria-label="Bigger (more studs)">+</button>
          <span className="pf-size-readout"><strong>{readout?.w ?? sizing.studs}</strong> studs<br /><small>{readout ? `${readout.h} bricks tall` : ''}</small></span>
        </div>
        <div className="pf-toggle-row">
          <div className="pf-seg" role="radiogroup" aria-label="Grid cell size">
            <button role="radio" aria-checked={!sizing.big} className={!sizing.big ? 'active' : ''}
              onClick={() => setSizing({ ...sizing, big: false })}>1×1</button>
            <button role="radio" aria-checked={sizing.big} className={sizing.big ? 'active' : ''}
              onClick={() => setSizing({ studs: clampSize(Math.round(sizing.studs / 2) * 2), big: true })}>2×2</button>
          </div>
          <button className={`pf-chip ${showBricks ? 'on' : ''}`} onClick={() => setShowBricks((b) => !b)} aria-pressed={showBricks}>
            <IconGrid size={18} /> {showBricks ? 'Bricks' : 'Grid'}
          </button>
          {ghost && (
            <button className={`pf-chip ${showGhost ? 'on' : ''}`} onClick={() => setShowGhost((g) => !g)} aria-pressed={showGhost}>
              <IconGhost size={18} /> Outline
            </button>
          )}
        </div>
        <div className="pf-shutter-row">
          <button className="pf-side-btn" onClick={() => galleryInput.current?.click()} aria-label="Choose from gallery">
            <IconGallery size={24} /><span>Gallery</span>
          </button>
          {cam === 'still' ? (
            <button className="pf-use-btn" onClick={capture}>Use photo</button>
          ) : (
            <button className="pf-shutter" onClick={capture} disabled={!canShoot} aria-label={`Take the ${which} photo`}><span /></button>
          )}
          {cam === 'still' ? (
            <button className="pf-side-btn" onClick={backToCamera} aria-label="Back to the camera"><IconPhoto size={24} /><span>Camera</span></button>
          ) : onSkip ? (
            <button className="pf-side-btn" onClick={onSkip} aria-label={`Skip the ${which} photo`}><span className="pf-skip">Skip</span><span>{which === 'side' ? 'No side' : which === 'top' ? 'No top' : 'No back'}</span></button>
          ) : (
            <span className="pf-side-btn placeholder" aria-hidden="true" />
          )}
        </div>
      </div>

      <input ref={takeInput} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      <input ref={galleryInput} type="file" accept="image/*" hidden onChange={onFile} />
    </div>
  );
}

/**
 * Top-down "where to stand" diagram for quality builds: the object in the middle (front edge at the bottom, marked),
 * the photos taken so far as small dots on the circle round it, and the current one as a big yellow dot (a ring over
 * the middle for the top photo).
 */
function OrbitCard({ which }: { which: PhotoApiView }) {
  const POS: Partial<Record<PhotoApiView, [number, number]>> = { front: [40, 70], right: [70, 40], back: [40, 10], left: [10, 40] };
  const at = QUALITY_STEPS.indexOf(which);
  const label = which === 'top' ? 'From above' : `${which[0].toUpperCase()}${which.slice(1)}`;
  return (
    <div className="pf-orbit" aria-hidden="true">
      <svg width="80" height="80" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r="30" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" strokeDasharray="3 4" />
        <rect x="29" y="29" width="22" height="22" rx="3" fill="rgba(255,255,255,0.22)" stroke="#fff" strokeWidth="1.5" />
        <path d="M30 51h20" stroke="var(--yellow)" strokeWidth="3.5" strokeLinecap="round" />
        <text x="40" y="44" textAnchor="middle" fontSize="8" fontWeight="800" fill="#fff">front</text>
        {QUALITY_STEPS.slice(0, at).filter((v) => POS[v]).map((v) => (
          <circle key={v} cx={POS[v]![0]} cy={POS[v]![1]} r="3.5" fill="rgba(255,255,255,0.7)" />
        ))}
        {POS[which] ? (
          <circle cx={POS[which]![0]} cy={POS[which]![1]} r="7" fill="var(--yellow)" stroke="#000" strokeWidth="1.5" />
        ) : (
          <circle cx="40" cy="40" r="15" fill="none" stroke="var(--yellow)" strokeWidth="3" />
        )}
      </svg>
      <span>{label}</span>
    </div>
  );
}

const clampSize = (n: number) => Math.min(CAMERA_MAX_STUDS, Math.max(MIN_STUDS, n));

function drawGrid(ctx: CanvasRenderingContext2D, L: Layout) {
  ctx.lineWidth = 1;
  for (let c = 0; c <= L.cols; c++) {
    ctx.strokeStyle = c % 4 === 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.25)';
    const x = Math.round(L.gx + c * L.cellW) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, L.gy);
    ctx.lineTo(x, L.gy + L.rows * L.cellH);
    ctx.stroke();
  }
  for (let r = 0; r <= L.rows; r++) {
    ctx.strokeStyle = r % 4 === 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.25)';
    const y = Math.round(L.gy + r * L.cellH) + 0.5;
    ctx.beginPath();
    ctx.moveTo(L.gx, y);
    ctx.lineTo(L.gx + L.cols * L.cellW, y);
    ctx.stroke();
  }
}

function drawMosaic(
  ctx: CanvasRenderingContext2D, x0: number, y0: number, cw: number, ch: number, cols: number, rows: number,
  cells: Int16Array, matcher: LiveMatcher, big: boolean, alpha: number,
) {
  ctx.globalAlpha = alpha;
  const studsPer = big ? 2 : 1;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const col = matcher.colors[cells[r * cols + c]];
      const x = x0 + c * cw, y = y0 + r * ch;
      ctx.fillStyle = col.hex;
      ctx.fillRect(x, y, cw + 0.5, ch + 0.5);
      if (cw >= 5) {
        const sw = cw / studsPer;
        const sr = sw * 0.28;
        ctx.fillStyle = shade(col, 0.22);
        for (let i = 0; i < studsPer; i++)
          for (let j = 0; j < studsPer; j++) {
            ctx.beginPath();
            ctx.arc(x + sw * (i + 0.5), y + (ch / studsPer) * (j + 0.5), sr, 0, Math.PI * 2);
            ctx.fill();
          }
        ctx.strokeStyle = shade(col, -0.35);
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x + 0.25, y + 0.25, cw - 0.5, ch - 0.5);
      }
    }
  ctx.globalAlpha = 1;
}

function drawBrackets(ctx: CanvasRenderingContext2D, g: { x: number; y: number; w: number; h: number }) {
  const l = Math.min(28, g.w / 5, g.h / 5);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 4;
  const corners: Array<[number, number, number, number]> = [
    [g.x, g.y, 1, 1], [g.x + g.w, g.y, -1, 1], [g.x, g.y + g.h, 1, -1], [g.x + g.w, g.y + g.h, -1, -1],
  ];
  for (const [x, y, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(x + dx * l, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * l);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}
