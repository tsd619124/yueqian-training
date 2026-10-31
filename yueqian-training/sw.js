/* 跃迁计划 Service Worker
   预缓存:只放应用外壳(页面、app.js、课程内容 JSON、清单、图标等),原文与配图页面的文件在首次打开时运行时缓存。
   取数:网络优先,3 秒没有响应就先用缓存;离线时回退缓存。写缓存放在 event.waitUntil 里。
   更新:新版本装好后等待,由页面在用户点按「有新版本，点此更新」后发 SKIP_WAITING 再接管。 */
var CACHE_PREFIX = 'yueqian-';
var CACHE = CACHE_PREFIX + 'v18';
var RUNTIME = CACHE_PREFIX + 'runtime';
/* 激活时只删除本应用旧版本的外壳缓存(yueqian-v数字);runtime 缓存与原文页自己的缓存(如 yueqian-content-v1)保留 */
/* 发布清单也读取 ASSETS(content-pipeline/production.mjs);前 5 项缺一项就安装失败,其余为可选,缺失不影响安装 */
var ASSETS = ['./index.html', './app.js', './content/course.json', './manifest.webmanifest', './icon-180.png', './external-catalog.js', './sync-config.js', './training-receipt.png', './training-receipt-obscured.png', './THIRD_PARTY_NOTICES.txt'];
var REQUIRED = 5;
var NETWORK_TIMEOUT = 3000;

function cacheKey(url) {
  var u = new URL(url, self.registration.scope);
  u.search = ''; u.hash = '';
  if (/\/$/.test(u.pathname)) u.pathname += 'index.html'; /* ./ 与 ./index.html 共用一条缓存 */
  return u.href;
}
var SHELL = ASSETS.map(cacheKey);

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (cache) {
    function put(asset) { return cache.add(new Request(cacheKey(asset), { cache: 'reload' })); }
    return Promise.all(ASSETS.slice(0, REQUIRED).map(put)).then(function () {
      return Promise.all(ASSETS.slice(REQUIRED).map(function (asset) { return put(asset).catch(function () {}); }));
    });
  }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return /^yueqian-v\d+$/.test(k) && k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function fromCache(key, req) {
  return caches.match(key).then(function (hit) {
    if (hit) return hit;
    if (req.mode === 'navigate') return caches.match(cacheKey('./index.html'));
    return null;
  });
}
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  /* version.json、sync-config.js 用 no-store 直连;原文资料库由页面自行缓存 */
  if (/\/(?:api(?:\/|$)|content-library(?:\/|$))/.test(url.pathname) || req.cache === 'no-store') return;
  var key = cacheKey(req.url);
  var store = SHELL.indexOf(key) >= 0 ? CACHE : RUNTIME;
  var network = fetch(req).then(function (res) {
    return { res: res, copy: res && res.ok && res.type === 'basic' ? res.clone() : null };
  });
  e.waitUntil(network.then(function (got) {
    if (got.copy) return caches.open(store).then(function (cache) { return cache.put(key, got.copy); });
  }).catch(function () {}));
  e.respondWith(new Promise(function (resolve) {
    var settled = false;
    function settle(res) { if (!settled && res) { settled = true; resolve(res); } }
    network.then(function (got) { settle(got.res); }, function () {
      fromCache(key, req).then(function (hit) { settle(hit || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })); });
    });
    setTimeout(function () { if (!settled) fromCache(key, req).then(settle); }, NETWORK_TIMEOUT);
  }));
});
