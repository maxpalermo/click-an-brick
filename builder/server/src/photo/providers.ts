// Photo to Bricks: image-to-3D providers (runtime-agnostic: only fetch/FormData/Blob, no Node imports).
//   fal       primary, async queue (fal-ai/trellis/multi for 2–3 photos, fal-ai/trellis for 1), $0.02
//   stability fallback, synchronous SPAR3D, front photo only, $0.04
//   mock      local dev, returns a bundled sample GLB after ~5 s, $0
//   fal-trellis2 / fal-tripo: owner-only A/B models (POST /api/photo/jobs { model }), never the default.
import { base64ToBytes, errText, MAX_GLB_BYTES, type PhotoImage, type PhotoMode, type PhotoModel } from './core.js';

export type ProviderId = 'fal' | 'fal-trellis2' | 'fal-tripo' | 'stability' | 'mock';


export type CheckResult =
  | { state: 'queued' | 'running'; progress: number | null }
  | { state: 'done'; glb: ArrayBuffer }
  | { state: 'failed'; error: string };

export interface PhotoProvider {
  id: ProviderId;
  /** Price per generation in USD (counted against PHOTO_BUDGET_USD). */
  costUsd: number;
  /** Give up on an async job after this long (default PROVIDER_TIMEOUT_MS in core.ts). */
  timeoutMs?: number;
  /** true → `run` returns the GLB directly; false → `submit` + `check`. */
  sync: boolean;
  /** Async: start a job, return an opaque handle stored in photo_jobs.provider_req. */
  submit(images: PhotoImage[], mode: PhotoMode): Promise<string>;
  /** Async: one short status request (never long-polls). */
  check(req: string): Promise<CheckResult>;
  cancel?(req: string): Promise<void>;
  /** Sync: front photo (data URI) → GLB bytes. */
  run?(frontDataUri: string): Promise<ArrayBuffer>;
}

export const COST_USD: Record<ProviderId, number> = {
  fal: 0.02,
  'fal-trellis2': 0.25, // resolution 512
  'fal-tripo': 0.3, // standard texture, standard geometry, no quad
  stability: 0.04,
  mock: 0,
};

class ProviderError extends Error {}

async function readBody(res: Response, max = MAX_GLB_BYTES): Promise<ArrayBuffer> {
  const len = Number(res.headers.get('Content-Length') ?? '0');
  if (len > max) throw new ProviderError(`model file too large (${len} bytes)`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > max) throw new ProviderError(`model file too large (${buf.byteLength} bytes)`);
  return buf;
}

