// Web 原文资料库客户端（content-release.js）：按需读取、首次下载校验、缓存后信任、增量更新与失败保留。
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRelease, readLibrarySnapshot, sha256 } from '../../content-pipeline/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'yueqian-training');
for (const file of ['external-catalog.js', 'external-materials.js', 'content-release.js', 'material-search.js']) await import(path.join(web, file));
const catalog = globalThis.YUEQIAN_EXTERNAL_CATALOG;
const client = globalThis.YueqianContentRelease;
const search = globalThis.YueqianMaterialSearch;
const registry = JSON.parse(fs.readFileSync(path.join(root, 'content-pipeline/sources.json')));
const topics = JSON.parse(fs.readFileSync(path.join(root, 'content-pipeline/topics.json')));
const snapshot = await readLibrarySnapshot();
const current = buildRelease(snapshot, registry, topics);
const checks = [];
async function check(name, run) { await run(); checks.push(name); }

class MemoryCache {
  constructor() { this.entries = new Map(); }
  async match(request) { const bytes = this.entries.get(typeof request === 'string' ? request : request.url); return bytes ? new Response(bytes) : undefined; }
  async put(request, response) { this.entries.set(typeof request === 'string' ? request : request.url, new Uint8Array(await response.arrayBuffer())); }
  async keys() { return [...this.entries.keys()].map(url => ({ url })); }
  async delete(request) { return this.entries.delete(request.url); }
}
let cache = new MemoryCache();
client.setCacheStorage(() => ({ open: async name => { assert.equal(name, 'yueqian-content-v1'); return cache; } }));
function resetCache() { cache = new MemoryCache(); client.setCacheStorage(() => ({ open: async () => cache })); }

function pointer(bundle) { return { schemaVersion: 1, releaseID: bundle.releaseID, manifestPath: 'releases/' + bundle.releaseID + '/manifest.json', manifestSha256: sha256(bundle.files.get('manifest.json')) }; }
function fixtureFetch(bundle, requests, modify = value => value) {
  return async (value, options) => {
    const url = new URL(value);
    requests.push(url.pathname);
    assert.equal(url.origin, 'https://library.example');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    if (url.pathname === '/content/latest.json') { assert.equal(options.cache, 'no-store'); return new Response(JSON.stringify(pointer(bundle))); }
    const prefix = '/content/releases/' + bundle.releaseID + '/';
    assert.ok(url.pathname.startsWith(prefix));
    const file = url.pathname.slice(prefix.length);
    const bytes = bundle.files.get(file);
    return bytes ? modify(new Response(bytes), file) : new Response('missing', { status: 404 });
  };
}
const base = 'https://library.example/content/';
const nextSnapshot = structuredClone(snapshot);
nextSnapshot.sources = nextSnapshot.sources.map(source => source.id === 'microsoft-genai' ? { ...source, revision: 'a'.repeat(40), fetchedAt: '2026-10-28T08:00:00.000Z' } : source);
nextSnapshot.articles[0].markdown += '\n\n增量更新校验内容。\n';
nextSnapshot.articles[0].sha256 = sha256(nextSnapshot.articles[0].markdown);
const changedImage = nextSnapshot.articles[0].images[0];
const changedBytes = Buffer.concat([Buffer.from(changedImage.data, 'base64'), Buffer.from([0])]);
changedImage.data = changedBytes.toString('base64');
changedImage.sha256 = sha256(changedBytes);
const next = buildRelease(nextSnapshot, registry, topics);
const state = await client.load(base, catalog, fixtureFetch(current, []));

await check('首次打开只读指针与清单并校验，15 篇 58 张原图按需读取', async () => {
  const requests = [];
  resetCache();
  const loaded = await client.load(base, catalog, fixtureFetch(current, requests));
  assert.deepEqual(requests, ['/content/latest.json', '/content/' + pointer(current).manifestPath]);
  assert.equal(loaded.manifest.documents.length, 15);
  assert.equal(loaded.manifest.assetCount, 58);
  assert.deepEqual(client.restore(structuredClone(loaded)).latest, loaded.latest);
  assert.throws(() => client.restore({ ...loaded, schemaVersion: 1 }), /无效/);
});

await check('正文首次下载校验后进缓存；再次打开直接信任缓存，不发网、不重算', async () => {
  resetCache();
  const requests = [];
  const document = await client.documentFor(state, 'ms-rag', catalog, fixtureFetch(current, requests));
  assert.equal(document.id, 'ms-rag');
  assert.ok(document.images.every(image => image.width > 0 && image.height > 0));
  assert.equal(requests.length, 1);
  client.setCacheStorage(() => ({ open: async () => cache }));
  const again = await client.documentFor(state, 'ms-rag', catalog, async () => { throw new Error('must not fetch'); });
  assert.equal(again.markdown, document.markdown);
  const asset = document.images[0].path;
  assert.equal(client.assetURL(state, asset), base + 'releases/' + current.releaseID + '/' + asset);
  assert.equal(await client.cacheAssets(state, document.images.map(image => image.path), fixtureFetch(current, [])), document.images.length);
  assert.equal(await client.cacheAssets(state, document.images.map(image => image.path), async () => { throw new Error('must not fetch'); }), 0);
});

