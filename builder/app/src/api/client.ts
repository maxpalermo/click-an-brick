// HTTP implementation of the ApiClient contract (app/src/api/types.ts).
// Relative URLs: in dev Vite proxies /api → :8787, in production the server serves the app.
import type { BrickColor, CatalogPart } from '../model/types';
import type { ApiClient, SharedModel } from './types';

export const BASE = '/by-backend';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch {
    throw new ApiError('Cannot reach the Brickyard server. Is it running?', 0);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

/** Memoise a promise; forget it on failure so a later call can retry. */
function memo<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (!p) {
      p = fn();
      p.catch(() => (p = null));
    }
    return p;
  };
}

const getCatalog = memo(() => request<CatalogPart[]>('/api/catalog'));
const getColors = memo(() => request<BrickColor[]>('/api/colors'));

export const api: ApiClient = {
  getCatalog,
  getColors,

  shareModel(name: string, ldr: string) {
    return request<{ id: string }>('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ldr }),
    });
  },

  getSharedModel(id: string) {
    if (!/^[a-z0-9]{1,32}$/i.test(id)) return Promise.reject(new ApiError('Invalid model link.', 400));
    return request<SharedModel>(`/api/models/${encodeURIComponent(id)}`);
  },
};

/** URL of the packed (self-contained MPD) file for a part, for the engine's LDrawLoader. */
export const packedPartUrl = (partId: string) => `${BASE}/api/parts/${encodeURIComponent(partId.toLowerCase())}/packed`;
