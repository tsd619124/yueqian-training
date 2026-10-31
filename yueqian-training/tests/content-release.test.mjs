// Web 原文资料库客户端（content-release.js）的多来源（schema v2）契约：来源映射、逐来源许可、快照与失败保留。
// 运行：node --test yueqian-training/tests/content-release.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const library = path.join(web, 'content-library');
const base = 'https://library.example/content/';

// 先加载随站点发布的目录与 URL 构造器，再加载资料库客户端与检索客户端（与 materials.html 的顺序一致）。
await import(path.join(web, 'external-catalog.js'));
await import(path.join(web, 'external-materials.js'));
await import(path.join(web, 'content-release.js'));
await import(path.join(web, 'material-search.js'));
const client = globalThis.YueqianContentRelease;
const search = globalThis.YueqianMaterialSearch;
const realCatalog = globalThis.YUEQIAN_EXTERNAL_CATALOG;

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
function cacheURL(releaseID, name) { return base + 'releases/' + releaseID + '/' + name; }

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function jsonBytes(value) { return Buffer.from(JSON.stringify(canonical(value)) + '\n'); }

const ISO = '2026-10-31T14:48:30.821Z';
const fixtureSources = [
  { id: 'microsoft-genai', publisher: 'Microsoft', repository: 'microsoft/generative-ai-for-beginners', revision: 'a'.repeat(40), licenseText: 'MIT License\n\nCopyright (c) Microsoft Corporation.\n\nPermission is hereby granted, free of charge.\n' },
  { id: 'openai-cookbook', publisher: 'OpenAI', repository: 'openai/openai-cookbook', revision: 'b'.repeat(40), licenseText: 'MIT License\n\nCopyright (c) 2025 OpenAI\n\nPermission is hereby granted, free of charge.\n' }
];
const fixtureArticles = [
  { id: 'ms-sample', title: '示例一：RAG', sourceID: 'microsoft-genai', path: 'translations/zh-CN/15-rag-and-vector-databases/README.md', lessonIDs: ['w2.0'], markdown: '# 示例一\n\n检索增强生成的基础内容。\n', text: '示例一 检索增强生成的基础内容。' },
  { id: 'oc-sample', title: 'Sample Two', sourceID: 'openai-cookbook', path: 'examples/sample/README.md', lessonIDs: ['ref.agent'], markdown: '# Sample\n\nAgents API examples for memory.\n', text: 'Sample Agents API examples for memory.', images: [{ path: 'images/diagram.png', alt: 'diagram', bytes: [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3] }] }
];
function fixtureCatalog({ sources = fixtureSources, articles = fixtureArticles } = {}) {
  return { schemaVersion: 2, sources: sources.map(source => ({ id: source.id, publisher: source.publisher, repository: source.repository, licensePath: 'LICENSE' })), articles: articles.map(({ id, title, sourceID, path: articlePath, lessonIDs }) => ({ id, title, sourceID, path: articlePath, lessonIDs })) };
}
// 生成与 content-pipeline/lib.mjs buildRelease 同构的内存资料库（2 个来源、文档/索引/逐来源许可/合并许可）。
function buildFixture({ sources = fixtureSources, articles = fixtureArticles, extraFiles = [], perSourceLicenses = true, mutate = null } = {}) {
  const files = new Map();
  const summaries = [];
  const index = { schemaVersion: 1, documents: [] };
  let imageReferences = 0;
  const prepared = articles.map(article => {
    const source = sources.find(item => item.id === article.sourceID);
    assert.ok(source, 'fixture article needs a declared source');
    const url = globalThis.YueqianMaterials.sourceURL(source, article);
    const images = (article.images || []).map(image => {
      const bytes = Buffer.from(image.bytes);
      const hash = sha256(bytes);
      const assetPath = 'assets/' + hash + '.png';
      files.set(assetPath, bytes);
      imageReferences++;
      return { path: assetPath, sourcePath: image.path, sourceURL: globalThis.YueqianMaterials.rawURL(source.revision, image.path, source.repository), alt: image.alt, mimeType: 'image/png', sha256: hash, width: 1, height: 1 };
    });
    return { article, source, url, images };
  });
  for (const { article, source, url, images } of prepared) {
    const documentPath = 'documents/' + article.id + '.json';
    const document = {
      schemaVersion: 1, id: article.id, title: article.title, lessonIDs: article.lessonIDs, markdown: article.markdown, sha256: sha256(Buffer.from(article.markdown, 'utf8')), images,
      source: { id: source.id, publisher: source.publisher, repository: source.repository, revision: source.revision, path: article.path, url, rawURL: globalThis.YueqianMaterials.rawURL(source.revision, article.path, source.repository), downloadedAt: ISO, license: 'MIT' }
    };
    files.set(documentPath, jsonBytes(document));
    summaries.push({ id: article.id, title: article.title, path: documentPath, sourceID: source.id, url, lessonIDs: article.lessonIDs, imageCount: images.length });
    index.documents.push({ id: article.id, title: article.title, url, path: documentPath, sourceID: source.id, lessonIDs: article.lessonIDs, text: article.text || article.markdown });
  }
  files.set('index.json', jsonBytes(index));
  files.set('coverage.json', jsonBytes({ schemaVersion: 1, topics: [] }));
  if (perSourceLicenses) for (const source of sources) files.set('licenses/' + source.id + '.txt', Buffer.from(source.licenseText));
  files.set('LICENSE.txt', Buffer.from(sources.map(source => '===== ' + source.id + ' =====\n' + source.licenseText.trim()).join('\n\n') + '\n'));
  for (const [name, bytes] of extraFiles) files.set(name, Buffer.from(bytes));
  const content = {
    schemaVersion: 2,
    sources: sources.map(source => ({ id: source.id, publisher: source.publisher, repository: source.repository, revision: source.revision, downloadedAt: ISO })),
    documents: summaries,
    imageReferences,
    assetCount: [...files.keys()].filter(name => name.startsWith('assets/')).length,
    files: [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) }))
  };
  if (mutate) mutate(content, { files, summaries, index, sources });
  const releaseID = sha256(jsonBytes(content));
  const manifest = { ...content, releaseID };
  const manifestBytes = jsonBytes(manifest);
  return { files, manifest, manifestBytes, releaseID, latest: { schemaVersion: 1, releaseID, manifestPath: 'releases/' + releaseID + '/manifest.json', manifestSha256: sha256(manifestBytes) } };
}

