// Cut-out maths, pure TypeScript (no DOM): masks, boxes, crop transforms, the baseplate heuristic and the
// auto-seed points for tap refinement. DOM glue (decode/overlay/compose) is in canvas.ts.
// Unit tests: npx tsx app/src/photo/ui/cutout/mask.test.ts
import type { SegmentPoint } from '../../types';
import type { Rect01 } from '../image';
import type { Measure } from '../scale';

/** Binary mask at "work" resolution (long side ≤ WORK_SIDE): 1 = subject. */
export interface Mask {
  w: number;
  h: number;
  data: Uint8Array;
}

/** Long side of the work resolution: masks, overlay and the baseplate heuristic run at this size. */
export const WORK_SIDE = 512;
/** Margin around the subject box in the composed job image, as a fraction of the box's longer side. */
export const CROP_MARGIN = 0.08;

export const workSize = (w: number, h: number) => {
  const k = Math.min(1, WORK_SIDE / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
};

export const area = (m: Mask) => {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
};

/** Subject box in fractions, or null when the mask is empty. */
export function maskBox(m: Mask): Rect01 | null {
  let x0 = m.w, y0 = m.h, x1 = -1, y1 = -1;
  for (let y = 0; y < m.h; y++) {
    const row = y * m.w;
    for (let x = 0; x < m.w; x++)
      if (m.data[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  }
  return x1 < 0 ? null : { x0: x0 / m.w, y0: y0 / m.h, x1: (x1 + 1) / m.w, y1: (y1 + 1) / m.h };
}

/** 4-connected component labels (0 = background) and sizes (index = label). */
export function components(m: Mask): { label: Int32Array; sizes: number[] } {
  const { w, h, data } = m;
  const label = new Int32Array(w * h);
  const sizes = [0];
  const q = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!data[s] || label[s]) continue;
    const id = sizes.length;
    let head = 0, tail = 0;
    label[s] = id;
    q[tail++] = s;
    while (head < tail) {
      const i = q[head++];
      const x = i % w;
      if (x > 0 && data[i - 1] && !label[i - 1]) { label[i - 1] = id; q[tail++] = i - 1; }
      if (x < w - 1 && data[i + 1] && !label[i + 1]) { label[i + 1] = id; q[tail++] = i + 1; }
      if (i >= w && data[i - w] && !label[i - w]) { label[i - w] = id; q[tail++] = i - w; }
      if (i + w < w * h && data[i + w] && !label[i + w]) { label[i + w] = id; q[tail++] = i + w; }
    }
    sizes.push(tail);
  }
  return { label, sizes };
}

/** Drop specks: keep components at least `minShare` of the largest one. */
export function dropSpecks(m: Mask, minShare = 0.02): Mask {
  const { label, sizes } = components(m);
  const big = Math.max(0, ...sizes);
  const keep = sizes.map((s) => s > 0 && s >= big * minShare);
  const data = new Uint8Array(m.data.length);
  for (let i = 0; i < data.length; i++) data[i] = keep[label[i]] ? 1 : 0;
  return { w: m.w, h: m.h, data };
}

// ---------------------------------------------------------------- crop + measure

/**
 * Region of the original photo that becomes the job image: the subject box plus CROP_MARGIN of its longer
 * side (in pixels) on every side, clamped to the photo. Fractions of the original.
 */
export function cropRect(box: Rect01, photoW: number, photoH: number, margin = CROP_MARGIN): Rect01 {
  const bw = (box.x1 - box.x0) * photoW, bh = (box.y1 - box.y0) * photoH;
  const m = Math.max(bw, bh) * margin;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return { x0: c(box.x0 - m / photoW), y0: c(box.y0 - m / photoH), x1: c(box.x1 + m / photoW), y1: c(box.y1 + m / photoH) };
}

/** Original-photo fractions → fractions of the crop. */
export function toCrop(r: Rect01, crop: Rect01): Rect01 {
  const cw = crop.x1 - crop.x0 || 1, ch = crop.y1 - crop.y0 || 1;
  return { x0: (r.x0 - crop.x0) / cw, y0: (r.y0 - crop.y0) / ch, x1: (r.x1 - crop.x0) / cw, y1: (r.y1 - crop.y0) / ch };
}

/** Crop fractions → original-photo fractions. */
export function fromCrop(r: Rect01, crop: Rect01): Rect01 {
  const cw = crop.x1 - crop.x0, ch = crop.y1 - crop.y0;
  return { x0: crop.x0 + r.x0 * cw, y0: crop.y0 + r.y0 * ch, x1: crop.x0 + r.x1 * cw, y1: crop.y0 + r.y1 * ch };
}

/**
 * The same measurement expressed in the coordinates of the job image (the crop, encoded at outW × outH).
 * Scale maths (scale.ts estimateSize / convertScale) gives identical results for both, because every box
 * keeps its size in photo pixels × (outW / cropW px). The flow keeps the Measure on the ORIGINAL photo
 * (RealSize marks are image-relative) and never needs this; it exists for code that works on the job
 * image (e.g. future overlays) and is what the unit test checks.
 */
export function measureInCrop(m: Measure, crop: Rect01, outW?: number, outH?: number): Measure {
  const cw = (crop.x1 - crop.x0) * m.photoW, ch = (crop.y1 - crop.y0) * m.photoH;
  const k = outW ? outW / cw : 1;
  const ky = outH ? outH / ch : k;
  return {
    ...m,
    photoW: cw * k,
    photoH: ch * ky,
    guide: toCrop(m.guide, crop),
    // The guide's stud count stays the same: it is a property of the guide box, not of the image.
    object: m.object ? toCrop(m.object, crop) : undefined,
    brick: m.brick ? toCrop(m.brick, crop) : undefined,
  };
}

/**
 * Measure for the flow when a cut-out is used: the object box defaults to the cut-out's subject box (exact
 * extent of what the 3D AI sees) unless the user fitted it on the Real size screen.
 */
export function cutoutMeasure(m: Measure, subjectBox: Rect01 | null | undefined, userObject?: Rect01): Measure {
  const object = userObject ?? subjectBox ?? m.object;
  return object ? { ...m, object } : m;
}

// ---------------------------------------------------------------- baseplate

/** YUV-ish colour distance: chroma counts fully, brightness at 35% (plate top vs. shaded side, stud shadows). */
function colorDist(a: ArrayLike<number>, i: number, r: number, g: number, b: number): number {
  const ya = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
  const yb = 0.299 * r + 0.587 * g + 0.114 * b;
  const du = a[i + 2] - ya - (b - yb);
  const dv = a[i] - ya - (r - yb);
  return Math.sqrt(du * du + dv * dv + 0.1225 * (ya - yb) * (ya - yb));
}

export interface BaseplateResult {
  /** Plate pixels (1) at the mask's resolution. */
  plate: Uint8Array;
  /** The mask without the plate (specks dropped). */
  mask: Mask;
  /** Plate colour (sRGB). */
  color: [number, number, number];
}

/**
 * Finds a baseplate under a LEGO build and removes it from the mask. `rgba` is the photo at the mask's
 * resolution (ImageData layout). Heuristic, tuned on renders of builds on plates and photo-like shading:
 *  1. the bottom 7% of the subject must be dominated (≥ 35%) by one colour (quantised histogram) — the plate;
 *  2. flood from those bottom pixels through mask pixels of a similar colour (chroma-weighted, tolerant to
 *     the shaded edge and stud highlights) → plate region;
 *  3. sanity: the plate spans ≥ 50% of the subject width, covers 3–70% of it, stays out of the top 30%
 *     (else it is probably part of the build, e.g. a green wall), and leaves ≥ 20% for the build;
 *  4. remove it plus a 1-pixel seam, then drop stud specks.
 * Returns null when no plate is found (the UI says so and suggests tapping it with "Remove").
 * Limitation: build parts of the plate's colour that touch the plate (a green bush on a green plate) go too.
 */
export function findBaseplate(m: Mask, rgba: ArrayLike<number>): BaseplateResult | null {
  const { w, h, data } = m;
  const box = maskBox(m);
  if (!box) return null;
  const by0 = Math.round(box.y0 * h), by1 = Math.round(box.y1 * h) - 1;
  const bx0 = Math.round(box.x0 * w), bx1 = Math.round(box.x1 * w) - 1;
  const H = by1 - by0 + 1, W = bx1 - bx0 + 1;
  if (H < 16 || W < 16) return null;
  const total = area(m);

  // 1. dominant colour in the bottom band
  const bandTop = by1 - Math.max(2, Math.round(H * 0.07));
  const hist = new Map<number, { n: number; r: number; g: number; b: number }>();
  let bandN = 0;
  for (let y = bandTop; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) {
      const i = y * w + x;
      if (!data[i]) continue;
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const e = hist.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      hist.set(key, e);
      bandN++;
    }
  if (bandN < 20) return null;
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const e of hist.values()) if (e.n > best.n) best = e;
  if (best.n < bandN * 0.35) return null;
  const color: [number, number, number] = [best.r / best.n, best.g / best.n, best.b / best.n];

  // 2. flood through similar mask pixels, seeded from the band
  const TOL = 42;
  const plate = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let head = 0, tail = 0;
  const similar = (i: number) => colorDist(rgba, i * 4, color[0], color[1], color[2]) < TOL;
  for (let y = bandTop; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) {
      const i = y * w + x;
      if (data[i] && similar(i)) { plate[i] = 1; q[tail++] = i; }
    }
  while (head < tail) {
    const i = q[head++];
    const x = i % w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
    for (const j of nb) if (j >= 0 && j < w * h && data[j] && !plate[j] && similar(j)) { plate[j] = 1; q[tail++] = j; }
  }
  // Close small gaps (stud outlines, highlights) that are surrounded by plate on both sides, row-wise and column-wise.
  closeGaps(plate, data, w, h, 3);

  // 3. sanity checks
  let pN = 0, px0 = w, px1 = -1, py0 = h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (plate[y * w + x]) {
        pN++;
        if (x < px0) px0 = x;
        if (x > px1) px1 = x;
        if (y < py0) py0 = y;
      }
  if (pN < total * 0.03 || pN > total * 0.7) return null;
  if (px1 - px0 + 1 < W * 0.5) return null;
  if (py0 < by0 + H * 0.3) return null;

  // 4. remove plate + 1 px seam, drop specks
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!data[i] || plate[i]) continue;
    const x = i % w;
    const seam = (x > 0 && plate[i - 1]) || (x < w - 1 && plate[i + 1]) || (i >= w && plate[i - w]) || (i + w < w * h && plate[i + w]);
    out[i] = seam ? 0 : 1;
  }
  const rest = dropSpecks({ w, h, data: out }, 0.04);
  if (area(rest) < total * 0.2) return null;
  return { plate, mask: rest, color };
}

