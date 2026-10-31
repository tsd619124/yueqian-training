import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRelease, coverageReport, discoverSources, readLibrarySnapshot, searchIndex, sha256, validateRegistry, verifyLatest, writeRelease } from './lib.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const snapshot = await readLibrarySnapshot();
const registry = JSON.parse(await fs.readFile(path.join(directory, 'sources.json'), 'utf8'));
const topics = JSON.parse(await fs.readFile(path.join(directory, 'topics.json'), 'utf8'));
const bundle = buildRelease(snapshot, registry, topics);
const index = JSON.parse(bundle.files.get('index.json'));
const revision = 'a'.repeat(40);
const treeSHA = 'b'.repeat(40);
const blobSHA = 'c'.repeat(40);
const sourceRegistry = { ...registry, sources: [registry.sources[0]] };
const checkedAt = new Date('2026-10-28T02:00:00Z');

function response(body, headers = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function firstFetch(url, options) {
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.body, undefined);
  assert.equal(options.headers.Authorization, undefined);
  if (url.endsWith('/commits/main')) return response({ sha: revision, commit: { tree: { sha: treeSHA }, committer: { date: '2026-10-27T01:00:00Z' } } }, { etag: '"public-source"' });
  assert.equal(url, `https://api.github.com/repos/${registry.sources[0].repository}/git/trees/${treeSHA}?recursive=1`);
  return response({ sha: treeSHA, truncated: false, tree: [
    { type: 'blob', mode: '100644', path: '01-introduction/README.md', sha: blobSHA },
    { type: 'blob', mode: '100644', path: '02-models/README.md', sha: blobSHA },
    { type: 'blob', mode: '120000', path: '03-symlink/README.md', sha: blobSHA },
    { type: 'blob', mode: '100644', path: '../04-invalid/README.md', sha: blobSHA },
    { type: 'blob', mode: '100644', path: 'translations/zh-CN/01-introduction/README.md', sha: blobSHA }
  ] });
}

async function temporaryOutput(context) {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-content-pipeline-'));
  context.after(() => fs.rm(output, { recursive: true, force: true }));
  return output;
}

test('静态包保留全部已核准原文、原图与来源版本', () => {
  assert.equal(bundle.manifest.documents.length, 10);
  assert.equal(bundle.manifest.imageReferences, 49);
  assert.equal(bundle.manifest.assetCount, 49);
  assert.ok(bundle.totalBytes < registry.budget.maxReleaseBytes);
  for (const article of snapshot.articles) {
    const document = JSON.parse(bundle.files.get(`documents/${article.id}.json`));
    assert.equal(document.markdown, article.markdown);
    assert.equal(document.sha256, article.sha256);
    assert.deepEqual(document.lessonIDs, article.lessonIDs);
    assert.ok(document.source.url.includes('/blob/' + snapshot.revision + '/'));
    assert.ok(document.source.rawURL.includes(snapshot.revision));
    assert.equal(document.source.downloadedAt, snapshot.fetchedAt);
    assert.equal(document.source.publishedAt, undefined);
    for (const image of document.images) assert.equal(sha256(bundle.files.get(image.path)), image.sha256);
  }
  assert.equal(bundle.files.get('LICENSE.txt').toString(), snapshot.licenseText);
});

test('相同内容构建产生相同版本和文件字节', () => {
  const rebuilt = buildRelease(snapshot, registry, topics);
  assert.equal(rebuilt.releaseID, bundle.releaseID);
  assert.equal(rebuilt.totalBytes, bundle.totalBytes);
  for (const [filePath, bytes] of bundle.files) assert.deepEqual(bytes, rebuilt.files.get(filePath));
});

test('原文与图片损坏在写入前阻断', () => {
  const invalid = structuredClone(snapshot);
  invalid.articles[0].markdown += '\n未经来源核准的改动';
  assert.throws(() => buildRelease(invalid, registry, topics), /原文哈希/);
  invalid.articles = structuredClone(snapshot.articles);
  invalid.articles[0].images[0].data = Buffer.from('not the original image').toString('base64');
  assert.throws(() => buildRelease(invalid, registry, topics), /原图哈希/);
});

test('未核准来源和超出成本大小的内容不能发布', () => {
  assert.throws(() => buildRelease({ ...snapshot, repository: registry.sources[1].repository }, registry, topics), /没有获准/);
  assert.throws(() => buildRelease(snapshot, { ...registry, budget: { ...registry.budget, maxReleaseBytes: 100 } }, topics), /成本大小上限/);
});

test('落盘校验与重复运行复用同一版本', async context => {
  const output = await temporaryOutput(context);
  const first = await writeRelease(output, bundle);
  const pointer = await fs.readFile(path.join(output, 'latest.json'));
  const second = await writeRelease(output, bundle);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.deepEqual(await fs.readFile(path.join(output, 'latest.json')), pointer);
  assert.equal((await verifyLatest(output)).releaseID, bundle.releaseID);
  assert.deepEqual(await fs.readdir(path.join(output, 'releases')), [bundle.releaseID]);
});

