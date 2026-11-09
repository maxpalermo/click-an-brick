// Photo to Bricks: runtime-agnostic job service (validation, quotas, provider polling, fallback).
// No Node imports: bundled into the Cloudflare Worker (cloud/src/photo.ts, D1 + R2) and used by the
// Express dev server (server/src/photo/routes.ts, in-memory store). Contract: app/src/photo/types.ts.
// Design: docs/PHOTO_TO_BRICKS.md §3.
import { ALPHABET } from '../model-validation.js';
import type { CheckResult, PhotoProvider, ProviderId } from './providers.js';
import type { PhotoAnalysis, VisionProvider } from './vision.js';

// The contract types live in the app; duplicated structurally here so the server build (rootDir=src)
// does not reach into app/. The client imports the originals; keep these in sync with
// app/src/photo/types.ts (PhotoMode, PhotoJobStatus, PhotoJob, PhotoQuota).
export type PhotoMode = 'object' | 'lego';
export type PhotoJobStatus = 'queued' | 'running' | 'done' | 'failed';
/** Owner-only model override (POST /api/photo/jobs { model }). 'trellis' = the default fal provider. */
export type PhotoModel = 'trellis' | 'trellis2' | 'tripo-mv';
export const PHOTO_MODELS: readonly PhotoModel[] = ['trellis', 'trellis2', 'tripo-mv'];
/** Name reported as `model` in GET /api/photo/jobs/:id (the provider that made / is making the GLB). */
export const MODEL_OF_PROVIDER: Record<ProviderId, string> = {
  fal: 'trellis',
  'fal-trellis2': 'trellis2',
  'fal-tripo': 'tripo-mv',
  stability: 'spar3d',
  mock: 'mock',
};
export interface PhotoJobView {
  id: string;
  status: PhotoJobStatus;
  mode: PhotoMode;
  /** trellis | trellis2 | tripo-mv | spar3d | mock (additive, optional in the contract). */
  model?: string;
  progress: number | null;
  error?: string;
  createdAt: string;
  /** Vision analysis of the photo(s) (server/src/photo/vision.ts); absent until ready, or if it failed. */
  analysis?: PhotoAnalysis;
}
export interface PhotoQuotaView {
  remainingToday: number;
  budgetLeftUsd: number;
  /** Quality builds (4 sides + top, Tripo); absent when the server cannot make them. */
  quality?: QualityQuotaView;
}
export interface QualityQuotaView {
  /** Quality builds left this month (the owner is never blocked, but sees the same counter). */
  remaining: number;
  /** Monthly allowance (PHOTO_QUALITY_MONTHLY; a membership will raise it later). */
  monthly: number;
  /** Used this month, net of refunds for failed builds. */
  used: number;
  /** Credits never block this user (OWNER_EMAIL). */
  unlimited: boolean;
}

// ---------- limits ----------

/** Front + up to 4 more: back, side, or (4-side capture) right / back / left, plus an optional top view. */
export const MAX_IMAGES = 5;
/** Max decoded size per image. */
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
/** Max decoded size of all photos of one job together (must fit the body limit as base64: 4.4 MB → 5.9 MB). */
export const MAX_TOTAL_IMAGE_BYTES = 4.4 * 1024 * 1024;
/** Max JSON body for POST /api/photo/jobs: base64(4.4 MB) ≈ 5.87 MB + JSON slack, capped at 6 MB. */
export const MAX_PHOTO_BODY_BYTES = 6 * 1024 * 1024;
/** Human wording of the limits, for 413 messages (Express + Worker). */
export const PHOTO_SIZE_LIMIT_TEXT = 'max 1.5 MB each, 5 photos, 4.4 MB in total';
/** Max GLB we accept from a provider. */
export const MAX_GLB_BYTES = 50 * 1024 * 1024;
/** A GET may ask the provider for status at most this often per job. */
export const CHECK_INTERVAL_MS = 3000;
/** An async provider job older than this is given up on (client gives up after 5 min). */
export const PROVIDER_TIMEOUT_MS = 4 * 60 * 1000;
/** A synchronous provider call (Stability) still "running" after this is assumed lost. */
export const SYNC_TIMEOUT_MS = 2 * 60 * 1000;

