import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256, verifyLatest, writeAtomicJSON } from './lib.mjs';

async function existing(filePath) {
  try { return await fs.readFile(filePath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function verifyGenerated(directory) {
  const marker = JSON.parse(await fs.readFile(path.join(directory, '.generated.json'), 'utf8'));
  if (marker.schemaVersion !== 1 || !Array.isArray(marker.files)) throw new Error('资料目录未登记，保留现状。');
  const found = [];
  async function visit(folder, prefix = '') {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(folder, entry.name), name + '/');
      else if (!entry.isFile()) throw new Error('资料目录含未登记文件，保留现状。');
      else if (name !== '.generated.json') found.push(name);
    }
  }
  await visit(directory);
  if (found.length !== marker.files.length || !marker.files.every(record => found.includes(record.path) && !record.path.startsWith('/') && !record.path.split('/').includes('..'))) throw new Error('资料目录含额外文件，保留现状。');
  for (const record of marker.files) if (sha256(await fs.readFile(path.join(directory, record.path))) !== record.sha256) throw new Error('资料目录含人工修改，保留现状。');
}

async function listFiles(directory, prefix = '') {
  const found = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) found.push(...await listFiles(directory, name + '/'));
    else if (!entry.isFile()) throw new Error('资料目录不允许符号链接或特殊文件：' + name);
    else found.push(name);
  }
  return found;
}

async function writeStaged(target, files, marker) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(target), '.content-library-'));
  let backup = null;
  try {
    for (const [name, bytes] of files) {
      await fs.mkdir(path.dirname(path.join(staging, name)), { recursive: true });
      await fs.writeFile(path.join(staging, name), bytes, { flag: 'wx' });
    }
    if (marker) await writeAtomicJSON(path.join(staging, '.generated.json'), marker);
    try { await fs.access(target); backup = target + '.previous-' + crypto.randomUUID(); await fs.rename(target, backup); }
    catch (error) { if (error.code !== 'ENOENT') throw error; backup = null; }
    try { await fs.rename(staging, target); }
    catch (error) { if (backup) { await fs.rename(backup, target); backup = null; } throw error; }
    if (backup) await fs.rm(backup, { recursive: true, force: true });
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

// 生成两端共用资料库：Web 为 yueqian-training/content-library/（含 .generated.json 登记），
// iOS 为 Resources/ContentLibrary/，与 Web 逐字节相同（不含 .generated.json 与 search/）。不再生成 base64 种子。
export async function exportClientContent(output, { webDirectory, nativeLibraryDirectory, check = false }) {
  const manifest = await verifyLatest(output);
  const latestBytes = await fs.readFile(path.join(output, 'latest.json'));
  const latest = JSON.parse(latestBytes);
  const releaseDirectory = path.join(output, 'releases', manifest.releaseID);
  const manifestBytes = await fs.readFile(path.join(releaseDirectory, 'manifest.json'));
  const files = new Map([['latest.json', latestBytes], [latest.manifestPath, manifestBytes]]);
  for (const record of manifest.files) files.set(`releases/${manifest.releaseID}/${record.path}`, await fs.readFile(path.join(releaseDirectory, record.path)));
  const libraryDirectory = path.join(webDirectory, 'content-library');
  const marker = { schemaVersion: 1, releaseID: manifest.releaseID, files: [...files].map(([filePath, bytes]) => ({ path: filePath, sha256: sha256(bytes) })) };
  if (check) {
    for (const [name, expected] of files) if (!(await existing(path.join(libraryDirectory, name)))?.equals(expected)) throw new Error('客户端资料文件缺失或不同步：' + name);
    await verifyGenerated(libraryDirectory);
    if (nativeLibraryDirectory) {
      const nativeFiles = await listFiles(nativeLibraryDirectory);
      const extra = nativeFiles.filter(name => !files.has(name));
      if (extra.length || nativeFiles.length !== files.size) throw new Error('iOS ContentLibrary 与 Web 资料库文件集合不同：' + (extra[0] || '缺少文件'));
      for (const [name, expected] of files) if (!(await existing(path.join(nativeLibraryDirectory, name)))?.equals(expected)) throw new Error('iOS ContentLibrary 文件与 Web 不一致：' + name);
    }
  } else {
    try { await fs.access(libraryDirectory); await verifyGenerated(libraryDirectory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeStaged(libraryDirectory, files, marker);
    if (nativeLibraryDirectory) await writeStaged(nativeLibraryDirectory, files, null);
  }
  const bytes = [...files.values()].reduce((total, value) => total + value.length, 0);
  return { status: check ? '客户端共用资料校验通过（Web 与 iOS 逐字节一致）' : '客户端共用资料已生成，未部署', releaseID: manifest.releaseID, documents: manifest.documents.length, images: manifest.assetCount, files: files.size, bytes, libraryDirectory, nativeLibraryDirectory: nativeLibraryDirectory || null };
}
