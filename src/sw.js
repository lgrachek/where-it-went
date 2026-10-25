// Minimal service worker: makes the app installable and shows a friendly page when there's no signal.
// It never caches the budget data or the page itself, so you always see current numbers.
const CACHE = "wiw-v1";
const OFFLINE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/icons/icon-192.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return; // let everything else go straight to the network
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
