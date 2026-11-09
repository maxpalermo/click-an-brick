// Photo to Bricks "cut-out": POST /api/photo/segment → subject mask for one photo (front or back).
// Runtime-agnostic (Worker + Express). Contract: app/src/photo/types.ts (SegmentRequest / SegmentResponse).
//
//   no points  → automatic salient-object mask   fal-ai/birefnet/v2  (BiRefNet, "General Use (Light)")
//   points     → point-prompt mask                fal-ai/sam2/image   (Meta SAM 2, +/− points)
//   mock       → near-white / border-colour flood fill (local dev, no money; imagecodec.ts decodes the photo)
//
// The server never decodes pixels on the real path: fal returns the mask as a PNG data URI (sync_mode) and
// we pass it straight through. Box, baseplate removal, overlay and the final white-background composite
// all run in the browser (app/src/photo/ui/cutout/*). Reason: the Cloudflare Workers free plan allows
// ~10 ms CPU per request, which is not enough to decode a 1-megapixel photo; on a phone it is ~20 ms.
// The baseplate toggle therefore costs nothing and needs no second call.
//
// fal schemas, verified 2026-10-26 (https://fal.ai/models/<id>/llms.txt and
// https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>):
//   fal-ai/birefnet/v2   POST https://fal.run/fal-ai/birefnet/v2
//     in:  image_url (required) · model: "General Use (Light)" (default) | "General Use (Light 2K)" |
//          "General Use (Heavy)" | "Matting" | "Portrait" | "General Use (Dynamic)" · operating_resolution
//          "1024x1024" (default) | "2048x2048" | "2304x2304" · output_mask (false) · refine_foreground (true)
//          · sync_mode (false) · output_format png|webp|gif · mask_only (false: "Returns only the mask;
//          foreground refinement is skipped")
//     out: { image: Image{url,width,height,content_type}, mask_image?: Image }  (mask_only → image = mask)
//     price: billed per GPU-second; the model page shows no fixed per-image price ("$0 per compute
//          second" as rendered on 2026-10-26). BiRefNet Light at 1024² runs well under a second → we
//          book PHOTO_SEGMENT_COST_USD (default $0.003) per call against PHOTO_BUDGET_USD. Check the
//          real figure on the fal dashboard (Usage) after the first days and adjust the variable.
//   fal-ai/sam2/image    POST https://fal.run/fal-ai/sam2/image
//     in:  image_url (required) · prompts: PointPrompt[] {x, y, label} (pixels; label 1 = object,
//          0 = background) · box_prompts: {x_min,y_min,x_max,y_max}[] · apply_mask (false) · sync_mode ·
//          output_format jpeg|png|webp
//     out: { image: Image }  — the mask (apply_mask false)
//     price: billed per GPU-second like BiRefNet (same booking).
//   Alternative with a published price: fal-ai/sam-3/image ($0.005/request; point_prompts {x,y,label,
//   object_id}, text `prompt` defaults to "wheel" — points-only use is undocumented, so not used).
// Both calls use sync_mode: true (the mask comes back inline as a data URI and fal does not keep it in
// the request history) and X-Fal-Store-IO: 0 (fal does not store the photo payload).
import {
  base64ToBytes,
  errText,
  PhotoHttpError,
  round2,
  startOfUtcDay,
  startOfUtcMonth,
  validateImage,
  type JobStore,
  type PhotoImage,
} from './core.js';
import { bytesToBase64, decodeImage, encodeGrayPng, type RGBImage } from './imagecodec.js';
import { imageSize } from './vision.js';

// ---------- contract (keep in sync with app/src/photo/types.ts) ----------

export interface SegmentPoint {
  /** 0–1 fractions of the image, origin top-left. */
  x: number;
  y: number;
  /** 1 = part of the object, 0 = not the object. */
  label: 0 | 1;
}
export interface SegmentResult {
  /** PNG data URI. White/opaque = subject. Usually the photo's size; the client scales it if not. */
  mask: string;
  /** Subject box [x0, y0, x1, y1] in 0–1 fractions, when the server computed it (mock); else null. */
  box: [number, number, number, number] | null;
  /** birefnet | sam2 | mock */
  model: string;
  /** Cost booked for this call (USD). */
  costUsd: number;
}

