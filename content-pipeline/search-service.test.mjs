import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeQuery, rankDocuments } from './search-common.mjs';
import { createMemoryCache, createSearchHandler, createSearchService } from './search-service.mjs';

const releaseID = 'a'.repeat(64);
const revision = 'b'.repeat(40);
const sources = [{ id: 'official', repository: 'official/lessons', revision }];
const topics = { topics: [{ id: 'context', title: '上下文工程', terms: ['context engineering', '上下文工程'] }] };
const index = { schemaVersion: 1, documents: [{ id: 'library-context', title: 'Context Engineering', text: 'Context engineering selects the information supplied to a model. Trace the source and evaluate.', sourceID: 'official', url: `https://github.com/official/lessons/blob/${revision}/context/README.md`, path: 'documents/context.json', lessonIDs: ['w2.3'] }] };
const externalItem = { id: 'external-context', kind: 'external', reviewStatus: 'unreviewed', title: 'Context for agents', path: '02-context/README.md', sourceID: 'official', repository: 'official/lessons', revision, url: `https://github.com/official/lessons/blob/${revision}/02-context/README.md`, sha256: 'c'.repeat(64), excerpt: 'Context engineering uses tools and memory.', score: 2, matchedTerms: ['context'] };
const good = () => ({ status: 'ok', results: [externalItem], reason: null, checkedAt: '2026-10-28T07:00:00Z' });
const unavailable = () => ({ status: 'unavailable', results: [], reason: 'upstream-rate-limited' });
function service(options = {}) { return createSearchService({ index, releaseID, sources, topics, externalSearch: async () => good(), ...options }); }

test('中英文主题词可匹配原文，片段逐字取自资料而非生成回答', () => {
  for (const query of ['上下文工程', 'What is context engineering?', 'CONTEXT']) {
    const results = rankDocuments(index.documents, query, topics);
    assert.equal(results[0].id, 'library-context');
    assert.ok(index.documents[0].text.includes(results[0].excerpt));
  }
  assert.deepEqual(rankDocuments(index.documents, '星际独角兽zzz', topics), []);
  assert.equal(normalizeQuery('  ＲＡＧ  检索 '), 'rag 检索');
  for (const query of ['', '  ', '***', 'a\u0000', 'x'.repeat(257), null]) assert.throws(() => normalizeQuery(query));
});

test('统一结果明确核准与候选、来源版本，响应不泄露全文索引', async () => {
  const result = await service().search({ query: '上下文工程' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.library.results[0].reviewStatus, 'approved');
  assert.equal(result.body.external.results[0].reviewStatus, 'unreviewed');
  assert.equal(result.body.library.results[0].revision, revision);
  assert.equal(result.body.results[0].text, undefined);
  assert.equal(result.body.degraded, false);
  assert.equal(result.body.cache.status, 'miss');
});

test('scope=library 不触发外部请求；空结果不编造答案', async () => {
  const instance = service({ externalSearch: () => { throw new Error('must not fetch'); } });
  const result = await instance.search({ query: '独角兽zz', scope: 'library' });
  assert.deepEqual(result.body.results, []);
  assert.equal(result.body.external.status, 'not-requested');
  assert.equal(result.body.degraded, false);
});

test('新鲜缓存复用：不同limit共用完整结果，不发重复请求', async () => {
  let calls = 0;
  const instance = service({ externalSearch: async () => { calls++; return good(); } });
  await instance.search({ query: 'context', limit: 1 });
  const result = await instance.search({ query: '  CONTEXT ', limit: 10 });
  assert.equal(calls, 1);
  assert.equal(result.body.cache.status, 'fresh');
  assert.ok(result.body.cache.savedAt);
});

test('相同并发查询共用一次外部检索', async () => {
  let calls = 0;
  const instance = service({ externalSearch: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return good(); } });
  const results = await Promise.all([instance.search({ query: 'context' }), instance.search({ query: 'context' })]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.body.external.results.length === 1));
});

test('过期缓存遇到限流继续返回有效旧出处，标记降级而不改写检查时间', async () => {
  let timestamp = Date.parse('2026-10-28T07:00:00Z');
  let failure = false;
  const instance = service({ now: () => timestamp, limits: { cacheTtlMs: 10 }, externalSearch: async () => failure ? unavailable() : good() });
  const first = await instance.search({ query: 'context' });
  timestamp += 11; failure = true;
  const result = await instance.search({ query: 'context' });
  assert.equal(result.body.external.results[0].url, externalItem.url);
  assert.equal(result.body.external.checkedAt, undefined);
  assert.equal(result.body.cache.status, 'stale');
  assert.equal(result.body.cache.savedAt, first.body.generatedAt);
  assert.equal(result.body.degraded, true);
  assert.equal(result.body.reason, 'upstream-rate-limited');
});

test('超过最大缓存时间后，不再返回旧外部条目', async () => {
  let timestamp = Date.parse('2026-10-28T07:00:00Z');
  let failure = false;
  const instance = service({ now: () => timestamp, limits: { cacheTtlMs: 10, maxStaleMs: 20 }, externalSearch: async () => failure ? unavailable() : good() });
  await instance.search({ query: 'context' });
  timestamp += 21; failure = true;
  const result = await instance.search({ query: 'context' });
  assert.deepEqual(result.body.external.results, []);
  assert.equal(result.body.cache.status, 'miss');
  assert.equal(result.body.library.results.length, 1);
});

