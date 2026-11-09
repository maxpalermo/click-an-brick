// Full-screen "Photo to Bricks" overlay: mode (+ build type) → front → cut-out (→ real size) → back → cut-out → side
// (optional) → cut-out → confirm (model size) → progress → result. Quality builds (4 sides + top, Tripo) shoot front
// (→ real size) → right → back → left → top (optional, the only one with Skip) instead, each through the cut-out, and
// a 402 (no credits left) offers a quick build from the same front and back photos. Cut-out: cutout/CutoutScreen.tsx (subject on white is what
// the 3D AI and vision get; the Measure stays on the ORIGINAL front photo, with the cut-out's subject box as the
// default object box). Model size: size.ts / SizePicker.tsx (picked on the Confirm screen, before converting).
// Design: docs/PHOTO_TO_BRICKS.md §3, §6, §7, §9 (U1–U6).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../../model/store';
import { useColors } from '../../ui/context';
import type { PhotoApiView, PhotoMode } from '../types';
import { CameraScreen, QUALITY_STEPS, type Sizing } from './CameraScreen';
import type { Cutout } from './cutout/canvas';
import { CutoutScreen, newCutoutSession, type CutoutSession } from './cutout/CutoutScreen';
import { cutoutMeasure } from './cutout/mask';
import { Brick2x2Art } from './icons';
import type { Rect01, Shot } from './image';
import { LiveMatcher } from './legoColors';
import { RealSize } from './RealSize';
import { Result } from './Result';
import { measureFromShot, type Measure } from './scale';
import { Confirm, ModePick, Progress, type BuildOutput } from './screens';
import { makeConverter } from './service';
import { defaultSize, fitChoice, type SizeChoice } from './size';
import { usePhotoFlow, openPhotoFlow } from './store';
import { hasAutoResume, loadResume, takeAutoResume, type ResumeRecord } from './resume';
import './photo.css';

type Which = PhotoApiView;
type Step = 'mode' | Which | 'cutout' | 'confirm' | 'realsize' | 'progress' | 'result';
/** Photo order of a quick build; quality builds use QUALITY_STEPS (front, right, back, left, top). */
const WHICH: Which[] = ['front', 'back', 'side'];
/** Quality-build sides shot with the front photo as a ghost (same distance and height). */
const GHOSTED: Which[] = ['right', 'back', 'left'];

/** Mount once in the editor; renders nothing until the flow is opened. */
export function PhotoFlowHost() {
  const open = usePhotoFlow((s) => s.open);
  const readOnly = useEditor((s) => s.readOnly);
  // Back from "Reload and continue" (resume.ts): reopen the flow on the saved build.
  useEffect(() => { if (!readOnly && hasAutoResume()) openPhotoFlow(); }, [readOnly]);
  if (!open || readOnly) return null;
  return <PhotoFlow />;
}

