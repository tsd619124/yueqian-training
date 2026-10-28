import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildRelease, sha256, writeRelease } from './lib.mjs';
import { prepareSearchWorker } from './search-runtime.mjs';
import { retainPrevious } from './production.mjs';

const registry = JSON.parse(await fs.readFile(new URL('./sources.json', import.meta.url)));
const topics = JSON.parse(await fs.readFile(new URL('./topics.json', import.meta.url)));
await import('../yueqian-training/external-snapshot.js');
const original = buildRelease(globalThis.YUEQIAN_EXTERNAL_SEED, registry, topics);
const pointer = release => ({ schemaVersion: 1, releaseID: release.releaseID, manifestPath: `releases/${release.releaseID}/manifest.json`, manifestSha256: sha256(release.files.get('manifest.json')) });
async function temporary(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-production-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeRelease(directory, original);
  return directory;
}

test('首次上线仅登记真实当前发布，不伪造上一版', async context => {
  const directory = await temporary(context);
  const history = await retainPrevious(directory, null);
  assert.deepEqual(history, [pointer(original)]);
});

test('保留已校验的上一发布，并拒绝哈希损坏文件', async context => {
  const directory = await temporary(context);
  const snapshot = structuredClone(globalThis.YUEQIAN_EXTERNAL_SEED);
  snapshot.revision = 'a'.repeat(40);
  const previous = buildRelease(snapshot, registry, topics);
  let broken = false;
  context.mock.method(globalThis, 'fetch', async address => {
    const pathname = new URL(address).pathname;
    if (pathname.endsWith('/latest.json')) return Response.json(pointer(previous));
    const file = pathname.split('/' + previous.releaseID + '/')[1];
    return new Response(broken && file !== 'manifest.json' ? 'corrupt' : previous.files.get(file));
  });
  const history = await retainPrevious(directory, 'https://example.test/');
  assert.equal(history.length, 2);
  assert.deepEqual(await fs.readFile(path.join(directory, previous.manifestPath || pointer(previous).manifestPath)), previous.files.get('manifest.json'));
  const invalidDirectory = await temporary(context);
  broken = true;
  await assert.rejects(retainPrevious(invalidDirectory, 'https://example.test/'), /校验失败/);
  assert.equal(JSON.parse(await fs.readFile(path.join(invalidDirectory, 'latest.json'))).releaseID, original.releaseID);
});

test('Worker 来源刷新失败保留内置检索，且一小时内不反复请求', async context => {
  const directory = await temporary(context);
  const prepared = await prepareSearchWorker(directory);
  const worker = await import(pathToFileURL(path.join(prepared.directory, 'worker.mjs')));
  const content = JSON.parse(await fs.readFile(path.join(prepared.directory, 'search-bundle.json')));
  let requests = 0;
  const live = worker.createLiveWorker(content, { fetcher: async () => { requests++; return new Response('bad', { status: 503 }); } });
  const environment = { DISCOVERY_URL: 'https://example.test/discovery.json', ALLOWED_ORIGIN: 'https://app.test' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await live.fetch(new Request('https://worker.test/api/search?q=RAG'), environment);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).library.results.length > 0);
  }
  assert.equal(requests, 1);
  const health = await (await live.fetch(new Request('https://worker.test/health'), environment)).json();
  assert.equal(health.discoveryStatus, 'retained-after-refresh-failure');
});

test('Worker 静态备用资料走资产绑定，库内搜索不读取远端目录', async context => {
  const directory = await temporary(context);
  const prepared = await prepareSearchWorker(directory);
  const worker = await import(pathToFileURL(path.join(prepared.directory, 'worker.mjs')));
  const content = JSON.parse(await fs.readFile(path.join(prepared.directory, 'search-bundle.json')));
  const live = worker.createLiveWorker(content, { fetcher: async () => { throw new Error('不应联网'); } });
  const environment = { DISCOVERY_URL: 'https://example.test/discovery.json', ASSETS: { fetch: async () => new Response('static-content') } };
  assert.equal(await (await live.fetch(new Request('https://worker.test/content-library/latest.json'), environment)).text(), 'static-content');
  const response = await live.fetch(new Request('https://worker.test/api/search?q=RAG&scope=library'), environment);
  assert.ok((await response.json()).library.results.length > 0);
});