async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    // fal: { detail: string | {msg}[] , error_type? }  ·  Stability: { name, errors: string[] }
    if (typeof j.detail === 'string') return j.detail;
    if (Array.isArray(j.detail)) return j.detail.map((d) => (d && typeof d === 'object' && 'msg' in d ? String(d.msg) : String(d))).join('; ');
    if (Array.isArray(j.errors)) return j.errors.map(String).join('; ');
    if (typeof j.error === 'string') return j.error;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`;
}

// ---------- fal.ai (TRELLIS) ----------
//
// Verified 2026-10-25 against:
//   https://fal.ai/models/fal-ai/trellis/api · https://fal.ai/models/fal-ai/trellis/multi/api
//   (llms.txt and OpenAPI: https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/trellis/multi)
//   https://fal.ai/docs/inference-api/queue/submit · https://fal.ai/docs/inference-api/queue/result
//   https://fal.ai/docs/documentation/model-apis/inference/payloads (X-Fal-Store-IO)
//
// Submit:  POST https://queue.fal.run/fal-ai/trellis        { image_url: string, …}
//          POST https://queue.fal.run/fal-ai/trellis/multi  { image_urls: string[], multiimage_algo:
//               "stochastic" | "multidiffusion", …}
//          shared optional inputs: seed, ss_guidance_strength (7.5), ss_sampling_steps (12),
//          slat_guidance_strength (3), slat_sampling_steps (12), mesh_simplify (0.95, 0.9–0.98),
//          texture_size (512 | 1024 | 2048, default 1024).
//          Headers: Authorization: Key $FAL_KEY, Content-Type: application/json, X-Fal-Store-IO: 0.
//          → QueueStatus { status, request_id, response_url, status_url, cancel_url, queue_position? }
// Status:  GET status_url → { status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED", queue_position?, logs,
//          metrics, error?, error_type? }. Failed and cancelled requests also report COMPLETED, with
//          `error` set. We use the URLs from the submit response: for sub-path endpoints (…/multi) the
//          request lives under the app id (fal-ai/trellis/requests/<id>), not the endpoint path.
// Result:  GET response_url → 200 { model_mesh: { url, content_type?, file_name?, file_size? }, timings }
//          400 still running · 404 expired/unknown · 422 input rejected · 499 cancelled · 500 model error
//          ({ detail, error_type }). Queue results are kept 1 h (6 min if ≥ 10 KB); the mesh file is on
//          fal's CDN and also expires → we copy it into R2 as soon as the job completes.
// Cancel:  PUT cancel_url.
// Inputs:  photos are sent inline as base64 data URIs (fal accepts data URIs for file inputs — see
//          https://fal.ai/docs/documentation/model-apis/fal-cdn). If a model ever rejects them, upload
//          to fal storage first. X-Fal-Store-IO: 0 means fal does not keep the request payload.

const FAL_QUEUE = 'https://queue.fal.run';

interface FalHandle {
  request_id: string;
  status_url: string;
  response_url: string;
  cancel_url?: string;
}

/** One fal queue model: which endpoint to call with which body, and where the GLB is in the result. */
interface FalSpec {
  id: ProviderId;
  /** fal app id: queue requests live under it, also for sub-path endpoints (…/multi, …/image-to-3d). */
  app: string;
  /** → [endpoint id, JSON body, app id when it differs from `app` (e.g. another model family)] */
  request(images: PhotoImage[]): [string, Record<string, unknown>, string?] | Promise<[string, Record<string, unknown>, string?]>;
  /** GLB URL in the result JSON. */
  glbUrl(out: Record<string, unknown>): string | undefined;
  timeoutMs?: number;
}

type FalFile = { url?: string; content_type?: string | null; file_name?: string | null } | null | undefined;
const fileUrl = (f: unknown): string | undefined => {
  const u = f && typeof f === 'object' ? (f as { url?: unknown }).url : undefined;
  return typeof u === 'string' && u ? u : undefined;
};

function falQueueProvider(key: string, spec: FalSpec): PhotoProvider {
  const headers = {
    Authorization: `Key ${key}`,
    'Content-Type': 'application/json',
    'X-Fal-Store-IO': '0',
  };

  return {
    id: spec.id,
    costUsd: COST_USD[spec.id],
    timeoutMs: spec.timeoutMs,
    sync: false,

    async submit(images) {
      const [endpoint, body, app = spec.app] = await spec.request(images);
      const res = await fetch(`${FAL_QUEUE}/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new ProviderError(`fal submit: ${await errorDetail(res)}`);
      const j = (await res.json()) as Partial<FalHandle>;
      if (!j.request_id) throw new ProviderError('fal submit: no request_id in response');
      const base = `${FAL_QUEUE}/${app}/requests/${j.request_id}`;
      const h: FalHandle = {
        request_id: j.request_id,
        status_url: j.status_url ?? `${base}/status`,
        response_url: j.response_url ?? base,
        cancel_url: j.cancel_url ?? `${base}/cancel`,
      };
      return JSON.stringify(h);
    },

    async check(req) {
      const h = JSON.parse(req) as FalHandle;
      const auth = { Authorization: headers.Authorization };
      const s = await fetch(h.status_url, { headers: auth });
      if (s.status === 404) return { state: 'failed', error: 'The 3D job expired at the provider.' };
      if (!s.ok) throw new ProviderError(`fal status: ${await errorDetail(s)}`); // transient → retried
      const st = (await s.json()) as { status?: string; error?: string; error_type?: string };
      if (st.status === 'IN_QUEUE') return { state: 'queued', progress: null };
      if (st.status === 'IN_PROGRESS') return { state: 'running', progress: null };
      if (st.status !== 'COMPLETED') throw new ProviderError(`fal status: unexpected "${st.status}"`);
      if (st.error) return { state: 'failed', error: `3D service error: ${st.error}` };

      const r = await fetch(h.response_url, { headers: auth });
      if (r.status === 400) return { state: 'running', progress: null }; // "still in progress"
      // 500 = the model failed (terminal); 502/503/504 = gateway trouble → transient, retried next poll.
      if (r.status > 500) throw new ProviderError(`fal result: HTTP ${r.status}`);
      if (!r.ok) return { state: 'failed', error: `3D service error: ${await errorDetail(r)}` };
      const url = spec.glbUrl((await r.json()) as Record<string, unknown>);
      if (!url || !/^https:\/\//.test(url)) return { state: 'failed', error: '3D service returned no model.' };
      const g = await fetch(url);
      if (!g.ok) throw new ProviderError(`fal model download: HTTP ${g.status}`);
      return { state: 'done', glb: await readBody(g) };
    },

    async cancel(req) {
      const h = JSON.parse(req) as FalHandle;
      if (h.cancel_url) await fetch(h.cancel_url, { method: 'PUT', headers: { Authorization: headers.Authorization } });
    },
  };
}