function fixtureFetch(bundle, { requests = [], modify } = {}) {
  return async (value, options = {}) => {
    const url = new URL(value);
    requests.push(url.pathname);
    assert.equal(url.origin, 'https://library.example');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (url.pathname === '/content/latest.json') {
      assert.equal(options.cache, 'no-store');
      const response = new Response(JSON.stringify(bundle.latest));
      return modify ? modify('latest.json', response, bundle) : response;
    }
    const prefix = '/content/releases/' + bundle.releaseID + '/';
    assert.ok(url.pathname.startsWith(prefix), 'unexpected URL: ' + url.pathname);
    const name = decodeURIComponent(url.pathname.slice(prefix.length));
    if (name === 'manifest.json') {
      const response = new Response(bundle.manifestBytes);
      return modify ? modify(name, response, bundle) : response;
    }
    const bytes = bundle.files.get(name);
    const response = bytes ? new Response(bytes) : new Response('missing', { status: 404 });
    return modify ? modify(name, response, bundle) : response;
  };
}

async function loadFixture(bundle, catalog = fixtureCatalog()) {
  resetCache();
  return client.load(base, catalog, fixtureFetch(bundle));
}

// ---------- 文件白名单 ----------

test('safeFilePath：允许 licenses/<sourceID>.txt，同时保留 assets/documents/index/coverage/LICENSE', () => {
  for (const allowed of ['assets/' + 'a'.repeat(64) + '.png', 'assets/' + 'b'.repeat(64) + '.webp', 'documents/ms-rag.json', 'licenses/microsoft-genai.txt', 'licenses/openai-cookbook.txt', 'index.json', 'coverage.json', 'LICENSE.txt']) assert.equal(client.safeFilePath(allowed), true, allowed);
  for (const rejected of ['licenses/../LICENSE.txt', 'licenses/openai-cookbook.json', 'licenses/OpenAI.txt', 'licenses/openai_cookbook.txt', 'licenses/' + 'a'.repeat(81) + '.txt', 'licenses/', 'assets/not-a-hash.png', 'documents/../index.json', '/LICENSE.txt', 'LICENSE.txt/../x', 'search/index.json']) assert.equal(client.safeFilePath(rejected), false, rejected);
});

// ---------- 清单 ----------

