// 来源登记 ↔ 三端白名单一致性检查（回归防线）。
// 新增来源时，以下位置必须同步，否则 `release.mjs check` 直接失败：
//   content-pipeline/sources.json            （唯一事实源）
//   yueqian-training/external-catalog.js     （已发布资料库的来源与文章）
//   content-pipeline/search-index.mjs        （静态索引构建端）
//   yueqian-training/material-search.js      （Web 客户端）
//   native-app/Sources/YueqianCore/StaticSearchIndex.swift （iOS 客户端）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allowedSearchSources } from './search-index.mjs';
import { validateRegistry } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const registry = validateRegistry(JSON.parse(read('content-pipeline/sources.json')));
const registryMap = Object.fromEntries(registry.sources.map(source => [source.id, source.repository]));
const registryIDs = Object.keys(registryMap).sort();

function pairsFrom(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, label + ' 未找到白名单');
  const pairs = {};
  for (const item of match[1].matchAll(/'([a-z0-9-]+)'\s*:\s*'([^']+)'|"([a-z0-9-]+)"\s*:\s*"([^"]+)"/g)) {
    const id = item[1] || item[3];
    const repository = item[2] || item[4];
    assert.equal(pairs[id], undefined, label + ' 来源重复：' + id);
    pairs[id] = repository;
  }
  return pairs;
}

function compare(label, actual) {
  assert.deepEqual(Object.keys(actual).sort(), registryIDs, label + ' 的来源 ID 与 sources.json 不一致');
  for (const id of registryIDs) assert.equal(actual[id], registryMap[id], label + ' 的仓库与 sources.json 不一致：' + id);
}

test('静态索引构建端白名单与来源登记一致', () => {
  compare('search-index.mjs', { ...allowedSearchSources });
});

test('Web 客户端白名单与来源登记一致', () => {
  const source = read('yueqian-training/material-search.js');
  compare('material-search.js', pairsFrom(source, /const repositories = \{([\s\S]*?)\};/, 'material-search.js'));
});

const swiftSource = 'native-app/Sources/YueqianCore/StaticSearchIndex.swift';
test('iOS 客户端白名单与来源登记一致', { skip: !fs.existsSync(path.join(root, swiftSource)) && '公开仓库不包含原生 Swift 源码' }, () => {
  const source = read(swiftSource);
  compare('StaticSearchIndex.swift', pairsFrom(source, /public static let allowedSources = \[([\s\S]*?)\]/, 'StaticSearchIndex.swift'));
});

test('catalog 来源与文章引用均已登记且仓库一致', async () => {
  await import(pathToFileURL(path.join(root, 'yueqian-training/external-catalog.js')).href);
  const catalog = globalThis.YUEQIAN_EXTERNAL_CATALOG;
  assert.equal(catalog.schemaVersion, 2);
  assert.ok(catalog.sources.length <= 8 && catalog.articles.length <= 48);
  const catalogMap = Object.fromEntries(catalog.sources.map(source => [source.id, source.repository]));
  for (const [id, repository] of Object.entries(catalogMap)) {
    assert.equal(registryMap[id], repository, 'catalog 来源未在 sources.json 登记或仓库不一致：' + id);
  }
  const ids = new Set();
  for (const article of catalog.articles) {
    assert.ok(article.id && !ids.has(article.id) && article.path.endsWith('.md') && Array.isArray(article.lessonIDs) && article.lessonIDs.length > 0, 'catalog 文章字段无效：' + article.id);
    assert.ok(catalogMap[article.sourceID], 'catalog 文章引用了未登记来源：' + article.id + ' -> ' + article.sourceID);
    assert.ok(article.title.length > 0 && article.title.length < 200, 'catalog 文章标题无效：' + article.id);
    ids.add(article.id);
  }
});