export const DEFAULT_DAILY_LIMIT = 20;
export const DEFAULT_BUDGET_USD = 20;
/** Quality builds per user per month while the app is private (no payments yet). */
export const DEFAULT_QUALITY_MONTHLY = 10;
/** A quality build needs these sides (a top photo is optional but recommended: it goes to the vision step). */
export const QUALITY_VIEWS: readonly PhotoView[] = ['front', 'right', 'back', 'left'];

export const JOB_ID_LEN = 12;
const JOB_ID_RE = new RegExp(`^[${ALPHABET}]{${JOB_ID_LEN}}$`);
export const isValidJobId = (id: string) => JOB_ID_RE.test(id);

export function newJobId(): string {
  // Uniform pick via rejection sampling (31 symbols; reject bytes ≥ 248 = 8*31).
  let s = '';
  const buf = new Uint8Array(32);
  while (s.length < JOB_ID_LEN) {
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 248 && s.length < JOB_ID_LEN) s += ALPHABET[b % ALPHABET.length];
  }
  return s;
}

export class PhotoHttpError extends Error {
  constructor(public status: number, message: string, public headers?: Record<string, string>) {
    super(message);
  }
}

// ---------- validation ----------

const DATA_URI_RE = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]*={0,2})$/;

/**
 * Which side of the subject a photo shows. 'side' = left or right, unknown which (the app's 3-shot flow);
 * 'right' / 'left' = the side on the viewer's right / left when facing the front (4-side capture: front, a quarter turn to the right, back, left); 'top' = from
 * directly above. 'top' goes to the vision step only: the image-to-3D models (TRELLIS, Tripo) take side views.
 */
export type PhotoView = 'front' | 'right' | 'back' | 'left' | 'side' | 'top';
export const PHOTO_VIEWS: readonly PhotoView[] = ['front', 'right', 'back', 'left', 'side', 'top'];
/** Default view order when a job sends no `views` (1–3 photos, unchanged from before). */
const LEGACY_VIEWS: readonly PhotoView[] = ['front', 'back', 'side'];
const VIEW_LABEL: Record<PhotoView, string> = {
  front: 'Front photo', right: 'Right photo', back: 'Back photo', left: 'Left photo', side: 'Side photo', top: 'Top photo',
};
/** Views the 3D providers can use (everything except 'top'). */
export const isSideView = (v: PhotoView) => v !== 'top';

export interface PhotoImage {
  mime: 'image/jpeg' | 'image/png';
  /** Which side it shows (from `views`, else by position: front, back, side). */
  view: PhotoView;
  /** The original data URI (sent as-is to providers that accept data URIs). */
  dataUri: string;
  bytes: number;
}

function decodedLength(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Decode a base64 string to bytes (atob exists in Workers and Node ≥ 16). */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function dataUriToBytes(uri: string): { mime: string; bytes: Uint8Array } {
  const m = DATA_URI_RE.exec(uri);
  if (!m) throw new Error('Not an image data URI.');
  return { mime: m[1], bytes: base64ToBytes(m[2]) };
}

/** Owner-only "model" field: undefined when absent; 400 when present but unknown. */
export function parsePhotoModel(body: unknown): PhotoModel | undefined {
  const m = body && typeof body === 'object' ? (body as Record<string, unknown>).model : undefined;
  if (m === undefined || m === null || m === '') return undefined;
  if (typeof m !== 'string' || !(PHOTO_MODELS as readonly string[]).includes(m)) {
    throw new PhotoHttpError(400, '"model" must be one of ' + PHOTO_MODELS.join(', ') + '.');
  }
  return m as PhotoModel;
}

/** One photo: base64 JPEG/PNG data URI, ≤ MAX_IMAGE_BYTES, magic bytes matching the declared type. */
export function validateImage(img: unknown, which: string): PhotoImage {
  if (typeof img !== 'string') throw new PhotoHttpError(400, `${which}: must be a data URI string.`);
  const m = DATA_URI_RE.exec(img);
  if (!m) throw new PhotoHttpError(400, `${which}: must be a base64 JPEG or PNG data URI (data:image/jpeg;base64,…).`);
  const b64 = m[2];
  if (b64.length % 4 !== 0) throw new PhotoHttpError(400, `${which}: invalid base64 data.`);
  const bytes = decodedLength(b64);
  if (bytes === 0) throw new PhotoHttpError(400, `${which}: image is empty.`);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new PhotoHttpError(413, `${which} is too large (${(bytes / 1024 / 1024).toFixed(1)} MB, max 1.5 MB). Resize it to 1024 px.`);
  }
  // Magic bytes must match the declared type.
  const head = base64ToBytes(b64.slice(0, 12));
  const mime = m[1] as PhotoImage['mime'];
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if ((mime === 'image/jpeg' && !isJpeg) || (mime === 'image/png' && !isPng)) {
    throw new PhotoHttpError(400, `${which}: file content is not a valid ${mime === 'image/jpeg' ? 'JPEG' : 'PNG'}.`);
  }
  return { mime, dataUri: img, bytes, view: 'front' };
}

