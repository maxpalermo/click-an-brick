// Cut-out DOM glue: decode masks, draw the overlay, compose the final job image (subject on white).
import { JPEG_QUALITY, type Rect01, type Shot } from '../image';
import { cropRect, maskBox, workSize, type Mask } from './mask';

/** What the flow keeps for a shot whose cut-out was accepted. */
export interface Cutout {
  /** Job image: the subject on plain white, cropped to `crop`. JPEG data URI, ≤ 1024 px, ≤ 1.5 MB. */
  dataUrl: string;
  width: number;
  height: number;
  /** Region of the original photo in the job image (fractions of the original). */
  crop: Rect01;
  /** Subject box in the original photo (fractions). */
  box: Rect01;
  /** Baseplate removed (LEGO mode, toggle off). */
  baseplateRemoved: boolean;
}

export const MAX_JOB_BYTES = 1.5 * 1024 * 1024;

export function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  return img.decode().then(() => img);
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available');
  return { c, ctx };
}

/** The photo's pixels at the work resolution (RGBA). */
export function photoPixels(img: HTMLImageElement, shot: Shot): Uint8ClampedArray {
  const { w, h } = workSize(shot.width, shot.height);
  const { ctx } = canvas(w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * Decode a provider mask (PNG data URI, any size) to a binary work-resolution mask. Masks with
 * transparency use alpha; opaque masks use brightness (white = subject).
 */
export async function decodeMask(dataUrl: string, shot: Shot): Promise<Mask> {
  const img = await loadImage(dataUrl);
  const { w, h } = workSize(shot.width, shot.height);
  const { ctx } = canvas(w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  let transparent = false;
  for (let i = 3; i < px.length; i += 4 * 7) if (px[i] < 250) { transparent = true; break; }
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = transparent ? px[i * 4 + 3] : 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    data[i] = v >= 128 ? 1 : 0;
  }
  return { w, h, data };
}

/**
 * Overlay at work resolution: background dimmed, subject clear with a yellow outline, removed baseplate
 * tinted red. Drawn on `target` (CSS scales it over the photo).
 */
export function drawOverlay(target: HTMLCanvasElement, m: Mask, plate?: Uint8Array | null) {
  if (target.width !== m.w || target.height !== m.h) {
    target.width = m.w;
    target.height = m.h;
  }
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(m.w, m.h);
  const o = new Uint32Array(img.data.buffer);
  // Little-endian ABGR words.
  const DIM = (158 << 24) | (20 << 16) | (12 << 8) | 10; // rgba(10,12,20,0.62)
  const EDGE = (255 << 24) | (59 << 16) | (195 << 8) | 245; // #f5c33b
  const PLATE = (150 << 24) | (47 << 16) | (64 << 8) | 224; // accent red, 0.59
  const { w, h, data } = m;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (data[i]) {
        const edge =
          (x > 0 && !data[i - 1]) || (x < w - 1 && !data[i + 1]) || (y > 0 && !data[i - w]) || (y < h - 1 && !data[i + w]) ||
          x === 0 || y === 0 || x === w - 1 || y === h - 1;
        o[i] = edge ? EDGE : 0;
      } else o[i] = plate?.[i] ? PLATE : DIM;
    }
  ctx.putImageData(img, 0, 0);
}

/**
 * Compose the job image: crop the original photo to the subject box (+ margin), keep only the subject
 * (mask upscaled with smoothing = soft 1–2 px edge) and put it on plain white. JPEG, quality lowered
 * if needed to stay under 1.5 MB.
 */
export function composeCutout(img: HTMLImageElement, shot: Shot, m: Mask, baseplateRemoved: boolean): Cutout | null {
  const box = maskBox(m);
  if (!box) return null;
  const crop = cropRect(box, shot.width, shot.height);
  const cx = Math.floor(crop.x0 * shot.width), cy = Math.floor(crop.y0 * shot.height);
  const cw = Math.max(1, Math.ceil(crop.x1 * shot.width) - cx), ch = Math.max(1, Math.ceil(crop.y1 * shot.height) - cy);
  // Mask as an alpha image at work resolution.
  const mk = canvas(m.w, m.h);
  const md = mk.ctx.createImageData(m.w, m.h);
  for (let i = 0; i < m.data.length; i++) {
    md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = 255;
    md.data[i * 4 + 3] = m.data[i] ? 255 : 0;
  }
  mk.ctx.putImageData(md, 0, 0);
  const sub = canvas(cw, ch);
  sub.ctx.imageSmoothingEnabled = true;
  sub.ctx.imageSmoothingQuality = 'high';
  sub.ctx.drawImage(mk.c, 0, 0, m.w, m.h, -cx, -cy, shot.width, shot.height);
  sub.ctx.globalCompositeOperation = 'source-in';
  sub.ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, -cx, -cy, shot.width, shot.height);
  const out = canvas(cw, ch);
  out.ctx.fillStyle = '#fff';
  out.ctx.fillRect(0, 0, cw, ch);
  out.ctx.drawImage(sub.c, 0, 0);
  let q = JPEG_QUALITY + 0.05;
  let dataUrl = out.c.toDataURL('image/jpeg', q);
  while (dataUrl.length * 0.75 > MAX_JOB_BYTES && q > 0.5) {
    q -= 0.1;
    dataUrl = out.c.toDataURL('image/jpeg', q);
  }
  // Exact crop actually used (integer pixels).
  const used: Rect01 = { x0: cx / shot.width, y0: cy / shot.height, x1: (cx + cw) / shot.width, y1: (cy + ch) / shot.height };
  return { dataUrl, width: cw, height: ch, crop: used, box, baseplateRemoved };
}
