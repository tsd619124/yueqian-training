// Web 文案与品牌一致性：4 来源动态摘要、12 周口径、内部 ID 清理与 1.20.0 更新日志。
// 运行：node --test yueqian-training/tests/copy-brand.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(web, name), 'utf8');
const html = read('index.html');
const app = read('app.js');
const materials = read('materials.html');
const manifest = JSON.parse(read('manifest.webmanifest'));
const latest = JSON.parse(read('content-library/latest.json'));
const libraryManifest = JSON.parse(read(path.join('content-library', latest.manifestPath)));

test('学习中心原文入口从 latest.json 与 manifest 动态生成摘要，不写死来源', async () => {
  assert.match(html, /id="materialsEntry"[^>]*>原文与配图<\/a>/u);
  assert.ok(!html.includes('原文与配图 · Microsoft'), '入口仍写死 Microsoft');
  assert.match(app, /fetch\('\.\/content-library\/latest\.json'/u);
  assert.match(app, /latest\.manifestPath/u);

  const helperSource = /function materialsEntryText\(manifest\)\{[^\n]*\}/u.exec(app)?.[0];
  assert.ok(helperSource, '缺少动态摘要函数');
  const materialsEntryText = vm.runInNewContext('(' + helperSource + ')');
  assert.equal(libraryManifest.sources.length, 4);
  assert.equal(libraryManifest.documents.length, 21);
  assert.equal(materialsEntryText(libraryManifest), '原文与配图 · 4 个来源 · 21 篇');
  assert.equal(materialsEntryText({ sources: [], documents: [] }), '原文与配图');

  // 用模拟 fetch 跑一遍加载函数：latest.json → manifest → 入口文案。
  const loadSource = /function loadMaterialsEntry\(\)\{[\s\S]*?\n\}/u.exec(app)?.[0];
  assert.ok(loadSource, '缺少原文入口加载函数');
  const entry = { textContent: '原文与配图' };
  const context = {
    document: { getElementById: () => entry },
    window: {},
    Error,
    materialsEntryText,
    fetch: async url => ({
      ok: true,
      json: async () => (url.endsWith('latest.json') ? latest : libraryManifest)
    })
  };
  const loadMaterialsEntry = vm.runInNewContext('(' + loadSource + ')', context);
  loadMaterialsEntry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entry.textContent, '原文与配图 · 4 个来源 · 21 篇');
});

test('原文页 noscript 使用中性文案，不写死来源', () => {
  assert.match(materials, /<noscript>本页需启用 JavaScript；原文来自已审核的公开来源<\/noscript>/u);
  assert.ok(!materials.includes('Microsoft'), 'materials.html 仍含 Microsoft');
});

test('产品名统一为「跃迁计划 · AI 售前训练营」，时长统一 12 周', () => {
  assert.equal(/<title>([^<]*)<\/title>/u.exec(html)?.[1], '跃迁计划 · AI 售前训练营');
  assert.ok(!/90\s*天/u.test(html), 'index.html 仍含 90 天');
  const description = /<meta name="description" content="([^"]*)"/u.exec(html)?.[1] || '';
  assert.ok(description.includes('12 周'), 'meta description 缺少 12 周');
  assert.ok(description.includes('AI 售前训练营'), 'meta description 缺少产品名');
  assert.equal(manifest.name, '跃迁计划 · AI 售前训练营');
  assert.ok(manifest.description.includes('12 周'), 'manifest description 缺少 12 周');
  assert.ok(!manifest.description.includes('90 天'), 'manifest description 仍含 90 天');
  for (const text of ['帆软销售', '上海 AI 售前']) {
    assert.ok(!html.includes(text), 'index.html 通用文案仍含 ' + text);
    assert.ok(!app.includes(text), 'app.js 通用文案仍含 ' + text);
  }
});

test('Web 用户可见文案不直接显示模块字母或版本哈希', () => {
  assert.ok(!app.includes("attempt.mod+' 模块'"), '测验历史仍显示「A 模块」');
  assert.ok(!app.includes("esc(QM.mod)+' 模块'"), '答题页仍显示「A 模块」');
  assert.ok(!app.includes("esc(m.id+' · '+m.name)"), '技能树仍显示模块字母');
  assert.match(app, /modNameOf\(attempt\.mod\)/u);
  assert.match(app, /modNameOf\(QM\.mod\)/u);
  assert.ok(!/releaseID\.slice\(0,\s*12\)/u.test(app), 'app.js 仍截取 12 位版本哈希');
  assert.match(materials, /原文下载于 /u, '原文页未收起版本哈希');
});

test('更新日志顶部新增 1.20.0 第一阶段迭代段落', () => {
  const start = app.indexOf('var CHANGELOG=[');
  const entryStart = app.indexOf("{v:'1.20.0'", start);
  assert.ok(entryStart > start, '缺少 1.20.0 更新日志');
  assert.ok(entryStart < app.indexOf("{v:'1.18.0'", start), '1.20.0 不在更新日志顶部');
  const entry = /\{v:'1\.20\.0',d:'11-01',items:\[([\s\S]*?)\]\}/u.exec(app)?.[1] || '';
  for (const keyword of ['学习进度', '训练掌握度', '96 题', '间隔复习', '训练同步', '冲突', '可观测性', 'AX5', '4 个来源', '12 周']) {
    assert.ok(entry.includes(keyword), '更新日志缺少 ' + keyword);
  }
  assert.ok(app.includes("{v:'1.18.0',d:'11-01',items:['外部资料库扩展到 4 个发布来源、21 篇中文原文"), '历史更新日志被改动');
});

test('更新日志顶部新增 1.21.0 原文页语义修复段落', () => {
  const start = app.indexOf('var CHANGELOG=[');
  const entryStart = app.indexOf("{v:'1.21.0'", start);
  assert.ok(entryStart > start, '缺少 1.21.0 更新日志');
  assert.ok(entryStart < app.indexOf("{v:'1.20.0'", start), '1.21.0 不在更新日志顶部');
  const entry = /\{v:'1\.21\.0',d:'11-01',items:\[([\s\S]*?)\]\}/u.exec(app)?.[1] || '';
  for (const keyword of ['语义', '读屏', '轻量端']) assert.ok(entry.includes(keyword), '更新日志缺少 ' + keyword);
});

test('用户可见代码无 Microsoft 硬编码，历史更新日志除外', () => {
  const fontless = html.replace(/--font:[^;]+;/u, '');
  assert.ok(!/Microsoft/u.test(fontless), 'index.html 仍含 Microsoft');
  const beforeLog = app.slice(0, app.indexOf('var CHANGELOG='));
  assert.ok(!/Microsoft/u.test(beforeLog), 'app.js 更新日志前仍含 Microsoft');
  assert.ok(app.slice(app.indexOf('var CHANGELOG=')).includes('Microsoft'), '历史更新日志应保留原文');
});
