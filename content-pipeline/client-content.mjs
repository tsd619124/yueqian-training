import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256, verifyLatest, writeAtomicJSON } from './lib.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}

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

export async function exportClientContent(output, { webDirectory, nativeSeedPath, check = false }) {
  const manifest = await verifyLatest(output);
  const latestBytes = await fs.readFile(path.join(output, 'latest.json'));
  const latest = JSON.parse(latestBytes);
  const releaseDirectory = path.join(output, 'releases', manifest.releaseID);
  const manifestBytes = await fs.readFile(path.join(releaseDirectory, 'manifest.json'));
  const files = new Map([['latest.json', latestBytes], [latest.manifestPath, manifestBytes]]);
  const seedFiles = {};
  for (const record of manifest.files) {
    const bytes = await fs.readFile(path.join(releaseDirectory, record.path));
    files.set(`releases/${manifest.releaseID}/${record.path}`, bytes);
    if (!record.path.startsWith('assets/')) seedFiles[record.path] = bytes.toString('base64');
  }
  const seed = { schemaVersion: 1, latest, manifestBase64: manifestBytes.toString('base64'), files: seedFiles };
  const seedJSON = JSON.stringify(canonical(seed)) + '\n';
  const seedScript = 'globalThis.YUEQIAN_CONTENT_RELEASE = ' + seedJSON.trimEnd().replace(/</gu, '\\u003c') + ';\n';
  const libraryDirectory = path.join(webDirectory, 'content-library');
  const webSeedPath = path.join(webDirectory, 'content-release-seed.js');
  if (check) {
    for (const [name, expected] of files) if (!(await existing(path.join(libraryDirectory, name)))?.equals(expected)) throw new Error('客户端资料文件缺失或不同步：' + name);
    if (!(await existing(nativeSeedPath))?.equals(Buffer.from(seedJSON)) || !(await existing(webSeedPath))?.equals(Buffer.from(seedScript))) throw new Error('Web 与 iOS 发布清单种子不同步。');
    await verifyGenerated(libraryDirectory);
  } else {
    await fs.mkdir(webDirectory, { recursive: true });
    await fs.mkdir(path.dirname(nativeSeedPath), { recursive: true });
    const staging = await fs.mkdtemp(path.join(webDirectory, '.content-library-'));
    let backup = null;
    try {
      for (const [name, bytes] of files) {
        await fs.mkdir(path.dirname(path.join(staging, name)), { recursive: true });
        await fs.writeFile(path.join(staging, name), bytes, { flag: 'wx' });
      }
      await writeAtomicJSON(path.join(staging, '.generated.json'), { schemaVersion: 1, releaseID: manifest.releaseID, files: [...files].map(([filePath, bytes]) => ({ path: filePath, sha256: sha256(bytes) })) });
      try {
        await fs.access(libraryDirectory);
        await verifyGenerated(libraryDirectory);
        backup = libraryDirectory + '.previous-' + crypto.randomUUID();
        await fs.rename(libraryDirectory, backup);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await fs.rename(staging, libraryDirectory); }
      catch (error) { if (backup) { await fs.rename(backup, libraryDirectory); backup = null; } throw error; }
      if (backup) await fs.rm(backup, { recursive: true, force: true });
      await writeAtomicJSON(nativeSeedPath, seed);
      const temporarySeed = webSeedPath + '.' + crypto.randomUUID() + '.tmp';
      try { await fs.writeFile(temporarySeed, seedScript, { flag: 'wx' }); await fs.rename(temporarySeed, webSeedPath); }
      finally { await fs.rm(temporarySeed, { force: true }); }
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  return { status: check ? '客户端共用资料校验通过' : '客户端共用资料已生成，未部署', releaseID: manifest.releaseID, documents: manifest.documents.length, images: manifest.assetCount, files: files.size, seedBytes: Buffer.byteLength(seedJSON), libraryDirectory, nativeSeedPath };
}
