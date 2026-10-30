import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { rankDocuments } from './search-common.mjs';
import { buildSearchIndex, copySearchDirectory, courseKey, loadPublishedIndex, publishedDocuments, readSearchDirectory, truncateText, validateSearchIndex, validateSearchPointer, writeSearchOutput } from './search-index.mjs';

const registry = JSON.parse(await fs.readFile(new URL('./sources.json', import.meta.url)));
const topics = JSON.parse(await fs.readFile(new URL('./topics.json', import.meta.url)));
const sample = JSON.parse(await fs.readFile(new URL('./fixtures/search-index-sample.json', import.meta.url)));
const expectations = JSON.parse(await fs.readFile(new URL('./fixtures/search-index-expectations.json', import.meta.url)));
const revision = 'b'.repeat(40);
const newRevision = 'c'.repeat(40);
const hash = (algorithm, value) => createHash(algorithm).update(value).digest('hex');
const blobSHA = bytes => hash('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));

const files = {
  'microsoft-genai': { '15-rag-and-vector-databases/README.md': '# RAG and vector databases\nAlready published in Chinese.', '11-integrating-with-function-calling/README.md': '# Function calling\nConnect tools.' },
  'microsoft-agents': { '13-agent-memory/README.md': '# Memory for AI Agents\nShort-term and long-term memory.', '05-agentic-rag/README.md': '# Agentic RAG\n![diagram](images/a.png) Retrieval steps.' },
  'openai-cookbook': { 'examples/evaluation/README.md': '# Evaluation guide\nBuild an evaluation dataset. 评测。' }
};

function discoveryFor(contents, { checkedAt = new Date().toISOString(), revisions = {}, statuses = {} } = {}) {
  return {
    schemaVersion: 1,
    checkedAt,
    sources: registry.sources.map(source => {
      const sourceRevision = revisions[source.id] || revision;
      const candidates = Object.entries(contents[source.id] || {}).sort(([left], [right]) => left < right ? -1 : 1).map(([filePath, text]) => ({
        id: source.id + ':' + hash('sha256', filePath).slice(0, 16), sourceID: source.id, path: filePath, revision: sourceRevision, blobSHA: blobSHA(Buffer.from(text)),
        url: `https://github.com/${source.repository}/blob/${sourceRevision}/${filePath.split('/').map(encodeURIComponent).join('/')}`, state: 'discovered', licenseStatus: 'not-checked'
      }));
      return { id: source.id, publisher: source.publisher, repository: source.repository, revision: sourceRevision, treeSHA: 'd'.repeat(40), checkedAt, attemptedAt: checkedAt, status: statuses[source.id] || 'checked', lastError: null, totalMatchingFiles: candidates.length, selectionLimited: false, licenseFile: null, candidates };
    })
  };
}

function fetcherFor(contents, { fail = () => false, requests = [] } = {}) {
  return async address => {
    requests.push(address);
    const url = new URL(address);
    const [, owner, name, , ...segments] = url.pathname.split('/');
    const source = registry.sources.find(item => item.repository === owner + '/' + name);
    const filePath = segments.map(decodeURIComponent).join('/');
    if (fail(source.id, filePath)) return new Response('unavailable', { status: 503 });
    const text = contents[source.id]?.[filePath];
    return text === undefined ? new Response('missing', { status: 404 }) : new Response(Buffer.from(text));
  };
}

const published = [{ sourceID: 'microsoft-genai', path: 'translations/zh-CN/15-rag-and-vector-databases/README.md' }];

async function temporary(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-search-index-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('rankDocuments 复现跨端一致性夹具的 ID、顺序、score 与 excerpt', () => {
  assert.ok(expectations.expectations.length >= 5);
  for (const expectation of expectations.expectations) {
    const actual = rankDocuments(sample.documents, expectation.query, { topics: sample.topics }).map(({ id, score, excerpt }) => ({ id, score, excerpt }));
    assert.deepEqual(actual, expectation.results, expectation.query);
  }
});

test('一致性夹具本身满足 schema v1 约束', () => {
  validateSearchIndex(sample, { bytes: Buffer.from(JSON.stringify(sample)) });
});

test('课程目录键将中文翻译与英文原课视为同一课程', () => {
  assert.equal(courseKey('microsoft-genai', 'translations/zh-CN/15-rag-and-vector-databases/README.md'), courseKey('microsoft-genai', '15-rag-and-vector-databases/README.md'));
  assert.notEqual(courseKey('microsoft-genai', '15-rag-and-vector-databases/README.md'), courseKey('microsoft-agents', '15-rag-and-vector-databases/README.md'));
  assert.equal(courseKey('openai-cookbook', 'examples/evaluation/README.md'), 'openai-cookbook:examples/evaluation');
});

test('首次构建：校验 blob、提取正文、排除已发布课程，并通过校验器', async () => {
  const requests = [];
  const result = await buildSearchIndex({ registry, topics, discovery: discoveryFor(files), published, fetcher: fetcherFor(files, { requests }) });
  assert.equal(result.status, 'built');
  validateSearchPointer(result.pointer, result.indexBytes);
  assert.equal(result.pointer.indexPath, `search/index-${result.pointer.indexSha256}.json`);
  assert.equal(result.index.documents.length, 4);
  assert.equal(result.report.excluded, 1);
  assert.equal(requests.length, 4);
  assert.ok(!result.index.documents.some(document => document.path.startsWith('15-')));
  const rag = result.index.documents.find(document => document.path === '05-agentic-rag/README.md');
  assert.equal(rag.title, 'Agentic RAG');
  assert.equal(rag.text, 'Agentic RAG diagram Retrieval steps.');
  assert.equal(rag.sha256, hash('sha256', files['microsoft-agents']['05-agentic-rag/README.md']));
  assert.deepEqual(result.index.sources.map(source => [source.id, source.status, source.documentCount]), [['microsoft-genai', 'ready', 1], ['microsoft-agents', 'ready', 2], ['openai-cookbook', 'ready', 1]]);
  assert.deepEqual(Object.keys(result.index.topics[0]), ['id', 'title', 'terms']);
  assert.ok(rankDocuments(result.index.documents, '智能体 记忆', topics).length > 0);
});

test('未变化文档按 blobSHA 复用不下载；内容未变时沿用上一版字节', async () => {
  const first = await buildSearchIndex({ registry, topics, discovery: discoveryFor(files), published, fetcher: fetcherFor(files) });
  const requests = [];
  const second = await buildSearchIndex({ registry, topics, discovery: discoveryFor(files, { revisions: { 'openai-cookbook': newRevision } }), published, previous: first, fetcher: fetcherFor(files, { requests }) });
  assert.equal(requests.length, 0);
  assert.equal(second.status, 'unchanged');
  assert.ok(second.indexBytes.equals(first.indexBytes));
  const changed = structuredClone(files);
  changed['microsoft-agents']['13-agent-memory/README.md'] += '\nMore.';
  const third = await buildSearchIndex({ registry, topics, discovery: discoveryFor(changed), published, previous: first, fetcher: fetcherFor(changed, { requests }) });
  assert.equal(third.status, 'built');
  assert.equal(requests.length, 1);
  assert.equal(third.report.reused, 3);
  assert.notEqual(third.pointer.indexSha256, first.pointer.indexSha256);
});

test('单篇失败保留上一版条目并标记 partial；无上一版则省略该篇', async () => {
  const first = await buildSearchIndex({ registry, topics, discovery: discoveryFor(files), published, fetcher: fetcherFor(files) });
  const changed = structuredClone(files);
  changed['microsoft-agents']['13-agent-memory/README.md'] += '\nChanged.';
  changed['microsoft-agents']['08-multi-agent/README.md'] = '# Multi agent\nNew lesson.';
  const failing = (sourceID, filePath) => sourceID === 'microsoft-agents' && filePath === '13-agent-memory/README.md';
  const result = await buildSearchIndex({ registry, topics, discovery: discoveryFor(changed), published, previous: first, fetcher: fetcherFor(changed, { fail: failing }) });
  assert.equal(result.status, 'built');
  const agents = result.index.sources.find(source => source.id === 'microsoft-agents');
  assert.equal(agents.status, 'partial');
  assert.equal(agents.documentCount, 3);
  const memory = result.index.documents.find(document => document.path === '13-agent-memory/README.md');
  assert.deepEqual(memory, first.index.documents.find(document => document.path === '13-agent-memory/README.md'));
  assert.ok(result.report.failures.some(item => item.path === '13-agent-memory/README.md' && item.retainedPrevious));
  const fresh = await buildSearchIndex({ registry, topics, discovery: discoveryFor(changed), published, fetcher: fetcherFor(changed, { fail: failing }) });
  assert.ok(!fresh.index.documents.some(document => document.path === '13-agent-memory/README.md'));
});

test('来源失败保留该来源上一版条目（retained）；无上一版的失败来源不出现', async () => {
  const first = await buildSearchIndex({ registry, topics, discovery: discoveryFor(files), published, fetcher: fetcherFor(files) });
  const unavailable = discoveryFor(files, { statuses: { 'openai-cookbook': 'stale' } });
  const retained = await buildSearchIndex({ registry, topics, discovery: unavailable, published, previous: first, fetcher: fetcherFor(files) });
  const cookbook = retained.index.sources.find(source => source.id === 'openai-cookbook');
  assert.equal(cookbook.status, 'retained');
  assert.equal(cookbook.documentCount, 1);
  validateSearchIndex(retained.index, { bytes: retained.indexBytes });
  const changed = structuredClone(files);
  changed['microsoft-agents']['13-agent-memory/README.md'] += '\nChanged.';
  changed['microsoft-agents']['05-agentic-rag/README.md'] += '\nChanged.';
  const networkDown = await buildSearchIndex({ registry, topics, discovery: discoveryFor(changed), published, previous: first, fetcher: fetcherFor(changed, { fail: sourceID => sourceID === 'microsoft-agents' }) });
  assert.equal(networkDown.index.sources.find(source => source.id === 'microsoft-agents').status, 'retained');
  const noPrevious = await buildSearchIndex({ registry, topics, discovery: unavailable, published, fetcher: fetcherFor(files) });
  assert.deepEqual(noPrevious.index.sources.map(source => source.id), ['microsoft-genai', 'microsoft-agents']);
});

test('整体无可用结果时原样保留上一版；没有上一版则不产出索引', async () => {
  const first = await buildSearchIndex({ registry, topics, discovery: discoveryFor(files), published, fetcher: fetcherFor(files) });
  const changed = structuredClone(files);
  for (const source of Object.values(changed)) for (const key of Object.keys(source)) source[key] += '\nChanged.';
  const down = fetcherFor(changed, { fail: () => true });
  const retained = await buildSearchIndex({ registry, topics, discovery: discoveryFor(changed), published, previous: first, fetcher: down });
  assert.equal(retained.status, 'retained-previous');
  assert.ok(retained.indexBytes.equals(first.indexBytes));
  assert.equal((await buildSearchIndex({ registry, topics, discovery: null, published, previous: first, fetcher: down })).status, 'retained-previous');
  assert.equal((await buildSearchIndex({ registry, topics, discovery: discoveryFor(changed), published, fetcher: down })).status, 'empty');
});

test('blob 哈希不符、超过 700KB 与非 UTF-8 正文被拒收', async () => {
  const tampered = async address => address.includes('13-agent-memory') ? new Response('# Tampered') : fetcherFor(files)(address);
  const result = await buildSearchIndex({ registry, topics, discovery: discoveryFor(files), published, fetcher: tampered });
  assert.ok(result.report.failures.some(item => item.path === '13-agent-memory/README.md' && item.reason === 'integrity-failed'));
  const large = { ...files, 'openai-cookbook': { 'examples/large.md': 'x'.repeat(700001) } };
  const oversized = await buildSearchIndex({ registry, topics, discovery: discoveryFor(large), published, fetcher: fetcherFor(large) });
  assert.ok(oversized.report.failures.some(item => item.reason === 'document-too-large'));
  assert.ok(!oversized.index.sources.some(source => source.id === 'openai-cookbook'));
});

test('正文截断到 12000 个 UTF-16 单元且不留孤立代理项', async () => {
  assert.equal(truncateText('a'.repeat(11999) + '😀', 12000), 'a'.repeat(11999));
  const long = { ...files, 'openai-cookbook': { 'examples/long.md': '# Long\n' + '记忆'.repeat(9000) } };
  const result = await buildSearchIndex({ registry, topics, discovery: discoveryFor(long), published, fetcher: fetcherFor(long) });
  const document = result.index.documents.find(item => item.path === 'examples/long.md');
  assert.equal(document.text.length, 12000);
  assert.ok(document.text.isWellFormed());
});

test('校验器拒收违反契约的索引与指针', async () => {
  const valid = await buildSearchIndex({ registry, topics, discovery: discoveryFor(files), published, fetcher: fetcherFor(files) });
  const mutate = change => { const copy = structuredClone(valid.index); change(copy); return copy; };
  for (const [label, broken] of [
    ['未知来源', mutate(index => { index.documents[0].sourceID = 'other'; })],
    ['仓库不对应', mutate(index => { index.sources[0].repository = 'someone/else'; })],
    ['地址不一致', mutate(index => { index.documents[0].url += 'x'; })],
    ['正文过长', mutate(index => { index.documents[0].text = 'x'.repeat(12001); })],
    ['标题过长', mutate(index => { index.documents[0].title = 'x'.repeat(401); })],
    ['文档数不一致', mutate(index => { index.sources[0].documentCount++; })],
    ['重复 ID', mutate(index => { index.documents[1] = index.documents[0]; })],
    ['状态无效', mutate(index => { index.sources[0].status = 'ok'; })],
    ['版本无效', mutate(index => { index.documents[0].revision = 'main'; })]
  ]) assert.throws(() => validateSearchIndex(broken), /静态检索索引无效/, label);
  assert.throws(() => validateSearchIndex(valid.index, { bytes: Buffer.alloc(4194305) }), /4 MiB/);
  assert.throws(() => validateSearchPointer({ ...valid.pointer, indexPath: 'search/other.json' }), /指针/);
  assert.throws(() => validateSearchPointer({ ...valid.pointer, bytes: valid.pointer.bytes + 1 }, valid.indexBytes), /字节数或 SHA-256/);
  const tampered = Buffer.from(valid.indexBytes);
  tampered[tampered.length - 2] ^= 1;
  assert.throws(() => validateSearchPointer(valid.pointer, tampered), /SHA-256/);
});

test('写出、读取与复制 search 目录：保留上一版索引文件，跳过损坏文件', async context => {
  const directory = await temporary(context);
  const first = await buildSearchIndex({ registry, topics, discovery: discoveryFor(files), published, fetcher: fetcherFor(files) });
  const changed = structuredClone(files);
  changed['openai-cookbook']['examples/evaluation/README.md'] += '\nChanged.';
  const second = await buildSearchIndex({ registry, topics, discovery: discoveryFor(changed), published, previous: first, fetcher: fetcherFor(changed) });
  const output = path.join(directory, 'search-index');
  await writeSearchOutput(output, second, first);
  assert.deepEqual((await fs.readdir(output)).sort(), ['index-' + first.pointer.indexSha256 + '.json', 'index-' + second.pointer.indexSha256 + '.json', 'latest.json'].sort());
  assert.equal((await readSearchDirectory(output)).pointer.indexSha256, second.pointer.indexSha256);
  await fs.writeFile(path.join(output, 'index-' + 'f'.repeat(64) + '.json'), '{}');
  const copied = await copySearchDirectory(output, path.join(directory, 'site/search'));
  assert.equal(copied.files.length, 3);
  assert.ok(!copied.files.includes('index-' + 'f'.repeat(64) + '.json'));
  const loaded = await loadPublishedIndex(path.join(directory, 'site/search'));
  assert.equal(loaded.previous.pointer.indexSha256, second.pointer.indexSha256);
  await fs.writeFile(path.join(directory, 'site/search/latest.json'), JSON.stringify({ ...second.pointer, bytes: 1 }));
  assert.match((await loadPublishedIndex(path.join(directory, 'site/search'))).warning, /上一版索引不可用/);
  const cache = path.join(directory, 'search');
  await fs.mkdir(cache);
  await fs.writeFile(path.join(cache, 'cache.json'), '{}');
  await assert.rejects(writeSearchOutput(cache, second), /拒绝覆盖/);
  assert.equal(await fs.readFile(path.join(cache, 'cache.json'), 'utf8'), '{}');
});

test('从线上读取上一版：404 视为首次，哈希不符给出警告', async () => {
  const valid = await buildSearchIndex({ registry, topics, discovery: discoveryFor(files), published, fetcher: fetcherFor(files) });
  const base = 'https://example.test/content-library/';
  const online = (indexBytes = valid.indexBytes) => async address => address === base + 'search/latest.json' ? new Response(valid.pointerBytes) : address === base + valid.pointer.indexPath ? new Response(indexBytes) : new Response('', { status: 404 });
  assert.equal((await loadPublishedIndex(base, { fetcher: online() })).previous.pointer.indexSha256, valid.pointer.indexSha256);
  assert.deepEqual(await loadPublishedIndex(base, { fetcher: async () => new Response('', { status: 404 }) }), { previous: null, warning: null });
  const result = await loadPublishedIndex(base, { fetcher: online(Buffer.from('{}')) });
  assert.equal(result.previous, null);
  assert.match(result.warning, /上一版索引不可用/);
  assert.match((await loadPublishedIndex('http://example.test/content-library/')).warning, /HTTPS/);
});

test('正式资料库的 10 篇已发布文档可读取为排除列表', async () => {
  const documents = await publishedDocuments(fileURLToPath(new URL('../yueqian-training/content-library', import.meta.url)));
  assert.equal(documents.length, 10);
  assert.ok(documents.every(item => item.sourceID === 'microsoft-genai' && item.path.startsWith('translations/zh-CN/')));
});
