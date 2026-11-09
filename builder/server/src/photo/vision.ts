// Photo to Bricks: vision step. The photo(s) go to Claude (Anthropic Messages API, image input) at job
// creation, in parallel with the image-to-3D job; the answer is a PhotoAnalysis (category, symmetry,
// subject box, features with boxes, palette, isBrickBuilt, colorRegions, brickSize, and for buildings / castles
// `structures`: walls, towers, arches, windows, roofs… with boxes) that the converter uses to place special parts
// and to build architecture from LEGO recipes. One call per job; structures need no extra call.
// Runtime-agnostic (only the SDK, which uses fetch): bundled into the Worker and used by Express.
// Contract: app/src/photo/convert/contracts.ts (PhotoAnalysis, PM-owned) — duplicated structurally here
// because the server build (rootDir=src) cannot import from app/. Keep in sync.
//
// Model: claude-sonnet-5-5 ($2 / $10 per MTok). It is in the high-resolution vision tier (up to 2576 px,
// coordinates 1:1 with image pixels), which is what box accuracy needs, at half the Opus 5.5 price. A
// typical call is ~1.4k image tokens per 1024 px photo + ~1.2k prompt tokens in, ~0.8–0.9k tokens out
// (JSON + a little thinking at effort "low") → ≈ $0.012 for one photo, ≈ $0.015 for front + back, ≈ $0.018 with a
// side photo too. Buildings / castles also return `structures` (+ ~1–2.5k output tokens ≈ +$0.01–0.025; prompt
// +~0.9k tokens ≈ +$0.002 for every photo), so a 5-view castle is ≈ $0.04–0.05.
// claude-opus-5-5 would be 2× that (≈ $0.03); claude-haiku-5-5 ≈ $0.001 but weaker at localisation.
// VISION_MODEL lets the owner switch. The real cost (from response usage) is added to the job's cost_usd.
import Anthropic from '@anthropic-ai/sdk';
import type { PhotoImage, PhotoMode } from './core.js';

// ---------- contract (copy of app/src/photo/convert/contracts.ts) ----------

export type Symmetry = 'left-right' | 'front-back' | 'both' | 'radial' | 'none';
export type FeatureKind =
  | 'wheel' | 'windscreen' | 'window' | 'headlight' | 'taillight' | 'grille' | 'bumper'
  | 'door' | 'roof' | 'eye' | 'mouth' | 'ear' | 'leg' | 'arm' | 'handle' | 'spout' | 'text-or-logo' | 'other';
export type Box = [number, number, number, number];
export interface PhotoFeature {
  kind: FeatureKind;
  view: 'front' | 'back';
  box: Box;
  mirrored: boolean;
  color?: string;
  confidence: number;
}
export interface PhotoAnalysis {
  category: string;
  symmetry: Symmetry;
  subjectBox: Box;
  features: PhotoFeature[];
  palette: string[];
  isBrickBuilt: boolean;
  /** LEGO-build photos only: real size from counting studs / brick courses (target size without a reference brick). */
  brickSize?: BrickSize;
  /** Named true material colours (no shading), 2–6 regions; the converter snaps sampled colours to them. */
  colorRegions?: ColorRegion[];
  /** Architectural structures (buildings / castles only) the converter builds from LEGO recipes. */
  structures?: PhotoStructure[];
  notes?: string;
}
export interface BrickSize { studsWide: number; studsDeep: number; plates: number; confidence: number }
export interface ColorRegion { name: string; color: string; share: number }
export type StructureKind =
  | 'wall' | 'column' | 'arch' | 'window' | 'door' | 'tower' | 'battlements' | 'roof' | 'stairs' | 'balcony' | 'fence';
export type StructureView = 'front' | 'back' | 'right' | 'left' | 'side';
export interface PhotoStructure {
  kind: StructureKind;
  view: StructureView;
  box: Box;
  /** column/tower round|square; arch/window/door top round|pointed|square; roof gable|hip|cone|pyramid|flat. */
  shape?: string;
  /** Repeats inside the box (default 1). */
  count?: number;
  color?: string;
  confidence: number;
}

