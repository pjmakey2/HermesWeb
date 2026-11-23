// Service worker mínimo: solo hace que HermesWeb se pueda instalar como app.
// No guarda nada en caché (todo es en vivo y requiere sesión), deja pasar las peticiones a la red.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