function PhotoFlow() {
  const colors = useColors();
  const close = usePhotoFlow((s) => s.close);
  const matcher = useMemo(() => new LiveMatcher(colors), [colors]);
  const converter = useMemo(() => makeConverter(colors), [colors]);
  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<PhotoMode>('object');
  /** Quality build (picked on the mode screen): 4 sides + top, Tripo, uses a monthly credit. */
  const [quality, setQuality] = useState(false);
  const seq = quality ? QUALITY_STEPS : WHICH;
  const [sizing, setSizing] = useState<Sizing>({ studs: 24, big: false });
  /** Photos as taken (null / absent = skipped). Front is required, back and side are optional (quality: only top is). */
  const [shots, setShots] = useState<Partial<Record<Which, Shot | null>>>({});
  const front = shots.front ?? null;
  /** Accepted cut-outs (null = use the full photo) and the editing sessions behind them (mask cache). */
  const [cuts, setCuts] = useState<Partial<Record<Which, Cutout | null>>>({});
  const sessions = useRef<Partial<Record<Which, CutoutSession>>>({});
  const [cutWhich, setCutWhich] = useState<Which>('front');
  /** Came to the camera from the confirm screen (retake) → go back there after the shot. */
  const [returnToConfirm, setReturnToConfirm] = useState(false);
  const [marks, setMarks] = useState<{ brick?: Rect01; object?: Rect01 }>({});
  /** LEGO builds: the reference-brick screen is shown right after the front photo; this is where the flow goes next. */
  const [refPrompt, setRefPrompt] = useState<null | Which | 'confirm'>(null);
  const [hollow, setHollow] = useState(false);
  /** Model size picked on the Confirm screen (size.ts). */
  const [size, setSize] = useState<SizeChoice>(() => defaultSize('object'));
  const [output, setOutput] = useState<BuildOutput | null>(null);
  /** A build whose 3D shape is already downloaded (resume.ts): offered on the first screen, or continued after a reload. */
  const [saved, setSaved] = useState<ResumeRecord | null>(() => loadResume());
  const [resume, setResume] = useState<ResumeRecord | null>(null);
  const startResume = (r: ResumeRecord) => {
    setMode(r.mode);
    setQuality(!!r.quality);
    setHollow(r.hollow);
    if (r.size) setSize(r.size);
    setResume(r);
    setStep('progress');
  };
  useEffect(() => {
    const r = takeAutoResume() ? loadResume() : null;
    if (r) startResume(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => converter.cancel(), [converter]);

  // Real-size marks are relative to the original front photo; the cut-out's subject box is the default object box.
  const measure: Measure | null = front
    ? cutoutMeasure({ ...measureFromShot(front), brick: marks.brick }, cuts.front?.box, marks.object)
    : null;
  /** Photos for the job in order front, back, side (quality: front, right, back, left, top): cut-out, else the photo. */
  const jobPhotos = seq.flatMap((w) => {
    const url = cuts[w]?.dataUrl ?? shots[w]?.dataUrl;
    return url ? [{ view: w, url }] : [];
  });
  const shown = (w: Which): Shot | null => {
    const s = shots[w];
    const c = cuts[w];
    return s ? (c ? { ...s, dataUrl: c.dataUrl, width: c.width, height: c.height } : s) : null;
  };

  const pickMode = (m: PhotoMode, q: boolean) => {
    setMode(m);
    setQuality(q);
    setResume(null);
    setSize(defaultSize(m));
    setStep('front');
  };

  /** The photo after w in this build's order (confirm after the last). */
  const nextOf = (w: Which): Which | 'confirm' => seq[seq.indexOf(w) + 1] ?? 'confirm';

  /** After the cut-out of a photo: LEGO front → real size prompt; else on to the next photo / confirm. */
  const afterCutout = (w: Which, cut: Cutout | null) => {
    setCuts((c) => ({ ...c, [w]: cut }));
    if (w === 'front') {
      setMarks((m) => ({ brick: m.brick })); // a new subject box replaces any fitted object box
      const next = returnToConfirm ? 'confirm' : nextOf('front');
      setRefPrompt(mode === 'lego' ? next : null);
      setStep(mode === 'lego' ? 'realsize' : next);
    } else if (!returnToConfirm && (quality || w === 'back')) {
      setStep(nextOf(w)); // quick: offer the optional side photo; quality: the next side round the object
    } else {
      setStep('confirm');
    }
    setReturnToConfirm(false);
  };

  const skip = (w: Which) => {
    setShots((s) => ({ ...s, [w]: null }));
    setCuts((c) => ({ ...c, [w]: undefined }));
    setReturnToConfirm(false);
    setStep('confirm');
  };

  /** No quality builds left (Confirm, or a 402 on submit): quick build from the same front and back photos. */
  const toQuick = () => {
    setQuality(false);
    setShots((s) => ({ ...s, side: undefined })); // a side photo from an earlier quick build is not of this object
    setCuts((c) => ({ ...c, side: undefined }));
    setResume(null);
    setStep('confirm');
  };

  const goBack = () => {
    switch (step) {
      case 'mode': return close();
      case 'cutout': return setStep(cutWhich);
      case 'confirm': return setStep(quality ? 'top' : shots.back ? 'side' : 'back');
      case 'realsize':
        if (refPrompt) setCutWhich('front');
        return setStep(refPrompt ? 'cutout' : 'confirm');
      case 'result': return setStep(front ? 'confirm' : 'mode');
      case 'progress': return setStep('confirm');
      default: { // a camera step: the previous photo (the first one goes back to the mode screen)
        if (returnToConfirm) return setStep('confirm');
        const i = seq.indexOf(step);
        return setStep(i > 0 ? seq[i - 1] : 'mode');
      }
    }
  };

  // Escape = back (never during a build, where it would silently cancel).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || step === 'progress') return;
      e.stopPropagation();
      goBack();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Move focus into each new screen (keyboard + screen reader users).
  useEffect(() => {
    const el = rootRef.current;
    const target = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('button');
    target?.focus({ preventScroll: true });
  }, [step]);

  const legoHint = (
    <>
      <Brick2x2Art size={30} />
      <span>Put a 2×2 brick next to your build<small>so the model comes out exactly as big as it is</small></span>
    </>
  );

  let screen: JSX.Element;
  switch (step) {
    case 'mode':
      screen = <ModePick onClose={close} onPick={pickMode} saved={saved} onResume={() => saved && startResume(saved)} />;
      break;
    case 'front':
    case 'back':
    case 'side':
    case 'right':
    case 'left':
    case 'top':
      screen = (
        <CameraScreen
          key={step}
          which={step}
          quality={quality}
          sizing={sizing}
          setSizing={setSizing}
          matcher={matcher}
          ghost={(quality ? GHOSTED.includes(step) : step === 'back') ? front?.dataUrl : undefined}
          hint={mode === 'lego' && step === 'front' ? legoHint : undefined}
          onBack={goBack}
          onClose={close}
          onSkip={(quality ? step === 'top' : step !== 'front') ? () => skip(step) : undefined}
          onShot={(s) => {
            const w: Which = step;
            setShots((v) => ({ ...v, [w]: s }));
            if (w === 'front') setMarks({}); // old marks belong to the old photo
            setCuts((c) => ({ ...c, [w]: undefined }));
            sessions.current[w] = newCutoutSession(s);
            setCutWhich(w);
            setStep('cutout'); // returnToConfirm is kept until the cut-out is done (Back → camera keeps it)
          }}
        />
      );
      break;
    case 'cutout': {
      const shot = shots[cutWhich] ?? null;
      const session = shot && (sessions.current[cutWhich]?.shot === shot ? sessions.current[cutWhich] : (sessions.current[cutWhich] = newCutoutSession(shot)));
      screen = session ? (
        <CutoutScreen
          key={`${cutWhich}-${shot!.dataUrl.length}`}
          which={cutWhich}
          mode={mode}
          session={session}
          onBack={goBack}
          onClose={close}
          onDone={(cut) => afterCutout(cutWhich, cut)}
        />
      ) : <></>;
      break;
    }
    case 'confirm':
      screen = front && measure ? (
        <Confirm
          mode={mode}
          front={shown('front')!}
          back={shown('back')}
          side={shown('side')}
          quality={quality ? { right: shown('right'), left: shown('left'), top: shown('top') } : undefined}
          onQuick={toQuick}
          measure={measure}
          size={fitChoice(size, mode, !!marks.brick)}
          setSize={setSize}
          onBack={goBack}
          onClose={close}
          onRetake={(w) => { setReturnToConfirm(true); setStep(w); }}
          onRealSize={() => setStep('realsize')}
          onCreate={() => { setSize(fitChoice(size, mode, !!marks.brick)); setResume(null); setStep('progress'); }}
        />
      ) : <ModePick onClose={close} onPick={pickMode} />;
      break;
    case 'realsize':
      screen = front ? (
        <RealSize
          shot={front}
          mode={mode}
          initial={{ brick: marks.brick, object: marks.object ?? cuts.front?.box }}
          prompted={refPrompt !== null}
          onCancel={goBack}
          onSkip={refPrompt ? () => { setStep(refPrompt); setRefPrompt(null); } : undefined}
          onApply={(v) => {
            setMarks(v);
            // A marked brick means "make it real size" (exact); removing it falls back to the mode's default.
            if (v.brick) setSize((s) => ({ preset: 'real', studs: s.studs }));
            else setSize((s) => fitChoice(s, mode, false));
            setStep(refPrompt ?? 'confirm');
            setRefPrompt(null);
          }}
        />
      ) : <></>;
      break;
    case 'progress':
      screen = resume ? (
        <Progress
          key={resume.jobId}
          mode={resume.mode}
          images={resume.image ? [resume.image] : []}
          views={resume.views}
          quality={resume.quality}
          size={resume.size}
          measure={resume.measure}
          converter={converter}
          hollow={resume.hollow}
          resume={resume}
          onDone={(o) => { setOutput(o); setSaved(null); setStep('result'); }}
          onCancel={() => { setResume(null); setStep('mode'); }}
          onEdit={() => { setResume(null); setStep(front ? 'confirm' : 'mode'); }}
        />
      ) : front && measure ? (
        <Progress
          mode={mode}
          images={jobPhotos.map((p) => p.url)}
          views={jobPhotos.map((p) => p.view)}
          quality={quality}
          onQuick={toQuick}
          size={size}
          measure={measure}
          converter={converter}
          hollow={hollow}
          onDone={(o) => { setOutput(o); setSaved(null); setStep('result'); }}
          onCancel={() => setStep('confirm')}
          onEdit={() => setStep('confirm')}
        />
      ) : <></>;
      break;
    case 'result':
      screen = output ? (
        <Result
          output={output}
          mode={mode}
          converter={converter}
          hollow={hollow}
          setHollow={setHollow}
          onRetake={goBack}
          onDone={close}
          onClose={close}
        />
      ) : <></>;
      break;
  }

  return (
    <div className={`photo-flow step-${step}`} ref={rootRef} role="dialog" aria-modal="true" aria-label="Build from a photo">
      {screen}
    </div>
  );
}
