import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRelease, readLibrarySnapshot, sha256, writeRelease } from './lib.mjs';
import { prepareSearchWorker } from './search-runtime.mjs';
import { readWebRelease, retainPrevious } from './production.mjs';
import { checkCacheName, checkWorkerSearch, classifyMismatch, verifyFiles } from './verify-production.mjs';

const registry = JSON.parse(await fs.readFile(new URL('./sources.json', import.meta.url)));
const topics = JSON.parse(await fs.readFile(new URL('./topics.json', import.meta.url)));
const bundledSnapshot = await readLibrarySnapshot();
const original = buildRelease(bundledSnapshot, registry, topics);
const pointer = release => ({ schemaVersion: 1, releaseID: release.releaseID, manifestPath: `releases/${release.releaseID}/manifest.json`, manifestSha256: sha256(release.files.get('manifest.json')) });
async function temporary(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-production-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeRelease(directory, original);
  return directory;
}

test('首次上线仅登记真实当前发布，不伪造上一版', async context => {
  const directory = await temporary(context);
  const history = await retainPrevious(directory, null);
  assert.deepEqual(history, [pointer(original)]);
});

test('保留已校验的上一发布，并拒绝哈希损坏文件', async context => {
  const directory = await temporary(context);
  const snapshot = structuredClone(bundledSnapshot);
  snapshot.sources = snapshot.sources.map(source => ({ ...source, revision: 'a'.repeat(40) }));
  const previous = buildRelease(snapshot, registry, topics);
  let broken = false;
  context.mock.method(globalThis, 'fetch', async address => {
    const pathname = new URL(address).pathname;
    if (pathname.endsWith('/latest.json')) return Response.json(pointer(previous));
    const file = pathname.split('/' + previous.releaseID + '/')[1];
    return new Response(broken && file !== 'manifest.json' ? 'corrupt' : previous.files.get(file));
  });
  const history = await retainPrevious(directory, 'https://example.test/');
  assert.equal(history.length, 2);
  assert.deepEqual(await fs.readFile(path.join(directory, previous.manifestPath || pointer(previous).manifestPath)), previous.files.get('manifest.json'));
  const invalidDirectory = await temporary(context);
  broken = true;
  await assert.rejects(retainPrevious(invalidDirectory, 'https://example.test/'), /校验失败/);
  assert.equal(JSON.parse(await fs.readFile(path.join(invalidDirectory, 'latest.json'))).releaseID, original.releaseID);
});

test('Worker 来源刷新失败保留内置检索，且一小时内不反复请求', async context => {
  const directory = await temporary(context);
  const prepared = await prepareSearchWorker(directory);
  const worker = await import(pathToFileURL(path.join(prepared.directory, 'worker.mjs')));
  const content = JSON.parse(await fs.readFile(path.join(prepared.directory, 'search-bundle.json')));
  let requests = 0;
  const live = worker.createLiveWorker(content, { fetcher: async () => { requests++; return new Response('bad', { status: 503 }); } });
  const environment = { DISCOVERY_URL: 'https://example.test/discovery.json', ALLOWED_ORIGIN: 'https://app.test' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await live.fetch(new Request('https://worker.test/api/search?q=RAG'), environment);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).library.results.length > 0);
  }
  assert.equal(requests, 1);
  const health = await (await live.fetch(new Request('https://worker.test/health'), environment)).json();
  assert.equal(health.discoveryStatus, 'retained-after-refresh-failure');
});

test('Worker 静态备用资料走资产绑定，库内搜索不读取远端目录', async context => {
  const directory = await temporary(context);
  const prepared = await prepareSearchWorker(directory);
  const worker = await import(pathToFileURL(path.join(prepared.directory, 'worker.mjs')));
  const content = JSON.parse(await fs.readFile(path.join(prepared.directory, 'search-bundle.json')));
  const live = worker.createLiveWorker(content, { fetcher: async () => { throw new Error('不应联网'); } });
  const environment = { DISCOVERY_URL: 'https://example.test/discovery.json', ASSETS: { fetch: async () => new Response('static-content') } };
  assert.equal(await (await live.fetch(new Request('https://worker.test/content-library/latest.json'), environment)).text(), 'static-content');
  const response = await live.fetch(new Request('https://worker.test/api/search?q=RAG&scope=library'), environment);
  assert.ok((await response.json()).library.results.length > 0);
});

