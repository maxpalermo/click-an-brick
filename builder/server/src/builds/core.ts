// "My builds": per-user archive of builds. Runtime-agnostic (no Node imports): bundled into the Cloudflare
// Worker (cloud/src/builds.ts, D1 `builds`) and used by the Express dev server (server/src/builds/routes.ts,
// in memory). Contract: app/src/api/builds.types.ts (types duplicated structurally here, keep in sync).
import { ALPHABET, isValidModelId } from '../model-validation.js';

export type BuildSource = 'editor' | 'photo' | 'import';
const SOURCES: readonly BuildSource[] = ['editor', 'photo', 'import'];

export interface BuildSummary {
  id: string;
  name: string;
  parts: number;
  thumb: string | null;
  source: BuildSource;
  shareId: string | null;
  photoJobId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Build extends BuildSummary {
  ldr: string;
}
export interface BuildList {
  builds: BuildSummary[];
  limit: number;
}

export const BUILD_THUMB_MAX_BYTES = 80 * 1024;
export const BUILD_NAME_MAX = 100;
export const BUILD_LDR_MAX_BYTES = 2 * 1024 * 1024;
/** JSON body limit: ldr + thumbnail (base64) + slack. */
export const BUILD_BODY_MAX_BYTES = BUILD_LDR_MAX_BYTES + 160 * 1024;
export const BUILDS_PER_USER = 300;

export const BUILD_ID_LEN = 10;
const BUILD_ID_RE = new RegExp(`^[${ALPHABET}]{${BUILD_ID_LEN}}$`);
const PHOTO_JOB_RE = new RegExp(`^[${ALPHABET}]{12}$`);
const THUMB_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export class BuildHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** One row of D1 `builds` (cloud/migrations/0006_builds.sql). Times are ISO 8601 UTC. */
export interface BuildRow {
  id: string;
  user: string;
  name: string;
  ldr: string;
  parts: number;
  thumb: string | null;
  source: BuildSource;
  share_id: string | null;
  photo_job_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuildStore {
  /** The user's builds without ldr, newest updated first. */
  list(user: string): Promise<Omit<BuildRow, 'ldr'>[]>;
  count(user: string): Promise<number>;
  get(id: string): Promise<BuildRow | null>;
  /** false when the id is taken. */
  insert(row: BuildRow): Promise<boolean>;
  update(id: string, user: string, patch: Partial<BuildRow>): Promise<void>;
  delete(id: string, user: string): Promise<boolean>;
}

export function newBuildId(): string {
  let s = '';
  const buf = new Uint8Array(32);
  while (s.length < BUILD_ID_LEN) {
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 248 && s.length < BUILD_ID_LEN) s += ALPHABET[b % ALPHABET.length];
  }
  return s;
}

export const isValidBuildId = (id: string) => BUILD_ID_RE.test(id);

/** Parts = type-1 lines of the main file (what app/src/model/ldraw.ts fromLdr loads). */
export function countParts(ldr: string): number {
  let n = 0;
  for (const line of ldr.split(/\r?\n/)) {
    const t = line.trimStart();
    if (t.startsWith('0 FILE') && n > 0) break;
    if (t.startsWith('1 ')) n++;
  }
  return n;
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

function field<T>(body: Record<string, unknown>, key: string, check: (v: unknown) => T | undefined, msg: string): T | undefined {
  if (!(key in body) || body[key] === undefined) return undefined;
  const v = check(body[key]);
  if (v === undefined) throw new BuildHttpError(400, msg);
  return v;
}

const asName = (v: unknown) => {
  if (typeof v !== 'string') return undefined;
  const n = v.trim() || 'Untitled';
  return n.length <= BUILD_NAME_MAX ? n : undefined;
};
const asLdr = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  if (utf8Len(v) > BUILD_LDR_MAX_BYTES) throw new BuildHttpError(413, 'This build is too large to save (max 2 MB as .ldr).');
  return v;
};
const asThumb = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v !== 'string' || !THUMB_RE.test(v)) return undefined;
  if (v.length * 0.75 > BUILD_THUMB_MAX_BYTES) throw new BuildHttpError(413, 'The preview image is too large (max 80 KB).');
  return v;
};
const asShareId = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && isValidModelId(v) ? v : undefined);
const asJobId = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && PHOTO_JOB_RE.test(v) ? v : undefined);
const asSource = (v: unknown) => (typeof v === 'string' && (SOURCES as readonly string[]).includes(v) ? (v as BuildSource) : undefined);

function obj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BuildHttpError(400, 'Body must be a JSON object.');
  return body as Record<string, unknown>;
}

