import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createExternalSearch } from './external-search.mjs';

const topics = JSON.parse(await fs.readFile(new URL('./topics.json', import.meta.url), 'utf8'));
const timestamp = Date.parse('2026-10-28T07:00:00Z');
const revision = 'a'.repeat(40);
const hash = (algorithm, value) => createHash(algorithm).update(value).digest('hex');
const blob = value => hash('sha1', Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(value)}\0`), Buffer.from(value)]));
const officialRepository = 'microsoft/ai-agents-for-beginners';

function fixture(documents = [{ path: '12-context-engineering/README.md', markdown: '# Context Engineering\n\nContext engineering controls how agents receive useful information.\n' }]) {
  const registry = { schemaVersion: 1, budget: { maxCandidatesPerSource: 80 }, sources: [{ id: 'microsoft-agents', publisher: 'Microsoft', repository: officialRepository, candidatePattern: '^[0-9]{2}-[^/]+/README\\.md$' }] };
  const candidates = documents.map(document => ({ id: 'microsoft-agents:' + hash('sha256', document.path).slice(0, 16), sourceID: 'microsoft-agents', revision, path: document.path, blobSHA: blob(document.markdown), url: `https://github.com/${officialRepository}/blob/${revision}/${document.path}` }));
  const discovery = { schemaVersion: 1, sources: [{ id: 'microsoft-agents', repository: officialRepository, status: 'checked', checkedAt: new Date(timestamp - 3600000).toISOString(), revision, selectionLimited: false, totalMatchingFiles: candidates.length, candidates }] };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const found = documents.find(document => url.endsWith('/' + document.path));
    assert.ok(found, 'only configured fixture documents may be requested');
    return new Response(found.markdown, { headers: { 'content-type': 'text/plain' } });
  };
  return { registry, discovery, topics, fetcher, now: () => timestamp, calls, documents };
}

test('中文上下文工程查询定位英文原文，返回可核验片段和固定版本出处', async () => {
  const context = fixture();
  const result = await createExternalSearch(context)('上下文工程');
  assert.equal(result.status, 'ok');
  assert.equal(result.results.length, 1);
  const article = result.results[0];
  assert.equal(article.title, 'Context Engineering');
  assert.equal(article.kind, 'external');
  assert.equal(article.reviewStatus, 'unreviewed');
  assert.equal(article.revision, revision);
  assert.equal(article.repository, officialRepository);
  assert.equal(article.sha256, hash('sha256', context.documents[0].markdown));
  assert.match(article.excerpt, /controls how agents receive useful information/u);
  assert.equal(article.text, undefined);
  assert.equal(article.markdown, undefined);
  assert.equal(article.checkedAt, context.discovery.sources[0].checkedAt);
  assert.equal(article.downloadedAt, new Date(timestamp).toISOString());
  assert.equal(context.calls.length, 1);
  const { url, options } = context.calls[0];
  assert.equal(url, `https://raw.githubusercontent.com/${officialRepository}/${revision}/12-context-engineering/README.md`);
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(result.scope.fullWebSearch, false);
  assert.equal(result.scope.coverageLimited, true);
  assert.equal(result.scope.inspectedDocuments, 1);
  assert.equal(result.budget.downloadedBytes, Buffer.byteLength(context.documents[0].markdown));
});

test('未命中配置目录返回空结果，不触发网络请求', async () => {
  const context = fixture();
  const result = await createExternalSearch(context)('quantum telescope');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.results, []);
  assert.equal(result.budget.requests, 0);
  assert.equal(context.calls.length, 0);
});

