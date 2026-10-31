// 静态外部检索索引：排序一致性、指针/索引校验、原子替换与离线行为。
// 运行：node --test yueqian-training/tests/static-search-index.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const fixtures = path.resolve(web, '../content-pipeline/fixtures');
const memory = new Map();
globalThis.YueqianMaterials = {
  async cachedValue(key, value) {
    if (arguments.length > 1) { memory.set(key, structuredClone(value)); return value; }
    return structuredClone(memory.get(key));
  }
};
await import(path.join(web, 'content-release.js'));
await import(path.join(web, 'material-search.js'));
const search = globalThis.YueqianMaterialSearch;
const sampleBytes = fs.readFileSync(path.join(fixtures, 'search-index-sample.json'));
const sample = JSON.parse(sampleBytes);
const expectations = JSON.parse(fs.readFileSync(path.join(fixtures, 'search-index-expectations.json'))).expectations;
const base = 'https://library.example/content/';
const snapshot = {
  schemaVersion: 2,
  sources: [
    { id: 'microsoft-genai', repository: 'microsoft/generative-ai-for-beginners', revision: 'a'.repeat(40) },
    { id: 'microsoft-agents', repository: 'microsoft/ai-agents-for-beginners', revision: 'b'.repeat(40) },
    { id: 'openai-cookbook', repository: 'openai/openai-cookbook', revision: 'c'.repeat(40) }
  ],
  articles: []
};
globalThis.YueqianMaterials.sourceURL = (value, article) => {
  const source = Array.isArray(value?.sources) ? value.sources.find(item => item.id === article.sourceID) : value;
  return 'https://github.com/' + source.repository + '/blob/' + source.revision + '/' + article.path;
};

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function bundle(index = sample, overrides = {}) {
  const bytes = Buffer.isBuffer(index) ? index : Buffer.from(JSON.stringify(index));
  const digest = sha(bytes);
  const value = typeof index === 'object' && !Buffer.isBuffer(index) ? index : JSON.parse(bytes);
  return { bytes, pointer: { schemaVersion: 1, indexPath: 'search/index-' + digest + '.json', indexSha256: digest, bytes: bytes.length, generatedAt: value.generatedAt, documentCount: value.documents.length, ...overrides } };
}
function server(current, requests, { indexBytes } = {}) {
  return async (value, options) => {
    const url = new URL(value);
    requests.push(url.pathname);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'GET');
    if (url.pathname === '/content/search/latest.json') return new Response(JSON.stringify(current().pointer));
    if (url.pathname === '/content/' + current().pointer.indexPath) return new Response(indexBytes ? indexBytes() : current().bytes);
    return new Response('not found', { status: 404 });
  };
}
function reset() { memory.clear(); search.resetIndexMemory(); }
function setOnline(value) { Object.defineProperty(globalThis, 'navigator', { value: { onLine: value }, configurable: true, writable: true }); }

test('样例索引通过合同校验', () => {
  assert.doesNotThrow(() => search.validIndex(structuredClone(sample)));
});

test('本地排序逐条复现管线生成的期望：ID、顺序、score 与 excerpt', () => {
  const state = { index: sample };
  for (const expectation of expectations) {
    const results = search.indexResults(state, expectation.query);
    assert.deepEqual(results.map(item => ({ id: item.id, score: item.score, excerpt: item.excerpt })), expectation.results, expectation.query);
    const ranked = search.rankDocuments(sample.documents, expectation.query, { topics: sample.topics });
    assert.deepEqual(ranked.map(item => [item.id, item.score, item.excerpt]), expectation.results.map(item => [item.id, item.score, item.excerpt]));
    for (const item of results) {
      assert.equal(search.validItem(item, 'external'), true, item.id);
      assert.equal(item.kind, 'external');
      assert.equal(item.reviewStatus, 'unreviewed');
      assert.equal(item.checkedAt, sample.sources.find(source => source.id === item.sourceID).checkedAt);
      assert.deepEqual(Object.keys(item).sort(), ['checkedAt', 'excerpt', 'id', 'kind', 'repository', 'reviewStatus', 'revision', 'score', 'sha256', 'sourceID', 'title', 'url']);
    }
  }
  assert.ok(expectations.length >= 5);
});

