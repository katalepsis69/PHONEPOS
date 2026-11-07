// phone-repair-pos/public/report-sw.js
// Pass-through service worker: exists only so Android offers the install
// prompt on an HTTPS origin. Caches nothing — a stale report
// is a lie. Default scope "/" also matching POS pages is harmless under
// a pass-through; iOS Add-to-Home-Screen works without it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