/**
 * `views` (optional, additive): one entry per image saying which side it shows. Must include "front"
 * (the job reorders it first), each view at most once, and "side" cannot be combined with "left"/"right"
 * (say which side it is). Without `views` the order is front, back, side (1–3 photos only), so a
 * front + side job must send views: ['front', 'side'] and 4–5 photo jobs must always send `views`.
 */
export function parseViews(v: unknown, n: number): PhotoView[] {
  if (v === undefined || v === null) {
    if (n > LEGACY_VIEWS.length) throw new PhotoHttpError(400, `\`views\` is required with more than ${LEGACY_VIEWS.length} photos.`);
    return LEGACY_VIEWS.slice(0, n) as PhotoView[];
  }
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => (PHOTO_VIEWS as readonly unknown[]).includes(x))) {
    throw new PhotoHttpError(400, `\`views\` must list one of ${PHOTO_VIEWS.map((x) => `"${x}"`).join(', ')} for each photo.`);
  }
  if (!v.includes('front') || new Set(v).size !== v.length) {
    throw new PhotoHttpError(400, '`views` must include "front" and name each side at most once.');
  }
  if (v.includes('side') && (v.includes('left') || v.includes('right'))) {
    throw new PhotoHttpError(400, '`views`: use "left"/"right" or "side", not both.');
  }
  return v as PhotoView[];
}

/** Validated job input. `images` is ordered front first (then as sent); top views are kept for vision. */
export function validatePhotoJobInput(body: unknown): { images: PhotoImage[]; mode: PhotoMode } {
  if (!body || typeof body !== 'object') throw new PhotoHttpError(400, 'Body must be a JSON object { images, mode }.');
  const { images, mode, views } = body as Record<string, unknown>;
  if (mode !== 'object' && mode !== 'lego') throw new PhotoHttpError(400, '`mode` must be "object" or "lego".');
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_IMAGES) {
    throw new PhotoHttpError(400, `\`images\` must be an array of 1–${MAX_IMAGES} photos (front first, then back and/or side, or right/back/left/top with \`views\`).`);
  }
  const vs = parseViews(views, images.length);
  const out: PhotoImage[] = images.map((img, i) => ({ ...validateImage(img, VIEW_LABEL[vs[i]]), view: vs[i] }));
  const total = out.reduce((s, i) => s + i.bytes, 0);
  if (total > MAX_TOTAL_IMAGE_BYTES) {
    throw new PhotoHttpError(413, `The photos are too large together (${(total / 1024 / 1024).toFixed(1)} MB, ${PHOTO_SIZE_LIMIT_TEXT}).`);
  }
  // Front first (fallback and single-image providers use images[0]); the rest keep their order.
  return { images: [...out.filter((i) => i.view === 'front'), ...out.filter((i) => i.view !== 'front')], mode };
}

// ---------- storage interfaces ----------