/** Fill runs of ≤ maxGap non-plate mask pixels lying between plate pixels (horizontal, then vertical). */
function closeGaps(plate: Uint8Array, mask: Uint8Array, w: number, h: number, maxGap: number) {
  const fill: number[] = [];
  for (let y = 0; y < h; y++) {
    let last = -1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (plate[i]) {
        if (last >= 0 && x - last - 1 > 0 && x - last - 1 <= maxGap) for (let k = last + 1; k < x; k++) fill.push(y * w + k);
        last = x;
      } else if (!mask[i]) last = -1;
    }
  }
  for (let x = 0; x < w; x++) {
    let last = -1;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      if (plate[i]) {
        if (last >= 0 && y - last - 1 > 0 && y - last - 1 <= maxGap) for (let k = last + 1; k < y; k++) fill.push(k * w + x);
        last = y;
      } else if (!mask[i]) last = -1;
    }
  }
  for (const i of fill) plate[i] = 1;
}

// ---------------------------------------------------------------- tap refinement

/** Chamfer distance to the nearest non-mask pixel (3-4 metric / 3 ≈ pixels). */
export function distanceInside(m: Mask): Float32Array {
  const { w, h, data } = m;
  const d = new Float32Array(w * h);
  const INF = 1e9;
  for (let i = 0; i < w * h; i++) d[i] = data[i] ? INF : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x === 0 || y === 0) v = Math.min(v, 3);
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) v = Math.min(v, d[i - w] + 3);
      if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + 4);
      if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + 4);
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x === w - 1 || y === h - 1) v = Math.min(v, 3);
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) v = Math.min(v, d[i + w] + 3);
      if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + 4);
      if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + 4);
      d[i] = v;
    }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/**
 * Up to `n` positive points deep inside the mask (largest distance to its edge), spread apart and away from
 * `avoid` points. Sent with the user's taps so SAM keeps the already-good selection while refining it.
 */
