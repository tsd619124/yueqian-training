// 应用外壳：课程内容 JSON、版本文件与 Service Worker 的缓存策略。
// 运行：node --test yueqian-training/tests/app-shell.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(web, name), 'utf8');
const html = read('index.html');
const app = read('app.js');
const worker = read('sw.js');
const course = JSON.parse(read('content/course.json'));
const catalogPath = path.resolve(web, '../native-app/Sources/YueqianCore/Resources/catalog.json');

test('version.json 与 index.html 的 APP_VERSION、sw.js 的 CACHE 一致', () => {
  const version = JSON.parse(read('version.json'));
  const appVersion = /\bvar\s+APP_VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'/u.exec(html)?.[1];
  const prefix = /\bvar\s+CACHE_PREFIX\s*=\s*'([^']+)'/u.exec(worker)?.[1];
  const cache = /\bvar\s+CACHE\s*=\s*CACHE_PREFIX\s*\+\s*'([^']+)'/u.exec(worker)?.[1];
  assert.deepEqual(version, { version: appVersion, cache: prefix + cache });
});

test('index.html 与 app.js 不再内嵌课程数据，也不在加载时改写教材', () => {
  assert.ok(Buffer.byteLength(html) < 80 * 1024, 'index.html 应小于 80KB');
  for (const marker of ['var LESSONS=', 'var QUIZ=', 'CONTENT_SUPPLEMENTS', 'CONTENT_CASEBOOK', 'LESSON_REVIEWS', '## 虚构教学示例']) {
    assert.ok(!html.includes(marker) && !app.includes(marker), '仍包含 ' + marker);
  }
  assert.match(app, /var CONTENT_URL='\.\/content\/course\.json'/u);
  assert.match(html, /<script src="\.\/app\.js"><\/script>/u);
  assert.ok(!/\bvar\s+APP_VERSION\b/u.test(app), 'APP_VERSION 只在 index.html 定义');
});

test('course.json 即最终内容：与原生 catalog.json 的课程字段逐项相同', () => {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.deepEqual(Object.keys(course), Object.keys(catalog));
  for (const key of Object.keys(catalog)) assert.deepEqual(course[key], catalog[key], key);
  assert.equal(Object.keys(course.lessons).length, 60);
  assert.equal(course.entries.length, 60);
  // 原先在加载时追加的内容已写进数据
  assert.ok(course.lessons['w1.0'].how.includes('完成本页新增专项，保存自己的过程、参考与实际结果、失败修正和未测项'));
  assert.ok(Object.values(course.lessons).some(lesson => lesson.mat.some(material => material.b.startsWith('## 虚构教学示例\n'))));
  assert.equal(course.lessons['w1.0'].review.date, '2026-10-27');
});

test('预缓存只含应用外壳，不含原文页与大体积快照', () => {
  const assets = [...(/\bvar\s+ASSETS\s*=\s*\[([^\]]*)\]/u.exec(worker)[1]).matchAll(/'([^']*)'/gu)].map(match => match[1]);
  for (const required of ['./index.html', './app.js', './content/course.json', './manifest.webmanifest', './icon-180.png']) assert.ok(assets.includes(required), required);
  for (const excluded of ['./', './materials.html', './external-snapshot.js', './content-release-seed.js', './external-materials.js', './material-search.js', './content-release.js']) assert.ok(!assets.includes(excluded), excluded);
  for (const asset of assets) assert.ok(fs.existsSync(path.join(web, asset)), '文件不存在：' + asset);
  const bytes = assets.reduce((total, asset) => total + fs.statSync(path.join(web, asset)).size, 0);
  assert.ok(bytes < 600 * 1024, '预缓存合计 ' + bytes + ' 字节');
});

