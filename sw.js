/* Exacto — service worker (Projets, Chantier, Shop, Punch).
   Sans mode hors ligne complet : les données restent toujours en direct (API et connexion jamais mises en cache).
   Rôle : rendre l'application installable, afficher une page claire hors connexion, accélérer les images/icônes. */
const V = 'exacto-pwa-v1', OFFLINE = '/offline';
const PRE = [OFFLINE, '/exacto-logo.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(PRE.map(u => fetch(new Request(u, { cache: 'reload' })).then(r => { if (r.ok && !r.redirected) return c.put(u, r); }).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('exacto-pwa-') && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;   // API, Clerk et tiers : toujours en direct
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match(OFFLINE).then(r => r || new Response('Hors connexion', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))));
    return;
  }
  if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(url.pathname)) {               // images / polices : cache puis mise à jour en arrière-plan
    e.respondWith(caches.open(V).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(r => { if (r.ok && !r.redirected) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })));
    return;
  }
  if (/\.(js|css|webmanifest)$/i.test(url.pathname)) {                              // scripts : réseau d'abord, copie si hors connexion
    e.respondWith(fetch(req).then(r => { if (r.ok && !r.redirected) caches.open(V).then(c => c.put(req, r.clone())); return r; }).catch(() => caches.match(req)));
  }
});