await check('下载的正文或原图哈希不符时拒绝，不写入缓存', async () => {
  resetCache();
  const bad = fixtureFetch(current, [], (response, file) => file.startsWith('documents/') || file.startsWith('assets/') ? new Response(Buffer.alloc(Number(current.manifest.files.find(item => item.path === file).bytes))) : response);
  await assert.rejects(client.documentFor(state, 'ms-agents', catalog, bad), /校验失败/);
  const asset = current.manifest.files.find(item => item.path.startsWith('assets/')).path;
  await assert.rejects(client.file(state, asset, bad), /校验失败/);
  assert.equal(cache.entries.size, 0);
});

await check('资料未变化只读指针，不下载正文或原图', async () => {
  let requests = 0;
  const result = await client.refresh(base, state, catalog, async () => { requests++; return new Response(JSON.stringify(state.latest)); });
  assert.equal(result.changed, false);
  assert.equal(requests, 1);
  assert.equal(result.state, state);
});

await check('增量更新：正文与索引完整下载校验，原图按哈希复用缓存，变更原图查看时再下载', async () => {
  resetCache();
  for (const item of current.manifest.files) await cache.put(base + 'releases/' + current.releaseID + '/' + item.path, new Response(current.files.get(item.path)));
  const requests = [];
  const result = await client.refresh(base, state, catalog, fixtureFetch(next, requests));
  const previousHashes = new Set(current.manifest.files.map(file => file.sha256));
  const changed = next.manifest.files.filter(file => !previousHashes.has(file.sha256));
  const changedRequired = changed.filter(file => !file.path.startsWith('assets/') && file.path !== 'coverage.json');
  assert.equal(result.changed, true);
  assert.equal(requests.length, 2 + changedRequired.length);
  assert.equal(requests.filter(file => file.includes('/assets/')).length, 0);
  assert.equal(result.budget.reusedFiles, next.manifest.files.length - changed.length);
  const changedAsset = changed.find(file => file.path.startsWith('assets/'));
  assert.ok(changedAsset);
  const assetRequests = [];
  await client.file(result.state, changedAsset.path, fixtureFetch(next, assetRequests));
  assert.equal(assetRequests.length, 1);
  assert.equal(await client.prune(result.state), current.manifest.files.length);
  assert.ok([...cache.entries.keys()].every(url => url.includes('/releases/' + next.releaseID + '/')));
});

await check('断网、坏正文、坏清单与同版本冲突均保留旧版本', async () => {
  const original = JSON.stringify(state);
  await assert.rejects(client.refresh(base, state, catalog, fixtureFetch(next, [], (response, file) => file.startsWith('documents/') ? new Response('missing', { status: 404 }) : response)), /HTTP 404/);
  await assert.rejects(client.refresh(base, state, catalog, fixtureFetch(next, [], (response, file) => file === 'index.json' ? new Response(Buffer.alloc(next.manifest.files.find(item => item.path === 'index.json').bytes)) : response)), /校验失败/);
  await assert.rejects(client.refresh(base, state, catalog, fixtureFetch(next, [], (response, file) => file === 'manifest.json' ? new Response('{}') : response)), /哈希校验失败/);
  await assert.rejects(client.refresh(base, state, catalog, async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(client.refresh(base, state, catalog, async () => new Response(JSON.stringify({ ...state.latest, manifestSha256: 'f'.repeat(64) }))), /冲突/);
  assert.equal(JSON.stringify(state), original);
});

await check('课程关联被改动的清单不能被激活', async () => {
  const changedCatalog = structuredClone(catalog);
  changedCatalog.articles[0].lessonIDs = ['unapproved-course'];
  await assert.rejects(client.load(base, changedCatalog, fixtureFetch(current, [])), /关联未经审核/);
});

await check('服务地址限制公开 HTTPS 或本机 HTTP，拒绝凭证与附带参数', async () => {
  assert.equal(client.baseURL('https://library.example/content').href, 'https://library.example/content/');
  assert.equal(client.endpoint('http://127.0.0.1:8788/api/search').hostname, '127.0.0.1');
  assert.equal(client.endpoint('http://[::1]:8788/').hostname, '[::1]');
  for (const url of ['http://example.com/', 'https://user:secret@example.com/', 'https://example.com/?key=value', 'https://example.com/#part', 'file:///tmp/library', 'javascript:alert(1)']) assert.throws(() => client.endpoint(url));
  await assert.rejects(client.refresh('https://library.example/', state, catalog, async () => new Response('x'.repeat(4097))), /限制|过大/);
});

resetCache();
const searchSource = await client.searchSnapshot(state, catalog, fixtureFetch(current, []));
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
function response(externalResults = [external], degraded = false, overrides = {}) { return new Response(JSON.stringify({ schemaVersion: 1, query: 'rag', releaseID: state.latest.releaseID, generatedAt: new Date().toISOString(), cache: { status: 'miss', savedAt: null }, library: { results: [] }, external: { results: externalResults }, degraded, ...overrides })); }
const queryOptions = { query: 'RAG', snapshot: searchSource, releaseID: state.latest.releaseID, searchURL: 'https://search.example/api/search' };

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