export const SYMMETRIES: readonly Symmetry[] = ['left-right', 'front-back', 'both', 'radial', 'none'];
export const FEATURE_KINDS: readonly FeatureKind[] = [
  'wheel', 'windscreen', 'window', 'headlight', 'taillight', 'grille', 'bumper',
  'door', 'roof', 'eye', 'mouth', 'ear', 'leg', 'arm', 'handle', 'spout', 'text-or-logo', 'other',
];
export const STRUCTURE_KINDS: readonly StructureKind[] = [
  'wall', 'column', 'arch', 'window', 'door', 'tower', 'battlements', 'roof', 'stairs', 'balcony', 'fence',
];
/** Allowed `shape` per kind (anything else is dropped). */
export const STRUCTURE_SHAPES: Partial<Record<StructureKind, readonly string[]>> = {
  column: ['round', 'square'],
  tower: ['round', 'square'],
  arch: ['round', 'pointed', 'square'],
  window: ['round', 'pointed', 'square'],
  door: ['round', 'pointed', 'square'],
  roof: ['gable', 'hip', 'cone', 'pyramid', 'flat'],
};
const SHAPE_ENUM = ['round', 'square', 'pointed', 'gable', 'hip', 'cone', 'pyramid', 'flat', 'none'] as const;
export const MAX_STRUCTURES = 40;
/** Suggested categories (the contract allows any string; these keep answers consistent). */
export const CATEGORIES = [
  'car', 'truck', 'bus', 'train', 'plane', 'boat', 'bike', 'house', 'building', 'animal', 'figure',
  'mug', 'teapot', 'bottle', 'shoe', 'plant', 'furniture', 'other',
] as const;

// ---------- provider interface ----------

export interface VisionResult {
  analysis: PhotoAnalysis;
  /** Money spent on this call (USD), estimated from token usage. */
  costUsd: number;
}

export interface VisionProvider {
  id: 'claude' | 'mock';
  /** Upper estimate per call (USD), used to check the monthly budget before calling. */
  maxCostUsd: number;
  analyze(images: PhotoImage[], mode: PhotoMode): Promise<VisionResult>;
}

export const DEFAULT_VISION_MODEL = 'claude-sonnet-5-5';
/** A vision call must finish within the Worker's waitUntil grace period (~30 s after the response). */
export const VISION_TIMEOUT_MS = 25_000;
// 6000 since structures (buildings only) were added: a castle can need ~1.5–2.5k extra output tokens; a cut-off
// answer loses the whole analysis, so the cap is generous (non-buildings still answer in ~1k).
const MAX_TOKENS = 6000;

/** USD per million tokens (claude-api skill pricing table, 2026-10). Unknown models → Opus 5.5 rates. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
};
const priceOf = (model: string) => PRICES[model] ?? PRICES['claude-opus-5-5'];

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Cost of one call. Cache writes are billed at 1.25× input. */
export function usageCostUsd(model: string, u: Usage): number {
  const p = priceOf(model);
  const usd =
    (u.input_tokens * p.input +
      (u.cache_creation_input_tokens ?? 0) * p.input * 1.25 +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      u.output_tokens * p.output) /
    1e6;
  return Math.round(usd * 1e6) / 1e6;
}

/** Rough upper bound before the call: ~1.6k tokens per photo + 2.5k prompt in, MAX_TOKENS/2 out (up to 5 photos). */
export function estimateMaxCostUsd(model: string, images = 5): number {
  return usageCostUsd(model, { input_tokens: 2500 + 1600 * images, output_tokens: MAX_TOKENS / 2 });
}

// ---------- image size (to normalise pixel boxes) ----------

