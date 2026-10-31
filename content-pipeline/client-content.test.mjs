import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRelease, readLibrarySnapshot, writeRelease } from './lib.mjs';
import { exportClientContent } from './client-content.mjs';

const registry = JSON.parse(await fs.readFile(new URL('./sources.json', import.meta.url)));
const topics = JSON.parse(await fs.readFile(new URL('./topics.json', import.meta.url)));
const seedSnapshot = await readLibrarySnapshot();

async function tree(directory, prefix = '') {
  const found = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...await tree(directory, prefix + entry.name + '/'));
    else found.push(prefix + entry.name);
  }
  return found.sort();
}

async function environment(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-client-content-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'pipeline');
  const options = { webDirectory: path.join(directory, 'web'), nativeLibraryDirectory: path.join(directory, 'native/ContentLibrary') };
  const bundle = buildRelease(seedSnapshot, registry, topics);
  await writeRelease(output, bundle);
  return { directory, output, options, bundle };
}

test('iOS ContentLibrary 与 Web content-library 逐字节相同，原图为独立文件，不生成 base64 种子', async context => {
  const { output, options, bundle } = await environment(context);
  const result = await exportClientContent(output, options);
  assert.equal(result.documents, 15);
  assert.equal(result.images, 58);
  const library = path.join(options.webDirectory, 'content-library');
  const webFiles = (await tree(library)).filter(name => name !== '.generated.json');
  assert.deepEqual(await tree(options.nativeLibraryDirectory), webFiles);
  for (const name of webFiles) assert.deepEqual(await fs.readFile(path.join(options.nativeLibraryDirectory, name)), await fs.readFile(path.join(library, name)));
  assert.equal(webFiles.length, bundle.manifest.files.length + 2);
  assert.equal(webFiles.filter(name => name.includes('/assets/')).length, 58);
  const document = JSON.parse(await fs.readFile(path.join(library, 'releases', bundle.releaseID, 'documents/ms-rag.json')));
  assert.ok(document.images.every(image => Number.isInteger(image.width) && Number.isInteger(image.height) && image.width > 0));
  await assert.rejects(fs.access(path.join(options.webDirectory, 'content-release-seed.js')));
  await exportClientContent(output, { ...options, check: true });
  await fs.writeFile(path.join(options.nativeLibraryDirectory, 'extra.json'), '{}');
  await assert.rejects(exportClientContent(output, { ...options, check: true }), /文件集合不同/u);
  await fs.rm(path.join(options.nativeLibraryDirectory, 'extra.json'));
  await fs.writeFile(path.join(options.nativeLibraryDirectory, 'latest.json'), '{}');
  await assert.rejects(exportClientContent(output, { ...options, check: true }), /与 Web 不一致/u);
});

test('由资料库还原的快照重建得到同一版本（资料库即唯一来源）', async () => {
  const bundle = buildRelease(seedSnapshot, registry, topics);
  const latest = JSON.parse(await fs.readFile(new URL('../yueqian-training/content-library/latest.json', import.meta.url)));
  assert.equal(bundle.releaseID, latest.releaseID);
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
  const nativePointer = path.join(options.nativeLibraryDirectory, 'latest.json');
  const before = await fs.readFile(nativePointer);
  await fs.writeFile(path.join(output, 'releases', bundle.releaseID, 'index.json'), '{}');
  await assert.rejects(exportClientContent(output, options), /校验失败/u);
  assert.deepEqual(await fs.readFile(nativePointer), before);
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