/**
 * Default provider: TRELLIS v1 (`fal-ai/trellis/multi` for 2–4 side photos: front first, then back / side /
 * right / left, all in image_urls; the multi endpoint takes views in any order and has no view labels),
 * `fal-ai/trellis` for 1. $0.02 per job whatever the photo count. Never receives a 'top' photo (core.ts).
 */
export function falProvider(key: string): PhotoProvider {
  const common = { texture_size: 1024, mesh_simplify: 0.95 };
  return falQueueProvider(key, {
    id: 'fal',
    app: 'fal-ai/trellis',
    request: (images) =>
      images.length > 1
        ? ['fal-ai/trellis/multi', { image_urls: images.map((i) => i.dataUri), multiimage_algo: 'stochastic', ...common }]
        : ['fal-ai/trellis', { image_url: images[0].dataUri, ...common }],
    glbUrl: (out) => fileUrl(out.model_mesh),
  });
}

// ---------- fal.ai TRELLIS.2 (owner-only A/B, model 'trellis2') ----------
//
// Verified 2026-10-26 against https://fal.ai/models/fal-ai/trellis-2/api, its llms.txt
// (https://fal.ai/models/fal-ai/trellis-2/llms.txt) and the queue OpenAPI
// (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/trellis-2):
//   POST https://queue.fal.run/fal-ai/trellis-2   Trellis2Input ("SingleImageInputModel"):
//     image_url: string (required) — ONE image; fal has no multi-view variant of TRELLIS.2.
//     resolution: 512 | 1024 | 1536 (default 1024) → price $0.25 / $0.30 / $0.35
//     texture_size: 1024 | 2048 | 4096 (default 2048) · decimation_target: 5000–2000000 vertices
//     (default 500000; docs: "reduce to 20k-50k for web/mobile") · remesh: bool (default true) · seed ·
//     ss_* / shape_slat_* / tex_slat_* sampler knobs (left at defaults).
//   Result (GET response_url): Trellis2Output { model_glb: File { url, content_type, file_name, file_size } }.
//   Queue paths: /fal-ai/trellis-2/requests/{request_id}[/status | /cancel] (same protocol as above).
// Cheapest resolution (512), smallest texture (1024), 100k vertices: the converter samples a 24–48-stud
// grid, so more detail only makes the GLB bigger. The back photo, if any, is ignored.
export function falTrellis2Provider(key: string): PhotoProvider {
  return falQueueProvider(key, {
    id: 'fal-trellis2',
    app: 'fal-ai/trellis-2',
    timeoutMs: 10 * 60 * 1000,
    request: (images) => [
      'fal-ai/trellis-2',
      { image_url: images[0].dataUri, resolution: 512, texture_size: 1024, decimation_target: 100_000 },
    ],
    glbUrl: (out) => fileUrl(out.model_glb),
  });
}

