import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease, sha256 } from '../../content-pipeline/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'yueqian-training');
for (const file of ['external-catalog.js', 'external-snapshot.js', 'external-materials.js', 'content-release-seed.js', 'content-release.js', 'material-search.js']) await import(path.join(web, file));
const catalog = globalThis.YUEQIAN_EXTERNAL_CATALOG;
const snapshot = globalThis.YUEQIAN_EXTERNAL_SEED;
const client = globalThis.YueqianContentRelease;
const search = globalThis.YueqianMaterialSearch;
const registry = JSON.parse(fs.readFileSync(path.join(root, 'content-pipeline/sources.json')));
const topics = JSON.parse(fs.readFileSync(path.join(root, 'content-pipeline/topics.json')));
const seed = await client.fromSeed(globalThis.YUEQIAN_CONTENT_RELEASE, snapshot, catalog);
const checks = [];
async function check(name, run) { await run(); checks.push(name); }
function pointer(bundle) { return { schemaVersion: 1, releaseID: bundle.releaseID, manifestPath: 'releases/' + bundle.releaseID + '/manifest.json', manifestSha256: sha256(bundle.files.get('manifest.json')) }; }
function fixtureFetch(bundle, requests, modify = value => value) {
  return async (value, options) => {
    const url = new URL(value);
    requests.push(url.pathname);
    assert.equal(url.origin, 'https://library.example');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    if (url.pathname === '/content/latest.json') return new Response(JSON.stringify(pointer(bundle)));
    const prefix = '/content/releases/' + bundle.releaseID + '/';
    assert.ok(url.pathname.startsWith(prefix));
    const file = url.pathname.slice(prefix.length);
    const bytes = bundle.files.get(file);
    return bytes ? modify(new Response(bytes), file) : new Response('missing', { status: 404 });
  };
}
const nextSnapshot = structuredClone(snapshot);
nextSnapshot.revision = 'a'.repeat(40);
nextSnapshot.fetchedAt = '2026-10-28T08:00:00.000Z';
nextSnapshot.articles[0].markdown += '\n\n增量更新校验内容。\n';
nextSnapshot.articles[0].sha256 = sha256(nextSnapshot.articles[0].markdown);
const changedImage = nextSnapshot.articles[0].images[0];
const changedBytes = Buffer.concat([Buffer.from(changedImage.data, 'base64'), Buffer.from([0])]);
changedImage.data = changedBytes.toString('base64');
changedImage.sha256 = sha256(changedBytes);
const bundle = buildRelease(nextSnapshot, registry, topics);

await check('两端发布清单与内置 10 篇、49 张原图一致', async () => {
  assert.equal(seed.snapshot.articles.length, 10);
  assert.equal(seed.snapshot.articles.flatMap(article => article.images).length, 49);
  assert.deepEqual(seed.snapshot, snapshot);
  assert.equal(Object.keys(seed.files).length, 13);
  assert.ok(Object.keys(seed.files).every(file => !file.startsWith('assets/')));
  const native = JSON.parse(fs.readFileSync(path.join(root, 'native-app/Sources/YueqianCore/Resources/content-release.json')));
  assert.deepEqual(seed.latest, native.latest);
});

await check('资料未变化只读指针，不下载正文或原图', async () => {
  let requests = 0;
  const result = await client.refresh('https://library.example/content/', seed, catalog, async () => {
    requests++;
    return new Response(JSON.stringify(seed.latest));
  });
  assert.equal(result.changed, false);
  assert.equal(requests, 1);
  assert.equal(result.budget.requests, 1);
  assert.deepEqual(result.state.snapshot, snapshot);
});

await check('增量下载只取变更哈希，完整校验后返回新版本', async () => {
  const requests = [];
  const result = await client.refresh('https://library.example/content', seed, catalog, fixtureFetch(bundle, requests));
  const previous = JSON.parse(Buffer.from(seed.manifestBase64, 'base64'));
  const previousHashes = new Set(previous.files.map(file => file.sha256));
  const changed = bundle.manifest.files.filter(file => !previousHashes.has(file.sha256));
  assert.equal(requests.length, changed.length + 2);
  assert.equal(result.budget.reusedFiles, bundle.manifest.files.length - changed.length);
  assert.equal(requests.filter(file => file.includes('/assets/')).length, 1);
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.snapshot, nextSnapshot);
  assert.deepEqual(result.state.snapshot.articles.map(article => article.lessonIDs), snapshot.articles.map(article => article.lessonIDs));
  assert.equal(seed.snapshot.revision, snapshot.revision);
});