export function toSummary(r: Omit<BuildRow, 'ldr'>): BuildSummary {
  return {
    id: r.id,
    name: r.name,
    parts: r.parts,
    thumb: r.thumb,
    source: r.source,
    shareId: r.share_id,
    photoJobId: r.photo_job_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class BuildsService {
  constructor(private store: BuildStore, private now: () => number = Date.now) {}

  async list(user: string): Promise<BuildList> {
    return { builds: (await this.store.list(user)).map(toSummary), limit: BUILDS_PER_USER };
  }

  async create(user: string, body: unknown): Promise<BuildSummary> {
    const b = obj(body);
    const ldr = field(b, 'ldr', asLdr, '`ldr` must be a non-empty LDraw text.');
    if (ldr === undefined) throw new BuildHttpError(400, '`ldr` is required.');
    const name = field(b, 'name', asName, `\`name\` must be a string of at most ${BUILD_NAME_MAX} characters.`) ?? 'Untitled';
    const thumb = field(b, 'thumb', asThumb, '`thumb` must be a JPEG, PNG or WebP data URI, or null.') ?? null;
    const source = field(b, 'source', asSource, '`source` must be "editor", "photo" or "import".') ?? 'editor';
    const shareId = field(b, 'shareId', asShareId, '`shareId` must be a share link id, or null.') ?? null;
    const photoJobId = field(b, 'photoJobId', asJobId, '`photoJobId` must be a photo job id, or null.') ?? null;
    if ((await this.store.count(user)) >= BUILDS_PER_USER) {
      throw new BuildHttpError(409, `My builds is full (${BUILDS_PER_USER} builds). Delete some to make room.`);
    }
    const t = new Date(this.now()).toISOString();
    for (let attempt = 0; attempt < 10; attempt++) {
      const row: BuildRow = {
        id: newBuildId(), user, name, ldr, parts: countParts(ldr), thumb, source,
        share_id: shareId, photo_job_id: photoJobId, created_at: t, updated_at: t,
      };
      if (await this.store.insert(row)) return toSummary(row);
    }
    throw new Error('Could not allocate a build id.');
  }

  async get(user: string, id: string): Promise<Build> {
    const r = await this.load(user, id);
    return { ...toSummary(r), ldr: r.ldr };
  }

  async update(user: string, id: string, body: unknown): Promise<BuildSummary> {
    const b = obj(body);
    const patch: Partial<BuildRow> = {};
    const name = field(b, 'name', asName, `\`name\` must be a string of at most ${BUILD_NAME_MAX} characters.`);
    const ldr = field(b, 'ldr', asLdr, '`ldr` must be a non-empty LDraw text.');
    const thumb = field(b, 'thumb', asThumb, '`thumb` must be a JPEG, PNG or WebP data URI, or null.');
    const shareId = field(b, 'shareId', asShareId, '`shareId` must be a share link id, or null.');
    if (name !== undefined) patch.name = name;
    if (ldr !== undefined) { patch.ldr = ldr; patch.parts = countParts(ldr); }
    if (thumb !== undefined) patch.thumb = thumb;
    if (shareId !== undefined) patch.share_id = shareId;
    const r = await this.load(user, id);
    if (Object.keys(patch).length) {
      patch.updated_at = new Date(this.now()).toISOString();
      await this.store.update(id, user, patch);
    }
    return toSummary({ ...r, ...patch });
  }

  async delete(user: string, id: string): Promise<void> {
    if (!isValidBuildId(id)) throw new BuildHttpError(400, 'Invalid build id.');
    if (!(await this.store.delete(id, user))) throw new BuildHttpError(404, 'Build not found.');
  }

  private async load(user: string, id: string): Promise<BuildRow> {
    if (!isValidBuildId(id)) throw new BuildHttpError(400, 'Invalid build id.');
    const r = await this.store.get(id);
    // Someone else's build looks exactly like a missing one.
    if (!r || r.user !== user) throw new BuildHttpError(404, 'Build not found.');
    return r;
  }
}

/** In-memory store for the Express dev server (lost on restart). */
export class MemoryBuildStore implements BuildStore {
  private rows = new Map<string, BuildRow>();
  async list(user: string) {
    return [...this.rows.values()]
      .filter((r) => r.user === user)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(({ ldr: _ldr, ...r }) => ({ ...r }));
  }
  async count(user: string) {
    let n = 0;
    for (const r of this.rows.values()) if (r.user === user) n++;
    return n;
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async insert(row: BuildRow) {
    if (this.rows.has(row.id)) return false;
    this.rows.set(row.id, { ...row });
    return true;
  }
  async update(id: string, user: string, patch: Partial<BuildRow>) {
    const r = this.rows.get(id);
    if (r && r.user === user) Object.assign(r, patch);
  }
  async delete(id: string, user: string) {
    const r = this.rows.get(id);
    if (!r || r.user !== user) return false;
    return this.rows.delete(id);
  }
}
