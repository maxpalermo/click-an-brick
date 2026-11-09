// Mode pick (+ quick / quality build type), confirm (cost + quota) and progress screens of the Photo to Bricks flow.
import { useEffect, useRef, useState } from 'react';
import { IconBricks, IconCheck, IconClose } from '../../ui/Icons';
import { Spinner } from '../../ui/Overlays';
import type { ConvertMessage, ConvertOptions, ConvertResult, PhotoConverter, PhotoJob, PhotoApiView, PhotoMode, PhotoQuota } from '../types';
import { ConverterError } from '../convert';
import type { PhotoAnalysis } from '../convert/contracts';
import { cacheGlb, glbBounds, loadCachedGlb, type Bounds } from './glb';
import { Brick2x2Art, IconAlert, IconBack, IconCube, IconRuler, IconSparkle, IconUpload } from './icons';
import type { Shot } from './image';
import { convertScale, estimateSize, preferBrickSize, type Measure, type ScaleChoice } from './scale';
import { scaleForChoice, sizeSourceOf, type SizeChoice, type SizeSource } from './size';
import { SizePicker } from './SizePicker';
import { Cancelled, FlowError, QUALITY_POLL_LIMIT_MS, createJob, fetchModel, friendly, getQuota, pollJob, type FlowStage, type RetryFrom } from './service';
import { reloadAndResume, saveResume, type ResumeRecord } from './resume';

// ------------------------------------------------------------------ header

export function FlowHeader({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose: () => void }) {
  return (
    <header className="pf-head">
      {onBack ? (
        <button className="icon-btn pf-touch" onClick={onBack} aria-label="Back"><IconBack size={22} /></button>
      ) : <span className="pf-touch" />}
      <h2>{title}</h2>
      <button className="icon-btn pf-touch" onClick={onClose} aria-label="Close"><IconClose size={20} /></button>
    </header>
  );
}

// ------------------------------------------------------------------ 1. mode

/** Quick = 2–3 photos, TRELLIS (~1 min); quality = 4 sides + top, Tripo multiview (~3 min, uses a monthly credit). */
export type BuildType = 'quick' | 'quality';
const BUILD_TYPE_KEY = 'brickyard.photo.buildType.v1';

/** Last build type picked on this device (localStorage; quick when unknown or storage is blocked). */
function loadBuildType(): BuildType {
  try { return localStorage.getItem(BUILD_TYPE_KEY) === 'quality' ? 'quality' : 'quick'; } catch { return 'quick'; }
}
function saveBuildType(t: BuildType): void {
  try { localStorage.setItem(BUILD_TYPE_KEY, t); } catch { /* private mode: just not remembered */ }
}

/** Quota (null while loading, 'error' when it could not be read), refetched whenever the screen mounts. */
function useQuota(): PhotoQuota | null | 'error' {
  const [quota, setQuota] = useState<PhotoQuota | null | 'error'>(null);
  useEffect(() => {
    let alive = true;
    getQuota().then((q) => alive && setQuota(q), () => alive && setQuota('error'));
    return () => { alive = false; };
  }, []);
  return quota;
}

/** Quality counter: "N of M left this month" (the owner is never blocked: how many were used instead). */
const qualityLeft = (q: NonNullable<PhotoQuota['quality']>) =>
  q.unlimited ? `${q.used} used this month, no limit for you` : `${q.remaining} of ${q.monthly} left this month`;