/** Width/height from a JPEG (SOFn) or PNG (IHDR) header; null when unreadable. */
export function imageSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length >= 24) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const m = bytes[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = (bytes[i + 5] << 8) | bytes[i + 6];
      const w = (bytes[i + 7] << 8) | bytes[i + 8];
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

function b64Bytes(b64: string, n: number): Uint8Array {
  // Decode only the start of the image (enough for the header in practice), falling back to all of it.
  const tryDecode = (s: string) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  return tryDecode(b64.length > n ? b64.slice(0, n - (n % 4)) : b64);
}

function sizeOfDataUri(uri: string): { w: number; h: number } | null {
  const b64 = uri.slice(uri.indexOf(',') + 1);
  return imageSize(b64Bytes(b64, 96 * 1024)) ?? imageSize(b64Bytes(b64, b64.length));
}

// ---------- validation / clamping (never trust the model's JSON) ----------

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const HEX_RE = /^#?([0-9a-f]{6})$/i;
const hex = (v: unknown): string | undefined => {
  const m = typeof v === 'string' ? HEX_RE.exec(v.trim()) : null;
  return m ? `#${m[1].toUpperCase()}` : undefined;
};

/**
 * Box from the model → fractions [x0,y0,x1,y1] in 0–1. Accepts {x0,y0,x1,y1} or a 4-array, in pixels of
 * an image of size `dim` (values > 1.5 are taken as pixels) or already as fractions. null if unusable.
 */
export function toBox(v: unknown, dim: { w: number; h: number } | null): Box | null {
  let a: unknown[] | null = null;
  if (Array.isArray(v)) a = v;
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    a = [o.x0, o.y0, o.x1, o.y1];
  }
  if (!a || a.length !== 4) return null;
  const n = a.map(Number);
  if (!n.every(Number.isFinite)) return null;
  const pixels = n.some((x) => x > 1.5);
  if (pixels && !dim) return null;
  const [x0, y0, x1, y1] = pixels ? [n[0] / dim!.w, n[1] / dim!.h, n[2] / dim!.w, n[3] / dim!.h] : n;
  const b: Box = [clamp01(Math.min(x0, x1)), clamp01(Math.min(y0, y1)), clamp01(Math.max(x0, x1)), clamp01(Math.max(y0, y1))];
  if (b[2] - b[0] < 0.002 || b[3] - b[1] < 0.002) return null;
  return b.map((x) => Math.round(x * 1000) / 1000) as Box;
}

/**
 * brickSize from the model: whole studs 1–96 and plates 1–288 (a 1-brick-high model is 3 plates), confidence 0–1.
 * null when missing, zero (the schema asks for zeros on non-LEGO photos) or not finite.
 */
export function toBrickSize(v: unknown): BrickSize | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const w = Math.round(Number(o.studsWide)), d = Math.round(Number(o.studsDeep)), p = Math.round(Number(o.plates));
  const c = Number(o.confidence);
  if (![w, d, p, c].every(Number.isFinite) || w < 1 || d < 1 || p < 1 || c <= 0) return null;
  return {
    studsWide: Math.min(96, w),
    studsDeep: Math.min(96, d),
    plates: Math.min(288, p),
    confidence: Math.round(clamp01(c) * 100) / 100,
  };
}

/**
 * colorRegions from the model: valid #RRGGBB, non-empty name (≤ 40 chars), share > 0; at most 6, largest share
 * first, shares normalised to sum 1; regions with the same colour are merged. null when fewer than 1 survives.
 */
export function toColorRegions(v: unknown): ColorRegion[] | null {
  if (!Array.isArray(v)) return null;
  const out: ColorRegion[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const color = hex(o.color);
    const share = Number(o.share);
    if (!color || !Number.isFinite(share) || share <= 0) continue;
    const name = (typeof o.name === 'string' ? o.name.trim().slice(0, 40) : '') || 'region';
    const same = out.find((x) => x.color === color);
    if (same) same.share += share;
    else out.push({ name, color, share });
  }
  if (!out.length) return null;
  out.sort((a, b) => b.share - a.share);
  const top = out.slice(0, 6);
  const sum = top.reduce((s, r) => s + r.share, 0);
  return top.map((r) => ({ ...r, share: Math.round((r.share / sum) * 1000) / 1000 }));
}

type Dim = { w: number; h: number } | null;
/** Image sizes of the photos the request actually had (a key is present only when that view was sent). */
export type ViewDims = Partial<Record<StructureView, Dim>>;

