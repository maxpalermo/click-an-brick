// Photo-to-bricks Web Worker: receives a GLB and options, posts progress per stage, then the result.
// Created by index.ts with `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.

import { convertGlb } from './core';
import { browserEnv } from './browser';
import type { WorkerMessage, WorkerRequest } from './protocol';

interface WorkerScope {
  postMessage(m: WorkerMessage): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = async (e) => {
  const req = e.data;
  if (!req || req.type !== 'convert') return;
  try {
    const { result } = await convertGlb(req.glb, req.colors, req.options, browserEnv, (m) => scope.postMessage(m));
    scope.postMessage({ type: 'done', result });
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