// ---------- fal.ai Tripo H3.1 (owner-only A/B, model 'tripo-mv') ----------
//
// Verified 2026-10-26 against https://fal.ai/models/tripo3d/h3.1/multiview-to-3d/api, its llms.txt and
// the queue OpenAPI (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=tripo3d/h3.1/multiview-to-3d),
// and https://fal.ai/models/tripo3d/h3.1/image-to-3d/llms.txt:
//   POST https://queue.fal.run/tripo3d/h3.1/multiview-to-3d   FullMultiviewTo3DInput:
//     image_urls: string[] (required, minItems 2, maxItems 4) — "Order: [front, left, back, right].
//     Front view is required." · face_limit 1000–2000000 · texture (default true) · pbr (default true)
//     · texture_quality standard|detailed · geometry_quality standard|detailed · texture_alignment
//     original_image|geometry · orientation default|align_image · auto_size · quad · model_seed · texture_seed
//   POST https://queue.fal.run/tripo3d/h3.1/image-to-3d   same options, image_url: string (one photo).
//   Price (both): $0.20 untextured · $0.30 standard texture · $0.40 HD texture; +$0.20 detailed
//     geometry; +$0.05 quad. We send texture: true, standard/standard, quad: false → $0.30.
//   Result: Tripo3DOutput { model_mesh: File ("May be GLB or FBX"; FBX only with quad), model_urls:
//     { glb?, fbx?, base_model?, pbr_model? }, rendered_image?, task_id? }. We take model_urls.glb, then
//     pbr_model, then model_mesh unless it is FBX.
//   Queue paths live under the app id: /tripo3d/h3.1/requests/{request_id}[/status | /cancel].
//   Skipping a view (verified 2026-10-27): fal's H3.1 schema has image_urls items of plain `string`, minItems 2,
//   "Front view is required; others are optional" — but no way to leave a middle slot out. Tripo's own API
//   (https://developers.tripo3d.com/en/docs/generation-multiview-to-model/standard.md) accepts "Exactly 4
//   strings in order [front, left, back, right]. Use an empty string "" to skip a view" or a view-key format,
//   but fal's wrapper downloads every list item first: "" failed live on 2026-10-26 with "Failed to download
//   the file", and fal does not expose the view-key format. fal's only documented per-view skip is the older
//   Tripo v2.5 endpoint (https://fal.ai/models/tripo3d/tripo/v2.5/multiview-to-3d/llms.txt):
//     POST https://queue.fal.run/tripo3d/tripo/v2.5/multiview-to-3d  front_image_url (required),
//     left_image_url / back_image_url / right_image_url (each optional) · texture "no"|"standard"|"HD" ·
//     pbr (default false) · quad · texture_alignment · orientation · face_limit · seed · texture_seed · auto_size.
//     Same price ($0.30 with standard texture). Result: { model_mesh: File (GLB), base_model?, pbr_model?,
//     rendered_image?, task_id }. Queue app id: tripo3d/tripo.
//   So: views are put in their slots [front, left, back, right] by name ('side' takes the left slot, or the
//   right one when left is taken). Contiguous from the front (2–4 views, e.g. all four sides, or front + left)
//   → H3.1 list with trailing empty slots dropped. A gap in the middle (typically front + back) depends on
//   PHOTO_TRIPO_LAYOUT: 'v25' (default) → the v2.5 endpoint with named fields (exact views, older model);
//   'pair' → H3.1 with the gap squeezed out ([front, back]: Tripo reads the back as the LEFT view);
//   'gap' → H3.1 with "" in the gap (fails at fal today, kept to re-test).
//   One side photo → image-to-3d (multiview needs ≥ 2 images). pbr: false — we only use the base colour.
export type TripoLayout = 'v25' | 'pair' | 'gap';
export const TRIPO_FACE_LIMIT = 300_000;

