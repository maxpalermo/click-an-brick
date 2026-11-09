import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import express, { type NextFunction, type Request, type Response } from 'express';
import { buildCatalog, buildColors } from './catalog.js';
import { isValidModelId, loadModel, saveModel, validateModelInput, ValidationError } from './models.js';
import { userOf } from './auth.js';
import { getPacked, isValidPartId } from './packer.js';
import { photoRouter } from './photo/routes.js';
import { buildsRouter } from './builds/routes.js';
import {
  APP_DIST,
  CACHE_DIR,
  CATALOG_FILE,
  COLORS_FILE,
  LDRAW_ROOT,
  libraryPresent,
  LIBRARY_MISSING_MESSAGE,
} from './paths.js';

const PORT = Number(process.env.PORT) || 8787;
const app = express();
app.disable('x-powered-by');
app.set('etag', 'weak');

// ---------- helpers ----------

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface Payload {
  raw: Buffer;
  gz: Buffer;
  etag: string;
  type: string;
}

function makePayload(body: string | Buffer, type: string): Payload {
  const raw = typeof body === 'string' ? Buffer.from(body) : body;
  return {
    raw,
    gz: zlib.gzipSync(raw, { level: 6 }),
    etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 27)}"`,
    type,
  };
}

/** Send a precomputed payload with ETag / 304 and gzip when the client accepts it. */
function sendPayload(req: Request, res: Response, p: Payload, cacheControl: string) {
  res.setHeader('Content-Type', p.type);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('ETag', p.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === p.etag)) {
    res.status(304).end();
    return;
  }
  const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && p.raw.length > 1024;
  const body = gzip ? p.gz : p.raw;
  if (gzip) res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Content-Length', String(body.length));
  res.status(200).end(req.method === 'HEAD' ? undefined : body);
}

function requireLibrary() {
  if (!libraryPresent()) throw new HttpError(503, LIBRARY_MISSING_MESSAGE);
}

/** Load a JSON cache file; build it from the library if missing. */
function lazyJson(file: string, build: () => Promise<unknown>) {
  let cached: Promise<Payload> | null = null;
  return (): Promise<Payload> => {
    if (!cached) {
      cached = (async () => {
        let text: string;
        try {
          text = await fsp.readFile(file, 'utf8');
        } catch {
          requireLibrary();
          console.log(`[cache] building ${path.basename(file)} …`);
          const t0 = Date.now();
          text = JSON.stringify(await build());
          await fsp.mkdir(CACHE_DIR, { recursive: true });
          await fsp.writeFile(file, text);
          console.log(`[cache] built ${path.basename(file)} in ${Date.now() - t0} ms`);
        }
        return makePayload(text, 'application/json; charset=utf-8');
      })();
      cached.catch(() => (cached = null)); // retry next time on failure
    }
    return cached;
  };
}

const getCatalog = lazyJson(CATALOG_FILE, buildCatalog);
const getColors = lazyJson(COLORS_FILE, buildColors);

/** Simple in-memory sliding-window rate limiter. */
function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, ts] of hits) {
      const kept = ts.filter((t) => t > cutoff);
      if (kept.length) hits.set(ip, kept);
      else hits.delete(ip);
    }
  }, windowMs).unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const ts = (hits.get(ip) ?? []).filter((t) => t > now - windowMs);
    if (ts.length >= max) {
      res.setHeader('Retry-After', String(Math.ceil((ts[0] + windowMs - now) / 1000)));
      res.status(429).json({ error: 'Too many models shared from this address, try again in a minute.' });
      return;
    }
    ts.push(now);
    hits.set(ip, ts);
    next();
  };
}

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// ---------- middleware ----------

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/ldraw/') && res.statusCode < 400) return; // too chatty
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }
  next();
});

// ---------- API ----------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, library: libraryPresent() });
});

app.get(
  '/api/catalog',
  asyncRoute(async (req, res) => sendPayload(req, res, await getCatalog(), 'public, max-age=3600')),
);

app.get(
  '/api/colors',
  asyncRoute(async (req, res) => sendPayload(req, res, await getColors(), 'public, max-age=3600')),
);

const packedPayloads = new Map<string, Payload>(); // id → gzipped/etagged payload (bounded)
app.get(
  '/api/parts/:id/packed',
  asyncRoute(async (req, res) => {
    const id = String(req.params.id).toLowerCase();
    if (!isValidPartId(id)) throw new HttpError(400, 'Invalid part id (expected e.g. "3001.dat").');
    requireLibrary();
    const text = await getPacked(id);
    if (text === null) throw new HttpError(404, `Part not found: ${id}`);
    let p = packedPayloads.get(id);
    if (!p) {
      p = makePayload(text, 'text/plain; charset=utf-8');
      packedPayloads.set(id, p);
      if (packedPayloads.size > 400) packedPayloads.delete(packedPayloads.keys().next().value as string);
    }
    sendPayload(req, res, p, 'public, max-age=86400');
  }),
);

app.post(
  '/api/models',
  rateLimit(30, 60_000),
  express.json({ limit: '2mb' }),
  asyncRoute(async (req, res) => {
    const owner = userOf(req);
    if (!owner) throw new HttpError(401, 'Login richiesto');
    const { name, ldr } = validateModelInput(req.body);
    const model = await saveModel(name, ldr, owner);
    res.status(201).json({ id: model.id });
  }),
);

app.get(
  '/api/models/:id',
  asyncRoute(async (req, res) => {
    const id = String(req.params.id);
    if (!isValidModelId(id)) throw new HttpError(400, 'Invalid model id.');
    const model = await loadModel(id);
    if (!model) throw new HttpError(404, 'Model not found. The link may be wrong or the model was removed.');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(model);
  }),
);

// Photo to Bricks (mock provider by default; see server/src/photo/routes.ts)
app.use('/api/photo', photoRouter());

// My builds (in memory in dev; see server/src/builds/routes.ts)
app.use('/api/builds', buildsRouter());

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unknown API endpoint.')));

// ---------- static LDraw library ----------

app.use('/ldraw', (req, res, next) => {
  if (!libraryPresent()) return next(new HttpError(503, LIBRARY_MISSING_MESSAGE));
  next();
});
app.use('/ldraw', express.static(LDRAW_ROOT, { maxAge: '1d', dotfiles: 'ignore', index: false, fallthrough: true }));
app.use('/ldraw', (_req, _res, next) => next(new HttpError(404, 'LDraw file not found.')));

// ---------- production: serve the built app ----------

if (fs.existsSync(path.join(APP_DIST, 'index.html'))) {
  app.use(express.static(APP_DIST, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api(\/|$)|\/ldraw(\/|$)).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(APP_DIST, 'index.html'));
  });
  console.log(`[static] serving app from ${APP_DIST}`);
}

// ---------- errors ----------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  let status = 500;
  let message = 'Internal server error.';
  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
  } else if (err instanceof ValidationError) {
    status = 400;
    message = err.message;
  } else if (err && typeof err === 'object' && 'type' in err) {
    const t = (err as { type: string }).type;
    if (t === 'entity.too.large') {
      status = 413;
      message = 'Model too large (max 2 MB).';
    } else if (t === 'entity.parse.failed') {
      status = 400;
      message = 'Malformed JSON body.';
    }
  }
  if (status >= 500) console.error(err);
  if (!res.headersSent) res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`Brickyard server on http://localhost:${PORT}`);
  if (!libraryPresent()) console.warn(`[warn] ${LIBRARY_MISSING_MESSAGE}`);
});