test('manifestFor 接受 2 个来源的 v2 清单：逐来源映射、文章 URL 用该来源 revision', async () => {
  const bundle = buildFixture();
  const catalog = fixtureCatalog();
  const manifest = await client.manifestFor(bundle.latest, bundle.manifestBytes, catalog);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.sources.map(source => source.id), ['microsoft-genai', 'openai-cookbook']);
  assert.deepEqual(manifest.sources.map(source => source.revision), ['a'.repeat(40), 'b'.repeat(40)]);
  assert.ok(manifest.files.some(record => record.path === 'licenses/openai-cookbook.txt'));
  assert.equal(manifest.documents[0].url, 'https://github.com/microsoft/generative-ai-for-beginners/blob/' + 'a'.repeat(40) + '/translations/zh-CN/15-rag-and-vector-databases/README.md');
  assert.equal(manifest.documents[1].url, 'https://github.com/openai/openai-cookbook/blob/' + 'b'.repeat(40) + '/examples/sample/README.md');
  const state = await client.load(base, catalog, fixtureFetch(bundle));
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.manifest.documents.length, 2);
});

test('manifestFor 拒绝错误 sourceID、未知来源、重复来源、错误 revision/repository 与非来源许可', async () => {
  const catalog = fixtureCatalog();
  const cases = {
    '文章 sourceID 与目录不符': content => { content.documents[1].sourceID = 'microsoft-genai'; },
    '文章 sourceID 未登记': content => { content.documents[0].sourceID = 'unknown-source'; },
    '来源重复登记': content => { content.sources.push({ ...content.sources[0] }); },
    'revision 非 40 位十六进制': content => { content.sources[0].revision = 'z'.repeat(40); },
    'repository 与目录不符': content => { content.sources[0].repository = 'openai/openai-cookbook'; },
    'publisher 与目录不符': content => { content.sources[1].publisher = 'Microsoft'; },
    '规格版本仍为 v1': content => { content.schemaVersion = 1; }
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const bundle = buildFixture({ mutate });
    await assert.rejects(client.manifestFor(bundle.latest, bundle.manifestBytes, catalog), /版本或来源无效|发布来源未经审核|课程关联未经审核|资料许可文件与来源不一致/, name);
  }
  const unknownLicense = buildFixture({ extraFiles: [['licenses/unknown-source.txt', Buffer.from('MIT License\n')]] });
  await assert.rejects(client.manifestFor(unknownLicense.latest, unknownLicense.manifestBytes, catalog), /资料许可文件与来源不一致/);
  const disallowedLicense = buildFixture({ extraFiles: [['licenses/OpenAI.txt', Buffer.from('MIT License\n')]] });
  await assert.rejects(client.manifestFor(disallowedLicense.latest, disallowedLicense.manifestBytes, catalog), /资料文件记录无效/);
  const changedCatalog = fixtureCatalog();
  changedCatalog.articles[1].sourceID = 'microsoft-genai';
  const bundle = buildFixture();
  await assert.rejects(client.manifestFor(bundle.latest, bundle.manifestBytes, changedCatalog), /课程关联未经审核/);
});

test('manifestFor 拒绝被改动的清单哈希与 v1 旧资料库', async () => {
  const bundle = buildFixture();
  const catalog = fixtureCatalog();
  const tampered = Buffer.from(bundle.manifestBytes);
  tampered[tampered.length - 1] = 0x20;
  await assert.rejects(client.manifestFor(bundle.latest, tampered, catalog), /哈希校验失败/);
  const legacy = buildFixture({ mutate: content => { content.schemaVersion = 1; } });
  await assert.rejects(client.manifestFor(legacy.latest, legacy.manifestBytes, catalog), /资料清单版本或来源无效/);
});

test('licenses/<id>.txt 可选：缺少逐来源许可时以合并 LICENSE.txt 兜底并通过校验', async () => {
  const bundle = buildFixture({ perSourceLicenses: false });
  const catalog = fixtureCatalog();
  const state = await client.load(base, catalog, fixtureFetch(bundle));
  assert.equal(state.manifest.files.some(record => record.path.startsWith('licenses/')), false);
  const merged = await client.licenseText(state, 'openai-cookbook', fixtureFetch(bundle));
  assert.equal(merged, fixtureSources[1].licenseText.trim());
  const microsoft = await client.licenseText(state, 'microsoft-genai', fixtureFetch(bundle));
  assert.equal(microsoft, fixtureSources[0].licenseText.trim());
  const values = await client.licenseTexts(state, fixtureFetch(bundle));
  assert.deepEqual(values.map(value => value.id), ['microsoft-genai', 'openai-cookbook']);
});

