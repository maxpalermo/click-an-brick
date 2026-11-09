// Public entry point of the photo-to-bricks converter (contract: ../types.ts PhotoConverter).
// Each convert() runs in a dedicated module Web Worker; cancel() terminates it.

import type { BrickColor } from '../../model/types';
import type { ConvertMessage, ConvertOptions, ConvertResult, PhotoConverter } from '../types';
import type { WorkerMessage, WorkerRequest } from './protocol';

export { buildPalette, COMMON_COLORS, COMMON_COLOR_CODES } from './color';

type Progress = Extract<ConvertMessage, { type: 'progress' }>;

export class ConvertCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'AbortError'; }
}

/**
 * Why a conversion failed, for the UI's error text:
 * - 'start': the worker script never ran (error before its first message). Almost always an open tab from an older
 *   deploy whose hashed worker chunk no longer exists (the SPA fallback serves index.html instead), or offline with
 *   the chunk not cached yet. A reload fixes it.
 * - 'crashed': the worker died mid-run without a message (usually out of memory on a phone).
 * - 'stalled': no message for STALL_MS (killed silently, or hopelessly slow).
 * - 'failed': the converter threw; `message` is its text.
 */
export type ConverterErrorCode = 'start' | 'crashed' | 'stalled' | 'failed';
export class ConverterError extends Error {
  constructor(public code: ConverterErrorCode, message: string) { super(message); this.name = 'ConverterError'; }
}

/** No progress for this long = the worker is gone (big builds on slow phones still post progress every few s). */
const STALL_MS = 180_000;

export function createPhotoConverter(colors: BrickColor[]): PhotoConverter {
  let worker: Worker | null = null;
  let pending: { reject: (e: Error) => void } | null = null;

  const stop = () => {
    worker?.terminate();
    worker = null;
    const p = pending;
    pending = null;
    p?.reject(new ConvertCancelled());
  };

  return {
    convert(glb: ArrayBuffer, options: ConvertOptions, onProgress?: (m: Progress) => void): Promise<ConvertResult> {
      stop(); // one conversion at a time: a new call supersedes the running one
      // copy so the caller keeps its buffer (e.g. the IndexedDB-cached GLB re-used for re-runs)
      const copy = glb.slice(0);
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker = w;
      return new Promise<ConvertResult>((resolve, reject) => {
        let started = false;
        let stall = 0;
        const finish = () => { window.clearTimeout(stall); if (worker === w) { w.terminate(); worker = null; } pending = null; };
        const fail = (err: Error) => { finish(); reject(err); };
        const arm = () => {
          window.clearTimeout(stall);
          stall = window.setTimeout(() => fail(new ConverterError('stalled', 'the brick converter stopped responding')), STALL_MS);
        };
        pending = { reject: (e) => { window.clearTimeout(stall); reject(e); } };
        arm();
        w.onmessage = (e: MessageEvent<WorkerMessage>) => {
          const m = e.data;
          started = true;
          arm();
          if (m.type === 'progress') onProgress?.(m);
          else if (m.type === 'done') { finish(); resolve(m.result); }
          else if (m.type === 'error') fail(new ConverterError('failed', m.message));
        };
        // A module worker whose script fails to load gets a plain Event (no message, not an ErrorEvent).
        w.onerror = (e) => {
          e.preventDefault();
          const msg = (e as ErrorEvent).message;
          fail(started
            ? new ConverterError(msg ? 'failed' : 'crashed', msg || 'the brick converter stopped unexpectedly')
            : new ConverterError('start', msg || 'the brick converter could not start'));
        };
        w.onmessageerror = () => fail(new ConverterError('failed', 'converter worker message could not be decoded'));
        const req: WorkerRequest = { type: 'convert', glb: copy, options, colors };
        w.postMessage(req, [copy]);
      });
    },
    cancel: stop,
  };
}
