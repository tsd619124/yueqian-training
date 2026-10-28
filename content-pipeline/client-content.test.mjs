import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { buildRelease, writeRelease, sha256 } from './lib.mjs';
import { exportClientContent } from './client-content.mjs';

await import('../yueqian-training/external-snapshot.js');
const registry = JSON.parse(await fs.readFile(new URL('./sources.json', import.meta.url)));
const topics = JSON.parse(await fs.readFile(new URL('./topics.json', import.meta.url)));
const seedSnapshot = globalThis.YUEQIAN_EXTERNAL_SEED;

async function environment(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-client-content-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'pipeline');
  const options = { webDirectory: path.join(directory, 'web'), nativeSeedPath: path.join(directory, 'native/content-release.json') };
  const bundle = buildRelease(seedSnapshot, registry, topics);
  await writeRelease(output, bundle);
  return { directory, output, options, bundle };
}

test('Web 与原生使用完全相同的清单，原图由既有种子复用而非重复编码', async context => {
  const { output, options, bundle } = await environment(context);
  const result = await exportClientContent(output, options);
  assert.equal(result.documents, 10);
  assert.equal(result.images, 49);
  const native = JSON.parse(await fs.readFile(options.nativeSeedPath));
  const sandbox = {};
  vm.runInNewContext(await fs.readFile(path.join(options.webDirectory, 'content-release-seed.js'), 'utf8'), sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.YUEQIAN_CONTENT_RELEASE)), native);
  assert.equal(sha256(Buffer.from(native.manifestBase64, 'base64')), native.latest.manifestSha256);
  const imageHashes = new Set(seedSnapshot.articles.flatMap(article => article.images.map(image => image.sha256)));
  for (const record of bundle.manifest.files) {
    if (record.path.startsWith('assets/')) { assert.ok(imageHashes.has(record.sha256)); assert.equal(native.files[record.path], undefined); }
    else assert.equal(sha256(Buffer.from(native.files[record.path], 'base64')), record.sha256);
  }
  await exportClientContent(output, { ...options, check: true });
});

test('重复生成不变版本，不修改正式发布指针', async context => {
  const { output, options } = await environment(context);
  const before = await fs.readFile(path.join(output, 'latest.json'));
  const first = await exportClientContent(output, options);
  const second = await exportClientContent(output, options);
  assert.equal(first.releaseID, second.releaseID);
  assert.deepEqual(await fs.readFile(path.join(output, 'latest.json')), before);
});

test('发布包损坏时拒绝导出，不覆盖先前有效客户端资料', async context => {
  const { output, options, bundle } = await environment(context);
  await exportClientContent(output, options);
  const before = await fs.readFile(options.nativeSeedPath);
  await fs.writeFile(path.join(output, 'releases', bundle.releaseID, 'index.json'), '{}');
  await assert.rejects(exportClientContent(output, options), /校验失败/u);
  assert.deepEqual(await fs.readFile(options.nativeSeedPath), before);
});

test('生成目录含人工改动时保留并拒绝覆盖，check能发现不同步', async context => {
  const { output, options } = await environment(context);
  await exportClientContent(output, options);
  const pointer = path.join(options.webDirectory, 'content-library/latest.json');
  await fs.writeFile(pointer, 'manual edit');
  await assert.rejects(exportClientContent(output, options), /人工修改/u);
  await assert.rejects(exportClientContent(output, { ...options, check: true }), /不同步/u);
  assert.equal(await fs.readFile(pointer, 'utf8'), 'manual edit');
});
