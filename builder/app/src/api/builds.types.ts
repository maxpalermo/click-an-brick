// Contract for "My builds": a per-user archive of builds (owned by the PM; change only via the PM).
// Server: server/src/builds/core.ts (runtime-agnostic), cloud/src/builds.ts (D1 `builds`, migration 0006),
// server/src/builds/routes.ts (Express dev, in memory). The user is the Cloudflare Access email
// (Cf-Access-Authenticated-User-Email); without Access (local dev) everyone is 'local'.
//
//   GET    /api/builds          → BuildList (newest updated first, no ldr)
//   POST   /api/builds          CreateBuildRequest → 201 BuildSummary
//   GET    /api/builds/:id      → Build (with ldr)
//   PATCH  /api/builds/:id      UpdateBuildRequest → BuildSummary (only the fields sent change)
//   DELETE /api/builds/:id      → 204
// Errors are JSON { error }: 400 bad input · 401 not signed in · 404 not found / not yours ·
// 409 archive full (BuildList.limit builds per user) · 413 too large.

/** Where a build came from: made in the editor, a Photo to Bricks result, or an imported .ldr file. */
export type BuildSource = 'editor' | 'photo' | 'import';

export interface BuildSummary {
  /** 10 characters from 23456789abcdefghjkmnpqrstuvwxyz. */
  id: string;
  name: string;
  /** Number of parts (type-1 lines of the ldr), computed by the server. */
  parts: number;
  /** Small preview image as a data URI (JPEG/PNG/WebP, ≤ BUILD_THUMB_MAX_BYTES), or null. */
  thumb: string | null;
  source: BuildSource;
  /** Id of the share link made from this build (GET /api/models/:id), if it was shared. */
  shareId: string | null;
  /** Photo to Bricks job it came from (source 'photo'). */
  photoJobId: string | null;
  /** ISO 8601 UTC. */
  createdAt: string;
  updatedAt: string;
}

export interface Build extends BuildSummary {
  /** LDraw .ldr text (app/src/model/ldraw.ts toLdr / fromLdr), ≤ 2 MB. */
  ldr: string;
}

export interface BuildList {
  builds: BuildSummary[];
  /** Max builds per user; POST answers 409 when the archive is full. */
  limit: number;
}

export interface CreateBuildRequest {
  name: string;
  ldr: string;
  thumb?: string | null;
  /** Default 'editor'. */
  source?: BuildSource;
  shareId?: string | null;
  photoJobId?: string | null;
}

export interface UpdateBuildRequest {
  name?: string;
  ldr?: string;
  thumb?: string | null;
  shareId?: string | null;
}

/** Thumbnail limit: aim for ~256 px JPEG at quality ~0.8 (≈ 15–30 KB). */
export const BUILD_THUMB_MAX_BYTES = 80 * 1024;
export const BUILD_NAME_MAX = 100;