export const MAX_SEGMENT_POINTS = 24;
export const DEFAULT_SEGMENT_DAILY_LIMIT = 60;
export const DEFAULT_SEGMENT_COST_USD = 0.003;
/** POST body: one 1.5 MB photo as base64 (~2 MB) + points. */
export const MAX_SEGMENT_BODY_BYTES = 2.2 * 1024 * 1024;

/** One row of D1 `photo_segments` (cloud/migrations/0004_photo_segments.sql). */
export interface SegmentRow {
  user: string;
  created_at: number;
  model: string;
  cost_usd: number;
  ok: boolean;
}

/** Cut-out call log, for the per-user daily limit. JobStore.spendSince must include these costs. */
export interface SegmentLog {
  recordSegment(row: SegmentRow): Promise<void>;
  countSegmentsSince(user: string, since: number): Promise<number>;
}

export function validateSegmentInput(body: unknown): { image: PhotoImage; points: SegmentPoint[] } {
  if (!body || typeof body !== 'object') throw new PhotoHttpError(400, 'Body must be a JSON object { image, points? }.');
  const b = body as Record<string, unknown>;
  const image = validateImage(b.image, 'Photo');
  const raw = b.points ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_SEGMENT_POINTS) {
    throw new PhotoHttpError(400, `\`points\` must be an array of at most ${MAX_SEGMENT_POINTS} points.`);
  }
  const points = raw.map((p, i): SegmentPoint => {
    const o = (p ?? {}) as Record<string, unknown>;
    const x = Number(o.x), y = Number(o.y), label = Number(o.label);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1 || (label !== 0 && label !== 1)) {
      throw new PhotoHttpError(400, `Point ${i + 1}: needs x and y between 0 and 1 and label 0 or 1.`);
    }
    return { x, y, label: label as 0 | 1 };
  });
  if (points.length && !points.some((p) => p.label === 1)) {
    throw new PhotoHttpError(400, 'Tap at least one point on the object (label 1).');
  }
  return { image, points };
}

// ---------- providers ----------

export interface SegmentProvider {
  id: string;
  costUsd: number;
  segment(image: PhotoImage, points: SegmentPoint[]): Promise<{ mask: string; box: SegmentResult['box'] }>;
}

class SegmentProviderError extends Error {}

const FAL_RUN = 'https://fal.run';

function sizeOf(image: PhotoImage): { w: number; h: number } {
  const b64 = image.dataUri.slice(image.dataUri.indexOf(',') + 1);
  const head = b64.length > 128 * 1024 ? b64.slice(0, 128 * 1024) : b64;
  const s = imageSize(base64ToBytes(head)) ?? imageSize(base64ToBytes(b64));
  if (!s) throw new PhotoHttpError(400, 'Could not read the photo size.');
  return s;
}

async function falRun(key: string, endpoint: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${FAL_RUN}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json', 'X-Fal-Store-IO': '0' },
    body: JSON.stringify({ ...body, sync_mode: true, output_format: 'png' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let detail = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(t) as { detail?: unknown };
      if (typeof j.detail === 'string') detail = j.detail;
      else if (Array.isArray(j.detail)) detail = j.detail.map((d) => (d && typeof d === 'object' && 'msg' in d ? String(d.msg) : String(d))).join('; ');
    } catch {
      /* not JSON */
    }
    throw new SegmentProviderError(`fal ${endpoint}: ${detail}`);
  }
  const out = (await res.json()) as { image?: { url?: unknown } };
  const url = typeof out.image?.url === 'string' ? out.image.url : '';
  if (url.startsWith('data:image/')) return url;
  if (/^https:\/\//.test(url)) {
    // sync_mode ignored: fetch the CDN file once and inline it.
    const g = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!g.ok) throw new SegmentProviderError(`fal mask download: HTTP ${g.status}`);
    const type = (g.headers.get('Content-Type') ?? 'image/png').split(';')[0];
    return `data:${type};base64,${bytesToBase64(new Uint8Array(await g.arrayBuffer()))}`;
  }
  throw new SegmentProviderError(`fal ${endpoint}: no mask in the response`);
}