/**
 * structures from the model: known kind, a view the request had (never TOP), a usable box in that photo; shape kept
 * only when valid for the kind; count a whole number 1–64 (omitted when 1); confidence 0–1; at most MAX_STRUCTURES.
 * Returns [] when nothing survives (also for non-buildings, which the prompt asks to answer with an empty list).
 */
export function toStructures(v: unknown, dims: ViewDims): PhotoStructure[] {
  const out: PhotoStructure[] = [];
  for (const s of Array.isArray(v) ? v : []) {
    if (out.length >= MAX_STRUCTURES) break;
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const kind = typeof r.kind === 'string' ? (r.kind.trim().toLowerCase() as StructureKind) : null;
    if (!kind || !STRUCTURE_KINDS.includes(kind)) continue;
    const view = typeof r.view === 'string' ? (r.view.trim().toLowerCase() as StructureView) : 'front';
    if (!(view in dims)) continue; // TOP, unknown, or a view the request did not have
    const box = toBox(r.box, dims[view] ?? null);
    if (!box) continue;
    const shape = typeof r.shape === 'string' ? r.shape.trim().toLowerCase() : '';
    const okShape = STRUCTURE_SHAPES[kind]?.includes(shape) ? shape : undefined;
    const n = Math.round(Number(r.count));
    const count = Number.isFinite(n) && n > 1 ? Math.min(64, n) : undefined;
    const color = hex(r.color);
    const conf = Number(r.confidence);
    out.push({
      kind,
      view,
      box,
      ...(okShape ? { shape: okShape } : {}),
      ...(count ? { count } : {}),
      ...(color ? { color } : {}),
      confidence: Number.isFinite(conf) ? Math.round(clamp01(conf) * 100) / 100 : 0.5,
    });
  }
  return out;
}

/** Coerce anything into a contract-valid PhotoAnalysis (or null when there is nothing usable). */
export function sanitizeAnalysis(
  raw: unknown,
  dims: {
    front: Dim;
    back: Dim;
    hasBack: boolean;
    /** RIGHT / LEFT / SIDE photo sizes, keyed only for views the request had (for structures). */
    sides?: Partial<Record<'right' | 'left' | 'side', Dim>>;
  },
  // Features seen only in a SIDE / RIGHT / LEFT / TOP photo are dropped: the contract (PhotoFeature.view) has
  // front/back only, and the converter places parts from front/back boxes. Those photos still inform brickSize,
  // symmetry and colours. Structures keep RIGHT / LEFT / SIDE boxes (the contract has those views), never TOP.
): PhotoAnalysis | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const category =
    typeof o.category === 'string' && o.category.trim()
      ? o.category.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').slice(0, 40) || 'other'
      : 'other';
  const symmetry = (SYMMETRIES as readonly string[]).includes(o.symmetry as string) ? (o.symmetry as Symmetry) : 'none';
  const subjectBox = toBox(o.subjectBox, dims.front) ?? [0, 0, 1, 1];
  const features: PhotoFeature[] = [];
  for (const f of Array.isArray(o.features) ? o.features : []) {
    if (!f || typeof f !== 'object' || features.length >= 40) continue;
    const r = f as Record<string, unknown>;
    if (r.view !== undefined && r.view !== 'front' && r.view !== 'back') continue;
    const view = r.view === 'back' ? 'back' : 'front';
    if (view === 'back' && !dims.hasBack) continue;
    const box = toBox(r.box, view === 'back' ? dims.back : dims.front);
    if (!box) continue;
    const kind = (FEATURE_KINDS as readonly string[]).includes(r.kind as string) ? (r.kind as FeatureKind) : 'other';
    const conf = Number(r.confidence);
    const color = hex(r.color);
    features.push({
      kind,
      view,
      box,
      mirrored: r.mirrored === true,
      ...(color ? { color } : {}),
      confidence: Number.isFinite(conf) ? Math.round(clamp01(conf) * 100) / 100 : 0.5,
    });
  }
  const palette = [...new Set((Array.isArray(o.palette) ? o.palette : []).map(hex).filter((c): c is string => !!c))].slice(0, 6);
  const a: PhotoAnalysis = { category, symmetry, subjectBox, features, palette, isBrickBuilt: o.isBrickBuilt === true };
  const brickSize = a.isBrickBuilt ? toBrickSize(o.brickSize) : null;
  if (brickSize) a.brickSize = brickSize;
  const colorRegions = toColorRegions(o.colorRegions);
  if (colorRegions) a.colorRegions = colorRegions;
  const structures = toStructures(o.structures, {
    front: dims.front,
    ...(dims.hasBack ? { back: dims.back } : {}),
    ...(dims.sides ?? {}),
  });
  if (structures.length) a.structures = structures;
  if (typeof o.notes === 'string' && o.notes.trim()) a.notes = o.notes.trim().slice(0, 600);
  return a;
}

