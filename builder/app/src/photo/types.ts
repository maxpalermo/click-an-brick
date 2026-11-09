// Shared contract for Photo to Bricks (M2). Design: docs/PHOTO_TO_BRICKS.md.
// Owners: cloud agent (API), engine agent (converter + worker), UI agent (camera flow). Change only via the PM.

import type { Brick } from '../model/types';
import type { PhotoAnalysis } from './convert/contracts';

// ---------- HTTP API (cloud/src/worker.ts and the Express mock in server/) ----------

export type PhotoMode = 'object' | 'lego';
export type PhotoJobStatus = 'queued' | 'running' | 'done' | 'failed';
/** Which side of the subject a photo shows in the app's capture flow (front is always the first photo). */
export type PhotoView = 'front' | 'back' | 'side';
/**
 * Views the API accepts (additive): also 'right' / 'left' (the side on the viewer's right / left when facing the front) and 'top'
 * (from directly above; used by the vision step only, never sent to the image-to-3D model). Up to 5 photos,
 * must include 'front', each view at most once, 'side' not combined with 'left'/'right'.
 */
export type PhotoApiView = PhotoView | 'right' | 'left' | 'top';

/** POST /api/photo/jobs */
export interface CreatePhotoJobRequest {
  /**
   * 1–5 JPEG or PNG data URIs: front first, then back and/or side (or right / back / left / top with `views`).
   * Long side ≤ 1024 px, EXIF stripped, ≤ 1.5 MB each and ≤ 4.4 MB together (the body limit is 6 MB).
   */
  images: string[];
  /** Which side each image shows (additive, optional; required with 4–5 photos). Default by position: front, back, side. */
  views?: PhotoApiView[];
  mode: PhotoMode;
  /** Owner-only A/B override (Access email == OWNER_EMAIL); ignored for everyone else. */
  model?: PhotoModel;
  /**
   * Quality build: Tripo multiview (~$0.30, ~2–3 min) instead of TRELLIS. Needs views front, right, back and left
   * (top optional but recommended). Uses one quality credit (PhotoQuota.quality), refunded if the build fails.
   * 402 when none are left this month. Ignores `model`.
   */
  quality?: boolean;
}

/** Image-to-3D models the owner can pick for A/B tests. Default (no model) = 'trellis'. */
export type PhotoModel = 'trellis' | 'trellis2' | 'tripo-mv';
export interface CreatePhotoJobResponse {
  jobId: string;
}

/** GET /api/photo/jobs/:id  (poll every 3 s, back off to 10 s, give up after 5 min) */
export interface PhotoJob {
  id: string;
  status: PhotoJobStatus;
  mode: PhotoMode;
  /** Model that made / is making the GLB: trellis | trellis2 | tripo-mv | spar3d (fallback) | mock. */
  model?: string;
  /** 0–1 when the provider reports it, else null. */
  progress: number | null;
  error?: string;
  createdAt: string;
  /** Vision analysis of the photo(s) (Claude, server/src/photo/vision.ts). Absent until ready, or if it failed. */
  analysis?: PhotoAnalysis;
}

/**
 * Errors are JSON `{ error: string }`: 400 bad input · 401 not logged in · 402 no quality builds left this month ·
 * 404 not found / not yours ·
 * 409 model not ready · 410 model expired · 413 too large · 429 daily limit or budget (Retry-After) · 503 not configured.
 */

/** GET /api/photo/jobs/:id/model.glb → binary GLB (status must be 'done'). */
export const photoModelUrl = (id: string) => `/by-backend/api/photo/jobs/${encodeURIComponent(id)}/model.glb`;

/** GET /api/photo/quota → how many runs are left (per user today, and global budget). */
export interface PhotoQuota {
  remainingToday: number;
  budgetLeftUsd: number;
  /** Quality builds (CreatePhotoJobRequest.quality); absent when the server cannot make them (hide the option). */
  quality?: QualityQuota;
}

/** Quality-build credits this month. Private beta: a monthly allowance; a membership / packs will raise it later. */
export interface QualityQuota {
  /** Left this month. */
  remaining: number;
  /** Allowance this month (PHOTO_QUALITY_MONTHLY plus any grants). */
  monthly: number;
  /** Used this month, net of refunds for failed builds. */
  used: number;
  /** Never blocked (the owner); still show the counter. */
  unlimited: boolean;
}

