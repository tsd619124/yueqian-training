import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildRelease, readLibrarySnapshot, writeRelease } from './lib.mjs';
import { createFileCache, loadSearchBundle, prepareSearchWorker, startSearchServer } from './search-runtime.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(await fs.readFile(path.join(directory, 'sources.json'), 'utf8'));
const topics = JSON.parse(await fs.readFile(path.join(directory, 'topics.json'), 'utf8'));
const bundledSnapshot = await readLibrarySnapshot();
const bundle = buildRelease(bundledSnapshot, registry, topics);

async function temporaryOutput(context) {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-search-runtime-'));
  context.after(() => fs.rm(output, { recursive: true, force: true }));
  await writeRelease(output, bundle);
  return output;
}

test('内容包完整校验已核准索引，候选目录缺失不影响正式资料', async context => {
  const output = await temporaryOutput(context);
  const content = await loadSearchBundle(output);
  assert.equal(content.releaseID, bundle.releaseID);
  assert.equal(content.index.documents.length, 10);
  assert.equal(content.sources[0].revision, bundledSnapshot.revision);
  assert.equal(content.discovery, null);
  assert.equal((await loadSearchBundle(output)).bundleID, content.bundleID);
});

test('已核准索引损坏阻止启动，候选目录损坏只限制外部查询', async context => {
  const output = await temporaryOutput(context);
  await fs.writeFile(path.join(output, 'discovery.json'), '{broken');
  assert.equal((await loadSearchBundle(output)).discoveryWarning, 'invalid-discovery-file');
  await fs.writeFile(path.join(output, 'releases', bundle.releaseID, 'index.json'), '{}');
  await assert.rejects(loadSearchBundle(output), /校验失败/);
});

