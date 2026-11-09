// The one place where the photo UI touches the cloud client (app/src/api/photo.ts, cloud agent) and the
// converter (app/src/photo/convert, engine agent). Adapting to their final signatures happens here only.
import * as photoApi from '../../api/photo';
import { ConverterError, createPhotoConverter } from '../convert';
import type { BrickColor } from '../../model/types';
import type { CreatePhotoJobRequest, PhotoConverter, PhotoJob, PhotoQuota } from '../types';

/**
 * Where "Try again" restarts; 'reload' = reload the page and continue the saved build (resume.ts);
 * 'quick' = no quality builds left: offer a quick build with the same front and back photos instead.
 */
export type RetryFrom = 'create' | 'poll' | 'fetch' | 'convert' | 'reload' | 'quick' | 'none';
export type FlowStage = Exclude<RetryFrom, 'none' | 'reload' | 'quick'>;

/** An error with words a user can act on. */
export class FlowError extends Error {
  constructor(public title: string, public detail: string, public retry: RetryFrom) {
    super(title);
    this.name = 'FlowError';
  }
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ''));

/** Map any thrown error to a friendly FlowError for the given stage (quality: the job was a quality build). */
export function friendly(e: unknown, stage: FlowStage, quality = false): FlowError {
  if (e instanceof FlowError) return e;
  if (e instanceof ConverterError) return converterError(e);
  const status = statusOf(e);
  const msg = messageOf(e);
  const api = stage !== 'convert';
  // 402 on a quality build = no quality credits left this month (the server's message says when they reset).
  if (quality && stage === 'create' && status === 402)
    return new FlowError('No quality builds left', msg || "You've used all your quality builds for this month.", 'quick');
  if (status === 402 || (api && /budget|month/i.test(msg)))
    return new FlowError('Photo builds are paused', 'We have reached this month\'s limit for photo builds. Please try again later.', 'none');
  if (status === 429 || (api && /quota/i.test(msg)))
    return new FlowError("You've used today's photo builds", 'You can make more photo builds tomorrow. Nothing was used up.', 'none');
  if (stage === 'fetch' && status === 410)
    return new FlowError('This 3D shape has expired', 'Shapes are kept for 7 days. Take the photos again to make a new one.', 'none');
  if (stage === 'fetch' && status === 409)
    return new FlowError('The 3D shape is not ready yet', 'Give it a few more seconds, then try again.', 'poll');
  if (stage === 'fetch' && status === 404)
    return new FlowError("Couldn't find this photo build", 'It may belong to another account or have been removed. Take the photos again.', 'none');
  if (status === 503 || status === 404)
    return new FlowError("Photo builds aren't available yet", 'This feature is still being set up. Please try again later.', 'none');
  if (status === 401 || status === 403)
    return new FlowError('Please sign in again', 'Your session has expired. Reload the page, then try again.', 'none');
  if (status === 413)
    return new FlowError('Those photos are too big', 'Try again with fewer or smaller photos.', 'none');
  if (api && (status === 0 || e instanceof TypeError || /network|failed to fetch|reach/i.test(msg)))
    return new FlowError("You're offline", 'Check your connection, then try again.', stage);
  switch (stage) {
    case 'create':
      return new FlowError("Couldn't send your photos", msg || 'The server did not accept the photos.', 'create');
    case 'poll':
      return new FlowError('The 3D shape failed', friendlyJobError(msg), 'create');
    case 'fetch':
      return new FlowError("Couldn't download the 3D shape", msg || 'Please try again.', 'fetch');
    case 'convert':
      return new FlowError("Couldn't turn the shape into bricks", msg || 'Try a smaller size, or try again.', 'convert');
  }
}

function converterError(e: ConverterError): FlowError {
  switch (e.code) {
    case 'start':
      // An open tab from before a deploy: its worker chunk is gone. The GLB is cached, so a reload continues for free.
      return new FlowError('Brickyard was just updated',
        'Reload to get the new version and your build carries on. Your 3D shape is saved, so this does not use another photo build.', 'reload');
    case 'crashed':
    case 'stalled':
      return new FlowError('This model is too big for your device',
        'Building it ran out of memory or time. Try again at a smaller size or with less detail.', 'convert');
    default:
      return new FlowError("Couldn't turn the shape into bricks", e.message || 'Try a smaller size, or try again.', 'convert');
  }
}

function friendlyJobError(msg: string): string {
  if (/timeout|timed out/i.test(msg)) return 'The AI took too long. Trying again usually works.';
  if (/content|safety|nsfw/i.test(msg)) return "The AI couldn't use this photo. Try a different photo.";
  return 'The AI could not make a shape from these photos. Try a plainer background and good light.';
}

export function createJob(req: CreatePhotoJobRequest): Promise<{ jobId: string }> {
  return photoApi.createJob(req);
}

export function getQuota(): Promise<PhotoQuota> {
  return photoApi.getQuota();
}

export function fetchModel(jobId: string): Promise<ArrayBuffer> {
  return photoApi.fetchModel(jobId);
}

const sleep = (ms: number, isCancelled: () => boolean) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (isCancelled()) reject(new Cancelled());
      else if (Date.now() - t0 >= ms) resolve();
      else window.setTimeout(tick, 250);
    };
    tick();
  });

/** Client give-up for polling: 5 min (contract); quality builds (Tripo, ~2–3 min) match the server's own 10 min. */
export const POLL_LIMIT_MS = 5 * 60_000;
export const QUALITY_POLL_LIMIT_MS = 10 * 60_000;

/**
 * Poll GET /api/photo/jobs/:id every 3 s, backing off to 10 s, giving up after limitMs (5 min by default, contract).
 * Implemented on top of getJob so cancel is instant and each update reaches the progress screen.
 * Transient network errors are retried a few times before failing.
 */
export async function pollJob(
  jobId: string, onUpdate: (j: PhotoJob) => void, isCancelled: () => boolean, limitMs = POLL_LIMIT_MS,
): Promise<PhotoJob> {
  const t0 = Date.now();
  let delay = 3000;
  let netFails = 0;
  for (;;) {
    await sleep(delay, isCancelled);
    let job: PhotoJob;
    try {
      job = await photoApi.getJob(jobId);
      netFails = 0;
    } catch (e) {
      if (isCancelled()) throw new Cancelled();
      const s = statusOf(e);
      if ((s === undefined || s === 0 || s >= 500) && ++netFails < 4) continue;
      throw friendly(e, 'poll');
    }
    if (isCancelled()) throw new Cancelled();
    onUpdate(job);
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new FlowError('The 3D shape failed', friendlyJobError(job.error ?? ''), 'create');
    if (Date.now() - t0 > limitMs)
      throw new FlowError('This is taking too long', 'The AI is very busy right now. You can wait a bit more, or try again later.', 'poll');
    delay = Math.min(10_000, Math.round(delay * 1.4));
  }
}

export function makeConverter(colors: BrickColor[]): PhotoConverter {
  return createPhotoConverter(colors);
}
