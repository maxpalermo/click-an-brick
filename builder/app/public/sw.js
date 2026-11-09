// Brickyard service worker: app-shell caching + offline-friendly part geometry.
// Registered only in production builds (see src/main.tsx).
const VERSION = 'v2';
const SHELL = `brickyard-shell-${VERSION}`;
const RUNTIME = `brickyard-runtime-${VERSION}`;
const PARTS = `brickyard-parts-${VERSION}`;
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL, RUNTIME, PARTS]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('brickyard-') && !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

/**
 * Hashed build assets: cache first. A chunk of an older deploy that no longer exists comes back from the server as
 * the SPA fallback (index.html, 200): never cache that, and answer 404 so the page sees a clear failure (a module
 * worker or import fed HTML fails with no message) instead of keeping a poisoned cache entry forever.
 */
async function assetFirst(req) {
  const cache = await caches.open(SHELL);
  const isHtml = (r) => (r.headers.get('Content-Type') || '').includes('text/html');
  const hit = await cache.match(req);
  // Same cache version on purpose: older open tabs still need their (valid) old chunks; only HTML entries are bad.
  if (hit && !isHtml(hit)) return hit;
  if (hit) await cache.delete(req);
  const res = await fetch(req);
  if (isHtml(res)) {
    return new Response('Not found (this file belongs to an older version of Brickyard).', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(fallbackUrl || req, res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match(fallbackUrl || req)) || (await caches.match('/index.html'));
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || fresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // SPA navigations: network first, fall back to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL, '/index.html'));
    return;
  }
  // Hashed build assets never change.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(assetFirst(req));
    return;
  }
  // Part geometry and LDraw files are immutable for a given library version.
  if (/^\/api\/parts\/[^/]+\/packed$/.test(url.pathname) || url.pathname.startsWith('/ldraw/')) {
    event.respondWith(cacheFirst(req, PARTS));
    return;
  }
  // Catalog / colours: fast from cache, refreshed in background.
  if (url.pathname === '/api/catalog' || url.pathname === '/api/colors') {
    event.respondWith(staleWhileRevalidate(req, RUNTIME));
    return;
  }
  // Shared models: prefer fresh, allow offline re-open.
  if (url.pathname.startsWith('/api/models/')) {
    event.respondWith(networkFirst(req, RUNTIME));
    return;
  }
  if (SHELL_URLS.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req, SHELL));
  }
});