async function webFixture(context, { assets = "'./', './index.html', './app.js'", version = "'2.3.4'" } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-web-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'index.html'), `<link rel="manifest" href="manifest.webmanifest"><script>var APP_VERSION=${version};</script><a href="./materials.html?x=1">`);
  await fs.writeFile(path.join(directory, 'sw.js'), `var CACHE_PREFIX = 'yueqian-';\nvar CACHE = CACHE_PREFIX + 'v99';\nvar ASSETS = [${assets}];`);
  for (const name of ['app.js', 'manifest.webmanifest', '使用说明-手机同步与部署.md']) await fs.writeFile(path.join(directory, name), name);
  return directory;
}

test('Web 版本、缓存名与发布文件从 index.html / sw.js 读取，不写死', async context => {
  const release = await readWebRelease(await webFixture(context));
  assert.equal(release.webVersion, '2.3.4');
  assert.equal(release.cache, 'yueqian-v99');
  assert.deepEqual(release.precached, ['app.js', 'index.html']);
  assert.deepEqual(release.files, ['app.js', 'index.html', 'manifest.webmanifest', 'sw.js', '使用说明-手机同步与部署.md']);
  await assert.rejects(readWebRelease(await webFixture(context, { assets: "'./missing.js'" })), /ASSETS 列出的文件不存在：missing\.js/);
  await assert.rejects(readWebRelease(await webFixture(context, { assets: "'../escape.js'" })), /超出发布根目录/);
  await assert.rejects(readWebRelease(await webFixture(context, { version: 'VERSION' })), /APP_VERSION/);
  await assert.rejects(readWebRelease(await webFixture(context, { assets: "'./other/app.js'" })), /超出发布根目录/);
});

test('version.json 与 content/*.json 即使不在 ASSETS 中也进入发布清单', async context => {
  const directory = await webFixture(context, { assets: "'./', './index.html', './content/lessons.json'" });
  await fs.mkdir(path.join(directory, 'content'));
  for (const name of ['content/lessons.json', 'content/quiz.json', 'version.json']) await fs.writeFile(path.join(directory, name), '{}');
  await fs.writeFile(path.join(directory, 'content/.hidden.json'), '{}');
  const release = await readWebRelease(directory);
  assert.deepEqual(release.precached, ['content/lessons.json', 'index.html']);
  assert.deepEqual(release.files, ['content/lessons.json', 'content/quiz.json', 'index.html', 'manifest.webmanifest', 'sw.js', 'version.json', '使用说明-手机同步与部署.md']);
});

test('当前 Web 源的 sw.js ASSETS 全部存在且进入发布清单', async () => {
  const release = await readWebRelease(fileURLToPath(new URL('../yueqian-training/', import.meta.url)));
  assert.ok(release.precached.every(file => release.files.includes(file)));
  assert.ok(release.files.includes('sw.js') && release.files.includes('index.html'));
  assert.match(release.webVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/u);
  assert.match(release.cache, /^yueqian-v[0-9]+$/u);
});