/** One row of D1 `photo_jobs` (cloud/migrations/0002_photo_jobs.sql). Times are epoch ms. */
export interface PhotoJobRow {
  id: string;
  user: string;
  status: PhotoJobStatus;
  mode: PhotoMode;
  provider: ProviderId;
  /** Provider-specific request handle (fal: JSON with request_id/status_url/response_url/cancel_url). */
  provider_req: string | null;
  created_at: number;
  updated_at: number;
  last_checked_at: number;
  glb_key: string | null;
  /** Money committed to providers for this job (USD). Summed for the monthly budget. */
  cost_usd: number;
  error: string | null;
  progress: number | null;
  /** Temporary R2 key of the front photo, kept only while a Stability fallback may still be needed. */
  input_key: string | null;
  /** PhotoAnalysis JSON from the vision step (migration 0003); null until ready / when it failed. */
  analysis_json?: string | null;
}

export interface JobStore {
  insert(row: PhotoJobRow): Promise<void>;
  get(id: string): Promise<PhotoJobRow | null>;
  /**
   * Apply `patch` if the row still matches `expect` (optimistic concurrency, e.g. status/provider/
   * last_checked_at). Returns true when the row was changed.
   */
  update(id: string, patch: Partial<PhotoJobRow>, expect?: Partial<PhotoJobRow>): Promise<boolean>;
  countUserSince(user: string, since: number): Promise<number>;
  /** Committed spend since `since`: photo_jobs.cost_usd plus cut-out calls (photo_segments, segment.ts). */
  spendSince(since: number): Promise<number>;
  /** Append to the credit ledger (D1 photo_credits, migration 0005). */
  addCredit(row: CreditRow): Promise<void>;
  /** Signed sum of a user's ledger rows of these kinds created since `since`. */
  creditSumSince(user: string, since: number, kinds: readonly CreditKind[]): Promise<number>;
  /** Ledger rows of a job (to refund a failed quality build exactly once). */
  creditsOfJob(jobId: string): Promise<CreditRow[]>;
}

/**
 * Credit ledger: one row per change of a user's quality-build balance. Today the balance is the monthly
 * allowance (PhotoConfig.qualityMonthly) + this month's rows. A membership or packs will add 'grant' rows
 * (with expires_at) from the payment webhook; the balance rule then extends to unexpired grants.
 */
export type CreditKind = 'use' | 'refund' | 'grant';
export interface CreditRow {
  user: string;
  created_at: number;
  kind: CreditKind;
  /** use = -1, refund = +1, grant = +n. */
  amount: number;
  job_id: string | null;
  expires_at?: number | null;
  note?: string | null;
}

export interface BlobObject {
  body: ReadableStream | Uint8Array;
  size: number;
}