test('新包损坏不替换上一个有效版本指针', async context => {
  const output = await temporaryOutput(context);
  await writeRelease(output, bundle);
  const pointer = await fs.readFile(path.join(output, 'latest.json'));
  const invalid = { ...bundle, files: new Map(bundle.files) };
  invalid.files.set('index.json', Buffer.from('{}'));
  await assert.rejects(writeRelease(output, invalid), /待写文件校验失败/);
  assert.deepEqual(await fs.readFile(path.join(output, 'latest.json')), pointer);
  assert.equal((await verifyLatest(output)).releaseID, bundle.releaseID);
});

test('写入中途失败清理临时目录并保留旧发布', async context => {
  const output = await temporaryOutput(context);
  await writeRelease(output, bundle);
  const pointer = await fs.readFile(path.join(output, 'latest.json'));
  const next = buildRelease({ ...snapshot, revision: 'd'.repeat(40) }, registry, topics);
  const originalWrite = fs.writeFile;
  context.mock.method(fs, 'writeFile', async (filePath, ...argumentsList) => {
    if (filePath.includes('.staging-') && filePath.endsWith('index.json')) throw new Error('模拟磁盘中断');
    return originalWrite(filePath, ...argumentsList);
  });
  await assert.rejects(writeRelease(output, next), /模拟磁盘中断/);
  assert.deepEqual(await fs.readFile(path.join(output, 'latest.json')), pointer);
  assert.equal((await verifyLatest(output)).releaseID, bundle.releaseID);
  assert.deepEqual(await fs.readdir(path.join(output, 'releases')), [bundle.releaseID]);
});

test('丢失或篡改落盘原图能被独立检查识别', async context => {
  const output = await temporaryOutput(context);
  await writeRelease(output, bundle);
  const asset = bundle.manifest.files.find(record => record.path.startsWith('assets/'));
  await fs.writeFile(path.join(output, 'releases', bundle.releaseID, asset.path), 'damaged');
  await assert.rejects(verifyLatest(output), /发布文件校验失败/);
  await assert.rejects(writeRelease(output, bundle), /发布文件校验失败/);
});

test('中文与英文检索返回已收录原文片段和固定版本来源', () => {
  const chinese = searchIndex(index, '向量数据库');
  assert.equal(chinese[0].id, 'ms-rag');
  assert.ok(chinese[0].matchedTerms.includes('向量'));
  const english = searchIndex(index, 'NearestNeighbors');
  assert.ok(english.some(result => result.id === 'ms-rag'));
  for (const result of [...chinese, ...english]) {
    assert.ok(index.documents.find(document => document.id === result.id).text.includes(result.excerpt));
    assert.ok(result.url.includes(snapshot.revision));
  }
  assert.deepEqual(searchIndex(index, '   '), []);
  assert.throws(() => searchIndex(index, 'a'.repeat(257)), /检索参数/);
});

test('主题报告只给原文线索，不把命中视为完整掌握或先进性', () => {
  const report = coverageReport(index, topics);
  assert.equal(report.requiresReview, true);
  assert.equal(report.topics.length, 17);
  assert.ok(report.topics.some(topic => topic.status === 'no-evidence'));
  for (const topic of report.topics) {
    assert.ok(['mentioned', 'no-evidence'].includes(topic.status));
    for (const evidence of topic.evidence) {
      assert.ok(index.documents.find(document => document.id === evidence.documentID).text.includes(evidence.excerpt));
      assert.ok(evidence.excerpt.includes(evidence.term));
    }
  }
});

test('来源目录不接受重复、无上限或不安全配置', () => {
  assert.throws(() => validateRegistry({ ...registry, sources: [...registry.sources, registry.sources[0]] }), /重复/);
  assert.throws(() => validateRegistry({ ...registry, budget: { ...registry.budget, maxRequests: 100000 } }), /成本上限/);
  assert.throws(() => validateRegistry({ ...registry, sources: [{ ...registry.sources[0], branch: '../main' }] }), /分支/);
  assert.throws(() => validateRegistry({ ...registry, sources: [{ ...registry.sources[0], id: undefined }] }), /来源 ID/);
  assert.throws(() => validateRegistry({ ...registry, sources: [{ ...registry.sources[0], repository: 'microsoft/..' }] }), /仓库/);
});

test('公开来源发现只用 GET，不读取凭证，候选没有直接发布', async () => {
  const discovery = await discoverSources(sourceRegistry, null, firstFetch, checkedAt);
  const source = discovery.sources[0];
  assert.equal(discovery.budget.requests, 2);
  assert.equal(source.status, 'checked');
  assert.equal(source.candidates.length, 2);
  assert.equal(source.lastRepositoryCommitAt, '2026-10-27T01:00:00Z');
  assert.equal(source.candidates[0].publishedAt, undefined);
  assert.ok(source.candidates.every(candidate => candidate.state === 'discovered' && candidate.licenseStatus === 'not-checked'));
});

