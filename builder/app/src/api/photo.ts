// Typed client for the Photo to Bricks endpoints (contract: app/src/photo/types.ts).
// Same relative URLs in dev (Vite proxies /api → Express mock on :8787) and on Cloudflare.
import {
  photoModelUrl,
  type CreatePhotoJobRequest,
  type CreatePhotoJobResponse,
  type PhotoJob,
  type PhotoQuota,
  type SegmentRequest,
  type SegmentResponse,
} from '../photo/types';
import { ApiError, BASE } from './client';

export { ApiError };

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { credentials: 'same-origin', ...init });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError('Cannot reach the Brickyard server. Check your connection.', 0);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') msg = body.error;
    } catch {
      /* non-JSON error body (e.g. an Access login page) */
    }
    throw new ApiError(msg, res.status);
  }
  return res;
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

/** POST /api/photo/jobs. 400 invalid photos · 413 too big · 429 daily limit / monthly budget · 503 not set up. */
export async function createJob(req: CreatePhotoJobRequest, signal?: AbortSignal): Promise<CreatePhotoJobResponse> {
  const res = await call('/api/photo/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  return (await res.json()) as CreatePhotoJobResponse;
}

/** GET /api/photo/jobs/:id (one poll). `analysis` appears once the vision step is done (usually before the GLB). */
export async function getJob(id: string, signal?: AbortSignal): Promise<PhotoJob> {
  const res = await call(`/api/photo/jobs/${encodeURIComponent(id)}`, { signal, cache: 'no-store' });
  return (await res.json()) as PhotoJob;
}

/** POST /api/photo/segment: cut-out mask for one photo (auto, or refined with tap points). */
export async function segment(req: SegmentRequest, signal?: AbortSignal): Promise<SegmentResponse> {
  const res = await call('/api/photo/segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  return (await res.json()) as SegmentResponse;
}

/** GET /api/photo/quota. */
export async function getQuota(signal?: AbortSignal): Promise<PhotoQuota> {
  const res = await call('/api/photo/quota', { signal, cache: 'no-store' });
  return (await res.json()) as PhotoQuota;
}

/** GET /api/photo/jobs/:id/model.glb → GLB bytes (only once the job is 'done'). */
export async function fetchModel(id: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await call(photoModelUrl(id), { signal });
  return res.arrayBuffer();
}

export interface WaitOptions {
  signal?: AbortSignal;
  /** Called after every successful poll (for progress UI). */
  onUpdate?: (job: PhotoJob) => void;
  /** First poll delay, then ×1.5 per poll up to maxIntervalMs. Defaults 3 s → 10 s (contract). */
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Give up after this long (default 5 min, contract). */
  timeoutMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll a job until it is 'done' (resolves with it) or 'failed' (rejects with ApiError carrying the
 * server's message). Polls every 3 s backing off to 10 s, gives up after 5 min (ApiError status 408).
 * Abort with `signal` (rejects with the abort reason / AbortError). Up to 3 consecutive network or
 * 5xx errors are tolerated.
 */
export async function waitForJob(id: string, opts: WaitOptions = {}): Promise<PhotoJob> {
  const { signal, onUpdate } = opts;
  const maxInterval = opts.maxIntervalMs ?? 10_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  let interval = opts.intervalMs ?? 3000;
  let errors = 0;
  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    let job: PhotoJob | null = null;
    try {
      job = await getJob(id, signal);
      errors = 0;
    } catch (err) {
      if (isAbort(err) || signal?.aborted) throw abortError(signal);
      const transient = err instanceof ApiError && (err.status === 0 || err.status >= 500);
      if (!transient || ++errors > 3) throw err;
    }
    if (job) {
      onUpdate?.(job);
      if (job.status === 'done') return job;
      if (job.status === 'failed') throw new ApiError(job.error ?? 'The photo could not be turned into a 3D model.', 422);
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new ApiError('This is taking too long. Please try again later.', 408);
    await sleep(Math.min(interval, left), signal);
    interval = Math.min(maxInterval, Math.round(interval * 1.5));
  }
}

export const photoApi = { createJob, getJob, waitForJob, fetchModel, getQuota, segment };