// ---------- prompt + schema ----------

export const VISION_SYSTEM = `You look at photos for a LEGO designer who will rebuild the subject as a brick model. Report what a designer needs to choose special parts and keep the model symmetric.

Coordinates: integer pixels of the image they refer to, origin top-left, boxes as {x0, y0, x1, y1} (left, top, right, bottom), tight around the visible part.

Photos: always a FRONT photo; sometimes a BACK photo (from behind) and/or a SIDE photo (from the left or right, roughly 90° from the front, unknown which), or RIGHT and LEFT photos (taken about 90° from the front: RIGHT = the side on the viewer's right when facing the front, LEFT = the side on the viewer's left), and sometimes a TOP photo taken from directly above. Each is labelled before it. Background was usually removed (subject on white).
- The TOP photo is the best view of the roof layout and the footprint: use it to understand which parts are towers, roofs, courtyards or terraces and where they sit, and to count studs for studsWide / studsDeep (count the studs, plate edges and wall courses along both horizontal sides). Its rotation is not fixed: match its edges to the side photos with distinctive details before relying on directions. Do not report features or structures (boxes) from the TOP photo.

- subjectBox: the main subject in the FRONT photo only (ignore background objects and other items).
- category: what the subject is.
- symmetry: the mirror symmetry a builder would use for the real object. "left-right" = mirror plane through the object's own centre line, as for a car seen from its front, a face or a figure; "front-back" = mirror plane containing the long axis, e.g. a mug or teapot whose handle and spout lie in that plane; "both"; "radial" (round pots, bowls, bottles, plants); "none".
- features: every part a LEGO designer would build with a special or contrasting part: wheels (each visible wheel), windscreen, windows, headlights, taillights, grille, bumper, doors, roof, eyes, mouth or beak, ears, legs, arms, handles, spouts, text or logos; anything else distinctive as "other". One box per visible instance, in the photo it is seen in ("front" or "back"; parts visible ONLY in a SIDE / RIGHT / LEFT photo get that view, "side", "right" or "left"). Use the SIDE / RIGHT / LEFT photos to understand depth, hidden sides and whether parts are mirrored. Set mirrored = true when the part has a twin on the opposite side of the mirror plane (left and right wheels, eyes, doors), even if the twin is hidden. color = its real colour (for windows: the glass tint). confidence 0–1.
- palette: up to 6 dominant colours of the subject (not the background), most important first, as #RRGGBB.
- colorRegions: 2–6 regions a LEGO designer would give one brick colour each (e.g. body, roof, tyres, beak), largest first. color = the TRUE material colour as #RRGGBB, as the object would look in even, diffuse light: ignore shadows, shading, highlights, reflections and the colour cast of the light (a light-blue car is light blue on its shadowed side too; glossy white is white, not grey). share = rough fraction of the visible surface (0–1, together about 1). Merge areas that are the same material even when they look darker or lighter in the photo; keep genuinely different materials apart even when similar. Tiny details (eyes, lights, logos) need not be listed. For a LEGO build (isBrickBuilt), give the official colour of the LEGO elements themselves, e.g. Red #B40000, Blue #1E5AA8, Yellow #FAC80A, Green #00852B, Black #1B2A34, White #F4F4F4, Light Bluish Grey #969696, Dark Bluish Grey #646464, Tan #D7BA8C: studio light makes bricks look lighter and paler than they are, so judge each colour against the others in the same photo (for transparent parts give the tint).
- isBrickBuilt: true only if the subject itself is already built from LEGO-style bricks (visible studs, brick seams).
- brickSize (only when isBrickBuilt, else all 0): the model's real size in LEGO units, measured by counting. studsWide and studsDeep = the footprint of the whole model in studs along its two horizontal sides (count the studs on top surfaces and along plate / brick edges; the longer side may be either), (a SIDE / RIGHT / LEFT photo shows the depth directly: count studsDeep there; with a TOP photo count both footprint sides on it and cross-check with the side views), plates = total height in plate heights (a brick = 3 plates, a plate or tile = 1; count the brick courses and plates from the ground to the top, including the base plate, roof plates and anything on top). confidence 0–1: how sure the count is (high when studs and courses are clearly visible, low when hidden or ambiguous).
- structures (ONLY when the subject is a building, house, castle, church, tower, bridge or similar architecture; otherwise an empty list): the big architectural pieces a LEGO designer would build from a known recipe instead of plain filler bricks. They decide whether the model reads as the right building, so recognisable overall form matters far more than small flat detail: report the large structures first and skip tiny surface decoration (posters, plaques, single bricks, plants, figures, accessories). Kinds:
  - wall: a large plain wall section or wing of the building (one box per wall face, not per course).
  - tower: a part that rises clearly above the main walls as its own volume (shape "round" or "square"). One structure per tower, from its foot to the top of its walls; its battlements and roof are separate structures.
  - battlements: the crenellated top of a wall or tower (alternating merlons and gaps). One box per crenellated edge; count = number of merlons.
  - roof: a sloped or flat roof surface over a part of the building (shape "gable", "hip", "cone" for a round tower's pointed roof, "pyramid" for a square spire, "flat" for a terrace or flat top). One per distinct roof.
  - column: a free-standing or engaged pillar (shape "round" or "square"). A colonnade of identical columns = one box with count.
  - arch: an arched opening or arcade without a door or glass (gate passage, blind arch, arcade bay); shape = the top ("round", "pointed", "square").
  - window: a window opening or slit; shape = its top. A row of identical windows at the same height = one box around the whole row with count.
  - door: an entrance door or gate with a door leaf; shape = its top.
  - stairs: a staircase or steps.
  - balcony: a balcony, gallery, overhanging walkway or machicolation ledge.
  - fence: a fence, railing, palisade or low parapet that is not crenellated.
  Rules: box tight around the whole structure in the photo it is seen in, view = that photo ("front", "back", "right", "left" or "side"; never the TOP photo). Prefer the FRONT photo; add a structure from another photo only when it is not visible (or not clear) in the FRONT photo, so each real structure is listed once. count = how many identical repeats are inside the box (1 when single). color = its real material colour as #RRGGBB (as for colorRegions). shape = "none" when the kind has no shape option or it is unclear. confidence 0–1. At most about 30 structures, biggest and most recognisable first. Keep listing doors, windows and roofs under features as well (features are unchanged).
- notes: one or two sentences on the overall shape and construction (e.g. "stepped roof of 4 layers", "uses 2x4 bricks, studs on top").`;