test('304 与相同提交仅请求一次，复用文件树并刷新检查时间', async () => {
  const previous = await discoverSources(sourceRegistry, null, firstFetch, checkedAt);
  const later = new Date('2026-10-29T02:00:00Z');
  const conditional = await discoverSources(sourceRegistry, previous, (url, options) => {
    assert.equal(options.headers['If-None-Match'], '"public-source"');
    return new Response(null, { status: 304 });
  }, later);
  assert.equal(conditional.budget.requests, 1);
  assert.equal(conditional.budget.downloadedBytes, 0);
  assert.equal(conditional.sources[0].status, 'unchanged');
  assert.equal(conditional.sources[0].checkedAt, later.toISOString());
  assert.deepEqual(conditional.sources[0].candidates, previous.sources[0].candidates);
  const same = await discoverSources(sourceRegistry, previous, firstFetch, later);
  assert.equal(same.budget.requests, 1);
  assert.equal(same.sources[0].status, 'unchanged');
});

test('来源故障保留旧候选及成功检查时间', async () => {
  const previous = await discoverSources(sourceRegistry, null, firstFetch, checkedAt);
  const later = new Date('2026-10-29T02:00:00Z');
  const failed = await discoverSources(sourceRegistry, previous, () => new Response('unavailable', { status: 503 }), later);
  assert.equal(failed.sources[0].status, 'stale');
  assert.equal(failed.sources[0].checkedAt, checkedAt.toISOString());
  assert.equal(failed.sources[0].attemptedAt, later.toISOString());
  assert.deepEqual(failed.sources[0].candidates, previous.sources[0].candidates);
});

test('损坏的发现缓存不冒充有效版本，也不阻断重新检查', async () => {
  for (const previous of [{ schemaVersion: 1, sources: {} }, { schemaVersion: 1, sources: [null] }]) {
    const discovery = await discoverSources(sourceRegistry, previous, firstFetch, checkedAt);
    assert.equal(discovery.sources[0].status, 'checked');
    assert.equal(discovery.budget.requests, 2);
  }
});

test('不完整文件树不替换上次候选', async () => {
  const previous = await discoverSources(sourceRegistry, null, firstFetch, checkedAt);
  const discovery = await discoverSources(sourceRegistry, previous, url => url.endsWith('/commits/main') ? response({ sha: 'd'.repeat(40), commit: { tree: { sha: treeSHA } } }) : response({ sha: treeSHA, truncated: true, tree: [] }), checkedAt);
  assert.equal(discovery.sources[0].status, 'stale');
  assert.deepEqual(discovery.sources[0].candidates, previous.sources[0].candidates);
  assert.match(discovery.sources[0].lastError, /不完整/);
});

test('请求上限在下一次联网前阻断', async () => {
  const limited = { ...sourceRegistry, budget: { ...registry.budget, maxRequests: 1 } };
  let calls = 0;
  const discovery = await discoverSources(limited, null, (url, options) => { calls++; return firstFetch(url, options); }, checkedAt);
  assert.equal(calls, 1);
  assert.equal(discovery.budget.requests, 1);
  assert.equal(discovery.sources[0].status, 'unavailable');
  assert.match(discovery.sources[0].lastError, /上限/);
});

test('无 Content-Length 的流式响应达到预算后取消读取', async () => {
  const limited = { ...sourceRegistry, budget: { ...registry.budget, maxDownloadBytes: 100, maxResponseBytes: 100 } };
  let cancelled = false;
  const discovery = await discoverSources(limited, null, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(200)); },
    cancel() { cancelled = true; }
  })), checkedAt);
  assert.equal(discovery.sources[0].status, 'unavailable');
  assert.equal(cancelled, true);
  assert.match(discovery.sources[0].lastError, /流量上限/);
});

test('候选数上限明确记录，稳定 ID 不随仓库提交变化', async () => {
  const limited = { ...sourceRegistry, budget: { ...registry.budget, maxCandidatesPerSource: 1 } };
  const first = await discoverSources(limited, null, firstFetch, checkedAt);
  assert.equal(first.sources[0].candidates.length, 1);
  assert.equal(first.sources[0].totalMatchingFiles, 2);
  assert.equal(first.sources[0].selectionLimited, true);
  const next = await discoverSources(limited, first, (url, options) => url.endsWith('/commits/main') ? response({ sha: 'd'.repeat(40), commit: { tree: { sha: treeSHA } } }) : firstFetch(url, options), checkedAt);
  assert.equal(first.sources[0].candidates[0].id, next.sources[0].candidates[0].id);
  assert.notEqual(first.sources[0].candidates[0].revision, next.sources[0].candidates[0].revision);
});