test('LICENSE 读取：逐来源许可文件优先，合并文本可逐来源显示，不假设只有 Microsoft', async () => {
  const bundle = buildFixture();
  const state = await client.load(base, fixtureCatalog(), fixtureFetch(bundle));
  assert.equal(await client.licenseText(state, 'microsoft-genai', fixtureFetch(bundle)), fixtureSources[0].licenseText);
  assert.equal(await client.licenseText(state, 'openai-cookbook', fixtureFetch(bundle)), fixtureSources[1].licenseText);
  const values = await client.licenseTexts(state, fixtureFetch(bundle));
  assert.deepEqual(values.map(value => value.id), ['microsoft-genai', 'openai-cookbook']);
  assert.equal(values[1].publisher, 'OpenAI');
  assert.ok(values.every(value => value.licenseText.includes('MIT License')));
  await assert.rejects(client.licenseText(state, 'not-a-source', fixtureFetch(bundle)), /没有该来源/);
});

// ---------- 单篇文档 ----------

test('documentFor/checkDocument 按 sourceID 映射：来源、正文与图片 URL 使用文章自己的 revision', async () => {
  const bundle = buildFixture();
  const catalog = fixtureCatalog();
  const state = await loadFixture(bundle, catalog);
  const first = await client.documentFor(state, 'ms-sample', catalog, fixtureFetch(bundle));
  assert.equal(first.source.id, 'microsoft-genai');
  assert.equal(first.source.revision, 'a'.repeat(40));
  const second = await client.documentFor(state, 'oc-sample', catalog, fixtureFetch(bundle));
  assert.equal(second.source.id, 'openai-cookbook');
  assert.equal(second.source.repository, 'openai/openai-cookbook');
  assert.equal(second.source.revision, 'b'.repeat(40));
  assert.equal(second.source.rawURL, 'https://raw.githubusercontent.com/openai/openai-cookbook/' + 'b'.repeat(40) + '/examples/sample/README.md');
  assert.equal(second.images.length, 1);
  assert.equal(second.images[0].sourceURL, 'https://raw.githubusercontent.com/openai/openai-cookbook/' + 'b'.repeat(40) + '/images/diagram.png');
  // 内容相同再次读取命中内存缓存，不重复发网。
  const again = await client.documentFor(state, 'oc-sample', catalog, async () => { throw new Error('must not fetch'); });
  assert.equal(again.markdown, second.markdown);
  // 原图按需下载并缓存：第二次读取不再访问网络。
  assert.equal(await client.cacheAssets(state, second.images.map(image => image.path), fixtureFetch(bundle)), 1);
  assert.equal(await client.cacheAssets(state, second.images.map(image => image.path), async () => { throw new Error('must not fetch'); }), 0);
});

test('checkDocument 拒绝错误来源字段、错误 revision 与错误图片 URL', async () => {
  const bundle = buildFixture();
  const catalog = fixtureCatalog();
  const state = await loadFixture(bundle, catalog);
  const document = await client.documentFor(state, 'oc-sample', catalog, fixtureFetch(bundle));
  const changes = {
    '来源 id 换成另一来源': value => { value.source.id = 'microsoft-genai'; },
    '来源 repository 不符': value => { value.source.repository = 'microsoft/generative-ai-for-beginners'; },
    '来源 revision 不符': value => { value.source.revision = 'c'.repeat(40); },
    '来源 publisher 不符': value => { value.source.publisher = 'Microsoft'; },
    '来源 url 不符': value => { value.source.url = 'https://github.com/openai/openai-cookbook/blob/' + 'c'.repeat(40) + '/examples/sample/README.md'; },
    '来源 rawURL 不符': value => { value.source.rawURL = 'https://raw.githubusercontent.com/openai/openai-cookbook/' + 'c'.repeat(40) + '/examples/sample/README.md'; },
    '来源下载时间不符': value => { value.source.downloadedAt = '2026-10-30T00:00:00.000Z'; },
    '许可不是 MIT': value => { value.source.license = 'Apache-2.0'; },
    '图片 URL 用了旧 revision': value => { value.images[0].sourceURL = 'https://raw.githubusercontent.com/openai/openai-cookbook/' + 'c'.repeat(40) + '/images/diagram.png'; },
    '图片路径不是资源路径': value => { value.images[0].path = 'documents/oc-sample.json'; },
    '图片哈希路径不符': value => { value.images[0].sha256 = 'd'.repeat(64); }
  };
  for (const [name, change] of Object.entries(changes)) {
    const copy = structuredClone(document);
    change(copy);
    assert.throws(() => client.checkDocument(state, copy, catalog), /不一致/, name);
  }
  const changedCatalog = fixtureCatalog();
  changedCatalog.articles[1].sourceID = 'microsoft-genai';
  assert.throws(() => client.checkDocument(state, document, changedCatalog), /不一致/);
});