test('每轮最多读取三篇，保留目录取样与未读取范围', async () => {
  const context = fixture(Array.from({ length: 5 }, (_, index) => ({ path: `0${index}-context-engineering/README.md`, markdown: `# Context engineering ${index}\n\nContext engineering material ${index}.\n` })));
  context.discovery.sources[0].selectionLimited = true;
  context.discovery.sources[0].totalMatchingFiles = 500;
  const result = await createExternalSearch(context)('context engineering');
  assert.equal(result.status, 'ok');
  assert.equal(result.budget.requests, 3);
  assert.equal(result.results.length, 3);
  assert.equal(result.scope.matchedCandidates, 5);
  assert.equal(result.scope.inspectedDocuments, 3);
  assert.equal(result.scope.sources[0].selectionLimited, true);
  assert.equal(result.scope.sources[0].totalMatchingFiles, 500);
});

test('调用方较小limit同时约束正文请求数', async () => {
  const context = fixture(Array.from({ length: 3 }, (_, index) => ({ path: `0${index}-context/README.md`, markdown: '# Context engineering\n\nContext material.\n' })));
  const result = await createExternalSearch(context)('context', { limit: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.budget.requests, 1);
});

test('正文哈希错误不输出片段或伪造结果', async () => {
  const context = fixture();
  context.fetcher = async () => new Response('# Context engineering\nThis differs from the discovered blob.');
  const result = await createExternalSearch(context)('context');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'integrity-failed');
  assert.deepEqual(result.results, []);
});

test('上游限流保留同轮已成功核验的结果', async () => {
  const context = fixture([{ path: '01-context/README.md', markdown: '# Context engineering\n\nContext evidence.\n' }, { path: '02-context/README.md', markdown: '# Context\n\nOther context evidence.\n' }]);
  const original = context.fetcher;
  context.fetcher = async (url, options) => url.includes('/02-context/') ? new Response('rate limited', { status: 429 }) : original(url, options);
  const result = await createExternalSearch(context)('context');
  assert.equal(result.status, 'partial');
  assert.equal(result.results.length, 1);
  assert.equal(result.reason, 'upstream-rate-limited');
  assert.equal(result.budget.requests, 2);
});

test('上游全部失败返回unavailable', async () => {
  const context = fixture();
  context.fetcher = async () => new Response('', { status: 503 });
  const result = await createExternalSearch(context)('context');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'upstream-unavailable');
  assert.deepEqual(result.results, []);
});

test('硬超时防止忽略AbortSignal的fetcher阻塞，并停止后续请求', async () => {
  const context = fixture([{ path: '01-context/README.md', markdown: '# Context\n' }, { path: '02-context/README.md', markdown: '# Context\n' }]);
  let calls = 0;
  let receivedSignal;
  context.fetcher = (url, options) => { calls++; receivedSignal = options.signal; return new Promise(() => {}); };
  const started = performance.now();
  const result = await createExternalSearch({ ...context, limits: { maxRunMs: 200 } })('context');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'timeout');
  assert.ok(performance.now() - started < 1000);
  assert.equal(calls, 1);
  assert.equal(receivedSignal.aborted, true);
});

test('正文流读取阻塞也遵守整轮超时', async () => {
  const context = fixture();
  let cancelled = false;
  context.fetcher = async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }));
  const result = await createExternalSearch({ ...context, limits: { maxRunMs: 25 } })('context');
  assert.equal(result.reason, 'timeout');
  assert.equal(cancelled, true);
  assert.equal(result.budget.requests, 1);
});

test('声明超大正文在读取前拒绝', async () => {
  const context = fixture();
  context.fetcher = async () => new Response('small actual body', { headers: { 'content-length': '700001' } });
  const result = await createExternalSearch(context)('context');
  assert.equal(result.reason, 'download-budget');
  assert.equal(result.budget.downloadedBytes, 0);
  assert.deepEqual(result.results, []);
});

test('未声明长度的超大流及时停止，不接受超限正文', async () => {
  const context = fixture();
  let cancelled = false;
  context.fetcher = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(700001)); }, cancel() { cancelled = true; } }));
  const result = await createExternalSearch(context)('context');
  assert.equal(result.reason, 'download-budget');
  assert.equal(cancelled, true);
  assert.equal(result.scope.inspectedDocuments, 0);
});