/** [front, left, back, right] slots by view name; undefined = no photo for that slot. */
export function tripoSlots(images: PhotoImage[]): (string | undefined)[] {
  const slots: (string | undefined)[] = [undefined, undefined, undefined, undefined];
  const at = { front: 0, left: 1, back: 2, right: 3 } as const;
  for (const i of images) if (i.view in at) slots[at[i.view as keyof typeof at]] = i.dataUri;
  const side = images.find((i) => i.view === 'side');
  if (side) {
    if (!slots[1]) slots[1] = side.dataUri;
    else if (!slots[3]) slots[3] = side.dataUri;
  }
  return slots;
}

export function tripoRequest(images: PhotoImage[], layout: TripoLayout): [string, Record<string, unknown>, string?] {
  // face_limit: Tripo's default mesh was 1.4M triangles / 43 MB for the castle (too heavy for a phone, near
  // MAX_GLB_BYTES); the converter samples a ≤ 96-stud grid, so 300k faces lose nothing. Same price.
  const opts = { texture: true, pbr: false, texture_quality: 'standard', geometry_quality: 'standard', quad: false, face_limit: TRIPO_FACE_LIMIT };
  const sides = images.filter((i) => i.view !== 'top');
  const slots = tripoSlots(sides);
  const n = slots.filter(Boolean).length;
  if (n < 2) return ['tripo3d/h3.1/image-to-3d', { image_url: slots[0] ?? sides[0].dataUri, ...opts }];
  let last = 3;
  while (!slots[last]) last--;
  const prefix = slots.slice(0, last + 1);
  if (prefix.every(Boolean)) return ['tripo3d/h3.1/multiview-to-3d', { image_urls: prefix, ...opts }];
  if (layout === 'pair') return ['tripo3d/h3.1/multiview-to-3d', { image_urls: slots.filter(Boolean), ...opts }];
  if (layout === 'gap') return ['tripo3d/h3.1/multiview-to-3d', { image_urls: prefix.map((u) => u ?? ''), ...opts }];
  const [front, left, back, right] = slots;
  return [
    'tripo3d/tripo/v2.5/multiview-to-3d',
    {
      front_image_url: front,
      ...(left ? { left_image_url: left } : {}),
      ...(back ? { back_image_url: back } : {}),
      ...(right ? { right_image_url: right } : {}),
      texture: 'standard',
      pbr: false,
      quad: false,
      face_limit: TRIPO_FACE_LIMIT,
    },
    'tripo3d/tripo',
  ];
}

// fal storage upload (protocol of @fal-ai/client src/storage.js, checked 2026-10-27):
//   POST https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3  { content_type, file_name }
//   → { upload_url, file_url }; then PUT the bytes to upload_url with the same Content-Type.
// The v2.5 Tripo endpoint failed live on 2026-10-27 with "Failed to download the file" for data URIs, so its
// photos go through fal storage first and the body carries the https file_url instead.
const FAL_REST = 'https://rest.alpha.fal.ai';