// ---------- 快照 ----------

test('searchSnapshot 返回 schemaVersion 2 的 sources/articles，article 带 sourceID，检索结果用文章自己的来源', async () => {
  const bundle = buildFixture();
  const catalog = fixtureCatalog();
  const state = await loadFixture(bundle, catalog);
  const snapshot = await client.searchSnapshot(state, catalog, fixtureFetch(bundle));
  assert.equal(snapshot.schemaVersion, 2);
  assert.deepEqual(snapshot.sources.map(source => source.id), ['microsoft-genai', 'openai-cookbook']);
  assert.deepEqual(snapshot.sources.map(source => source.fetchedAt), [ISO, ISO]);
  assert.equal('repository' in snapshot, false);
  assert.equal('revision' in snapshot, false);
  assert.deepEqual(snapshot.articles.map(article => article.sourceID), ['microsoft-genai', 'openai-cookbook']);
  assert.equal(snapshot.articles[0].markdown, fixtureArticles[0].text);
  const results = search.local(snapshot, 'memory');
  assert.equal(results.length, 1);
  assert.equal(results[0].sourceID, 'openai-cookbook');
  assert.equal(results[0].repository, 'openai/openai-cookbook');
  assert.equal(results[0].revision, 'b'.repeat(40));
  assert.equal(results[0].url, 'https://github.com/openai/openai-cookbook/blob/' + 'b'.repeat(40) + '/examples/sample/README.md');
});

// ---------- 状态恢复与更新 ----------

test('restore 接受多来源 v2 状态，明确拒绝旧单来源与损坏状态', async () => {
  const bundle = buildFixture();
  const state = await loadFixture(bundle);
  assert.equal(client.restore(structuredClone(state)).latest.releaseID, bundle.releaseID);
  for (const [name, mutate] of Object.entries({
    '旧 v1 清单': value => { value.manifest.schemaVersion = 1; },
    'sources 为空': value => { value.manifest.sources = []; },
    '来源 revision 无效': value => { value.manifest.sources[0].revision = 'abc'; },
    '文章 sourceID 未登记': value => { value.manifest.documents[0].sourceID = 'unknown-source'; },
    '来源重复': value => { value.manifest.sources.push({ ...value.manifest.sources[0] }); }
  })) {
    const saved = structuredClone(state);
    mutate(saved);
    assert.throws(() => client.restore(saved), /无效/, name);
  }
});

test('refresh 增量更新 v2：按哈希复用原图、下载变更正文，失败保留旧版本', async () => {
  resetCache();
  const catalog = fixtureCatalog();
  const first = buildFixture();
  const state = await client.load(base, catalog, fixtureFetch(first));
  for (const item of first.manifest.files) await cache.put(cacheURL(first.releaseID, item.path), new Response(first.files.get(item.path)));
  const articles = structuredClone(fixtureArticles);
  articles[0].markdown = '# 示例一\n\n更新后的检索增强内容。\n';
  articles[0].text = '示例一 更新后的检索增强内容。';
  const next = buildFixture({ articles });
  const requests = [];
  const result = await client.refresh(base, state, catalog, fixtureFetch(next, { requests }));
  assert.equal(result.changed, true);
  assert.equal(result.state.manifest.sources.length, 2);
  const previousHashes = new Set(first.manifest.files.map(item => item.sha256));
  const changed = next.manifest.files.filter(item => !previousHashes.has(item.sha256));
  assert.deepEqual(changed.map(item => item.path).sort(), ['documents/ms-sample.json', 'index.json']);
  assert.equal(requests.length, 2 + changed.length);
  assert.equal(requests.filter(name => name.includes('/assets/')).length, 0);
  assert.equal(result.budget.reusedFiles, next.manifest.files.length - changed.length);
  assert.equal(await client.prune(result.state), first.manifest.files.length);
  assert.ok([...cache.entries.keys()].every(url => url.includes('/releases/' + next.releaseID + '/')));
  // 同版本只读指针；清单冲突与坏正文都不会替换旧状态。
  const original = JSON.stringify(state);
  const same = await client.refresh(base, state, catalog, async () => new Response(JSON.stringify(state.latest)));
  assert.equal(same.changed, false);
  await assert.rejects(client.refresh(base, state, catalog, async () => new Response(JSON.stringify({ ...state.latest, manifestSha256: 'f'.repeat(64) }))), /冲突/);
  await assert.rejects(client.refresh(base, state, catalog, fixtureFetch(next, { modify: (name, response) => name.startsWith('documents/') ? new Response('missing', { status: 404 }) : response })), /HTTP 404/);
  await assert.rejects(client.refresh(base, state, catalog, fixtureFetch(next, { modify: (name, response, bundle) => name.startsWith('documents/') ? new Response(Buffer.alloc(bundle.files.get(name).length)) : response })), /校验失败/);
  assert.equal(JSON.stringify(state), original);
});

