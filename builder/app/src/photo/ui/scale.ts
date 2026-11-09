// Turning the camera measurements (UX A grid, UX B reference brick) into converter scale options.
// Formulas: docs/PHOTO_TO_BRICKS.md §6. The final lduPerUnit needs the mesh size, so it is computed
// after the GLB has loaded (see convertScale).
import type { ConvertOptions, PhotoMode } from '../types';
import type { PhotoAnalysis } from '../convert/contracts';
import { brickSizeUsable } from '../convert/sizeRules';
import type { Bounds } from './glb';
import type { Rect01, Shot } from './image';

export const STUD_LDU = 20;
export const BRICK_LDU = 24;
/** Side of a 2x2 brick's top face. */
export const REF_BRICK_LDU = 40;
/** Upper limit for the longest model dimension: the converter's limit (convert/orient.ts MAX_STUDS), so a big
 *  LEGO build (a ~70-stud castle) can come out at its real size. Above PHONE_WARN_STUDS (size.ts) the UI warns. */
export const MAX_STUDS = 96;
/** Upper limit of the camera's "studs across the frame" grid (a finer grid is unreadable on a phone). */
export const CAMERA_MAX_STUDS = 64;
export const MIN_STUDS = 6;
/** Below this the reference brick is too small to measure reliably (doc §6B). */
export const MIN_REF_PX = 30;

export interface Measure {
  photoW: number;
  photoH: number;
  /** Framing guide from the camera screen. */
  guide: Rect01;
  /** Studs across the guide (UX A). */
  studsW: number;
  /** Object box adjusted on the Real size screen (defaults to the guide). */
  object?: Rect01;
  /** Top face of a real 2x2 brick (UX B). */
  brick?: Rect01;
}

export function measureFromShot(s: Shot): Measure {
  return { photoW: s.width, photoH: s.height, guide: s.guide, studsW: s.studsW };
}

const wPx = (m: Measure, r: Rect01) => Math.abs(r.x1 - r.x0) * m.photoW;
const hPx = (m: Measure, r: Rect01) => Math.abs(r.y1 - r.y0) * m.photoH;

/** Reference brick width in photo pixels (horizontal edge: the least foreshortened one). */
export const brickPx = (m: Measure) => (m.brick ? wPx(m, m.brick) : 0);

export interface SizeEstimate {
  /** LDraw units per photo pixel at the object's depth. */
  lduPerPx: number;
  /** Object extent in LDU (front view). */
  widthLdu: number;
  heightLdu: number;
  lifeSize: boolean;
}

export function estimateSize(m: Measure): SizeEstimate {
  const obj = m.object ?? m.guide;
  const ref = brickPx(m);
  const lifeSize = ref > 0;
  const lduPerPx = lifeSize ? REF_BRICK_LDU / ref : (m.studsW * STUD_LDU) / Math.max(1, wPx(m, m.guide));
  return { lduPerPx, widthLdu: wPx(m, obj) * lduPerPx, heightLdu: hPx(m, obj) * lduPerPx, lifeSize };
}

export const studsWide = (e: SizeEstimate) => Math.max(1, Math.round(e.widthLdu / STUD_LDU));
export const bricksTall = (e: SizeEstimate) => Math.max(1, Math.round(e.heightLdu / BRICK_LDU));

export interface ScaleChoice {
  options: Pick<ConvertOptions, 'lduPerUnit' | 'sizeStuds'>;
  /** True when the requested size was reduced to MAX_STUDS. */
  capped: boolean;
}

/**
 * lduPerUnit = object extent in LDU / mesh extent (front view = mesh X/Y). The object was fitted inside
 * the box, so it touches the box on its limiting axis: width-limited when the mesh is relatively wider
 * than the box, else height-limited (doc: "if the subject is taller than it is wide, use height").
 * Without mesh bounds, falls back to sizeStuds (longest front-view dimension).
 */
export function convertScale(m: Measure, bounds: Bounds | null): ScaleChoice {
  const e = estimateSize(m);
  const obj = m.object ?? m.guide;
  if (bounds) {
    const mw = bounds.max[0] - bounds.min[0];
    const mh = bounds.max[1] - bounds.min[1];
    const md = bounds.max[2] - bounds.min[2];
    if (mw > 0 && mh > 0) {
      const boxAspect = wPx(m, obj) / Math.max(1, hPx(m, obj));
      let k = mw / mh >= boxAspect ? e.widthLdu / mw : e.heightLdu / mh;
      const longest = Math.max(mw, mh, md) * k;
      const cap = MAX_STUDS * STUD_LDU;
      const capped = longest > cap;
      if (capped) k *= cap / longest;
      return { options: { lduPerUnit: k }, capped };
    }
  }
  const studs = Math.round(Math.max(e.widthLdu, e.heightLdu) / STUD_LDU);
  return { options: { sizeStuds: clampStuds(studs) }, capped: studs > MAX_STUDS };
}

/**
 * LEGO builds without a marked reference brick: when the vision step counted the studs confidently,
 * pass no size so the converter scales to the real build (PhotoAnalysis.brickSize).
 */
export function preferBrickSize(scale: ScaleChoice, m: Measure, mode: PhotoMode, analysis?: PhotoAnalysis): ScaleChoice {
  if (mode !== 'lego' || estimateSize(m).lifeSize) return scale;
  if (!brickSizeUsable(analysis?.brickSize)) return scale;
  return { options: {}, capped: false };
}

export const clampStuds = (n: number) => Math.min(MAX_STUDS, Math.max(MIN_STUDS, Math.round(n)));