export interface BlobStore {
  put(key: string, data: ArrayBuffer | Uint8Array | string, contentType: string): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  getText(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export const glbKey = (id: string) => `photo-out/${id}.glb`;
export const inputKey = (id: string) => `photo-in/${id}.txt`;

// ---------- service ----------

export interface PhotoConfig {
  dailyLimit: number;
  budgetUsd: number;
  qualityMonthly: number;
}

export interface PhotoDeps {
  store: JobStore;
  blobs: BlobStore;
  /** null when the configured provider cannot run (e.g. PHOTO_PROVIDER=fal without FAL_KEY). */
  primary: PhotoProvider | null;
  /** Second vendor used once when the primary fails (Stability SPAR3D, front photo only). */
  fallback: PhotoProvider | null;
  /** Owner-only model override providers ("model" in POST /api/photo/jobs). No fallback for these. */
  models?: Partial<Record<PhotoModel, PhotoProvider>>;
  config: PhotoConfig;
  /** Keep background work alive after the response (Worker: ctx.waitUntil). */
  defer: (p: Promise<unknown>) => void;
  /** Why `primary` is null, for the 503 message. */
  unavailableReason?: string;
  /** Vision step run in parallel with the 3D job (null/absent = no analysis). Never fails the job. */
  vision?: VisionProvider | null;
  now?: () => number;
}

export function parseConfig(env: { PHOTO_DAILY_LIMIT?: string; PHOTO_BUDGET_USD?: string; PHOTO_QUALITY_MONTHLY?: string }): PhotoConfig {
  const num = (v: string | undefined, d: number) => {
    const n = v === undefined || v === '' ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    dailyLimit: Math.floor(num(env.PHOTO_DAILY_LIMIT, DEFAULT_DAILY_LIMIT)),
    budgetUsd: num(env.PHOTO_BUDGET_USD, DEFAULT_BUDGET_USD),
    qualityMonthly: Math.floor(num(env.PHOTO_QUALITY_MONTHLY, DEFAULT_QUALITY_MONTHLY)),
  };
}

export const startOfUtcDay = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
export const startOfUtcMonth = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
export const round2 = (n: number) => Math.round(n * 100) / 100;
const short = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function toView(row: PhotoJobRow): PhotoJobView {
  const v: PhotoJobView = {
    id: row.id,
    status: row.status,
    mode: row.mode,
    model: MODEL_OF_PROVIDER[row.provider] ?? row.provider,
    progress: row.status === 'done' ? 1 : row.progress,
    createdAt: new Date(row.created_at).toISOString(),
  };
  if (row.status === 'failed') v.error = row.error ?? 'The photo could not be turned into a 3D model.';
  if (row.analysis_json) {
    try {
      v.analysis = JSON.parse(row.analysis_json) as PhotoAnalysis;
    } catch {
      /* corrupt row: leave analysis absent */
    }
  }
  return v;
}

export class PhotoService {
  private now: () => number;
  constructor(private d: PhotoDeps) {
    this.now = d.now ?? Date.now;
  }

  /** 'claude' | 'mock' | null (no vision step), for logs. */
  get visionId(): string | null {
    return this.d.vision?.id ?? null;
  }

  /** `owner`: exempt from the daily limit (create() checks the same flag), so report the full allowance. */
  async quota(user: string, owner = false): Promise<PhotoQuotaView> {
    const t = this.now();
    const [used, spent, quality] = await Promise.all([
      this.d.store.countUserSince(user, startOfUtcDay(t)),
      this.d.store.spendSince(startOfUtcMonth(t)),
      this.qualityProvider() ? this.qualityQuota(user, owner) : Promise.resolve(undefined),
    ]);
    return {
      remainingToday: owner ? this.d.config.dailyLimit : Math.max(0, this.d.config.dailyLimit - used),
      budgetLeftUsd: Math.max(0, round2(this.d.config.budgetUsd - spent)),
      ...(quality ? { quality } : {}),
    };
  }

  /** Quality builds left this month: allowance + this month's ledger (uses −1, refunds +1, grants +n). */
  async qualityQuota(user: string, owner = false): Promise<QualityQuotaView> {
    const since = startOfUtcMonth(this.now());
    const [net, granted] = await Promise.all([
      this.d.store.creditSumSince(user, since, ['use', 'refund']),
      this.d.store.creditSumSince(user, since, ['grant']),
    ]);
    const monthly = this.d.config.qualityMonthly + granted;
    const usedNet = Math.max(0, -net);
    return { remaining: Math.max(0, monthly - usedNet), monthly, used: usedNet, unlimited: owner };
  }

  /** Tripo multiview (the owner A/B 'tripo-mv' provider); the mock stands in for it in local dev. */
  private qualityProvider(): PhotoProvider | null {
    return this.d.models?.['tripo-mv'] ?? (this.d.primary?.id === 'mock' ? this.d.primary : null);
  }

  /**
   * opts.owner (Access email == OWNER_EMAIL): honours body.model and skips the daily limit (the
   * monthly budget still applies). For everyone else body.model is ignored.
   */
  async create(user: string, body: unknown, opts: { owner?: boolean } = {}): Promise<{ jobId: string }> {
    const { images, mode } = validatePhotoJobInput(body);
    const quality = (body as Record<string, unknown>).quality === true;
    if (quality) {
      const views = new Set(images.map((i) => i.view));
      if (!QUALITY_VIEWS.every((v) => views.has(v))) {
        throw new PhotoHttpError(400, 'A quality build needs 4 photos: front, right, back and left (plus an optional top photo).');
      }
    }
    const model = opts.owner && !quality ? parsePhotoModel(body) : undefined;
    // With the mock (local dev) there are no model providers: the override is ignored.
    const override = quality ? this.qualityProvider() : model ? (this.d.models?.[model] ?? null) : null;
    if (quality && !override) throw new PhotoHttpError(503, 'Quality builds are not available on this server right now.');
    const primary = override ?? this.d.primary;
    if (!primary) throw new PhotoHttpError(503, this.d.unavailableReason ?? 'Photo to Bricks is not configured on this server.');

    if (quality && !opts.owner) {
      const qq = await this.qualityQuota(user);
      if (qq.remaining <= 0) {
        throw new PhotoHttpError(
          402,
          `You've used all ${qq.monthly} quality builds for this month. They reset on the 1st; standard builds (2 photos) are still available.`,
        );
      }
    }

    const q = await this.quota(user);
    if (q.remainingToday <= 0 && !opts.owner) {
      const t = this.now();
      const retry = Math.ceil((startOfUtcDay(t) + 86_400_000 - t) / 1000);
      throw new PhotoHttpError(
        429,
        `Daily limit reached: ${this.d.config.dailyLimit} photo models per person per day. It resets at midnight UTC.`,
        { 'Retry-After': String(retry) },
      );
    }
    if (q.budgetLeftUsd <= 0 || q.budgetLeftUsd < primary.costUsd) {
      throw new PhotoHttpError(
        429,
        `This month's Photo to Bricks budget ($${round2(this.d.config.budgetUsd)}) is used up. It resets on the 1st; the owner can raise PHOTO_BUDGET_USD.`,
      );
    }

    const t = this.now();
    const id = newJobId();
    const row: PhotoJobRow = {
      id,
      user,
      status: 'queued',
      mode,
      provider: primary.id,
      provider_req: null,
      created_at: t,
      updated_at: t,
      last_checked_at: t,
      glb_key: null,
      cost_usd: primary.costUsd,
      error: null,
      progress: null,
      input_key: null,
      analysis_json: null,
    };
    // Keep the front photo only if a fallback may need it later (deleted when the job ends).
    // Owner A/B jobs (override) never fall back: a Stability result would pollute the comparison.
    if (this.d.fallback && !primary.sync && !override) {
      row.input_key = inputKey(id);
      await this.d.blobs.put(row.input_key, images[0].dataUri, 'text/plain');
    }
    await this.d.store.insert(row);
    // Debit one quality credit; refunded in finish() if the build fails.
    if (quality) await this.d.store.addCredit({ user, created_at: t, kind: 'use', amount: -1, job_id: id, note: primary.id });
    // The 3D models get the side views only; a top view goes to the vision step alone.
    const sides = images.filter((i) => isSideView(i.view));
    console.log(
      `[photo] job ${id}: ${mode}, ${images.length} photo(s) (${images.map((i) => i.view).join(', ')}) → ${primary.id} gets ${sides.map((i) => i.view).join(', ')}`,
    );

    // Vision runs in the background, in parallel with the 3D job. Skipped when the budget can't cover it.
    const vision = this.d.vision;
    if (vision && q.budgetLeftUsd >= primary.costUsd + vision.maxCostUsd) {
      this.d.defer(this.runVision(id, vision, images, mode));
    }

    if (primary.sync) {
      await this.d.store.update(id, { status: 'running', updated_at: this.now() });
      this.d.defer(this.runSync(id, primary, images[0].dataUri));
      return { jobId: id };
    }
    try {
      const req = await primary.submit(sides, mode);
      await this.d.store.update(id, { provider_req: req, updated_at: this.now() });
    } catch (err) {
      console.error(`[photo] ${primary.id} submit failed for ${id}:`, err);
      // The provider never accepted the job → nothing was spent on it.
      await this.d.store.update(id, { cost_usd: 0 });
      await this.fallbackOrFail(row, `The 3D service rejected the request: ${short(errText(err))}`, override ? undefined : images[0].dataUri);
    }
    return { jobId: id };
  }

  async get(user: string, id: string): Promise<PhotoJobView> {
    let row = await this.load(user, id);
    if (row.status === 'done' || row.status === 'failed') return toView(row);
    const t = this.now();
    if (t - row.last_checked_at < CHECK_INTERVAL_MS) return toView(row);
    // Claim this check slot so concurrent polls don't hit the provider twice.
    if (!(await this.d.store.update(id, { last_checked_at: t }, { last_checked_at: row.last_checked_at }))) {
      return toView((await this.d.store.get(id)) ?? row);
    }
    row = { ...row, last_checked_at: t };

    const provider = this.providerFor(row.provider);
    if (!provider) {
      await this.finish(row, { status: 'failed', error: 'The 3D service for this job is no longer configured.' });
    } else if (provider.sync) {
      if (t - row.updated_at > SYNC_TIMEOUT_MS) {
        await this.finish(row, { status: 'failed', error: 'The 3D service took too long. Please try again.' }, { status: 'running', provider: row.provider });
      }
    } else if (!row.provider_req) {
      // Submission still in flight (or lost before it was recorded).
      if (t - row.created_at > 60_000) await this.finish(row, { status: 'failed', error: 'The job could not be started. Please try again.' });
    } else {
      let r: CheckResult;
      try {
        r = await provider.check(row.provider_req);
      } catch (err) {
        // Transient (network / 5xx at the provider): keep polling until the timeout.
        console.error(`[photo] ${provider.id} status check failed for ${id}:`, err);
        r = { state: row.status === 'running' ? 'running' : 'queued', progress: row.progress };
      }
      if (r.state === 'done') {
        await this.storeResult(row, r.glb);
      } else if (r.state === 'failed') {
        await this.fallbackOrFail(row, r.error);
      } else if (t - row.created_at > (provider.timeoutMs ?? PROVIDER_TIMEOUT_MS)) {
        provider.cancel?.(row.provider_req).catch(() => {});
        await this.fallbackOrFail(row, 'The 3D service took too long.');
      } else {
        await this.d.store.update(
          id,
          { status: r.state, progress: r.progress, updated_at: t },
          { status: row.status, provider: row.provider },
        );
      }
    }
    return toView((await this.d.store.get(id)) ?? row);
  }

  async model(user: string, id: string): Promise<BlobObject> {
    const row = await this.load(user, id);
    if (row.status !== 'done' || !row.glb_key) {
      throw new PhotoHttpError(409, row.status === 'failed' ? 'This job failed; there is no model.' : 'The model is not ready yet.');
    }
    const obj = await this.d.blobs.get(row.glb_key);
    if (!obj) throw new PhotoHttpError(410, 'This model has expired (results are kept for 7 days). Take the photos again.');
    return obj;
  }

  // ---------- internals ----------

  private async load(user: string, id: string): Promise<PhotoJobRow> {
    if (!isValidJobId(id)) throw new PhotoHttpError(400, 'Invalid job id.');
    const row = await this.d.store.get(id);
    // Someone else's job looks exactly like a missing one.
    if (!row || row.user !== user) throw new PhotoHttpError(404, 'Photo job not found.');
    return row;
  }

  private providerFor(id: ProviderId): PhotoProvider | null {
    if (this.d.primary?.id === id) return this.d.primary;
    if (this.d.fallback?.id === id) return this.d.fallback;
    for (const p of Object.values(this.d.models ?? {})) if (p?.id === id) return p;
    return null;
  }

  private async storeResult(row: PhotoJobRow, glb: ArrayBuffer): Promise<void> {
    if (!isGlb(glb)) {
      await this.fallbackOrFail(row, 'The 3D service returned an invalid model file.');
      return;
    }
    const key = glbKey(row.id);
    await this.d.blobs.put(key, glb, 'model/gltf-binary');
    await this.finish(row, { status: 'done', glb_key: key, progress: 1, error: null });
  }

  /** Terminal transition; also drops the temporary input photo and refunds a failed quality build. */
  private async finish(row: PhotoJobRow, patch: Partial<PhotoJobRow>, expect?: Partial<PhotoJobRow>): Promise<boolean> {
    const ok = await this.d.store.update(row.id, { ...patch, input_key: null, updated_at: this.now() }, expect);
    if (ok && row.input_key) await this.d.blobs.delete(row.input_key).catch(() => {});
    if (ok && patch.status === 'failed') await this.refundCredit(row).catch((err) => console.error(`[photo] refund failed for ${row.id}:`, err));
    return ok;
  }

  /** Give back the credit of a failed quality build, once (the ledger is the record of what was refunded). */
  private async refundCredit(row: PhotoJobRow): Promise<void> {
    const rows = await this.d.store.creditsOfJob(row.id);
    const net = rows.reduce((s, r) => s + (r.kind === 'use' || r.kind === 'refund' ? r.amount : 0), 0);
    if (net >= 0) return;
    await this.d.store.addCredit({ user: row.user, created_at: this.now(), kind: 'refund', amount: -net, job_id: row.id, note: 'build failed' });
  }

  /** Switch to the fallback provider once, or mark the job failed. */
  private async fallbackOrFail(row: PhotoJobRow, error: string, front?: string): Promise<void> {
    const fb = this.d.fallback;
    const fresh = (await this.d.store.get(row.id)) ?? row;
    if (fb && fresh.provider !== fb.id) {
      const image = front ?? (fresh.input_key ? await this.d.blobs.getText(fresh.input_key) : null);
      const q = await this.quota(row.user);
      if (image && q.budgetLeftUsd >= fb.costUsd) {
        // Claim the switch (only one poller wins).
        const claimed = await this.d.store.update(
          row.id,
          {
            provider: fb.id,
            provider_req: null,
            status: 'running',
            progress: null,
            cost_usd: fresh.cost_usd + fb.costUsd,
            updated_at: this.now(),
          },
          { provider: fresh.provider, status: fresh.status },
        );
        if (claimed) {
          console.warn(`[photo] ${row.id}: ${fresh.provider} failed (${error}) → falling back to ${fb.id}`);
          this.d.defer(this.runSync(row.id, fb, image));
        }
        return;
      }
    }
    await this.finish(fresh, { status: 'failed', error: `${error.replace(/[.\s]*$/, '.')} Please try again with a clear photo of one object.` });
  }

  /** Vision step: store the analysis and add its cost. Errors are logged, never surfaced to the job. */
  private async runVision(id: string, vision: VisionProvider, images: PhotoImage[], mode: PhotoMode): Promise<void> {
    let cost = 0;
    try {
      const r = await vision.analyze(images, mode);
      cost = r.costUsd;
      await this.d.store.update(id, { analysis_json: JSON.stringify(r.analysis) });
    } catch (err) {
      const c = Number((err as { costUsd?: unknown } | null)?.costUsd);
      if (Number.isFinite(c)) cost = c;
      console.error(`[photo] ${vision.id} vision failed for ${id}:`, errText(err));
    }
    if (cost > 0) await this.addCost(id, cost);
  }

  /** Add to cost_usd without overwriting a concurrent change (optimistic retry on the old value). */
  private async addCost(id: string, usd: number): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const row = await this.d.store.get(id);
      if (!row) return;
      const next = Math.round((row.cost_usd + usd) * 1e6) / 1e6;
      if (await this.d.store.update(id, { cost_usd: next }, { cost_usd: row.cost_usd })) return;
    }
    console.error(`[photo] could not record vision cost ${usd} for ${id}`);
  }