test('加载的正文/原图哈希不符时拒绝，且不写入缓存', async () => {
  resetCache();
  const bundle = buildFixture();
  const catalog = fixtureCatalog();
  const state = await client.load(base, catalog, fixtureFetch(bundle));
  const corrupt = fixtureFetch(bundle, { modify: (name, response, current) => name.startsWith('documents/') || name.startsWith('assets/') ? new Response(Buffer.alloc(current.files.get(name).length)) : response });
  await assert.rejects(client.documentFor(state, 'ms-sample', catalog, corrupt), /校验失败/);
  assert.equal(cache.entries.size, 0);
});

// ---------- 真实资料库（只读） ----------

function diskFetch(directory) {
  return async value => {
    const name = decodeURIComponent(new URL(value).pathname).replace(/^\/content\//, '');
    try { return new Response(await fs.readFile(path.join(directory, name))); } catch { return new Response('missing', { status: 404 }); }
  };
}

test('真实多来源资料库：3 个来源 15 篇逐篇校验，URL 与许可按来源读取，检索快照为 v2', async () => {
  resetCache();
  const state = await client.load(base, realCatalog, diskFetch(library));
  assert.equal(state.manifest.schemaVersion, 2);
  assert.deepEqual(state.manifest.sources.map(source => source.id), ['microsoft-genai', 'microsoft-agents', 'openai-cookbook']);
  assert.equal(state.manifest.documents.length, 15);
  const byID = new Map(state.manifest.sources.map(source => [source.id, source]));
  for (const definition of realCatalog.articles) {
    const document = await client.documentFor(state, definition.id, realCatalog, diskFetch(library));
    const source = byID.get(definition.sourceID);
    assert.ok(source, definition.sourceID);
    assert.equal(document.source.id, definition.sourceID);
    assert.equal(document.source.repository, source.repository);
    assert.equal(document.source.revision, source.revision);
    assert.ok(document.source.url.includes('/' + source.repository + '/blob/' + source.revision + '/'), document.source.url);
    assert.ok(document.source.rawURL.includes('/' + source.repository + '/' + source.revision + '/'), document.source.rawURL);
    for (const image of document.images) assert.ok(image.sourceURL.includes('/' + source.repository + '/' + source.revision + '/'), definition.id + ': ' + image.sourceURL);
  }
  const snapshot = await client.searchSnapshot(state, realCatalog, diskFetch(library));
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.articles.length, 15);
  assert.deepEqual(snapshot.sources.map(source => source.id), ['microsoft-genai', 'microsoft-agents', 'openai-cookbook']);
  assert.equal(snapshot.articles.find(article => article.id === 'oc-agents-api').sourceID, 'openai-cookbook');
  assert.equal('repository' in snapshot, false);
  const licenses = await client.licenseTexts(state, diskFetch(library));
  assert.deepEqual(licenses.map(value => value.id), ['microsoft-genai', 'microsoft-agents', 'openai-cookbook']);
  assert.equal(licenses[2].licenseText, await fs.readFile(path.join(library, 'releases', state.latest.releaseID, 'licenses/openai-cookbook.txt'), 'utf8'));
  assert.ok(licenses[0].licenseText.includes('MIT License'));
  assert.ok(licenses[2].licenseText.includes('Copyright (c) 2025 OpenAI'));
});
