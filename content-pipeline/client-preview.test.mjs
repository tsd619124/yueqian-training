import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRelease, readLibrarySnapshot, writeRelease } from './lib.mjs';
import { startClientPreview } from './client-preview.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(await fs.readFile(path.join(directory, 'sources.json'), 'utf8'));
const topics = JSON.parse(await fs.readFile(path.join(directory, 'topics.json'), 'utf8'));
const snapshot = await readLibrarySnapshot();
const bundle = buildRelease(snapshot, registry, topics);

async function fixture(context) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-client-preview-'));
  const output = path.join(temporary, 'output');
  const web = path.join(temporary, 'web');
  await fs.mkdir(web);
  await writeRelease(output, bundle);
  await fs.writeFile(path.join(web, 'index.html'), '<!doctype html><title>隔离预览</title>');
  await fs.writeFile(path.join(web, 'materials.html'), '<!doctype html><title>原文与配图</title>');
  await fs.writeFile(path.join(web, 'reader.js'), 'globalThis.previewFixture = true;\n');
  let externalRequests = 0;
  const runtime = await startClientPreview(output, {
    webDirectory: web,
    port: 0,
    fetcher: async () => { externalRequests++; throw new Error('测试禁止外网请求'); }
  });
  context.after(async () => { await runtime.close(); await fs.rm(temporary, { recursive: true, force: true }); });
  return { ...runtime, temporary, output, web, externalRequests: () => externalRequests };
}

function request(url, target, method = 'GET') {
  const endpoint = new URL(url);
  return new Promise((resolve, reject) => {
    const operation = http.request({ hostname: endpoint.hostname, port: endpoint.port, path: target, method, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    operation.on('error', reject);
    operation.end();
  });
}

test('同源预览仅监听本机，返回静态入口与资源 MIME、禁缓存和 HEAD', async context => {
  const runtime = await fixture(context);
  assert.equal(runtime.server.address().address, '127.0.0.1');
  const home = await request(runtime.url, '/');
  assert.equal(home.status, 200);
  assert.equal(home.body, '<!doctype html><title>隔离预览</title>');
  assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(home.headers['cache-control'], 'no-store');
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  const reader = await request(runtime.url, '/materials.html?article=ms-rag');
  assert.equal(reader.status, 200);
  assert.ok(reader.body.includes('原文与配图'));
  const script = await request(runtime.url, '/reader.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  const head = await request(runtime.url, '/reader.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-type'], script.headers['content-type']);
  assert.equal(head.body, '');
  assert.equal(runtime.externalRequests(), 0);
});

test('真实 HTTP 连接复用正式库内检索与健康接口，不访问外网', async context => {
  const runtime = await fixture(context);
  const response = await request(runtime.url, '/api/search?' + new URLSearchParams({ q: '向量数据库', scope: 'library', limit: '10' }));
  assert.equal(response.status, 200);
  const result = JSON.parse(response.body);
  assert.ok(result.library.results.length > 0);
  assert.equal(result.library.results[0].kind, 'library');
  assert.equal(result.library.results[0].reviewStatus, 'approved');
  assert.equal(result.external.status, 'not-requested');
  assert.ok(result.library.results[0].url.startsWith('https://github.com/' + snapshot.repository + '/blob/' + snapshot.revision + '/'));
  const health = await request(runtime.url, '/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).documents, 10);
  assert.equal((await request(runtime.url, '/api/search?q=x&limit=0')).status, 400);
  assert.equal(runtime.externalRequests(), 0);
});

test('静态资源与搜索均拒绝不支持的方法，缺失文件和目录返回 404', async context => {
  const runtime = await fixture(context);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await request(runtime.url, '/materials.html', method);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'GET, HEAD');
  }
  assert.equal((await request(runtime.url, '/api/search?q=RAG', 'POST')).status, 405);
  const missing = await request(runtime.url, '/missing.html');
  assert.equal(missing.status, 404);
  assert.equal(missing.body, 'Not found');
  assert.equal(missing.headers['cache-control'], 'no-store');
  await fs.mkdir(path.join(runtime.web, 'directory'));
  assert.equal((await request(runtime.url, '/directory/')).status, 404);
  assert.equal((await request(runtime.url, '/directory')).status, 404);
  assert.equal(runtime.externalRequests(), 0);
});

test('隐藏文件、隐藏目录和解码异常均不能通过静态入口读取', async context => {
  const runtime = await fixture(context);
  await fs.writeFile(path.join(runtime.web, '.private'), 'hidden-fixture');
  await fs.mkdir(path.join(runtime.web, '.private-directory'));
  await fs.writeFile(path.join(runtime.web, '.private-directory', 'note.txt'), 'hidden-fixture');
  for (const target of ['/.private', '/%2eprivate', '/.private-directory/note.txt', '/%2eprivate-directory/note.txt', '/%E0%A4%A', '/reader.js%00']) {
    const response = await request(runtime.url, target);
    assert.equal(response.status, 404, target);
    assert.ok(!response.body.includes('hidden-fixture'), target);
  }
});

test('原始 HTTP 路径中的越界与编码穿越不能读取静态根目录之外文件', async context => {
  const runtime = await fixture(context);
  await fs.writeFile(path.join(runtime.temporary, 'outside.txt'), 'outside-private-fixture');
  for (const target of ['/../outside.txt', '/%2e%2e/outside.txt', '/%2e%2e%2foutside.txt', '/nested%2f..%2f..%2foutside.txt', '/..%5coutside.txt', '//../outside.txt']) {
    const response = await request(runtime.url, target);
    assert.equal(response.status, 404, target);
    assert.ok(!response.body.includes('outside-private-fixture'), target);
  }
});

test('文件和目录软链接不能逃出静态根目录，前缀相似目录也不被接收', async context => {
  const runtime = await fixture(context);
  const outside = path.join(runtime.temporary, 'web-other');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'note.txt'), 'symlink-private-fixture');
  await fs.symlink(path.join(outside, 'note.txt'), path.join(runtime.web, 'outside-file.txt'));
  await fs.symlink(outside, path.join(runtime.web, 'outside-directory'));
  for (const target of ['/outside-file.txt', '/outside-directory/note.txt']) {
    const response = await request(runtime.url, target);
    assert.equal(response.status, 404, target);
    assert.ok(!response.body.includes('symlink-private-fixture'), target);
  }
});
