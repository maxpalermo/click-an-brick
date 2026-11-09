// Typed client for "My builds" (contract: app/src/api/builds.types.ts).
// Same relative URLs in dev (Vite proxies /api → Express on :8787) and on Cloudflare (Worker + D1).
import type { Build, BuildList, BuildSummary, CreateBuildRequest, UpdateBuildRequest } from './builds.types';
import { ApiError, BASE } from './client';

export { ApiError };

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { credentials: 'same-origin', cache: 'no-store', redirect: 'manual', ...init });
  } catch {
    throw new ApiError('Cannot reach the Brickyard server. Check your connection.', 0);
  }
  // Behind Cloudflare Access an expired session redirects to the login page (opaque / HTML answer).
  if (res.type === 'opaqueredirect' || (res.ok && !/json/i.test(res.headers.get('content-type') ?? '') && res.status !== 204)) {
    throw new ApiError('Your sign-in has expired.', 401);
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

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const BUILD_ID_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/;
const path = (id: string) => {
  if (!BUILD_ID_RE.test(id)) throw new ApiError('Invalid build id.', 400);
  return `/api/builds/${id}`;
};

/** GET /api/builds → newest updated first, without the ldr. */
export async function listBuilds(): Promise<BuildList> {
  return (await (await call('/api/builds')).json()) as BuildList;
}

/** POST /api/builds. 409 = archive full, 413 = too large. */
export async function createBuild(req: CreateBuildRequest): Promise<BuildSummary> {
  return (await (await call('/api/builds', { method: 'POST', ...json(req) })).json()) as BuildSummary;
}

/** GET /api/builds/:id (with the ldr). */
export async function getBuild(id: string): Promise<Build> {
  return (await (await call(path(id))).json()) as Build;
}

/** PATCH /api/builds/:id: only the fields sent change. */
export async function updateBuild(id: string, req: UpdateBuildRequest): Promise<BuildSummary> {
  return (await (await call(path(id), { method: 'PATCH', ...json(req) })).json()) as BuildSummary;
}

/** DELETE /api/builds/:id. */
export async function deleteBuild(id: string): Promise<void> {
  await call(path(id), { method: 'DELETE' });
}

/** A short, friendly message for an archive error. */
export function buildsErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return "You're offline or the server can't be reached.";
    if (e.status === 401) return 'Your sign-in has expired. Sign in again.';
    if (e.status === 409) return 'My builds is full. Delete a few builds to make room.';
    if (e.status === 413) return 'This build is too big for My builds. Export it as .ldr instead.';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}