// ---------- 在模拟环境里运行 sw.js ----------
function harness({ fetchImpl, delays = [] } = {}) {
  const stores = new Map();
  const handlers = {};
  const keyOf = request => (typeof request === 'string' ? request : request.url);
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async add(request) { const response = await context.fetch(request); if (!response.ok) throw new TypeError('bad status'); store.set(keyOf(request), response); },
        async put(request, response) { store.set(keyOf(request), response); }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request) { for (const store of stores.values()) { const hit = store.get(keyOf(request)); if (hit) return hit.clone(); } return undefined; }
  };
  const context = {
    URL, Request, Response, Promise, console,
    caches,
    location: { origin: 'https://site.test' },
    setTimeout: (fn, ms) => { delays.push(ms); return setImmediate(fn); },
    // 同源响应在浏览器里 type 为 basic,Node 的 Response 默认是 default
    fetch: async request => { const response = await (fetchImpl || (async () => new Response('ok:' + keyOf(request), { status: 200 })))(request); Object.defineProperty(response, 'type', { value: 'basic' }); return response; },
    self: { registration: { scope: 'https://site.test/app/' }, addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting() { context.skipped = true; }, clients: { claim: async () => {} } }
  };
  vm.runInNewContext(worker, context);
  // wait=false 时不等待 waitUntil(网络一直不返回的场景)
  async function dispatch(type, extra = {}, wait = true) {
    const pending = [];
    let responded = null;
    const event = { ...extra, waitUntil: promise => pending.push(promise), respondWith: promise => { responded = promise; } };
    handlers[type](event);
    const response = responded ? await responded : undefined;
    if (wait) await Promise.all(pending);
    return { response, pending: pending.length };
  }
  const request = (url, init = {}) => ({ url: new URL(url, 'https://site.test/app/').href, method: 'GET', mode: init.mode || 'cors', cache: init.cache || 'default' });
  return { stores, dispatch, request, context, delays };
}

test('安装：可选文件下载失败不影响安装，必需文件失败则安装失败', async () => {
  const optional = harness({ fetchImpl: async request => new Response('x', { status: request.url.endsWith('THIRD_PARTY_NOTICES.txt') ? 404 : 200 }) });
  await optional.dispatch('install');
  const cached = [...optional.stores.get('yueqian-v19').keys()];
  assert.ok(cached.includes('https://site.test/app/content/course.json'));
  assert.ok(!cached.some(url => url.endsWith('THIRD_PARTY_NOTICES.txt')));
  assert.ok(!cached.includes('https://site.test/app/'), './ 不单独缓存');
  assert.equal(optional.context.skipped, undefined, '安装后等待用户确认，不自动接管');
  const required = harness({ fetchImpl: async request => new Response('x', { status: request.url.endsWith('course.json') ? 500 : 200 }) });
  await assert.rejects(required.dispatch('install'));
});

test('取数：./ 与 ./index.html 共用一条缓存，写缓存在 waitUntil 内完成', async () => {
  const sw = harness();
  const first = await sw.dispatch('fetch', { request: sw.request('./?from=home', { mode: 'navigate' }) });
  assert.equal(await first.response.text(), 'ok:https://site.test/app/?from=home');
  assert.ok(first.pending >= 1);
  assert.deepEqual([...sw.stores.get('yueqian-v19').keys()], ['https://site.test/app/index.html']);
  await sw.dispatch('fetch', { request: sw.request('./materials.html?article=a') });
  assert.ok(sw.stores.get('yueqian-runtime').has('https://site.test/app/materials.html'), '原文页运行时缓存到独立的 runtime 缓存');
});

test('取数：3 秒无响应先用缓存；离线时导航回退 index.html；no-store 与资料库不经过缓存', async () => {
  let online = true;
  const sw = harness({ fetchImpl: async request => (online ? new Response('fresh', { status: 200 }) : new Promise(() => {})) });
  await sw.dispatch('fetch', { request: sw.request('./content/course.json') });
  online = false;
  const slow = await sw.dispatch('fetch', { request: sw.request('./content/course.json', { cache: 'no-cache' }) }, false);
  assert.equal(await slow.response.text(), 'fresh');
  assert.ok(sw.delays.includes(3000));

  const offline = harness({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await offline.stores.set('yueqian-v19', new Map([['https://site.test/app/index.html', new Response('shell')]]));
  const nav = await offline.dispatch('fetch', { request: offline.request('./materials.html', { mode: 'navigate' }) });
  assert.equal(await nav.response.text(), 'shell');
  const miss = await offline.dispatch('fetch', { request: offline.request('./missing.js') });
  assert.equal(miss.response.status, 503);
  for (const skipped of [offline.request('./version.json', { cache: 'no-store' }), offline.request('./content-library/latest.json')]) {
    const result = await offline.dispatch('fetch', { request: skipped });
    assert.equal(result.response, undefined);
  }
});

test('激活：只清理本应用旧版本外壳缓存，保留 runtime 与原文页缓存；SKIP_WAITING 消息才接管', async () => {
  const sw = harness();
  for (const name of ['yueqian-v17', 'yueqian-runtime', 'yueqian-content-v1', 'other-app']) await sw.context.caches.open(name);
  await sw.dispatch('activate');
  assert.deepEqual([...sw.stores.keys()].sort(), ['other-app', 'yueqian-content-v1', 'yueqian-runtime']);
  await sw.dispatch('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(sw.context.skipped, true);
});