export function falAutoSegmenter(key: string, costUsd: number): SegmentProvider {
  return {
    id: 'birefnet',
    costUsd,
    async segment(image) {
      const mask = await falRun(key, 'fal-ai/birefnet/v2', {
        image_url: image.dataUri,
        model: 'General Use (Light)',
        operating_resolution: '1024x1024',
        mask_only: true,
      });
      return { mask, box: null };
    },
  };
}

export function falPointSegmenter(key: string, costUsd: number): SegmentProvider {
  return {
    id: 'sam2',
    costUsd,
    async segment(image, points) {
      const { w, h } = sizeOf(image);
      const prompts = points.map((p) => ({
        x: Math.round(p.x * (w - 1)),
        y: Math.round(p.y * (h - 1)),
        label: p.label,
      }));
      const mask = await falRun(key, 'fal-ai/sam2/image', { image_url: image.dataUri, prompts, apply_mask: false });
      return { mask, box: null };
    },
  };
}

// ---------- mock (local dev) ----------

/** Work resolution of the mock (long side). */
const MOCK_SIDE = 320;

function downscale(img: RGBImage, side: number): RGBImage {
  const k = Math.min(1, side / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * k));
  const height = Math.max(1, Math.round(img.height * k));
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y / height) * img.height), y1 = Math.max(y0 + 1, Math.floor(((y + 1) / height) * img.height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x / width) * img.width), x1 = Math.max(x0 + 1, Math.floor(((x + 1) / width) * img.width));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 1)
        for (let xx = x0; xx < x1; xx += 1) {
          const o = (yy * img.width + xx) * 3;
          r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
        }
      const o = (y * width + x) * 3;
      data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n;
    }
  }
  return { width, height, data };
}

const dist = (d: Uint8Array, i: number, r: number, g: number, b: number) =>
  Math.hypot(d[i * 3] - r, d[i * 3 + 1] - g, d[i * 3 + 2] - b);

/** 4-connected flood from seeds; `ok(i, from)` decides whether pixel i joins (from = the pixel it came from). */
function flood(w: number, h: number, seeds: number[], ok: (i: number, from: number) => boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let head = 0, tail = 0;
  for (const s of seeds) if (!out[s]) { out[s] = 1; q[tail++] = s; }
  while (head < tail) {
    const i = q[head++];
    const x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && !out[j] && ok(j, i)) { out[j] = 1; q[tail++] = j; }
  }
  return out;
}

/** Labels of 4-connected components of `m` (0 = none). */
function components(w: number, h: number, m: Uint8Array): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(w * h);
  const sizes = [0];
  const q = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || label[s]) continue;
    const id = sizes.length;
    let head = 0, tail = 0;
    label[s] = id;
    q[tail++] = s;
    while (head < tail) {
      const i = q[head++];
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && m[i - 1] && !label[i - 1]) { label[i - 1] = id; q[tail++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !label[i + 1]) { label[i + 1] = id; q[tail++] = i + 1; }
      if (y > 0 && m[i - w] && !label[i - w]) { label[i - w] = id; q[tail++] = i - w; }
      if (y < h - 1 && m[i + w] && !label[i + w]) { label[i + w] = id; q[tail++] = i + w; }
    }
    sizes.push(tail);
  }
  return { label, sizes };
}

/**
 * Mock cut-out on a small copy of the photo: flood the background from the border (near-white pixels or
 * pixels close to the border's median colour, stepping only between similar neighbours), keep the largest
 * remaining blob. With points: blobs under positive points (or a colour region grown from the point),
 * minus colour regions grown from negative points.
 */
