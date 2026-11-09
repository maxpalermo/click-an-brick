// "My builds" routes for the Express dev server: same contract as the Worker (cloud/src/builds.ts,
// app/src/api/builds.types.ts). In memory: the archive is lost when the dev server restarts.
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { userOf as sessionUser } from '../auth.js';
import { SqliteBuildStore } from './sqlite-store.js';
import { BUILD_BODY_MAX_BYTES, BuildHttpError, BuildsService } from './core.js';

/** Identity: the shared bs_session cookie (admin.db), same as the FastAPI side. */
function userOf(req: Request): string {
  return sessionUser(req) ?? '';
}

export function buildsRouter(): Router {
  const service = (req: Request) => new BuildsService(new SqliteBuildStore(userOf(req)));
  const r = Router();
  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);
  const body = express.json({ limit: BUILD_BODY_MAX_BYTES });
  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  r.use((req, _res, next) => {
    if (!userOf(req)) return next(new BuildHttpError(401, 'Login richiesto'));
    next();
  });
  r.get('/', wrap(async (req, res) => void res.json(await service(req).list(userOf(req)))));
  r.post('/', body, wrap(async (req, res) => void res.status(201).json(await service(req).create(userOf(req), req.body))));
  r.get('/:id', wrap(async (req, res) => void res.json(await service(req).get(userOf(req), String(req.params.id)))));
  r.patch('/:id', body, wrap(async (req, res) => void res.json(await service(req).update(userOf(req), String(req.params.id), req.body))));
  r.delete('/:id', wrap(async (req, res) => {
    await service(req).delete(userOf(req), String(req.params.id));
    res.status(204).end();
  }));

  r.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof BuildHttpError) return void res.status(err.status).json({ error: err.message });
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.too.large') return void res.status(413).json({ error: 'This build is too large to save (max 2 MB as .ldr).' });
    if (e?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Malformed JSON body.' });
    next(err);
  });
  return r;
}