test('本机 HTTP 返回中文命中、固定版本出处及健康信息', async context => {
  const output = await temporaryOutput(context);
  let externalRequests = 0;
  const runtime = await startSearchServer(output, { port: 0, fetcher: async () => { externalRequests++; throw new Error('unexpected'); } });
  context.after(runtime.close);
  const response = await fetch(runtime.url + '/api/search?' + new URLSearchParams({ q: '向量数据库', scope: 'library' }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.ok(result.library.results.length > 0);
  assert.equal(result.library.results[0].reviewStatus, 'approved');
  assert.ok(result.library.results[0].url.includes('/blob/' + bundledSnapshot.revision + '/'));
  assert.equal(externalRequests, 0);
  assert.equal((await (await fetch(runtime.url + '/health')).json()).documents, 10);
  assert.equal((await fetch(runtime.url + '/api/search?q=x&limit=0')).status, 400);
  assert.equal((await fetch(runtime.url + '/api/search?q=x', { method: 'POST' })).status, 405);
  assert.equal((await fetch(runtime.url + '/')).status, 404);
});

test('本机服务不信任转发 IP，跨域仅放行指定 origin', async context => {
  const output = await temporaryOutput(context);
  const runtime = await startSearchServer(output, { port: 0, allowedOrigin: 'https://example.test', limits: { requestsPerClient: 1 } });
  context.after(runtime.close);
  const url = runtime.url + '/api/search?q=RAG&scope=library';
  const first = await fetch(url, { headers: { origin: 'https://example.test', 'x-forwarded-for': '192.0.2.1', 'cf-connecting-ip': '192.0.2.1' } });
  assert.equal(first.headers.get('access-control-allow-origin'), 'https://example.test');
  assert.equal((await first.json()).reason, null);
  const second = await fetch(url, { headers: { origin: 'https://other.test', 'x-forwarded-for': '192.0.2.2', 'cf-connecting-ip': '192.0.2.2' } });
  assert.equal(second.headers.get('access-control-allow-origin'), null);
  assert.equal((await second.json()).reason, 'rate-limited');
  assert.equal((await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://example.test' } })).status, 204);
});

test('查询缓存可跨服务重启恢复，损坏缓存丢弃并限制条目', async context => {
  const output = await temporaryOutput(context);
  const cachePath = path.join(output, 'search', 'cache.json');
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, 'bad json');
  const cache = await createFileCache(cachePath, 2);
  assert.equal(await cache.get('missing'), null);
  await cache.put('one', { createdAt: 1, value: { status: 'ok', results: [] } });
  await cache.put('two', { createdAt: 2, value: { status: 'ok', results: [] } });
  await cache.put('three', { createdAt: 3, value: { status: 'ok', results: [] } });
  const restored = await createFileCache(cachePath, 2);
  assert.equal(await restored.get('one'), null);
  assert.equal((await restored.get('three')).createdAt, 3);
  await assert.rejects(restored.put('large', { createdAt: 4, value: 'x'.repeat(131073) }), /超出上限/);
});

test('准备后的 Workers 工程独立可导入并支持 Request 查询', async context => {
  const output = await temporaryOutput(context);
  const pointer = await fs.readFile(path.join(output, 'latest.json'), 'utf8');
  const prepared = await prepareSearchWorker(output);
  assert.equal(prepared.status, 'prepared-not-deployed');
  assert.equal(prepared.directory, path.join(output, 'search-worker'));
  const worker = await import(pathToFileURL(path.join(prepared.directory, 'worker.mjs')));
  const response = await worker.default.fetch(new Request('https://search.example/api/search?q=RAG&scope=library'));
  assert.equal(response.status, 200);
  assert.ok((await response.json()).library.results.length > 0);
  assert.equal(await fs.readFile(path.join(output, 'latest.json'), 'utf8'), pointer);
  const config = JSON.parse(await fs.readFile(path.join(prepared.directory, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.main, 'worker.mjs');
  assert.equal(config.account_id, undefined);
  assert.equal(config.kv_namespaces, undefined);
});

test('Worker Request 适配与显式跨域沿用统一接口，缓存不可用时正常返回', async context => {
  const output = await temporaryOutput(context);
  const prepared = await prepareSearchWorker(output);
  const worker = await import(pathToFileURL(path.join(prepared.directory, 'worker.mjs')));
  const content = await loadSearchBundle(output);
  const handler = worker.createWorkerHandler(content, {
    allowedOrigin: 'https://app.example',
    cacheStorage: { default: { async match() { throw new Error('unavailable'); }, async put() { throw new Error('unavailable'); } } }
  });
  const response = await handler(new Request('https://search.example/api/search?q=RAG', { headers: { origin: 'https://app.example', 'cf-connecting-ip': '192.0.2.1' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example');
  const result = await response.json();
  assert.ok(result.library.results.length > 0);
  assert.equal(result.external.status, 'unavailable');
  assert.equal(result.degraded, true);
});

test('重复准备可重建生成目录，人工修改及额外文件不会被覆盖', async context => {
  const output = await temporaryOutput(context);
  const prepared = await prepareSearchWorker(output);
  assert.equal((await prepareSearchWorker(output)).bundleID, prepared.bundleID);
  await fs.writeFile(path.join(prepared.directory, 'notes.txt'), 'keep this');
  await assert.rejects(prepareSearchWorker(output), /未登记文件/);
  assert.equal(await fs.readFile(path.join(prepared.directory, 'notes.txt'), 'utf8'), 'keep this');
  await fs.rm(path.join(prepared.directory, 'notes.txt'));
  await fs.writeFile(path.join(prepared.directory, 'worker.mjs'), '// user edit');
  await assert.rejects(prepareSearchWorker(output), /人工修改/);
  assert.equal(await fs.readFile(path.join(prepared.directory, 'worker.mjs'), 'utf8'), '// user edit');
});

test('本机服务拒绝公开监听和无效跨域参数', async context => {
  const output = await temporaryOutput(context);
  await assert.rejects(startSearchServer(output, { host: '0.0.0.0' }), /本机地址/);
  await assert.rejects(startSearchServer(output, { allowedOrigin: '*' }), /CORS/);
});
