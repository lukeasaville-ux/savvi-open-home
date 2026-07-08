/* Savvi Open Home — service worker.
   Goal: instant repeat loads + offline shell, without ever serving a stale app.
   - Navigations (the HTML): network-first (always try fresh), fall back to cache offline.
   - Hashed static assets (JS/CSS/fonts/images): cache-first (they're immutable).
   - The n8n API + any cross-origin request: left untouched (never cached). */
const CACHE = "savvi-shell-v1";
const HTML = "/savvi-open-home/";

self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch the API / cross-origin

  if (req.mode === "navigate") {
    // Network-first for the app shell so a new deploy always wins.
    e.respondWith(
      fetch(req)
        .then((res) => { caches.open(CACHE).then((c) => c.put(HTML, res.clone())); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match(HTML)))
    );
    return;
  }

  // Cache-first for immutable, hashed assets.
  e.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});
