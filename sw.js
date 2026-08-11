// Service worker for 會談紀錄表.
//
// The app is one self-contained index.html plus a manifest and icons, so the
// precache list is the whole site. Everything else the app needs — React, the
// template engine, the XLSX/ZIP writer — is already inlined in that one file.
//
// Two rules shape the rest of this file, both because of where the app runs:
// a tablet handed to customers at a trade show.
//
//   1. Never take over on its own. No skipWaiting(), no clients.claim() on an
//      existing page. A new version installs and then WAITS. The page decides
//      when to apply it, and only ever at a moment where a reload is harmless
//      (see the update banner in index.html) — a customer halfway through a
//      form must never have the page reload underneath them.
//   2. Never be un-recoverable. A bad cache would otherwise keep serving a
//      broken app that reloading cannot fix, on a device that may not be in
//      reach. index.html handles ?sw=off by unregistering and clearing caches;
//      this file cooperates by keeping the cache name predictable and by
//      handling the SKIP_WAITING and CLEAR_CACHES messages below.

// Bump on every release. It is the cache identity: a new value means a new
// cache, and activate() deletes every other one.
const VERSION = 'v3.13.0';
const CACHE = 'exhibition-form-' + VERSION;

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // No skipWaiting: a freshly installed worker sits in `waiting` until the page
  // asks for it. See rule 1 above.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('exhibition-form-') && n !== CACHE)
      .map((n) => caches.delete(n)));
    // Only reached once the page has already agreed to the update, so taking
    // control of it here is what it asked for.
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // Sent by the update banner when staff choose to apply the new version.
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  // Part of the ?sw=off escape hatch.
  if (event.data === 'CLEAR_CACHES') {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Same-origin only. There is nothing cross-origin to fetch — the app is
  // fully offline — and passing other origins through keeps this worker out of
  // the way of anything unexpected.
  if (url.origin !== self.location.origin) return;

  // Navigations to the app's own entry point resolve to the shell. Cache-first,
  // because the shell is the whole app and a stale-while-revalidate would mean
  // the tablet silently swapping versions mid-show — exactly what rule 1
  // forbids.
  //
  // Deliberately *not* a catch-all for every navigation under scope: this app
  // has exactly one entry point and no client-side routes, so answering some
  // other path with the shell would be a lie. Any other path goes to the
  // network and 404s there, which is the truthful answer.
  const scopePath = new URL(self.registration.scope).pathname;
  const isEntryPoint = url.pathname === scopePath
    || url.pathname === scopePath + 'index.html';

  if (req.mode === 'navigate' && isEntryPoint) {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      if (cached) return cached;
      try {
        return await fetch(req);
      } catch {
        // Offline with nothing cached: nothing useful to return, but a clear
        // response beats the browser's generic failure page.
        return new Response('離線，且尚未快取任何版本。請連上網路後重新開啟。', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      // Only precached entries are meant to live in the cache; anything else is
      // passed through so the cache stays exactly the set this file declares.
      return res;
    } catch (err) {
      throw err;
    }
  })());
});
