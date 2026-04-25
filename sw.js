const CACHE_NAME = 'vokabeltrainer-v4';
const BASE = '/alexas-vokabeltrainer-englisch/';
const ASSETS = [
  BASE,
  BASE + 'index.html',
  BASE + 'app.js',
  BASE + 'style.css',
  BASE + 'manifest.json',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  BASE + 'data/index.json',
  BASE + 'data/unit1-across-cultures.json',
  BASE + 'data/unit1-weekend-workshop.json',
  BASE + 'data/unit1-checkout-story.json',
  BASE + 'data/unit1-text-smart.json',
  BASE + 'data/unit2.json',
  BASE + 'data/unit2-welcome-station1.json',
  BASE + 'data/unit2-station2.json',
  BASE + 'data/unit2-story-checkin.json',
  BASE + 'data/unit3-checkin.json',
  BASE + 'data/unit3-checkout.json',
  BASE + 'data/unit3-stations.json',
  BASE + 'data/unit3-story-textsmart.json',
  BASE + 'data/irregular-verbs.json'
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