test('多来源快照的本机原文结果使用文章自己的 sourceID 与版本', () => {
  const multi = {
    schemaVersion: 2,
    sources: snapshot.sources,
    articles: [
      { id: 'ms-rag', title: 'RAG 与向量数据库', sourceID: 'microsoft-genai', path: 'translations/zh-CN/15-rag-and-vector-databases/README.md', lessonIDs: ['w2.0'], markdown: '检索增强生成把检索与生成结合起来。' },
      { id: 'ma-memory', title: 'Memory for AI Agents', sourceID: 'microsoft-agents', path: '13-agent-memory/README.md', lessonIDs: ['ref.agent'], markdown: 'Agent memory keeps context across turns.' }
    ]
  };
  const results = search.local(multi, 'memory');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'ma-memory');
  assert.equal(results[0].sourceID, 'microsoft-agents');
  assert.equal(results[0].repository, 'microsoft/ai-agents-for-beginners');
  assert.equal(results[0].revision, 'b'.repeat(40));
  assert.equal(results[0].url, 'https://github.com/microsoft/ai-agents-for-beginners/blob/' + 'b'.repeat(40) + '/13-agent-memory/README.md');
  assert.equal(search.validItem(results[0], 'library'), true);
  const chinese = search.local(multi, '检索增强');
  assert.equal(chinese[0].sourceID, 'microsoft-genai');
  assert.equal(chinese[0].revision, 'a'.repeat(40));
  assert.ok(chinese[0].url.includes('/microsoft/generative-ai-for-beginners/blob/' + 'a'.repeat(40) + '/'));
});

test('首次下载、哈希未变不重复下载、变化后原子替换', async () => {
  reset(); setOnline(true);
  let current = bundle();
  const requests = [];
  const fetcher = server(() => current, requests);
  const first = await search.refreshIndex({ contentBaseURL: base, fetcher });
  assert.equal(first.status, 'updated');
  assert.equal(memory.get('search-index-v1').pointer.indexSha256, current.pointer.indexSha256);
  assert.equal(requests.length, 2);
  const second = await search.refreshIndex({ contentBaseURL: base, fetcher });
  assert.equal(second.status, 'current');
  assert.equal(requests.length, 3);
  const next = structuredClone(sample); next.generatedAt = '2026-10-31T00:00:00.000Z'; next.documents[0].title = 'Memory for AI Agents (v2)';
  current = bundle(next);
  const third = await search.refreshIndex({ contentBaseURL: base, fetcher });
  assert.equal(third.status, 'updated');
  assert.equal(memory.get('search-index-v1').index.documents[0].title, 'Memory for AI Agents (v2)');
  search.resetIndexMemory();
  assert.equal((await search.cachedIndex()).pointer.indexSha256, current.pointer.indexSha256);
});