test('上游部分成功时保留先前完整缓存，后续冷却仍能回退完整结果', async () => {
  let timestamp = Date.parse('2026-10-28T07:00:00Z');
  let failure = false;
  const instance = service({ now: () => timestamp, limits: { cacheTtlMs: 10 }, externalSearch: async () => failure ? { status: 'partial', results: [{ ...externalItem, id: 'new', url: externalItem.url.replace('/02-context/', '/03-context/') }], reason: 'upstream-rate-limited' } : good() });
  await instance.search({ query: 'context' });
  timestamp += 11; failure = true;
  const partial = await instance.search({ query: 'context' });
  assert.equal(partial.body.external.results.length, 2);
  const fallback = await instance.search({ query: 'context' });
  assert.equal(fallback.body.external.results[0].url, externalItem.url);
  assert.equal(fallback.body.cache.status, 'stale');
  assert.equal(fallback.body.reason, 'upstream-cooldown');
});

test('失败时未配置外部服务仍可搜索已核准资料', async () => {
  const result = await service({ externalSearch: null }).search({ query: 'context' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.reason, 'external-not-configured');
  assert.equal(result.body.library.results.length, 1);
});

test('客户请求限流可返回缓存，不能继续触发上游；无可用结果返回429', async () => {
  let calls = 0;
  const instance = service({ limits: { requestsPerClient: 1 }, externalSearch: async () => { calls++; return good(); } });
  await instance.search({ query: 'context' }, { clientID: 'one' });
  const cached = await instance.search({ query: 'context' }, { clientID: 'one' });
  assert.equal(cached.statusCode, 200);
  assert.equal(cached.body.reason, 'rate-limited');
  assert.equal(cached.body.cache.status, 'fresh');
  const denied = await instance.search({ query: 'nothing', scope: 'external' }, { clientID: 'one' });
  assert.equal(denied.statusCode, 429);
  assert.ok(denied.retryAfter > 0);
  assert.equal(calls, 1);
});

test('全局外部预算与冷却挡住后续网络请求，保留本地结果', async () => {
  let calls = 0;
  const instance = service({ limits: { externalQueriesPerWindow: 1 }, externalSearch: async () => { calls++; return good(); } });
  await instance.search({ query: 'context' });
  const denied = await instance.search({ query: 'engineering' });
  assert.equal(denied.body.reason, 'external-budget');
  assert.equal(denied.body.library.results.length, 1);
  assert.equal(calls, 1);
  const failed = service({ externalSearch: async () => { calls++; return unavailable(); } });
  await failed.search({ query: 'context' });
  const cooled = await failed.search({ query: 'engineering' });
  assert.equal(cooled.body.reason, 'upstream-cooldown');
  assert.equal(calls, 2);
});

test('忽略Abort的外部适配器也有查询时间上限', async () => {
  const instance = service({ externalSearch: () => new Promise(() => {}), limits: { externalTimeoutMs: 10 } });
  const result = await instance.search({ query: 'context' });
  assert.equal(result.body.reason, 'timeout');
  assert.equal(result.body.library.results.length, 1);
});

test('坏缓存、缓存读写失败及非法来源不会污染检索', async () => {
  const instance = service({ cache: { get: async () => { throw new Error('broken'); }, put: async () => { throw new Error('disk full'); } } });
  const result = await instance.search({ query: 'context' });
  assert.equal(result.body.external.results.length, 1);
  assert.equal(result.body.external.cacheWarning, 'cache-write-failed');
  const malicious = service({ externalSearch: async () => ({ status: 'ok', results: [{ ...externalItem, url: 'https://evil.example/collect' }] }) });
  const rejected = await malicious.search({ query: 'context' });
  assert.equal(rejected.body.external.results.length, 0);
  assert.equal(rejected.body.reason, 'upstream-unavailable');
});

test('查询缓存与内容版本绑定，内存缓存有数量上限', async () => {
  const cache = createMemoryCache(1);
  await cache.put('a', { value: 1 });
  await cache.put('b', { value: 2 });
  assert.equal(await cache.get('a'), null);
  const shared = createMemoryCache();
  let calls = 0;
  const externalSearch = async () => { calls++; return good(); };
  await service({ cache: shared, externalSearch }).search({ query: 'context' });
  await service({ cache: shared, externalSearch, bundleID: 'd'.repeat(64) }).search({ query: 'context' });
  assert.equal(calls, 2);
});

test('HTTP校验参数、方法、路由、CORS和健康状态', async () => {
  const handle = createSearchHandler(service(), { allowedOrigin: 'https://app.example' });
  for (const suffix of ['?q=', '?q=context&q=tools', '?q=context&url=https://evil.example', '?q=context&scope=unknown', '?q=context&limit=1.5', '?q=context&limit=0']) {
    assert.equal((await handle(new Request('http://localhost/api/search' + suffix))).status, 400);
  }
  assert.equal((await handle(new Request('http://localhost/no'))).status, 404);
  assert.equal((await handle(new Request('http://localhost/api/search', { method: 'POST' }))).status, 405);
  const result = await handle(new Request('http://localhost/api/search?q=context&scope=library', { headers: { origin: 'https://app.example' } }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('access-control-allow-origin'), 'https://app.example');
  const evil = await handle(new Request('http://localhost/health', { headers: { origin: 'https://evil.example' } }));
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await evil.json()).documents, 1);
  assert.equal((await handle(new Request('http://localhost/api/search', { method: 'OPTIONS', headers: { origin: 'https://app.example' } }))).status, 204);
});

test('HTTP限流响应包含Retry-After，完整参数边界受约束', async () => {
  const handle = createSearchHandler(service({ externalSearch: async () => ({ status: 'ok', results: [] }), limits: { requestsPerClient: 1 } }));
  await handle(new Request('http://localhost/api/search?q=nothing&scope=external'));
  const result = await handle(new Request('http://localhost/api/search?q=other&scope=external'));
  assert.equal(result.status, 429);
  assert.ok(Number(result.headers.get('retry-after')) > 0);
  assert.throws(() => service({ limits: { externalQueriesPerWindow: 11 } }));
});