export function ModePick({ onPick, onClose, saved, onResume }: {
  /** quality: build a quality build (4 sides + top) instead of a quick one. */
  onPick(m: PhotoMode, quality: boolean): void; onClose(): void;
  /** A build whose 3D shape is already downloaded but whose bricks were never finished (resume.ts). */
  saved?: ResumeRecord | null; onResume?(): void;
}) {
  const quota = useQuota();
  const [type, setType] = useState<BuildType>(loadBuildType);
  const qq = quota !== null && quota !== 'error' ? quota.quality : undefined;
  // No quality info (old server, offline, or it cannot make them): no choice, quick builds as before.
  const showTypes = quota === null || !!qq;
  const qualityBlocked = !!qq && !qq.unlimited && qq.remaining <= 0;
  // While the quota loads, trust the remembered choice (the server re-checks on submit).
  const quality = type === 'quality' && showTypes && !qualityBlocked;
  const choose = (t: BuildType) => { setType(t); saveBuildType(t); };

  return (
    <div className="pf-screen">
      <FlowHeader title="Build from a photo" onClose={onClose} />
      <div className="pf-body">
        <p className="pf-lead">Take a photo of something, and we'll turn it into a model made of real LEGO® bricks and plates.</p>
        {saved && onResume && (
          <button className="pf-mode-card pf-resume-card" onClick={onResume} data-autofocus>
            {saved.image ? <img className="pf-mode-icon pf-resume-img" src={saved.image} alt="" /> : <span className="pf-mode-icon b"><IconBricks size={30} /></span>}
            <span className="pf-mode-text">
              <strong>Finish your last photo build</strong>
              <small>Its 3D shape is ready, so this doesn't use another photo build.</small>
            </span>
          </button>
        )}
        {showTypes && (
          <>
            <h3 className="pf-section-k">Build type</h3>
            <div className="pf-buildtype" role="radiogroup" aria-label="Build type">
              <button role="radio" aria-checked={!quality} className={`pf-bt ${!quality ? 'active' : ''}`} onClick={() => choose('quick')}>
                <strong>Quick</strong>
                <small>2 photos, front and back</small>
                <span className="pf-bt-meta">About 1 minute</span>
              </button>
              <button role="radio" aria-checked={quality} className={`pf-bt ${quality ? 'active' : ''}`} onClick={() => choose('quality')}
                disabled={qualityBlocked} aria-describedby="pf-bt-quality-meta">
                <strong><IconSparkle size={16} /> Quality</strong>
                <small>4 sides + top. Much more accurate all round</small>
                <span className="pf-bt-meta" id="pf-bt-quality-meta">
                  {!qq ? 'About 3 minutes' : qualityBlocked ? 'None left this month. They reset on the 1st' : `About 3 min · ${qualityLeft(qq)}`}
                </span>
              </button>
            </div>
            <h3 className="pf-section-k">What are you building?</h3>
          </>
        )}
        <button className="pf-mode-card" onClick={() => onPick('object', quality)} data-autofocus={saved && onResume ? undefined : true}>
          <span className="pf-mode-icon a"><IconCube size={30} /></span>
          <span className="pf-mode-text">
            <strong>Any object</strong>
            <small>A toy, a car, a mug, your pet… Works best on one object with a plain background.</small>
          </span>
        </button>
        <button className="pf-mode-card" onClick={() => onPick('lego', quality)}>
          <span className="pf-mode-icon b"><IconBricks size={30} /></span>
          <span className="pf-mode-text">
            <strong>My LEGO build</strong>
            <small>Rebuild a model you made, snapped to the real stud grid.</small>
          </span>
        </button>
        <div className="pf-note">
          <strong>Good to know</strong>
          <ul>
            {quality
              ? <li>You walk round it: front, its right side, back and left side, then one from above (optional). The AI then takes about 2–3 minutes.</li>
              : <li>You shoot the front, then the back and one side (both optional, they help with the hidden sides).</li>}
            <li>The result is a re-creation: the inside is invented and slopes, tiles and round parts become small steps.</li>
            <li>Details smaller than about one stud get smoothed out.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 2. confirm

interface ConfirmProps {
  mode: PhotoMode;
  front: Shot;
  back: Shot | null;
  side: Shot | null;
  /** Quality build: the other photos (right and left required, top optional); `side` is not used. */
  quality?: { right: Shot | null; left: Shot | null; top: Shot | null };
  /** Quality build with no credits left (or none possible): make a quick build from the same front and back. */
  onQuick?(): void;
  measure: Measure;
  size: SizeChoice;
  setSize(s: SizeChoice): void;
  onRetake(which: PhotoApiView): void;
  onRealSize(): void;
  onCreate(): void;
  onBack(): void;
  onClose(): void;
}

export function Confirm({ mode, front, back, side, quality, onQuick, measure, size, setSize, onRetake, onRealSize, onCreate, onBack, onClose }: ConfirmProps) {
  const quota = useQuota();
  const est = estimateSize(measure);
  const noneLeft = quota !== null && quota !== 'error' && quota.remainingToday <= 0;
  const paused = quota !== null && quota !== 'error' && quota.budgetLeftUsd <= 0;
  // Quality: 'none' = this server cannot make quality builds; 'used' = no credits left this month.
  const qq = quality && quota !== null && quota !== 'error' ? quota.quality : undefined;
  const qualityOut = !quality || quota === null || quota === 'error' ? null
    : !qq ? 'none' : !qq.unlimited && qq.remaining <= 0 ? 'used' : null;
  const missing = !!quality && !(quality.right && back && quality.left);

  return (
    <div className="pf-screen">
      <FlowHeader title="Ready to build" onBack={onBack} onClose={onClose} />
      <div className="pf-body">
        {quality ? (
          <div className="pf-shots five">
            <ShotTile label="Front" shot={front} onRetake={() => onRetake('front')} />
            {([['right', 'Right', quality.right], ['back', 'Back', back], ['left', 'Left', quality.left], ['top', 'Top', quality.top]] as const).map(([v, label, shot]) =>
              shot ? <ShotTile key={v} label={label} shot={shot} onRetake={() => onRetake(v)} /> : (
                <button key={v} className="pf-shot empty" onClick={() => onRetake(v)}>
                  <span>+ Add {v}</span>
                  <small>{v === 'top' ? 'Optional, helps with roofs and the layout' : 'Needed for a quality build'}</small>
                </button>
              ))}
          </div>
        ) : <div className="pf-shots three">
          <ShotTile label="Front" shot={front} onRetake={() => onRetake('front')} />
          {back ? <ShotTile label="Back" shot={back} onRetake={() => onRetake('back')} /> : (
            <button className="pf-shot empty" onClick={() => onRetake('back')}>
              <span>+ Add back</span>
              <small>Optional, makes the back better</small>
            </button>
          )}
          {side ? <ShotTile label="Side" shot={side} onRetake={() => onRetake('side')} /> : (
            <button className="pf-shot empty" onClick={() => onRetake('side')}>
              <span>+ Add side</span>
              <small>Optional, helps the AI with hidden sides</small>
            </button>
          )}
        </div>}

        <div className="pf-summary">
          <div className="pf-summary-row">
            <span className="pf-summary-k">Type</span>
            <span>{mode === 'lego' ? 'My LEGO build' : 'Any object'}{quality ? ' · Quality build' : ''}</span>
          </div>
          <SizePicker mode={mode} measure={measure} size={size} setSize={setSize} onRealSize={onRealSize} />
          {(mode === 'object' || est.lifeSize) && (
            <button className="pf-realsize-btn" onClick={onRealSize}>
              {est.lifeSize ? <IconRuler size={20} /> : <Brick2x2Art size={26} />}
              <span>
                <strong>{est.lifeSize ? 'Real size is set from your 2×2 brick' : 'Real size (optional)'}</strong>
                <small>{est.lifeSize ? 'Tap to adjust the brick or object box' : 'Put a 2×2 brick next to the object and mark it'}</small>
              </span>
            </button>
          )}
        </div>

        <div className={`pf-cost ${noneLeft || paused || qualityOut ? 'warn' : ''} ${qualityOut ? 'stack' : ''}`} aria-live="polite">
          {quota === null && <><Spinner size={16} /> Checking your photo builds…</>}
          {quota === 'error' && <>This uses 1 {quality ? 'quality' : 'photo'} build.</>}
          {quota !== null && quota !== 'error' && (
            paused ? <>Photo builds are paused for this month. Please try again later.</>
              : noneLeft ? <>You've used all your photo builds for today. Come back tomorrow!</>
                : qualityOut ? (
                  <>
                    <span>{qualityOut === 'used'
                      ? <>You've used all {qq!.monthly} quality builds for this month. They reset on the 1st.</>
                      : <>Quality builds aren't available right now.</>}</span>
                    {onQuick && <button className="btn" onClick={onQuick}>Make a quick build instead</button>}
                  </>
                )
                  : qq ? (
                    <span>{qq.unlimited
                      ? <>Quality build: no monthly limit for you ({qq.used} used this month).</>
                      : <>This uses <strong>1</strong> of your <strong>{qq.remaining}</strong> quality build{qq.remaining === 1 ? '' : 's'} left this month.</>}
                    {' '}If it fails, you get it back. Changing the size later is free.</span>
                  )
                    : <span>This uses <strong>1</strong> of your <strong>{quota.remainingToday}</strong> photo build{quota.remainingToday === 1 ? '' : 's'} left today. Changing the size later is free.</span>
          )}
        </div>
        <p className="pf-privacy">Your photos are sent to our 3D partner (fal.ai, USA) to make the shape. We don't keep them, and location data is removed before upload.</p>
      </div>
      <div className="pf-foot">
        {quality ? (
          <button className="btn primary pf-big pf-cta two-line" onClick={onCreate} disabled={noneLeft || paused || !!qualityOut || missing} data-autofocus>
            <span className="pf-cta-main"><IconSparkle size={20} /> Create my model</span>
            <small>{qq && !qq.unlimited ? `Uses 1 of your ${qq.remaining} quality build${qq.remaining === 1 ? '' : 's'}` : 'Quality build'}</small>
          </button>
        ) : (
          <button className="btn primary pf-big pf-cta" onClick={onCreate} disabled={noneLeft || paused} data-autofocus>
            <IconSparkle size={20} /> Create my model
          </button>
        )}
      </div>
    </div>
  );
}

function ShotTile({ label, shot, onRetake }: { label: string; shot: Shot; onRetake(): void }) {
  return (
    <div className="pf-shot">
      <img src={shot.dataUrl} alt={`${label} photo`} />
      <span className="pf-shot-label">{label}</span>
      <button className="pf-retake" onClick={onRetake}>Retake</button>
    </div>
  );
}

// ------------------------------------------------------------------ 3. progress

export interface BuildOutput {
  jobId: string;
  glb: ArrayBuffer;
  bounds: Bounds | null;
  scale: ScaleChoice;
  result: ConvertResult;
  /** Vision analysis of the photos, when the server produced one. */
  analysis?: PhotoAnalysis;
  /** Set when the first conversion failed and this is the simpler fallback build (shown on the result screen). */
  fallback?: string;
  /** Size picked on the Confirm screen and where the result's size came from (shown on the result screen). */
  size?: SizeChoice;
  sizeSource?: SizeSource;
}

/** Size of the fallback build when the measured size fails (the balanced default, cheap on any phone). */
const FALLBACK_STUDS = 24;

interface ProgressProps {
  mode: PhotoMode;
  images: string[];
  /** Which side each image shows (front first). */
  views?: PhotoApiView[];
  /** Quality build (CreatePhotoJobRequest.quality): longer AI step, 10-minute give-up, 402 offers a quick build. */
  quality?: boolean;
  /** No quality builds left: switch to a quick build with the same front and back photos. */
  onQuick?(): void;
  /** Model size from the Confirm screen (absent: a resumed build from before the size choice, old behaviour). */
  size?: SizeChoice;
  measure: Measure;
  converter: PhotoConverter;
  hollow: boolean;
  onDone(o: BuildOutput): void;
  onCancel(): void;
  onEdit(): void;
  /** Continue a saved build after a reload (resume.ts): skips upload + AI, rebuilds from the cached shape. */
  resume?: ResumeRecord;
}

type Stage = 'upload' | 'shape' | 'bricks';
const STAGES: Array<{ id: Stage; label: string; sub: string }> = [
  { id: 'upload', label: 'Uploading photos', sub: 'A few seconds' },
  { id: 'shape', label: 'AI is making the 3D shape', sub: 'Usually 30–60 seconds' },
  { id: 'bricks', label: 'Building it with bricks', sub: 'Right here on your device' },
];
const QUALITY_SHAPE_SUB = 'About 2–3 minutes';
/** Time constant of the time-based progress estimate while the provider reports none (TRELLIS ~40 s, Tripo ~2–3 min). */
const SHAPE_TAU_MS = 30_000;
const QUALITY_SHAPE_TAU_MS = 75_000;
const clock = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const CONVERT_LABEL: Record<Extract<ConvertMessage, { type: 'progress' }>['stage'], string> = {
  load: 'Reading the shape', voxelize: 'Cutting into studs', colour: 'Picking LEGO colours', merge: 'Choosing bricks', repair: 'Making it hold together',
};

export function Progress({ mode, images, views, quality, onQuick, size, measure, converter, hollow, onDone, onCancel, onEdit, resume }: ProgressProps) {
  const [stage, setStage] = useState<Stage>('upload');
  const [frac, setFrac] = useState(0);
  const [sub, setSub] = useState<string | null>(null);
  const [error, setError] = useState<FlowError | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const jobId = useRef<string | null>(resume?.jobId ?? null);
  const glb = useRef<ArrayBuffer | null>(null);
  /** Vision analysis from the job (arrives during polling; absent if the vision step failed). */
  const analysis = useRef<PhotoAnalysis | undefined>(resume?.analysis);
  const cancelled = useRef(false);
  const shapeStart = useRef(0);

  const run = async (from: RetryFrom) => {
    if (from === 'reload') return reloadAndResume();
    setError(null);
    let at: FlowStage = 'create';
    try {
      if (from === 'create' || !jobId.current) {
        at = 'create';
        setStage('upload');
        setFrac(0.03);
        const r = await createJob({ images, mode, ...(views && views.length === images.length ? { views } : {}), ...(quality ? { quality: true } : {}) });
        if (cancelled.current) throw new Cancelled();
        jobId.current = r.jobId;
        glb.current = null;
        analysis.current = undefined;
      }
      const id = jobId.current!;
      if (!glb.current && (from === 'create' || from === 'poll')) {
        at = 'poll';
        setStage('shape');
        shapeStart.current = Date.now();
        setFrac(0.12);
        await pollJob(id, (j: PhotoJob) => {
          if (j.analysis) analysis.current = j.analysis;
          if (j.progress != null) setFrac(0.12 + 0.68 * Math.min(1, Math.max(0, j.progress)));
        }, () => cancelled.current, quality ? QUALITY_POLL_LIMIT_MS : undefined);
      }
      if (!glb.current) {
        at = 'fetch';
        setStage('bricks');
        setSub('Downloading the shape');
        setFrac(0.8);
        let buf = await loadCachedGlb(id);
        if (!buf) {
          buf = await fetchModel(id);
          void cacheGlb(id, buf);
        }
        if (cancelled.current) throw new Cancelled();
        glb.current = buf;
        // From here on a reload can finish the build without another photo build (the GLB is in IndexedDB).
        saveResume({ jobId: id, mode, measure, hollow, analysis: analysis.current, size, views: views ?? resume?.views, quality: quality || undefined, image: images[0] });
      }
      at = 'convert';
      setStage('bricks');
      setFrac(0.84);
      const bounds = glbBounds(glb.current);
      const scale = size ? scaleForChoice(size, mode, measure, bounds) : preferBrickSize(convertScale(measure, bounds), measure, mode, analysis.current);
      const onProgress = (m: Extract<ConvertMessage, { type: 'progress' }>) => {
        setSub(CONVERT_LABEL[m.stage] ?? null);
        const order = ['load', 'voxelize', 'colour', 'merge', 'repair'];
        const i = Math.max(0, order.indexOf(m.stage));
        setFrac(0.84 + 0.16 * ((i + Math.min(1, m.fraction)) / order.length));
      };
      // slice(): the converter may transfer the buffer to its worker; keep our own copy for re-runs.
      const convert = (o: ConvertOptions) => converter.convert(glb.current!.slice(0), o, onProgress);
      // Measured size first; if the converter fails (or the phone runs out of memory), a smaller build with the
      // vision analysis, then one without it (no special parts / symmetry priors, which is where most converter
      // exceptions would come from). A worker that cannot start at all (stale deploy) is not retried here.
      const small = { sizeStuds: FALLBACK_STUDS };
      const attempts: Array<{ scale: ScaleChoice; analysis?: PhotoAnalysis; note?: string }> = [
        { scale, analysis: analysis.current },
        ...(analysis.current ? [{ scale: { options: small, capped: false }, analysis: analysis.current,
          note: "It didn't work at the chosen size, so this is a smaller version. You can change the size below." }] : []),
        { scale: { options: small, capped: false }, analysis: undefined,
          note: "It didn't work at the chosen size, so this is a smaller, simpler version without special parts. You can change the size below." },
      ];
      let result: ConvertResult | null = null;
      let used = attempts[0];
      for (const a of attempts) {
        used = a;
        if (a !== attempts[0]) setSub('Trying a simpler version');
        try {
          result = await convert({ ...a.scale.options, mode, hollow, analysis: a.analysis });
          if (result.bricks.length || a === attempts[attempts.length - 1]) break; // empty at the end: "No bricks came out" below
          throw new ConverterError('failed', 'the model came out empty');
        } catch (e) {
          if (cancelled.current || !(e instanceof ConverterError) || e.code === 'start' || a === attempts[attempts.length - 1]) throw e;
          console.warn('[photo] conversion failed, trying a simpler version', e);
        }
      }
      if (!result) throw new ConverterError('failed', 'no result');
      const fallback = used.note;
      if (cancelled.current) throw new Cancelled();
      if (!result.bricks.length)
        throw new FlowError('No bricks came out', 'The shape was too thin or too small. Try a bigger size or a clearer photo.', 'convert');
      setFrac(1);
      const sizeSource: SizeSource | undefined = used !== attempts[0] ? 'default' : size ? sizeSourceOf(size, measure, used.analysis, result) : undefined;
      onDone({ jobId: id, glb: glb.current, bounds, scale: used.scale, result, analysis: used.analysis, fallback, size, sizeSource });
    } catch (e) {
      if (e instanceof Cancelled || cancelled.current) return;
      setError(friendly(e, at, quality));
    }
  };

  const started = useRef(false);
  useEffect(() => {
    // StrictMode re-mounts once in dev: keep the first run alive instead of creating a second job.
    cancelled.current = false;
    if (!started.current) {
      started.current = true;
      void run(resume ? 'fetch' : 'create');
    }
    return () => {
      cancelled.current = true;
      converter.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Elapsed timer + time-based estimate while the provider reports no progress.
  useEffect(() => {
    if (error) return;
    const t0 = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - t0) / 1000));
      if (stage === 'shape' && shapeStart.current) {
        const est = 0.12 + 0.66 * (1 - Math.exp(-(Date.now() - shapeStart.current) / (quality ? QUALITY_SHAPE_TAU_MS : SHAPE_TAU_MS)));
        setFrac((f) => Math.max(f, est));
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [stage, error]);

  const cancel = () => {
    cancelled.current = true;
    converter.cancel();
    onCancel();
  };
  const idx = STAGES.findIndex((s) => s.id === stage);

  return (
    <div className="pf-screen">
      <FlowHeader title={error ? 'Something went wrong' : 'Making your model'} onClose={cancel} />
      <div className="pf-body pf-progress">
        {!error ? (
          <>
            <div className="pf-hero" aria-hidden="true">
              {images[0] && <img src={images[0]} alt="" />}
              <div className="pf-scan" />
            </div>
            <div className="pf-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-label="Progress">
              <span style={{ width: `${Math.round(frac * 100)}%` }} />
            </div>
            <ol className="pf-stages">
              {STAGES.map((s, i) => (
                <li key={s.id} className={i < idx ? 'done' : i === idx ? 'active' : ''}>
                  <span className="pf-stage-dot">
                    {i < idx ? <IconCheck size={16} /> : i === idx ? <Spinner size={18} /> : s.id === 'upload' ? <IconUpload size={16} /> : s.id === 'shape' ? <IconSparkle size={16} /> : <IconBricks size={16} />}
                  </span>
                  <span className="pf-stage-text">
                    <strong>{s.label}</strong>
                    <small>{(() => {
                      const base = s.id === 'shape' && quality ? QUALITY_SHAPE_SUB : s.sub;
                      return i === idx && s.id === 'bricks' && sub ? sub : i === idx && s.id === 'shape' ? `${base} · ${clock(elapsed)}` : base;
                    })()}</small>
                  </span>
                </li>
              ))}
            </ol>
            <p className="pf-help center">You can keep this screen open. Leaving it cancels the build.</p>
          </>
        ) : (
          <div className="pf-error" role="alert">
            <div className="pf-error-icon"><IconAlert size={30} /></div>
            <h2>{error.title}</h2>
            <p>{error.detail}</p>
            {error.retry === 'create' && jobId.current && (
              <p className="pf-help">{quality ? 'Trying again uses another quality build. The one that failed was given back.' : 'Trying again uses another photo build.'}</p>
            )}
          </div>
        )}
      </div>
      <div className="pf-foot">
        {!error ? (
          <button className="btn pf-big pf-cta" onClick={cancel}>Cancel</button>
        ) : (
          <div className={`pf-row${error.retry === 'quick' ? ' stack' : ''}`}>
            <button className="btn pf-big" onClick={onEdit}>Change photos</button>
            {error.retry === 'quick' ? onQuick && (
              <button className="btn primary pf-big grow" onClick={onQuick} data-autofocus>Make a quick build instead</button>
            ) : error.retry !== 'none' && (
              <button className="btn primary pf-big grow" onClick={() => void run(error.retry)} data-autofocus>
                {error.retry === 'reload' ? 'Reload and continue' : 'Try again'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
