/* 跃迁计划 Service Worker:网络优先、离线回退缓存。
   在线时总能拿到最新版;离线(地铁等)回退到最近一次缓存。 */
var CACHE = 'yueqian-v7';
var ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-180.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })
  );
});
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith((function () {
    return fetch(req).then(function (res) {
      if (res && res.ok) {
        var cp = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, cp); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (c) {
        return c || caches.match('./index.html', { ignoreSearch: true });
      });
    });
  })());
});
