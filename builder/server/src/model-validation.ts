// Pure (runtime-agnostic) validation for shared models. No Node imports: this module is also
// bundled into the Cloudflare Worker (cloud/src/worker.ts), so both backends behave identically.

/** Unambiguous alphabet: no 0/o, 1/l/i. */
export const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const ID_LEN = 8;
const ID_RE = new RegExp(`^[${ALPHABET}]{${ID_LEN}}$`);

export const MAX_NAME_LEN = 100;
/** Max JSON body size for POST /api/models (matches express.json({ limit: '2mb' })). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function isValidModelId(id: string): boolean {
  return ID_RE.test(id);
}

export class ValidationError extends Error {}

export function validateModelInput(body: unknown): { name: string; ldr: string } {
  if (!body || typeof body !== 'object') throw new ValidationError('Body must be a JSON object { name, ldr }.');
  const { name, ldr } = body as Record<string, unknown>;
  if (typeof ldr !== 'string' || ldr.trim() === '') throw new ValidationError('`ldr` must be a non-empty string.');
  if (name !== undefined && typeof name !== 'string') throw new ValidationError('`name` must be a string.');
  const n = (name ?? '').trim() || 'Untitled';
  if (n.length > MAX_NAME_LEN) throw new ValidationError(`\`name\` must be at most ${MAX_NAME_LEN} characters.`);
  return { name: n, ldr };
}

const PART_ID = /^[a-z0-9_.-]+\.dat$/;

/** Valid (already lowercased) top-level part id, e.g. "3001.dat". */
export function isValidPartId(id: string): boolean {
  return PART_ID.test(id) && !id.includes('..') && id.length <= 80;
}
