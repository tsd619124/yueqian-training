import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLibrarySnapshot } from '../../content-pipeline/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'yueqian-training');
await import(path.join(web, 'external-catalog.js'));
await import(path.join(web, 'external-materials.js'));
const catalog = globalThis.YUEQIAN_EXTERNAL_CATALOG;
// base64 快照已退役：由随包资料库还原同一结构，用于校验下载与排版逻辑。
const snapshot = await readLibrarySnapshot();
const materials = globalThis.YueqianMaterials;
const revision = 'a'.repeat(40);
const results = [];
async function check(name, run) { await run(); results.push(name); }

await check('资料库完整原文与 49 张原图通过原文目录校验', async () => {
  await materials.validateSnapshot(snapshot, catalog);
  assert.equal(snapshot.articles.length, 10);
  assert.equal(snapshot.articles.flatMap(article => article.images).length, 49);
  for (const article of snapshot.articles) {
    const rendered = materials.renderMarkdown(snapshot, article);
    assert.ok((rendered.html.match(/<img /g) || []).length >= article.images.length, article.id + ' 的配图未完整排版');
  }
});

await check('未变化时仅检查一次公开版本，不发送学习数据', async () => {
  const requests = [];
  const result = await materials.downloadSnapshot(catalog, snapshot, async (url, options) => {
    requests.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined);
    return new Response(JSON.stringify({ object: { sha: snapshot.revision } }));
  });
  assert.equal(result, snapshot);
  assert.equal(requests.length, 1);
});

function fixtureFetch(url) {
  if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify({ object: { sha: revision } }));
  assert.ok(url.startsWith('https://raw.githubusercontent.com/' + catalog.repository + '/' + revision + '/'));
  const sourcePath = url.split('/' + revision + '/')[1];
  if (sourcePath === 'LICENSE') return new Response(snapshot.licenseText);
  const article = snapshot.articles.find(item => item.path === sourcePath);
  if (article) return new Response(article.markdown);
  const image = snapshot.articles.flatMap(item => item.images).find(item => item.path === sourcePath);
  return image ? new Response(Buffer.from(image.data, 'base64')) : new Response('missing', { status: 404 });
}

await check('跨版本完整下载原文与原图，保持源文哈希', async () => {
  const next = await materials.downloadSnapshot(catalog, snapshot, fixtureFetch);
  assert.equal(next.revision, revision);
  assert.deepEqual(next.articles.map(article => article.sha256), snapshot.articles.map(article => article.sha256));
  assert.deepEqual(next.articles.flatMap(article => article.images).map(image => image.sha256), snapshot.articles.flatMap(article => article.images).map(image => image.sha256));
});

await check('图片中途失败时拒绝新版本', async () => {
  await assert.rejects(materials.downloadSnapshot(catalog, snapshot, url => url.endsWith('.webp') ? new Response('missing', { status: 404 }) : fixtureFetch(url)), /HTTP 404/);
  assert.equal(snapshot.revision, (await readLibrarySnapshot()).revision);
});

await check('授权变化、缺失图片、错误哈希与未审核来源阻断', async () => {
  await assert.rejects(materials.downloadSnapshot(catalog, snapshot, url => url.endsWith('/LICENSE') ? new Response('All rights reserved') : fixtureFetch(url)), /授权已变化/);
  const invalid = structuredClone(snapshot);
  invalid.articles[0].images.pop();
  await assert.rejects(materials.validateSnapshot(invalid, catalog), /未下载完整/);
  invalid.articles = structuredClone(snapshot.articles);
  invalid.articles[0].markdown += '修改';
  await assert.rejects(materials.validateSnapshot(invalid, catalog), /缓存校验失败/);
  assert.throws(() => materials.imageReferences('![不可信](https://example.com/image.png)', catalog.articles[0].path, snapshot.revision), /尚未审核/);
});

await check('原文安全排版：原图用资料库地址并带尺寸，保留代码，文本不执行', async () => {
  const article = snapshot.articles.find(item => item.id === 'ms-rag');
  const linked = { ...article, images: article.images.map(image => ({ path: image.path, alt: image.alt, mimeType: image.mimeType, sha256: image.sha256, width: 640, height: 480, src: 'https://library.example/content/releases/x/assets/' + image.sha256 + '.webp' })) };
  const rendered = materials.renderMarkdown(snapshot, linked);
  assert.equal((rendered.html.match(/<img /g) || []).length, article.images.length);
  assert.ok(!rendered.html.includes('data:image/'));
  assert.ok(rendered.html.includes('src="https://library.example/content/releases/x/assets/') && rendered.html.includes('width="640" height="480" loading="lazy" decoding="async"'));
  assert.ok(!rendered.html.includes('lesson-banner'));
  assert.ok(rendered.html.includes('Co-op Translator'));
  const unsafe = { ...article, markdown: '<script>alert(1)</script>\n[不执行](javascript:alert)\n```html\n<img src=x onerror=alert(1)>\n```' };
  const html = materials.renderMarkdown(snapshot, unsafe).html;
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

console.log(JSON.stringify({ passed: results.length, checks: results }, null, 2));