const BOX_SCHEMA = {
  type: 'object',
  properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } },
  required: ['x0', 'y0', 'x1', 'y1'],
  additionalProperties: false,
} as const;

export const VISION_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...CATEGORIES] },
    symmetry: { type: 'string', enum: [...SYMMETRIES] },
    subjectBox: BOX_SCHEMA,
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...FEATURE_KINDS] },
          view: { type: 'string', enum: ['front', 'back', 'side', 'right', 'left'] },
          box: BOX_SCHEMA,
          mirrored: { type: 'boolean' },
          color: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['kind', 'view', 'box', 'mirrored', 'color', 'confidence'],
        additionalProperties: false,
      },
    },
    palette: { type: 'array', items: { type: 'string' } },
    colorRegions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, color: { type: 'string' }, share: { type: 'number' } },
        required: ['name', 'color', 'share'],
        additionalProperties: false,
      },
    },
    isBrickBuilt: { type: 'boolean' },
    brickSize: {
      type: 'object',
      properties: { studsWide: { type: 'number' }, studsDeep: { type: 'number' }, plates: { type: 'number' }, confidence: { type: 'number' } },
      required: ['studsWide', 'studsDeep', 'plates', 'confidence'],
      additionalProperties: false,
    },
    structures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...STRUCTURE_KINDS] },
          view: { type: 'string', enum: ['front', 'back', 'right', 'left', 'side'] },
          box: BOX_SCHEMA,
          shape: { type: 'string', enum: [...SHAPE_ENUM] },
          count: { type: 'integer' },
          color: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['kind', 'view', 'box', 'shape', 'count', 'color', 'confidence'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['category', 'symmetry', 'subjectBox', 'features', 'palette', 'colorRegions', 'isBrickBuilt', 'brickSize', 'structures', 'notes'],
  additionalProperties: false,
} as const;

