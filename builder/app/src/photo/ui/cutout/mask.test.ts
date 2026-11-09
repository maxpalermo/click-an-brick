// Unit tests for the cut-out maths (no DOM). Run: npx tsx app/src/photo/ui/cutout/mask.test.ts
import type { Rect01 } from '../image';
import { convertScale, estimateSize, type Measure } from '../scale';
import {
  area,
  cropRect,
  cutoutMeasure,
  dropSpecks,
  findBaseplate,
  fromCrop,
  interiorPoints,
  maskBox,
  measureInCrop,
  requestPoints,
  toCrop,
  type Mask,
} from './mask';

let failed = 0, passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function ok(c: unknown, msg = 'assertion failed') {
  if (!c) throw new Error(msg);
}
function near(a: number, b: number, eps = 1e-6, msg = '') {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ${b}, got ${a}`);
}
function nearRect(a: Rect01 | null | undefined, b: Rect01, eps = 1e-6) {
  ok(a, 'rect missing');
  for (const k of ['x0', 'y0', 'x1', 'y1'] as const) near(a![k], b[k], eps, k);
}

function rectMask(w: number, h: number, rects: Array<[number, number, number, number]>): Mask {
  const data = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * w + x] = 1;
  return { w, h, data };
}

console.log('cut-out maths');

test('maskBox: pixel-exact fractions', () => {
  nearRect(maskBox(rectMask(100, 50, [[10, 5, 30, 25]])), { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.5 });
  ok(maskBox(rectMask(10, 10, [])) === null, 'empty mask → null');
});

test('dropSpecks keeps the object, drops a speck', () => {
  const m = dropSpecks(rectMask(100, 100, [[10, 10, 60, 60], [90, 90, 91, 91]]));
  ok(area(m) === 2500, `area ${area(m)}`);
});

test('cropRect: margin of 8% of the longer box side, clamped to the photo', () => {
  // 1000×500 photo, box 400×200 px at (300,150) → margin 32 px
  const c = cropRect({ x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 }, 1000, 500);
  nearRect(c, { x0: 0.268, y0: 0.236, x1: 0.732, y1: 0.764 });
  const edge = cropRect({ x0: 0, y0: 0.9, x1: 0.5, y1: 1 }, 1000, 500);
  ok(edge.x0 === 0 && edge.y1 === 1, 'clamped');
});

test('toCrop / fromCrop round trip', () => {
  const crop = { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.6 };
  const r = { x0: 0.3, y0: 0.2, x1: 0.5, y1: 0.55 };
  nearRect(fromCrop(toCrop(r, crop), crop), r, 1e-12);
  nearRect(toCrop(crop, crop), { x0: 0, y0: 0, x1: 1, y1: 1 }, 1e-12);
});

const baseMeasure: Measure = {
  photoW: 1024,
  photoH: 768,
  guide: { x0: 0.2, y0: 0.15, x1: 0.8, y1: 0.85 },
  studsW: 24,
};

test('measureInCrop: size estimate is unchanged by the crop (grid sizing)', () => {
  const crop = { x0: 0.25, y0: 0.2, x1: 0.75, y1: 0.9 };
  const m = { ...baseMeasure, object: { x0: 0.3, y0: 0.25, x1: 0.7, y1: 0.85 } };
  const a = estimateSize(m);
  const b = estimateSize(measureInCrop(m, crop));
  near(b.lduPerPx, a.lduPerPx, 1e-9, 'lduPerPx');
  near(b.widthLdu, a.widthLdu, 1e-6, 'widthLdu');
  near(b.heightLdu, a.heightLdu, 1e-6, 'heightLdu');
});

test('measureInCrop: life size (reference brick) and a rescaled job image give the same LDU', () => {
  const crop = { x0: 0.1, y0: 0.05, x1: 0.9, y1: 0.95 };
  const m = { ...baseMeasure, object: { x0: 0.3, y0: 0.25, x1: 0.7, y1: 0.85 }, brick: { x0: 0.82, y0: 0.8, x1: 0.86, y1: 0.84 } };
  const a = estimateSize(m);
  const cw = (crop.x1 - crop.x0) * m.photoW, ch = (crop.y1 - crop.y0) * m.photoH;
  const b = estimateSize(measureInCrop(m, crop, cw / 2, ch / 2)); // job image encoded at half size
  ok(a.lifeSize && b.lifeSize, 'life size');
  near(b.widthLdu, a.widthLdu, 1e-6, 'widthLdu');
  near(b.heightLdu, a.heightLdu, 1e-6, 'heightLdu');
  const bounds = { min: [-0.5, 0, -0.3] as [number, number, number], max: [0.5, 1.2, 0.3] as [number, number, number] };
  near(convertScale(measureInCrop(m, crop, cw / 2, ch / 2), bounds).options.lduPerUnit!, convertScale(m, bounds).options.lduPerUnit!, 1e-6, 'lduPerUnit');
});

test('cutoutMeasure: subject box is the default object box; a fitted box wins', () => {
  const box = { x0: 0.31, y0: 0.22, x1: 0.69, y1: 0.88 };
  nearRect(cutoutMeasure(baseMeasure, box).object, box);
  const user = { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.9 };
  nearRect(cutoutMeasure(baseMeasure, box, user).object, user);
  ok(cutoutMeasure(baseMeasure, null).object === undefined, 'no box → guide');
  // A tighter, exact box changes the estimate only through the object extent (grid scale is the guide's).
  near(estimateSize(cutoutMeasure(baseMeasure, box)).lduPerPx, estimateSize(baseMeasure).lduPerPx, 1e-12);
});

// Synthetic "LEGO build on a baseplate": grey block on a wide green plate with lighter stud dots and a
// darker front edge, on a white background.
function scene(withPlate: boolean) {
  const w = 200, h = 160;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const mask = new Uint8Array(w * h);
  const set = (x: number, y: number, c: [number, number, number]) => {
    const i = y * w + x;
    rgba.set([...c, 255], i * 4);
    mask[i] = 1;
  };
  for (let y = 20; y < 120; y++) for (let x = 60; x < 140; x++) set(x, y, [150, 150, 155]); // build
  if (withPlate) {
    for (let y = 110; y < 140; y++)
      for (let x = 20; x < 180; x++) {
        if (y < 120 && x >= 60 && x < 140) continue; // build in front
        const stud = (x % 8 === 3 || x % 8 === 4) && y % 6 === 2;
        set(x, y, y >= 134 ? [40, 140, 60] : stud ? [110, 215, 120] : [75, 190, 90]);
      }
  }
  return { m: { w, h, data: mask }, rgba };
}

test('findBaseplate: removes a green plate under a grey build', () => {
  const { m, rgba } = scene(true);
  const r = findBaseplate(m, rgba);
  ok(r, 'plate found');
  const b = maskBox(r!.mask)!;
  near(b.y1, 120 / 160, 0.02, 'build bottom');
  near(b.x0, 60 / 200, 0.02, 'build left');
  near(b.x1, 140 / 200, 0.02, 'build right');
  ok(r!.color[1] > r!.color[0] + 60, 'plate colour is green');
});

test('findBaseplate: no plate → null (a plain build is left alone)', () => {
  const { m, rgba } = scene(false);
  ok(findBaseplate(m, rgba) === null, 'should be null');
});

test('findBaseplate: a same-colour wall reaching the top is not a plate', () => {
  const { m, rgba } = scene(true);
  // Paint the whole build green too → the "plate" would reach the top of the subject.
  for (let y = 20; y < 120; y++) for (let x = 60; x < 140; x++) rgba.set([75, 190, 90, 255], (y * m.w + x) * 4);
  ok(findBaseplate(m, rgba) === null, 'should be null');
});

test('interiorPoints: deep inside the mask, away from avoided points', () => {
  const m = rectMask(100, 100, [[10, 10, 90, 90]]);
  const pts = interiorPoints(m, [{ x: 0.5, y: 0.5, label: 0 }], 3);
  ok(pts.length === 3, `got ${pts.length}`);
  for (const p of pts) {
    ok(m.data[Math.floor(p.y * 100) * 100 + Math.floor(p.x * 100)] === 1, 'inside');
    ok(Math.hypot(p.x - 0.5, p.y - 0.5) * 100 >= 0.12 * Math.hypot(100, 100) - 1e-9, 'away from the remove point');
    ok(p.label === 1, 'positive');
  }
});

test('requestPoints: seeds from the auto mask, skips them for a far-away "add"', () => {
  const auto = rectMask(100, 100, [[10, 10, 40, 90]]);
  ok(requestPoints(auto, []).length === 0, 'no taps → auto mask, no call');
  const rm = requestPoints(auto, [{ x: 0.25, y: 0.2, label: 0 }]);
  ok(rm.some((p) => p.label === 1) && rm[rm.length - 1].label === 0, 'remove-only tap gets positive seeds');
  const near_ = requestPoints(auto, [{ x: 0.45, y: 0.5, label: 1 }]);
  ok(near_.length > 1, 'add next to the selection keeps seeds');
  const far = requestPoints(auto, [{ x: 0.85, y: 0.5, label: 1 }]);
  ok(far.length === 1, 'add far away = "this is the object" → no seeds');
  ok(requestPoints(null, [{ x: 0.5, y: 0.5, label: 0 }]).length === 0, 'only removes and no auto → nothing to send');
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} test(s) failed`);