  /** Run a synchronous provider (Stability) in the background. */
  private async runSync(id: string, provider: PhotoProvider, front: string): Promise<void> {
    const row = await this.d.store.get(id);
    if (!row) return;
    try {
      const glb = await provider.run!(front);
      if (!isGlb(glb)) throw new Error('response is not a GLB');
      const key = glbKey(id);
      await this.d.blobs.put(key, glb, 'model/gltf-binary');
      await this.finish(row, { status: 'done', glb_key: key, progress: 1, error: null }, { provider: provider.id, status: 'running' });
    } catch (err) {
      console.error(`[photo] ${provider.id} failed for ${id}:`, err);
      // Stability charges only successful generations; keep any earlier (primary, vision) cost.
      const fresh = (await this.d.store.get(id)) ?? row;
      await this.finish(
        row,
        {
          status: 'failed',
          cost_usd: Math.max(0, fresh.cost_usd - provider.costUsd),
          error: `The 3D service could not process this photo (${short(errText(err), 120)}). Please try again.`,
        },
        { provider: provider.id, status: 'running' },
      );
    }
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** GLB header: magic "glTF" (0x46546C67 little-endian), version 2. */
export function isGlb(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 20 || buf.byteLength > MAX_GLB_BYTES) return false;
  const v = new DataView(buf);
  return v.getUint32(0, true) === 0x46546c67 && v.getUint32(4, true) === 2;
}