await check('断网、坏原图、坏清单与同版本冲突均保留旧版本', async () => {
  const originalHash = sha256(JSON.stringify(seed));
  const missing = fixtureFetch(bundle, [], (response, file) => file.startsWith('assets/') ? new Response('missing', { status: 404 }) : response);
  await assert.rejects(client.refresh('https://library.example/content/', seed, catalog, missing), /HTTP 404/);
  const corrupted = fixtureFetch(bundle, [], (response, file) => file.startsWith('assets/') ? new Response(Buffer.alloc(changedBytes.length)) : response);
  await assert.rejects(client.refresh('https://library.example/content/', seed, catalog, corrupted), /校验失败/);
  const manifest = fixtureFetch(bundle, [], (response, file) => file === 'manifest.json' ? new Response('{}') : response);
  await assert.rejects(client.refresh('https://library.example/content/', seed, catalog, manifest), /哈希校验失败/);
  await assert.rejects(client.refresh('https://library.example/content/', seed, catalog, async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(client.refresh('https://library.example/content/', seed, catalog, async () => new Response(JSON.stringify({ ...seed.latest, manifestSha256: 'f'.repeat(64) }))), /冲突/);
  assert.equal(sha256(JSON.stringify(seed)), originalHash);
});

await check('缓存篡改、额外文件与课程关联更改不能被激活', async () => {
  const corrupted = structuredClone(seed);
  corrupted.files['LICENSE.txt'] = Buffer.from('All rights reserved').toString('base64');
  await assert.rejects(client.validateState(corrupted, catalog), /校验失败/);
  const extra = structuredClone(seed);
  extra.files['../escape'] = 'eA==';
  await assert.rejects(client.validateState(extra, catalog), /未知文件/);
  const changedCatalog = structuredClone(catalog);
  changedCatalog.articles[0].lessonIDs = ['unapproved-course'];
  await assert.rejects(client.validateState(seed, changedCatalog), /关联未经审核/);
});

await check('服务地址限制公开 HTTPS 或本机 HTTP，拒绝凭证与附带参数', async () => {
  assert.equal(client.baseURL('https://library.example/content').href, 'https://library.example/content/');
  assert.equal(client.endpoint('http://127.0.0.1:8788/api/search').hostname, '127.0.0.1');
  assert.equal(client.endpoint('http://[::1]:8788/').hostname, '[::1]');
  for (const url of ['http://example.com/', 'https://user:secret@example.com/', 'https://example.com/?key=value', 'https://example.com/#part', 'file:///tmp/library', 'javascript:alert(1)']) assert.throws(() => client.endpoint(url));
  await assert.rejects(client.refresh('https://library.example/', seed, catalog, async () => new Response('x'.repeat(4097))), /限制|过大/);
});

const memory = new Map();
const savedCachedValue = globalThis.YueqianMaterials.cachedValue;
globalThis.YueqianMaterials.cachedValue = async function (key, value) {
  if (arguments.length > 1) memory.set(key, structuredClone(value));
  return structuredClone(memory.get(key));
};
const external = {
  id: 'agents-context', title: 'Context engineering', excerpt: 'Context engineering uses tools and memory.',
  sourceID: 'microsoft-agents', repository: 'microsoft/ai-agents-for-beginners', revision: 'b'.repeat(40),
  url: 'https://github.com/microsoft/ai-agents-for-beginners/blob/' + 'b'.repeat(40) + '/context/README.md',
  sha256: 'c'.repeat(64), kind: 'external', reviewStatus: 'unreviewed'
};
function response(externalResults = [external], degraded = false, overrides = {}) { return new Response(JSON.stringify({ schemaVersion: 1, query: 'rag', releaseID: seed.latest.releaseID, generatedAt: new Date().toISOString(), cache: { status: 'miss', savedAt: null }, library: { results: [] }, external: { results: externalResults }, degraded, ...overrides })); }
const queryOptions = { query: 'RAG', snapshot, releaseID: seed.latest.releaseID, searchURL: 'https://search.example/api/search' };

await check('离线与未配置时中英文搜索仍有本机原文，片段来自正文', async () => {
  const result = await search.search({ ...queryOptions, query: '检索增强', searchURL: null, fetcher: () => { throw new Error('must not fetch'); } });
  assert.ok(result.library.some(item => item.id === 'ms-rag'));
  assert.equal(result.external.length, 0);
  assert.equal(result.cache, 'none');
  assert.ok(result.library.every(item => search.validItem(item, 'library')));
  for (const query of ['', '***', 'a\u0000', 'x'.repeat(257)]) assert.throws(() => search.normalize(query));
});

await check('统一搜索保留库内与未审核分组，查询缓存不重复发网', async () => {
  let requests = 0;
  const fetcher = async (value, options) => {
    requests++;
    const url = new URL(value);
    assert.equal(url.searchParams.get('q'), 'rag');
    assert.equal(url.searchParams.get('scope'), 'all');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined);
    return response();
  };
  const first = await search.search({ ...queryOptions, fetcher });
  assert.equal(first.external[0].reviewStatus, 'unreviewed');
  assert.ok(first.library.some(item => item.id === 'ms-rag'));
  const second = await search.search({ ...queryOptions, fetcher });
  assert.equal(second.cache, 'fresh');
  assert.equal(requests, 1);
  const cache = memory.get('search-cache-v1');
  cache.entries[0].savedAt -= 300001;
  cache.entries[0].value.savedAt = cache.entries[0].savedAt;
  const offline = await search.search({ ...queryOptions, fetcher: async () => { throw new Error('offline'); } });
  assert.equal(offline.cache, 'stale');
  assert.equal(offline.external[0].url, external.url);
  assert.equal(offline.degraded, true);
  const partial = await search.search({ ...queryOptions, fetcher: async () => response([], true) });
  assert.equal(partial.cache, 'stale');
  assert.equal(partial.external[0].url, external.url);
});

await check('检索缓存随资料版本隔离，非法来源与过大响应回退本机', async () => {
  const nextOptions = { ...queryOptions, releaseID: 'd'.repeat(64) };
  let requests = 0;
  const result = await search.search({ ...nextOptions, fetcher: async () => { requests++; return response([{ ...external, url: 'https://evil.example/source' }], false, { releaseID: nextOptions.releaseID }); } });
  assert.equal(requests, 1);
  assert.equal(result.external.length, 0);
  assert.equal(result.degraded, true);
  assert.ok(result.library.length);
  const oversized = await search.search({ ...nextOptions, fetcher: async () => new Response('x'.repeat(1048577)) });
  assert.equal(oversized.degraded, true);
  assert.equal(oversized.external.length, 0);
  assert.equal(search.validItem({ ...external, sourceID: 'unapproved' }, 'external'), false);
  assert.equal(search.validItem({ ...external, reviewStatus: 'approved' }, 'external'), false);
  assert.equal(search.validItem({ ...external, url: external.url + '?token=value' }, 'external'), false);
});

await check('服务响应的检索词与资料版本不一致时拒绝串用结果', async () => {
  memory.clear();
  for (const overrides of [{ query: 'different query' }, { releaseID: 'f'.repeat(64) }]) {
    const result = await search.search({ ...queryOptions, fetcher: async () => response([external], false, overrides) });
    assert.equal(result.external.length, 0);
    assert.ok(result.library.some(item => item.id === 'ms-rag'));
    assert.equal(result.degraded, true);
    assert.equal(memory.get('search-cache-v1'), undefined);
  }
});

await check('服务旧缓存保留来源时间，不重新标为新鲜或延长有效期', async () => {
  memory.clear();
  const savedAt = Date.now() - 600000;
  let requests = 0;
  const fetcher = async () => { requests++; return response([external], true, { cache: { status: 'stale', savedAt: new Date(savedAt).toISOString() } }); };
  const result = await search.search({ ...queryOptions, fetcher });
  assert.equal(result.cache, 'stale');
  assert.equal(memory.get('search-cache-v1').entries[0].savedAt, savedAt);
  const retry = await search.search({ ...queryOptions, fetcher });
  assert.equal(retry.cache, 'stale');
  assert.equal(requests, 2);
  assert.equal(memory.get('search-cache-v1').entries[0].savedAt, savedAt);
  memory.clear();
  const expired = await search.search({ ...queryOptions, fetcher: async () => response([external], true, { cache: { status: 'stale', savedAt: new Date(Date.now() - 86400001).toISOString() } }) });
  assert.equal(expired.external.length, 0);
  assert.equal(expired.degraded, true);
  const missing = await search.search({ ...queryOptions, fetcher: async () => response([external], true, { cache: { status: 'stale', savedAt: null } }) });
  assert.equal(missing.external.length, 0);
});
globalThis.YueqianMaterials.cachedValue = savedCachedValue;

console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
