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

const CACHE = 'meridian-terminal-v3';
const ARMAZON = ['/tablet', '/manifest.json', '/icon-192.png', '/icon-512.png'];

/* Los íconos y el manifiesto no cambian casi nunca: para esos sí conviene la
   caché primero, que abre al instante. El HTML de la app no. */
const esArmazonEstable = (ruta) => /\.(png|ico|webmanifest)$|^\/manifest\.json$/.test(ruta);

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

  // Íconos y manifiesto: caché primero, que abren al instante y no cambian.
  if (esArmazonEstable(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((cacheada) => cacheada || fetch(e.request).then((resp) => {
        if (resp && resp.ok) {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
        }
        return resp;
      }))
    );
    return;
  }

  // El HTML de la app: RED PRIMERO, con la caché solo como respaldo si no hay
  // señal.
  //
  // Antes era al revés (caché primero, refrescar por detrás), y eso escondía
  // cada versión nueva: al abrir la app se veía la vieja, y la nueva entraba
  // solo en la apertura siguiente. Así fue como la pestaña de Reservas quedó
  // invisible en la tablet aunque ya estaba desplegada — el equipo tenía
  // guardado el armazón de antes de que existiera.
  //
  // El costo es unas décimas de segundo al abrir con red. La ganancia es que
  // lo que se despliega es lo que se ve.
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok) {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