test('总下载预算不足时停止并保留已核验内容', async () => {
  const context = fixture([{ path: '01-context/README.md', markdown: '# Context\n\nFirst content.\n' }, { path: '02-context/README.md', markdown: '# Context\n\nSecond content.\n' }]);
  const result = await createExternalSearch({ ...context, limits: { maxDownloadBytes: Buffer.byteLength(context.documents[0].markdown) } })('context');
  assert.equal(result.status, 'partial');
  assert.equal(result.results.length, 1);
  assert.equal(result.reason, 'download-budget');
  assert.equal(result.budget.requests, 1);
});

test('最后超限chunk耗尽整轮预算后不再发送下一次GET', async () => {
  const context = fixture([{ path: '01-context/README.md', markdown: '# Context\n' }, { path: '02-context/README.md', markdown: '# Context\n' }]);
  let calls = 0;
  context.fetcher = async () => { calls++; return new Response(new Uint8Array(101)); };
  const result = await createExternalSearch({ ...context, limits: { maxDownloadBytes: 100 } })('context');
  assert.equal(result.reason, 'download-budget');
  assert.equal(result.budget.downloadedBytes, 101);
  assert.equal(result.budget.requests, 1);
  assert.equal(calls, 1);
});

for (const [name, change] of [
  ['过期来源', source => { source.checkedAt = new Date(timestamp - 73 * 3600000).toISOString(); }],
  ['未来检查时间', source => { source.checkedAt = new Date(timestamp + 1).toISOString(); }],
  ['失败来源', source => { source.status = 'stale'; }],
  ['仓库与配置不一致', source => { source.repository = 'attacker/fork'; }],
  ['伪造候选URL', source => { source.candidates[0].url = 'https://attacker.example/file.md'; }],
  ['候选版本不一致', source => { source.candidates[0].revision = 'b'.repeat(40); }],
  ['路径穿越', source => { source.candidates[0].path = '../12-context-engineering/README.md'; }],
  ['候选ID不一致', source => { source.candidates[0].id = 'microsoft-agents:fake'; }],
  ['重复候选', source => { source.candidates.push(structuredClone(source.candidates[0])); source.totalMatchingFiles++; }],
  ['取样范围被伪装为全量', source => { source.totalMatchingFiles = 30; }]
]) test(name + '不访问任何外部地址', async () => {
  const context = fixture();
  change(context.discovery.sources[0]);
  const result = await createExternalSearch(context)('context');
  assert.equal(result.status, 'unavailable');
  assert.equal(context.calls.length, 0);
  assert.deepEqual(result.results, []);
});

test('302重定向不跟随且不输出正文或结果', async () => {
  const context = fixture();
  const calls = [];
  context.fetcher = async (url, options) => {
    calls.push({ url, options });
    return new Response('# Context engineering\nUntrusted redirect response.', { status: 302, headers: { location: 'https://attacker.example/context.md' } });
  };
  const result = await createExternalSearch(context)('context');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'upstream-unavailable');
  assert.deepEqual(result.results, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(result.budget.downloadedBytes, 0);
});

test('fetcher返回其他URL的成功响应仍拒绝', async () => {
  const context = fixture();
  context.fetcher = async () => {
    const response = new Response(context.documents[0].markdown);
    Object.defineProperty(response, 'url', { value: 'https://attacker.example/context.md' });
    return response;
  };
  const result = await createExternalSearch(context)('context');
  assert.equal(result.reason, 'upstream-unavailable');
  assert.deepEqual(result.results, []);
});

test('无效查询或突破硬预算在请求前拒绝', async () => {
  const context = fixture();
  assert.throws(() => createExternalSearch({ ...context, limits: { maxRequests: 4 } }), /invalid-limits/u);
  const search = createExternalSearch(context);
  await assert.rejects(search(' '));
  await assert.rejects(search('context', { limit: 0 }), /invalid-limit/u);
  assert.equal(context.calls.length, 0);
});