/**
 * POST /api/photo/segment — cut-out of ONE photo (front or back), server/src/photo/segment.ts.
 * No points: automatic salient-object mask (fal BiRefNet). Points: point-prompt mask (fal SAM 2).
 * Same auth, owner exemption and monthly budget as photo jobs; separate daily limit (default 60 calls).
 * The baseplate toggle is applied in the browser (app/src/photo/ui/cutout/mask.ts), so it needs no call.
 * Errors: 400 bad input · 413 too large · 429 daily limit / budget · 502 provider failed · 503 not set up.
 */
export interface SegmentRequest {
  /** JPEG or PNG data URI, ≤ 1.5 MB (the photo as taken, ≤ 1024 px). */
  image: string;
  /** Point prompts in 0–1 image fractions; label 1 = object, 0 = not the object. ≤ 24, ≥ 1 positive. */
  points?: SegmentPoint[];
}
export interface SegmentPoint {
  x: number;
  y: number;
  label: 0 | 1;
}
export interface SegmentResponse {
  /** PNG data URI; bright/opaque = subject. May differ in size from the photo (the client scales it). */
  mask: string;
  /** Subject box [x0, y0, x1, y1] in 0–1 fractions when the server computed it, else null (client computes). */
  box: [number, number, number, number] | null;
  /** birefnet | sam2 | mock */
  model: string;
  costUsd: number;
}

// ---------- Converter (app/src/photo/convert/**, runs in a Web Worker) ----------

export interface ConvertOptions {
  /** Longest dimension of the model in studs (from the grid overlay). Ignored when lduPerUnit is set. */
  sizeStuds?: number;
  /** Exact scale from the reference-brick tap (B): LDraw units per mesh unit. */
  lduPerUnit?: number;
  /** 'lego' mode: snap the voxel grid to the real stud lattice (20 LDU × 8 LDU). */
  mode: PhotoMode;
  /** Keep only a shell to save parts. */
  hollow: boolean;
  /** Use bricks as well as plates (default true). */
  allowBricks?: boolean;
  /**
   * How much the converter approximates (default 'balanced'): smoother shape, fewer colours and bigger parts at
   * 'simple', closest to the AI mesh at 'detailed'. Also picks the size when neither sizeStuds nor lduPerUnit is set
   * (simple 16, balanced 24, detailed 32 studs; more for elongated objects).
   */
  detail?: DetailLevel;
  /** Vision analysis from the job (PhotoJob.analysis), when available: guides symmetry and special parts. */
  analysis?: PhotoAnalysis;
}

export type DetailLevel = 'simple' | 'balanced' | 'detailed';

export interface BomLine {
  part: string;
  color: number;
  count: number;
}

export interface ConvertResult {
  bricks: Omit<Brick, 'id'>[];
  bom: BomLine[];
  /**
   * cappedFrom: the requested longest side (studs) when it was over the converter's limit and the model was shrunk.
   * sizeSource: where the size came from ('reference' = measured from a reference brick (lduPerUnit), 'vision' = the
   * AI's stud count of a LEGO build (brickSize), 'user' = sizeStuds, 'default' = the detail level's default);
   * longestStuds: the longest side the model was converted at.
   */
  stats: { voxels: number; parts: number; colours: number; ms: number; cappedFrom?: number; sizeSource?: 'reference' | 'vision' | 'default' | 'user'; longestStuds?: number };
}

/** Messages between the UI and the converter worker. */
export type ConvertRequest = { type: 'convert'; glb: ArrayBuffer; options: ConvertOptions };
export type ConvertMessage =
  | { type: 'progress'; stage: 'load' | 'voxelize' | 'colour' | 'merge' | 'repair'; fraction: number }
  | { type: 'done'; result: ConvertResult }
  | { type: 'error'; message: string };

/** Engine-side entry point the UI calls (implemented in app/src/photo/convert/index.ts). */
export interface PhotoConverter {
  convert(glb: ArrayBuffer, options: ConvertOptions, onProgress?: (m: Extract<ConvertMessage, { type: 'progress' }>) => void): Promise<ConvertResult>;
  cancel(): void;
}
