// Size rules shared by the converter (pipeline.ts) and the UI size labels; no heavy imports, so the UI
// can use them without pulling the converter into the main bundle.
import type { PhotoAnalysis } from './contracts';

/** Minimum vision brickSize confidence for it to set the size (LEGO mode without lduPerUnit / sizeStuds). */
export const BRICK_SIZE_MIN_CONFIDENCE = 0.5;
/**
 * A big build (at least this many plates high or studs wide / deep) uses the vision's count even at a lower confidence:
 * counting 170 plates is never exact, but the order of magnitude is, and the default size (Balanced ~20-32 studs) is
 * far too small for it (the owner's castle is ~70 studs tall).
 */
export const BRICK_SIZE_BIG_PLATES = 90, BRICK_SIZE_BIG_STUDS = 24;
/** ... down to this confidence. */
export const BRICK_SIZE_BIG_MIN_CONFIDENCE = 0.1;
/** Longest side (studs) a low-confidence big-build count may ask for (96 studs = ~11k parts, ~12 s on the laptop). */
export const BRICK_SIZE_BIG_MAX = 72;

/** Whether the converter sizes a LEGO build from the vision's brickSize (shared with the UI's size label). */
export function brickSizeUsable(bs: PhotoAnalysis['brickSize'] | undefined): 'confident' | 'big' | null {
  if (!bs) return null;
  if (bs.confidence >= BRICK_SIZE_MIN_CONFIDENCE) return 'confident';
  const big = bs.plates >= BRICK_SIZE_BIG_PLATES || Math.max(bs.studsWide, bs.studsDeep) >= BRICK_SIZE_BIG_STUDS;
  return big && bs.confidence >= BRICK_SIZE_BIG_MIN_CONFIDENCE ? 'big' : null;
}
