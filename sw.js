const CACHE_NAME = 'vokabeltrainer-v6';
const BASE = '/alexas-vokabeltrainer-englisch/';
const ASSETS = [
  BASE,
  BASE + 'index.html',
  BASE + 'app.js',
  BASE + 'style.css',
  BASE + 'manifest.json',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  BASE + 'data/en/index.json',
  BASE + 'data/en/unit1-across-cultures.json',
  BASE + 'data/en/unit1-weekend-workshop.json',
  BASE + 'data/en/unit1-checkout-story.json',
  BASE + 'data/en/unit1-text-smart.json',
  BASE + 'data/en/unit2.json',
  BASE + 'data/en/unit2-welcome-station1.json',
  BASE + 'data/en/unit2-station2.json',
  BASE + 'data/en/unit2-story-checkin.json',
  BASE + 'data/en/unit3-checkin.json',
  BASE + 'data/en/unit3-checkout.json',
  BASE + 'data/en/unit3-stations.json',
  BASE + 'data/en/unit3-story-textsmart.json',
  BASE + 'data/en/irregular-verbs.json',
  BASE + 'data/es/index.json',
  BASE + 'data/es/unidad3-primer-paso.json',
  BASE + 'data/es/unidad3-bloque-a.json',
  BASE + 'data/es/unidad3-bloque-b.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request)
      .then(cached => cached || fetch(e.request)
        .then(resp => {
          if (resp && resp.status === 200 && e.request.method === 'GET') {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return resp;
        })
      )
  );
});
