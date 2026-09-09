/*
 * Service worker de la terminal.
 *
 * Regla que manda sobre todo lo demás: NUNCA servir órdenes viejas desde caché.
 * En una cocina, una orden desactualizada es peor que una pantalla en blanco —
 * se cocina lo que no es, o se da por entregado lo que no salió. Por eso:
 *
 *   - /api/ y /socket.io/  → siempre red, sin caché, sin excepciones
 *   - el armazón (html, íconos, manifiesto) → caché, para que la app abra
 *     al instante y muestre un mensaje claro si no hay señal
 */

const CACHE = 'meridian-terminal-v1';
const ARMAZON = ['/tablet', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ARMAZON))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(
        claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Datos en vivo: jamás desde caché
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Armazón: se sirve de caché al instante y se refresca por detrás, así una
  // versión nueva de la app entra sola en la siguiente apertura.
  e.respondWith(
    caches.match(e.request).then((cacheada) => {
      const red = fetch(e.request).then((resp) => {
        if (resp && resp.ok) {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
        }
        return resp;
      }).catch(() => cacheada);

      return cacheada || red;
    })
  );
});