export function mockMaskSmall(img: RGBImage, points: SegmentPoint[]): Uint8Array {
  const { width: w, height: h, data: d } = img;
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const med = [0, 1, 2].map((c) => {
    const v = border.map((i) => d[i * 3 + c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  const bgLike = (i: number) => {
    const r = d[i * 3], g = d[i * 3 + 1], b = d[i * 3 + 2];
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    return dist(d, i, med[0], med[1], med[2]) < 48 || (mn > 205 && mx - mn < 28);
  };
  const bg = flood(w, h, border.filter(bgLike), (j, from) => bgLike(j) && dist(d, j, d[from * 3], d[from * 3 + 1], d[from * 3 + 2]) < 28);
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) raw[i] = bg[i] ? 0 : 1;
  const { label, sizes } = components(w, h, raw);
  const pix = (p: SegmentPoint) => Math.min(h - 1, Math.round(p.y * (h - 1))) * w + Math.min(w - 1, Math.round(p.x * (w - 1)));
  const grow = (seed: number, tol: number, within?: Uint8Array) => {
    const r = d[seed * 3], g = d[seed * 3 + 1], b = d[seed * 3 + 2];
    return flood(w, h, [seed], (j) => (!within || within[j] === 1) && dist(d, j, r, g, b) < tol);
  };

  const mask = new Uint8Array(w * h);
  const pos = points.filter((p) => p.label === 1);
  if (!pos.length) {
    let best = 0;
    for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[best]) best = k;
    if (best) for (let i = 0; i < w * h; i++) mask[i] = label[i] === best ? 1 : 0;
    return mask;
  }
  for (const p of pos) {
    const i = pix(p);
    if (label[i]) {
      for (let k = 0; k < w * h; k++) if (label[k] === label[i]) mask[k] = 1;
    } else {
      const g = grow(i, 40);
      for (let k = 0; k < w * h; k++) if (g[k]) mask[k] = 1;
    }
  }
  for (const p of points.filter((q) => q.label === 0)) {
    const i = pix(p);
    if (!mask[i]) continue;
    const g = grow(i, 36, mask);
    for (let k = 0; k < w * h; k++) if (g[k]) mask[k] = 0;
  }
  // Positive points always win over a negative region that swallowed them.
  for (const p of pos) mask[pix(p)] = 1;
  return mask;
}

function boxOf(w: number, h: number, m: Uint8Array): SegmentResult['box'] {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (m[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return [r(x0 / w), r(y0 / h), r((x1 + 1) / w), r((y1 + 1) / h)];
}

export function mockSegmenter(delayMs = 600): SegmentProvider {
  return {
    id: 'mock',
    costUsd: 0,
    async segment(image, points) {
      const t0 = Date.now();
      const b64 = image.dataUri.slice(image.dataUri.indexOf(',') + 1);
      let full: RGBImage | null = null;
      try {
        full = await decodeImage(base64ToBytes(b64));
      } catch {
        full = null; // e.g. a progressive JPEG: fall back to a centred ellipse
      }
      let w: number, h: number, small: Uint8Array, sw: number, sh: number;
      if (full) {
        w = full.width;
        h = full.height;
        const s = downscale(full, MOCK_SIDE);
        sw = s.width;
        sh = s.height;
        small = mockMaskSmall(s, points);
      } else {
        const sz = sizeOf(image);
        w = sz.w;
        h = sz.h;
        sw = 64;
        sh = 64;
        small = new Uint8Array(sw * sh);
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) small[y * sw + x] = ((x - 31.5) / 22) ** 2 + ((y - 31.5) / 26) ** 2 <= 1 ? 1 : 0;
      }
      const gray = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
        for (let x = 0; x < w; x++) gray[y * w + x] = small[sy * sw + Math.min(sw - 1, Math.floor((x * sw) / w))] ? 255 : 0;
      }
      const png = await encodeGrayPng(w, h, gray);
      const wait = delayMs - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return { mask: `data:image/png;base64,${bytesToBase64(png)}`, box: boxOf(sw, sh, small) };
    },
  };
}

// ---------- selection from env ----------

export interface SegmentEnv {
  PHOTO_PROVIDER?: string;
  FAL_KEY?: string;
  /** fal | mock | off. Default: mock when PHOTO_PROVIDER is mock (or no FAL_KEY), else fal. */
  PHOTO_SEGMENT?: string;
  /** Booked cost per cut-out call (USD), default 0.003. */
  PHOTO_SEGMENT_COST_USD?: string;
  /** Cut-out calls per user per UTC day, default 60 (OWNER_EMAIL is exempt). */
  PHOTO_SEGMENT_DAILY_LIMIT?: string;
  PHOTO_MOCK_DELAY_MS?: string;
}

export interface SegmentSelection {
  auto: SegmentProvider | null;
  points: SegmentProvider | null;
  unavailableReason?: string;
  dailyLimit: number;
}

export function selectSegmenters(env: SegmentEnv): SegmentSelection {
  const num = (v: string | undefined, d: number) => {
    const n = v === undefined || v === '' ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const dailyLimit = Math.floor(num(env.PHOTO_SEGMENT_DAILY_LIMIT, DEFAULT_SEGMENT_DAILY_LIMIT));
  const provider = (env.PHOTO_PROVIDER || (env.FAL_KEY ? 'fal' : 'mock')).trim().toLowerCase();
  const want = (env.PHOTO_SEGMENT || (provider === 'mock' ? 'mock' : 'fal')).trim().toLowerCase();
  if (want === 'mock') {
    const m = mockSegmenter(Math.min(1500, num(env.PHOTO_MOCK_DELAY_MS, 5000) / 8));
    return { auto: m, points: m, dailyLimit };
  }
  if (want === 'off') return { auto: null, points: null, dailyLimit, unavailableReason: 'Automatic cut-out is turned off on this server.' };
  if (want === 'fal') {
    if (!env.FAL_KEY) return { auto: null, points: null, dailyLimit, unavailableReason: 'Automatic cut-out is not set up yet (FAL_KEY missing).' };
    const cost = num(env.PHOTO_SEGMENT_COST_USD, DEFAULT_SEGMENT_COST_USD);
    return { auto: falAutoSegmenter(env.FAL_KEY, cost), points: falPointSegmenter(env.FAL_KEY, cost), dailyLimit };
  }
  return { auto: null, points: null, dailyLimit, unavailableReason: `Unknown PHOTO_SEGMENT "${env.PHOTO_SEGMENT}".` };
}

// ---------- service ----------

export interface SegmentDeps {
  store: JobStore & SegmentLog;
  sel: SegmentSelection;
  /** Monthly budget shared with photo jobs (PHOTO_BUDGET_USD). */
  budgetUsd: number;
  now?: () => number;
}

export async function segmentPhoto(d: SegmentDeps, user: string, body: unknown, opts: { owner?: boolean } = {}): Promise<SegmentResult> {
  const { image, points } = validateSegmentInput(body);
  const provider = points.length ? d.sel.points : d.sel.auto;
  if (!provider) throw new PhotoHttpError(503, d.sel.unavailableReason ?? 'Automatic cut-out is not available.');
  const t = (d.now ?? Date.now)();
  const [used, spent] = await Promise.all([
    d.store.countSegmentsSince(user, startOfUtcDay(t)),
    d.store.spendSince(startOfUtcMonth(t)),
  ]);
  if (!opts.owner && used >= d.sel.dailyLimit) {
    const retry = Math.ceil((startOfUtcDay(t) + 86_400_000 - t) / 1000);
    throw new PhotoHttpError(429, `Daily cut-out limit reached (${d.sel.dailyLimit} per day). Use the full photo, or try again tomorrow.`, {
      'Retry-After': String(retry),
    });
  }
  if (d.budgetUsd - spent < provider.costUsd) {
    throw new PhotoHttpError(429, `This month's Photo to Bricks budget ($${round2(d.budgetUsd)}) is used up. Use the full photo.`);
  }
  try {
    const r = await provider.segment(image, points);
    await d.store.recordSegment({ user, created_at: t, model: provider.id, cost_usd: provider.costUsd, ok: true });
    return { mask: r.mask, box: r.box, model: provider.id, costUsd: provider.costUsd };
  } catch (err) {
    if (err instanceof PhotoHttpError) throw err;
    console.error(`[photo] ${provider.id} cut-out failed:`, errText(err));
    // Counted against the daily limit (abuse guard), but nothing is booked: fal bills successful runs.
    await d.store.recordSegment({ user, created_at: t, model: provider.id, cost_usd: 0, ok: false }).catch(() => {});
    throw new PhotoHttpError(502, "Couldn't cut out the object this time. Try again, or use the full photo.");
  }
}