async function falUpload(key: string, dataUri: string): Promise<string> {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUri);
  if (!m) return dataUri; // already a URL
  const type = m[1];
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  const ext = type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
  const init = await fetch(`${FAL_REST}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: type, file_name: `photo-${Date.now()}.${ext}` }),
  });
  if (!init.ok) throw new ProviderError(`fal upload: ${await errorDetail(init)}`);
  const { upload_url, file_url } = (await init.json()) as { upload_url?: string; file_url?: string };
  if (!upload_url || !file_url) throw new ProviderError('fal upload: no upload_url in response');
  const put = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': type }, body: bytes });
  if (!put.ok) throw new ProviderError(`fal upload: ${await errorDetail(put)}`);
  return file_url;
}

export function falTripoProvider(key: string, layout: TripoLayout = 'v25'): PhotoProvider {
  return falQueueProvider(key, {
    id: 'fal-tripo',
    app: 'tripo3d/h3.1',
    timeoutMs: 10 * 60 * 1000,
    async request(images) {
      const [endpoint, body, app] = tripoRequest(images, layout);
      if (endpoint.startsWith('tripo3d/tripo/v2.5/')) {
        for (const f of ['front_image_url', 'left_image_url', 'back_image_url', 'right_image_url'])
          if (typeof body[f] === 'string') body[f] = await falUpload(key, body[f] as string);
      }
      return [endpoint, body, app];
    },
    glbUrl(out) {
      // H3.1: model_urls.{glb,pbr_model} + model_mesh · v2.5: model_mesh (GLB), pbr_model, base_model at top level.
      const urls = (out.model_urls ?? {}) as Record<string, FalFile>;
      const mesh = out.model_mesh as FalFile;
      const meshIsFbx = /fbx/i.test(`${mesh?.content_type ?? ''} ${mesh?.file_name ?? ''}`);
      return fileUrl(urls.glb) ?? fileUrl(urls.pbr_model) ?? (meshIsFbx ? undefined : fileUrl(mesh)) ?? fileUrl(out.pbr_model) ?? fileUrl(out.base_model);
    },
  });
}

// ---------- Stability AI SPAR3D (fallback) ----------
//
// Verified 2026-10-25 against https://docs.stability.ai/api-reference/3d/stable-point-aware-3d
//   POST https://api.stability.ai/v2beta/3d/stable-point-aware-3d, multipart/form-data,
//   header `authorization: Bearer $STABILITY_KEY`.
//   Fields: image (jpeg/png/webp, each side ≥ 64 px, 4,096–4,194,304 px total; required),
//   texture_resolution ('512'|'1024'|'2048', default '1024'), foreground_ratio (1–2, default 1.3),
//   remesh (none|triangle|quad), target_type (none|vertex|face), target_count (100–20000),
//   guidance_scale (1–10, default 3), seed.
//   200 → binary GLB. Errors 400/403 (content moderated)/413/429/500 → JSON { name, errors[] }.
//   4 credits ($0.04) per successful generation; failures are not charged. Synchronous (seconds).

const STABILITY_URL = 'https://api.stability.ai/v2beta/3d/stable-point-aware-3d';

export function stabilityProvider(key: string): PhotoProvider {
  return {
    id: 'stability',
    costUsd: COST_USD.stability,
    sync: true,
    submit: () => Promise.reject(new Error('stability is synchronous')),
    check: () => Promise.reject(new Error('stability is synchronous')),
    async run(front) {
      const m = /^data:(image\/(?:jpeg|png));base64,(.*)$/.exec(front);
      if (!m) throw new ProviderError('bad input image');
      const form = new FormData();
      form.append('image', new Blob([base64ToBytes(m[2])], { type: m[1] }), m[1] === 'image/png' ? 'front.png' : 'front.jpg');
      form.append('texture_resolution', '1024');
      const res = await fetch(STABILITY_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new ProviderError(`Stability: ${await errorDetail(res)}`);
      return readBody(res);
    },
  };
}

// ---------- mock (local dev, no money) ----------

export interface MockOptions {
  /** Returns the sample GLB (Worker: bundled module; Node: read from disk). */
  loadGlb: () => Promise<ArrayBuffer>;
  delayMs?: number;
  /** Force every job to fail (to develop the error UI). */
  fail?: boolean;
}

export function mockProvider(o: MockOptions): PhotoProvider {
  const delay = o.delayMs ?? 5000;
  return {
    id: 'mock',
    costUsd: COST_USD.mock,
    sync: false,
    async submit(images) {
      const start = Date.now();
      // Same GLB whatever the photos; the view list is kept in the handle so local runs can be checked.
      return JSON.stringify({ start, readyAt: start + delay, views: images.map((i) => i.view) });
    },
    async check(req) {
      const { start, readyAt } = JSON.parse(req) as { start: number; readyAt: number };
      const t = Date.now();
      if (t < readyAt) {
        const p = (t - start) / Math.max(1, readyAt - start);
        return p < 0.2 ? { state: 'queued', progress: null } : { state: 'running', progress: Math.round(p * 100) / 100 };
      }
      if (o.fail) return { state: 'failed', error: 'Mock provider failure (PHOTO_MOCK_FAIL=1).' };
      try {
        return { state: 'done', glb: await o.loadGlb() };
      } catch (err) {
        return { state: 'failed', error: `Mock sample GLB missing: ${errText(err)}` };
      }
    },
  };
}

// ---------- selection from env ----------

export interface ProviderEnv {
  PHOTO_PROVIDER?: string;
  FAL_KEY?: string;
  STABILITY_KEY?: string;
  PHOTO_MOCK_DELAY_MS?: string;
  PHOTO_MOCK_FAIL?: string;
  /** Tripo multiview with a missing middle view (front + back): v25 (default) = Tripo v2.5 named fields,
   *  pair = H3.1 [front, back] (back read as left), gap = H3.1 [front, "", back] (fails at fal). */
  PHOTO_TRIPO_LAYOUT?: string;
}

export interface ProviderSelection {
  primary: PhotoProvider | null;
  fallback: PhotoProvider | null;
  unavailableReason?: string;
  /** Owner-only model override (needs FAL_KEY; empty with the mock, which ignores `model`). */
  models?: Partial<Record<PhotoModel, PhotoProvider>>;
}

/** PHOTO_PROVIDER = fal | stability | mock; default: fal when FAL_KEY is set, else mock. */
export function selectProviders(env: ProviderEnv, loadMockGlb: () => Promise<ArrayBuffer>): ProviderSelection {
  const want = (env.PHOTO_PROVIDER || (env.FAL_KEY ? 'fal' : 'mock')).trim().toLowerCase();
  const fallback = env.STABILITY_KEY ? stabilityProvider(env.STABILITY_KEY) : null;
  if (want === 'mock') {
    const delay = Number(env.PHOTO_MOCK_DELAY_MS);
    return {
      primary: mockProvider({
        loadGlb: loadMockGlb,
        delayMs: Number.isFinite(delay) && delay >= 0 ? delay : undefined,
        fail: env.PHOTO_MOCK_FAIL === '1' || env.PHOTO_MOCK_FAIL === 'true',
      }),
      fallback: null,
    };
  }
  if (want === 'fal') {
    if (!env.FAL_KEY) return { primary: null, fallback: null, unavailableReason: 'Photo to Bricks is not set up yet (FAL_KEY missing).' };
    const primary = falProvider(env.FAL_KEY);
    const want = env.PHOTO_TRIPO_LAYOUT?.trim().toLowerCase();
    const layout: TripoLayout = want === 'pair' || want === 'gap' ? want : 'v25';
    return {
      primary,
      fallback,
      models: { trellis: primary, trellis2: falTrellis2Provider(env.FAL_KEY), 'tripo-mv': falTripoProvider(env.FAL_KEY, layout) },
    };
  }
  if (want === 'stability') {
    if (!fallback) return { primary: null, fallback: null, unavailableReason: 'Photo to Bricks is not set up yet (STABILITY_KEY missing).' };
    return { primary: fallback, fallback: null };
  }
  return { primary: null, fallback: null, unavailableReason: `Unknown PHOTO_PROVIDER "${env.PHOTO_PROVIDER}".` };
}
