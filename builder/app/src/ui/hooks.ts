import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CatalogPart } from '../model/types';

/** Reactive matchMedia. */
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

export const useIsPhone = () => useMedia('(max-width: 767px)');

// ---------- hash routing ----------

export type Route = { name: 'editor' } | { name: 'viewer'; id: string };

export function parseHash(hash: string): Route {
  const m = /^#\/m\/([A-Za-z0-9_-]+)\/?$/.exec(hash);
  return m ? { name: 'viewer', id: m[1] } : { name: 'editor' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(hash: string): void {
  if (location.hash !== hash) location.hash = hash;
}

// ---------- catalog (loaded once, shared) ----------

export type CatalogStatus = 'loading' | 'ready' | 'error';
interface CatalogSnapshot {
  status: CatalogStatus;
  parts: CatalogPart[];
}

let snapshot: CatalogSnapshot = { status: 'loading', parts: [] };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = (s: CatalogSnapshot) => {
  snapshot = s;
  listeners.forEach((l) => l());
};

export function loadCatalog(force = false): void {
  if (inflight || (snapshot.status === 'ready' && !force)) return;
  emit({ status: 'loading', parts: snapshot.parts });
  inflight = api
    .getCatalog()
    .then((parts) => emit({ status: 'ready', parts: Array.isArray(parts) ? parts : [] }))
    .catch(() => emit({ status: 'error', parts: [] }))
    .finally(() => {
      inflight = null;
    });
}

export function useCatalog(): CatalogSnapshot & { retry(): void } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    loadCatalog();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return { ...snapshot, retry: () => loadCatalog(true) };
}

/** Lookup of part id → catalog part (lower-cased ids). */
let indexFor: CatalogPart[] | null = null;
let index = new Map<string, CatalogPart>();
export function partIndex(parts: CatalogPart[]): Map<string, CatalogPart> {
  if (indexFor !== parts) {
    indexFor = parts;
    index = new Map(parts.map((p) => [p.id.toLowerCase(), p]));
  }
  return index;
}
