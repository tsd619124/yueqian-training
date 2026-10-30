/* 跃迁计划 Service Worker:网络优先、离线回退缓存。
   在线时总能拿到最新版;离线(地铁等)回退到最近一次缓存。 */
var CACHE_PREFIX = 'yueqian-';
var CACHE = CACHE_PREFIX + 'v17';
var ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './sync-config.js', './training-receipt.png', './training-receipt-obscured.png', './materials.html', './external-catalog.js', './external-snapshot.js', './content-release-seed.js', './material-services.js', './content-release.js', './material-search.js', './external-materials.js', './external-materials.css', './THIRD_PARTY_NOTICES.txt'];
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })
  );
});
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (/\/(?:api(?:\/|$)|content-library(?:\/|$))/.test(url.pathname) || req.cache === 'no-store') return;
  e.respondWith((function () {
    return fetch(req).then(function (res) {
      if (res && res.ok) {
        var cp = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, cp); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (c) {
        if(c)return c;
        if(req.mode==='navigate')return caches.match('./index.html', { ignoreSearch: true });
        return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      });
    });
  })());
});