// 原文与配图页是独立页面，它的依赖不会经过 index.html 的引用收集。
// 以前只进运行时缓存，而运行时缓存要「先联网打开过一次」才有，于是断网首开原文页
// 会落到 navigate 兜底显示首页。这条断言钉住「依赖必须进 ASSETS」，防止以后加文件又漏。
test('原文与配图页的全部本地依赖都进 sw.js 预缓存', async () => {
  const web = fileURLToPath(new URL('../yueqian-training/', import.meta.url));
  const html = await fs.readFile(path.join(web, 'materials.html'), 'utf8');
  const assets = await fs.readFile(path.join(web, 'sw.js'), 'utf8');
  const assetsBlock = /\bvar\s+ASSETS\s*=\s*\[([\s\S]*?)\];/u.exec(assets)?.[1];
  assert.ok(assetsBlock, 'sw.js 里找不到 ASSETS');
  const precached = new Set([...assetsBlock.matchAll(/'([^']*)'/gu)].map(match => match[1].replace(/^\.\//u, '')));
  // 只检查同源的本地文件；外链、锚点与他页链接不算（index.html 已单独预缓存）。
  const dependencies = [...html.matchAll(/(?:src|href)\s*=\s*"\.\/([^"?#]+)"/gu)]
    .map(match => match[1])
    .filter(name => name !== 'index.html' && /\.(?:js|css)$/u.test(name));
  assert.ok(dependencies.length >= 6, `原文页依赖过少（${dependencies.length}），选择器可能已失效`);
  const missing = dependencies.filter(name => !precached.has(name));
  assert.deepEqual(missing, [], `原文页这些依赖没进预缓存，断网首开会显示首页：${missing.join(', ')}`);
});

function siteFetcher(files, schedule = () => null) {
  let calls = 0;
  return async address => {
    calls++;
    const url = new URL(address);
    const override = schedule(url.pathname.slice(1), calls);
    const body = override ?? files[url.pathname.slice(1)];
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
  };
}

const record = (filePath, body) => ({ path: filePath, bytes: Buffer.byteLength(body), sha256: sha256(body) });

test('读回检查按指数退避重试，传播延迟消失后通过', async () => {
  const report = { files: [record('index.html', 'new'), record('a.js', 'same')] };
  const previousReport = { files: [record('index.html', 'old'), record('a.js', 'same')] };
  const delays = [];
  let clock = 0;
  const fetcher = siteFetcher({ 'index.html': 'new', 'a.js': 'same' }, (file, calls) => file === 'index.html' && calls < 5 ? 'old' : null);
  const result = await verifyFiles({ base: new URL('https://site.test/'), report, previousReport, fetcher, sleep: async delay => { delays.push(delay); clock += delay; }, now: () => clock, options: { initialDelayMs: 5, maxDelayMs: 20, budgetMs: 1000 } });
  assert.equal(result.mismatches.length, 0);
  assert.deepEqual(delays, [5, 10, 20]);
});

test('超时后区分传播延迟与损坏', async () => {
  const report = { files: [record('index.html', 'new'), record('fresh.js', 'fresh'), record('b.js', 'expected')] };
  const previousReport = { files: [record('index.html', 'old'), record('b.js', 'older')] };
  let clock = 0;
  const lagging = await verifyFiles({ base: new URL('https://site.test/'), report: { files: report.files.slice(0, 2) }, previousReport, fetcher: siteFetcher({ 'index.html': 'old' }), sleep: async delay => { clock += delay; }, now: () => clock, options: { initialDelayMs: 10, maxDelayMs: 10, budgetMs: 35 } });
  assert.equal(lagging.attempts, 4);
  assert.ok(lagging.propagationLagOnly);
  assert.deepEqual(lagging.mismatches.map(item => item.classification), ['propagation-lag', 'propagation-lag']);
  const corrupt = await verifyFiles({ base: new URL('https://site.test/'), report, previousReport, fetcher: siteFetcher({ 'index.html': 'new', 'fresh.js': 'fresh', 'b.js': 'garbage' }), sleep: async () => {}, now: () => 0, options: { budgetMs: 0 } });
  assert.equal(corrupt.propagationLagOnly, false);
  assert.deepEqual(corrupt.mismatches.map(item => [item.path, item.classification]), [['b.js', 'corrupt']]);
  assert.equal(classifyMismatch(record('x', 'x'), { status: 503 }, new Map()), 'unreachable');
});

test('Workers 检索检查只告警，不要求 releaseID 一致', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-verify-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = new URL('https://site.test/app/');
  assert.equal((await checkWorkerSearch(directory, base)).status, 'not-configured');
  await fs.writeFile(path.join(directory, 'material-services.js'), "globalThis.X = { searchURL: 'https://worker.test/api/search' };");
  const ok = await checkWorkerSearch(directory, base, async () => new Response(JSON.stringify({ releaseID: 'other', library: { results: [{}] } }), { headers: { 'access-control-allow-origin': base.origin } }));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.releaseID, 'other');
  const down = await checkWorkerSearch(directory, base, async () => { throw new TypeError('fetch failed'); });
  assert.equal(down.status, 'warning');
});

// 线上 version.json 的 cache 字段此前只被打印、从不校验。它与本次发布的 CACHE 不一致时，
// 用户更新后仍会命中旧外壳缓存——「更新了却看不到新界面」，而且极难排查。
test('线上 version.json 的缓存名必须与本次发布一致', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-cache-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = new URL('https://site.test/app/');
  const write = async cache => fs.writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify({ schemaVersion: 1, cache }));

  await write('yueqian-v27');
  const same = await checkCacheName({ base, directory, fetcher: async () => new Response(JSON.stringify({ version: '1.23.0', cache: 'yueqian-v27' })) });
  assert.equal(same.status, 'valid');

  const stale = await checkCacheName({ base, directory, fetcher: async () => new Response(JSON.stringify({ version: '1.23.0', cache: 'yueqian-v26' })) });
  assert.equal(stale.status, 'invalid');
  assert.match(stale.error, /缓存名不一致/u);

  const missing = await checkCacheName({ base, directory, fetcher: async () => new Response(JSON.stringify({ version: '1.23.0' })) });
  assert.equal(missing.status, 'invalid');

  const down = await checkCacheName({ base, directory, fetcher: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(down.status, 'invalid');

  // 发布清单本身没有 cache 字段时跳过，不误报。
  await fs.writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify({ schemaVersion: 1 }));
  assert.equal((await checkCacheName({ base, directory, fetcher: async () => new Response('{}') })).status, 'skipped');
});