export function interiorPoints(m: Mask, avoid: SegmentPoint[], n = 3): SegmentPoint[] {
  const d = distanceInside(m);
  const diag = Math.hypot(m.w, m.h);
  const minSep = diag * 0.12;
  const picked: Array<{ x: number; y: number }> = [];
  const blocked = avoid.map((p) => ({ x: p.x * m.w, y: p.y * m.h }));
  const order = Array.from(d.keys()).filter((i) => d[i] >= 2).sort((a, b) => d[b] - d[a]);
  for (const i of order) {
    if (picked.length >= n) break;
    const x = (i % m.w) + 0.5, y = Math.floor(i / m.w) + 0.5;
    const far = (p: { x: number; y: number }) => Math.hypot(p.x - x, p.y - y) >= minSep;
    if (picked.every(far) && blocked.every(far)) picked.push({ x, y });
  }
  return picked.map((p) => ({ x: p.x / m.w, y: p.y / m.h, label: 1 as const }));
}

/**
 * Points to send for the user's taps. The automatic mask seeds the request (interior points) unless the
 * user's first "add" tap is clearly elsewhere — further than 10% of the photo diagonal from the automatic
 * selection — which means "that's the object I want" (the AI picked the wrong thing).
 */
export function requestPoints(auto: Mask | null, taps: SegmentPoint[]): SegmentPoint[] {
  if (!taps.length) return [];
  const firstAdd = taps.find((t) => t.label === 1);
  let seed = !!auto && area(auto) > 0;
  if (seed && auto && firstAdd) {
    const d = distanceOutside(auto, firstAdd);
    if (d > Math.hypot(auto.w, auto.h) * 0.1) seed = false;
  }
  const negatives = taps.filter((t) => t.label === 0);
  const seeds = seed && auto ? interiorPoints(auto, negatives, firstAdd ? 2 : 3) : [];
  const pts = [...seeds, ...taps];
  // The server needs at least one positive point.
  return pts.some((p) => p.label === 1) ? pts.slice(-24) : [];
}

/** Pixel distance from a point to the nearest mask pixel (0 when inside). */
export function distanceOutside(m: Mask, p: { x: number; y: number }): number {
  const px = p.x * m.w, py = p.y * m.h;
  const i = Math.min(m.h - 1, Math.floor(py)) * m.w + Math.min(m.w - 1, Math.floor(px));
  if (m.data[i]) return 0;
  let best = Infinity;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) if (m.data[y * m.w + x]) best = Math.min(best, (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2);
  return Math.sqrt(best);
}

export const pointsKey = (pts: SegmentPoint[]) => pts.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.label}`).join(';');
