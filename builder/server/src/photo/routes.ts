// Photo to Bricks routes for the Express dev server — same contract as the Worker
// (cloud/src/photo.ts, app/src/photo/types.ts). Defaults to the mock provider (no money spent):
// set PHOTO_PROVIDER=fal + FAL_KEY in the environment to try the real service locally.
import fsp from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { SERVER_ROOT } from '../paths.js';
import { MAX_PHOTO_BODY_BYTES, parseConfig, PHOTO_SIZE_LIMIT_TEXT, PhotoHttpError, PhotoService } from './core.js';
import { MemoryBlobStore, MemoryJobStore } from './memory-store.js';
import { selectProviders } from './providers.js';
import { MOCK_ANALYSIS, selectVision, type PhotoAnalysis } from './vision.js';
import { MAX_SEGMENT_BODY_BYTES, segmentPhoto, selectSegmenters } from './segment.js';

/** Sample GLB shared with the Worker's mock (cloud/src/assets/mock-duck.glb, Khronos "Duck"). */
const MOCK_GLB = process.env.PHOTO_MOCK_GLB
  ? path.resolve(process.env.PHOTO_MOCK_GLB)
  : path.resolve(SERVER_ROOT, '..', 'cloud', 'src', 'assets', 'mock-duck.glb');

let mockGlb: Promise<ArrayBuffer> | null = null;
const loadMockGlb = () => {
  if (!mockGlb) {
    mockGlb = fsp.readFile(MOCK_GLB).then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    mockGlb.catch(() => (mockGlb = null));
  }
  return mockGlb;
};

/**
 * Mock vision fixture: PHOTO_MOCK_ANALYSIS=<case> (a test case id from app/public/test-photos/manifest.json)
 * returns research/photo2brick/analysis/<case>.json; default the duck (same as the mock GLB).
 */
const loadMockAnalysis = async (): Promise<PhotoAnalysis> => {
  const name = (process.env.PHOTO_MOCK_ANALYSIS ?? '').trim();
  if (!name || !/^[a-z0-9-]+$/.test(name)) return MOCK_ANALYSIS;
  const file = path.resolve(SERVER_ROOT, '..', 'research', 'photo2brick', 'analysis', `${name}.json`);
  return JSON.parse(await fsp.readFile(file, 'utf8')) as PhotoAnalysis;
};

/** Identity: Cloudflare Access header when present (e.g. behind a tunnel), else 'local'. */
function userOf(req: Request): string {
  return String(req.headers['cf-access-authenticated-user-email'] ?? '').trim().toLowerCase() || 'local';
}

export function photoRouter(): Router {
  const env = process.env;
  const sel = selectProviders({ ...env, PHOTO_PROVIDER: env.PHOTO_PROVIDER || 'mock' }, loadMockGlb);
  const store = new MemoryJobStore();
  const config = parseConfig(env);
  const segmenters = selectSegmenters({ ...env, PHOTO_PROVIDER: env.PHOTO_PROVIDER || 'mock' });
  const service = new PhotoService({
    store,
    blobs: new MemoryBlobStore(),
    primary: sel.primary,
    fallback: sel.fallback,
    models: sel.models,
    unavailableReason: sel.unavailableReason,
    // Claude with ANTHROPIC_API_KEY; without a key the mock 3D provider gets fixture analyses.
    vision: selectVision(env, sel.primary?.id, loadMockAnalysis),
    config,
    defer: (p) => void p.catch((err) => console.error('[photo] background task failed:', err)),
  });
  console.log(`[photo] provider: ${sel.primary?.id ?? `none (${sel.unavailableReason})`}${sel.fallback ? ` + fallback ${sel.fallback.id}` : ''}`);
  console.log(`[photo] vision: ${service.visionId ?? 'off'}`);
  console.log(`[photo] cut-out: ${segmenters.auto ? `${segmenters.auto.id} + ${segmenters.points?.id}` : `off (${segmenters.unavailableReason})`}`);

  const r = Router();
  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  r.post(
    '/jobs',
    express.json({ limit: MAX_PHOTO_BODY_BYTES }),
    wrap(async (req, res) => {
      const user = userOf(req);
      const owner = (env.OWNER_EMAIL ?? '').trim().toLowerCase();
      res.status(201).json(await service.create(user, req.body, { owner: !!owner && user === owner }));
    }),
  );

  r.post(
    '/segment',
    express.json({ limit: MAX_SEGMENT_BODY_BYTES }),
    wrap(async (req, res) => {
      const user = userOf(req);
      const owner = (env.OWNER_EMAIL ?? '').trim().toLowerCase();
      res.setHeader('Cache-Control', 'no-store');
      res.json(await segmentPhoto({ store, sel: segmenters, budgetUsd: config.budgetUsd }, user, req.body, { owner: !!owner && user === owner }));
    }),
  );

  r.get(
    '/jobs/:id',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.get(userOf(req), String(req.params.id)));
    }),
  );

  r.get(
    '/jobs/:id/model.glb',
    wrap(async (req, res) => {
      const obj = await service.model(userOf(req), String(req.params.id));
      res.setHeader('Content-Type', 'model/gltf-binary');
      res.setHeader('Content-Length', String(obj.size));
      res.setHeader('Cache-Control', 'private, max-age=86400');
      const body = obj.body instanceof Uint8Array ? Buffer.from(obj.body.buffer, obj.body.byteOffset, obj.body.byteLength) : Buffer.from(await new Response(obj.body).arrayBuffer());
      res.status(200).end(req.method === 'HEAD' ? undefined : body);
    }),
  );

  r.get(
    '/quota',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const user = userOf(req);
      const owner = (env.OWNER_EMAIL ?? '').trim().toLowerCase();
      res.json(await service.quota(user, !!owner && user === owner));
    }),
  );

  // Photo errors carry their own status; body-parser errors get photo-specific wording.
  r.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof PhotoHttpError) {
      if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
      res.status(err.status).json({ error: err.message });
      return;
    }
    const t = err && typeof err === 'object' && 'type' in err ? (err as { type: string }).type : '';
    if (t === 'entity.too.large') {
      res.status(413).json({ error: `Photos too large (${PHOTO_SIZE_LIMIT_TEXT}).` });
      return;
    }
    next(err);
  });
  return r;
}