test('任一校验失败整份拒收，保留上一版缓存', async () => {
  reset(); setOnline(true);
  const good = bundle();
  await search.refreshIndex({ contentBaseURL: base, fetcher: server(() => good, []) });
  const kept = good.pointer.indexSha256;
  const mutate = change => { const value = structuredClone(sample); value.generatedAt = '2026-10-31T00:00:00.000Z'; change(value); return bundle(value); };
  const changed = mutate(() => {});
  assert.notEqual(changed.pointer.indexSha256, kept);
  const cases = {
    'SHA-256 不符': () => ({ ...changed, pointer: { ...changed.pointer, indexSha256: 'f'.repeat(64), indexPath: 'search/index-' + 'f'.repeat(64) + '.json' } }),
    '字节数少于实际': () => ({ ...changed, pointer: { ...changed.pointer, bytes: changed.bytes.length - 1 } }),
    '字节数多于实际': () => ({ ...changed, pointer: { ...changed.pointer, bytes: changed.bytes.length + 1 } }),
    '指针路径与哈希不一致': () => ({ ...changed, pointer: { ...changed.pointer, indexPath: 'search/other.json' } }),
    '指针文档数不一致': () => ({ ...changed, pointer: { ...changed.pointer, documentCount: 9 } }),
    '指针超过 4 MiB': () => ({ ...changed, pointer: { ...changed.pointer, bytes: 4 * 1024 * 1024 + 1 } }),
    '指针 schemaVersion 不符': () => ({ ...changed, pointer: { ...changed.pointer, schemaVersion: 2 } }),
    '未批准来源': () => mutate(value => { value.documents[0].sourceID = 'unknown'; }),
    '来源与仓库不对应': () => mutate(value => { value.documents[0].repository = 'openai/openai-cookbook'; }),
    'revision 非 40 位': () => mutate(value => { value.documents[0].revision = 'abc'; }),
    'url 与固定版本路径不一致': () => mutate(value => { value.documents[0].url = value.documents[0].url.replace('/blob/', '/tree/'); }),
    'url 路径未按段编码': () => mutate(value => { value.documents[0].path = 'a b/README.md'; value.documents[0].url = 'https://github.com/' + value.documents[0].repository + '/blob/' + value.documents[0].revision + '/a b/README.md'; }),
    'text 超过 12000': () => mutate(value => { value.documents[0].text = 'x'.repeat(12001); }),
    'title 超过 400': () => mutate(value => { value.documents[0].title = 'x'.repeat(401); }),
    'id 超过 200': () => mutate(value => { value.documents[0].id = 'x'.repeat(201); }),
    'id 重复': () => mutate(value => { value.documents[1].id = value.documents[0].id; }),
    'topics 超过 100': () => mutate(value => { value.topics = Array.from({ length: 101 }, (_, index) => ({ id: 't' + index, title: 't', terms: [] })); }),
    'documents 超过 400': () => mutate(value => { value.documents = Array.from({ length: 401 }, (_, index) => ({ ...value.documents[0], id: 'microsoft-agents:' + String(index).padStart(16, '0') })); }),
    'kind 或 reviewStatus 不符': () => mutate(value => { value.reviewStatus = 'approved'; }),
    'source 状态未知': () => mutate(value => { value.sources[0].status = 'live'; }),
    '缺少文档所属来源': () => mutate(value => { value.sources = value.sources.filter(source => source.id !== 'openai-cookbook'); }),
    '索引非 UTF-8 JSON': () => { const bytes = Buffer.from([0xff, 0xfe, 0x00]); return { bytes, pointer: { ...changed.pointer, indexSha256: sha(bytes), indexPath: 'search/index-' + sha(bytes) + '.json', bytes: bytes.length } }; }
  };
  for (const [name, make] of Object.entries(cases)) {
    const current = make();
    search.resetIndexMemory();
    const result = await search.refreshIndex({ contentBaseURL: base, fetcher: server(() => current, []) });
    assert.equal(result.status, 'failed', name);
    assert.equal(memory.get('search-index-v1').pointer.indexSha256, kept, name);
    assert.equal(result.state.pointer.indexSha256, kept, name);
  }
  const notFound = await search.refreshIndex({ contentBaseURL: base, fetcher: async () => new Response('x', { status: 404 }) });
  assert.equal(notFound.status, 'failed');
  const network = await search.refreshIndex({ contentBaseURL: base, fetcher: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(network.status, 'failed');
  assert.equal(memory.get('search-index-v1').pointer.indexSha256, kept);
});

test('离线时不发网络请求，有缓存仍可搜索', async () => {
  reset(); setOnline(true);
  const good = bundle();
  await search.refreshIndex({ contentBaseURL: base, fetcher: server(() => good, []) });
  setOnline(false);
  const offline = await search.refreshIndex({ contentBaseURL: base, fetcher: () => { throw new Error('must not fetch'); } });
  assert.equal(offline.status, 'offline');
  search.resetIndexMemory();
  const result = await search.search({ query: 'memory', snapshot, releaseID: 'r', searchURL: null, contentBaseURL: base, fetcher: () => { throw new Error('must not fetch'); } });
  assert.equal(result.cache, 'index');
  assert.equal(result.external[0].id, 'microsoft-agents:0000000000000001');
  assert.match(result.message, /^已搜索保存的原文与官方来源索引（更新于 .+）。$/);
  reset();
  const empty = await search.search({ query: 'memory', snapshot, releaseID: 'r', searchURL: null, contentBaseURL: base, fetcher: () => { throw new Error('must not fetch'); } });
  assert.equal(empty.external.length, 0);
  assert.equal(empty.message, '官方来源索引尚未下载，联网后自动获取。');
  setOnline(true);
});

test('无缓存时搜索按需下载；旧默认 Workers 地址视为未配置', async () => {
  reset(); setOnline(true);
  const good = bundle();
  const requests = [];
  const fetcher = server(() => good, requests);
  const result = await search.search({ query: '智能体 记忆', snapshot, releaseID: 'r', searchURL: 'https://yueqian-content-search.ricardofeng619.workers.dev/api/search', contentBaseURL: base, fetcher });
  assert.deepEqual(requests, ['/content/search/latest.json', '/content/' + good.pointer.indexPath]);
  assert.deepEqual(result.external.map(item => [item.id, item.score]), expectations.find(item => item.query === '智能体 记忆').results.map(item => [item.id, item.score]));
  assert.equal(result.degraded, false);
  assert.equal(search.isLegacySearchURL('https://yueqian-content-search.ricardofeng619.workers.dev/api/search'), true);
  assert.equal(search.isLegacySearchURL('https://search.example/api/search'), false);
});

test('用户自配检索服务失败时回退本机索引', async () => {
  setOnline(true);
  const result = await search.search({ query: 'rag', snapshot, releaseID: 'r', searchURL: 'https://search.example/api/search', contentBaseURL: base, fetcher: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(result.cache, 'index');
  assert.equal(result.degraded, true);
  assert.equal(result.external[0].id, 'microsoft-agents:0000000000000002');
});