const B64_RE = /^data:(image\/(?:jpeg|png));base64,(.*)$/;

// ---------- Claude provider ----------

export function claudeVisionProvider(apiKey: string, model = DEFAULT_VISION_MODEL): VisionProvider {
  // No retries: a second attempt would not fit in the Worker's background window; the job does not need it.
  const client = new Anthropic({ apiKey, timeout: VISION_TIMEOUT_MS, maxRetries: 0 });
  return {
    id: 'claude',
    maxCostUsd: estimateMaxCostUsd(model),
    async analyze(images, mode) {
      const dims = images.map((i) => sizeOfDataUri(i.dataUri));
      const viewOf = (img: PhotoImage, i: number): string => img.view ?? (i === 0 ? 'front' : i === 1 ? 'back' : 'side');
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      images.forEach((img, i) => {
        const m = B64_RE.exec(img.dataUri);
        if (!m) throw new Error('bad image data URI');
        const d = dims[i];
        content.push({ type: 'text', text: `${viewOf(img, i).toUpperCase()} photo${d ? ` (${d.w}×${d.h} px)` : ''}:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: m[1] as 'image/jpeg' | 'image/png', data: m[2] } });
      });
      const views = images.map(viewOf);
      const backIdx = views.indexOf('back');
      const extra = [
        backIdx >= 0 ? 'The BACK photo shows the same subject from behind (roughly opposite side).' : '',
        views.includes('side') ? 'The SIDE photo shows the same subject from the left or right (about 90° from the front).' : '',
        views.includes('right') ? "The RIGHT photo shows the side that is on your right when you face the front (a quarter turn round to the right)." : '',
        views.includes('left') ? "The LEFT photo shows the side that is on your left when you face the front." : '',
        views.includes('top') ? 'The TOP photo looks straight down on the subject: use it for the roof layout, the footprint and the stud counts.' : '',
      ].filter(Boolean).join(' ');
      content.push({
        type: 'text',
        text:
          (extra ? `${extra} ` : 'Only a FRONT photo is available. ') +
          (mode === 'lego'
            ? 'The user says this is a photo of a LEGO model they want to rebuild.'
            : 'The user wants a brick model of this real object.') +
          ' Analyse it.',
      });

      const res = await client.beta.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        // Opt-in server-side fallback (claude-api skill default): if the model declines for policy reasons,
        // the API retries on its default fallback model inside the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: VISION_SYSTEM,
        // Low effort: a perception task; thinking adds cost without improving boxes much.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: VISION_SCHEMA } },
        messages: [{ role: 'user', content }],
      });
      // Price at the more expensive of the requested model and the one that served the turn.
      const costUsd = Math.max(usageCostUsd(model, res.usage), usageCostUsd(res.model, res.usage));
      if (res.stop_reason === 'refusal') throw Object.assign(new Error('vision model declined the photo'), { costUsd });
      if (res.stop_reason === 'max_tokens') throw Object.assign(new Error('vision answer was cut off'), { costUsd });
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw Object.assign(new Error('vision answer is not JSON'), { costUsd });
      }
      const sides: Partial<Record<'right' | 'left' | 'side', { w: number; h: number } | null>> = {};
      for (const v of ['right', 'left', 'side'] as const) {
        const i = views.indexOf(v);
        if (i >= 0) sides[v] = dims[i];
      }
      const analysis = sanitizeAnalysis(raw, { front: dims[0], back: backIdx >= 0 ? dims[backIdx] : null, hasBack: backIdx >= 0, sides });
      if (!analysis) throw Object.assign(new Error('vision answer is empty'), { costUsd });
      return { analysis, costUsd };
    },
  };
}

// ---------- mock (local dev, no key, no money) ----------

/** research/photo2brick/analysis/duck.json (the mock 3D provider returns the Khronos duck too). */
export const MOCK_ANALYSIS: PhotoAnalysis = {
  category: 'animal',
  symmetry: 'left-right',
  subjectBox: [0.15, 0.086, 0.871, 0.84],
  features: [
    { kind: 'eye', view: 'front', box: [0.297, 0.259, 0.339, 0.324], mirrored: true, color: '#E8E8F0', confidence: 0.95 },
    { kind: 'eye', view: 'front', box: [0.413, 0.322, 0.488, 0.389], mirrored: true, color: '#E8E8F0', confidence: 0.95 },
    { kind: 'mouth', view: 'front', box: [0.214, 0.356, 0.457, 0.513], mirrored: false, color: '#F28C28', confidence: 0.9 },
    { kind: 'other', view: 'front', box: [0.608, 0.496, 0.816, 0.776], mirrored: true, color: '#2E7DB5', confidence: 0.75 },
    { kind: 'other', view: 'front', box: [0.587, 0.086, 0.871, 0.52], mirrored: false, color: '#2A4FA8', confidence: 0.6 },
  ],
  palette: ['#2A4FA8', '#F28C28', '#2E7DB5', '#E8E8F0', '#1A1A1A'],
  isBrickBuilt: false,
  colorRegions: [
    { name: 'body', color: '#2A4FA8', share: 0.82 },
    { name: 'beak', color: '#F28C28', share: 0.08 },
    { name: 'wings', color: '#2E7DB5', share: 0.08 },
    { name: 'eyes', color: '#E8E8F0', share: 0.02 },
  ],
  notes:
    'Rubber duck, 3/4 view facing left. Beak = mouth (orange, curved/slope parts), eyes are round 1x1 tiles, wing is a lighter-blue curved panel on each side, upright curled tail at the back right (the last "other" box).',
};

/** Returns a fixture analysis (default: the duck) after a short delay. */
export function mockVisionProvider(load: () => Promise<PhotoAnalysis> = async () => MOCK_ANALYSIS, delayMs = 300): VisionProvider {
  return {
    id: 'mock',
    maxCostUsd: 0,
    async analyze() {
      await new Promise((r) => setTimeout(r, delayMs));
      return { analysis: structuredClone(await load()), costUsd: 0 };
    },
  };
}

// ---------- selection from env ----------

export interface VisionEnv {
  ANTHROPIC_API_KEY?: string;
  /** claude | mock | off. Default: claude with ANTHROPIC_API_KEY, mock with the mock 3D provider, else off. */
  PHOTO_VISION?: string;
  /** Model id for the vision call (default claude-sonnet-5-5). */
  VISION_MODEL?: string;
}

/** `photoProvider` = the selected 3D primary id ('mock' in local dev). */
export function selectVision(env: VisionEnv, photoProvider: string | undefined, loadMock?: () => Promise<PhotoAnalysis>): VisionProvider | null {
  const want = (env.PHOTO_VISION ?? '').trim().toLowerCase();
  if (want === 'off') return null;
  if (want === 'mock') return mockVisionProvider(loadMock);
  if (env.ANTHROPIC_API_KEY) return claudeVisionProvider(env.ANTHROPIC_API_KEY, env.VISION_MODEL?.trim() || DEFAULT_VISION_MODEL);
  // No key: fixtures only in local dev (mock 3D). In production the analysis is simply absent.
  return photoProvider === 'mock' ? mockVisionProvider(loadMock) : null;
}
