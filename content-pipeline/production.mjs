import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, verifyLatest, writeAtomicJSON } from './lib.mjs';

export const webFiles = ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-180.png', 'sync-config.js', 'training-receipt.png', 'training-receipt-obscured.png', 'materials.html', 'external-catalog.js', 'external-snapshot.js', 'content-release-seed.js', 'material-services.js', 'content-release.js', 'material-search.js', 'external-materials.js', 'external-materials.css', 'THIRD_PARTY_NOTICES.txt', '使用说明-手机同步与部署.md'];

async function readRemote(url, maximum = 20971520, optional = false) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000), cache: 'no-store' });
  if (optional && response.status === 404) return null;
  if (!response.ok || !response.body) throw new Error('线上文件不可读取：' + url);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximum) throw new Error('线上文件超过上限。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validPointer(pointer) {
  return pointer?.schemaVersion === 1 && /^[a-f0-9]{64}$/u.test(pointer.releaseID) && pointer.manifestPath === `releases/${pointer.releaseID}/manifest.json` && /^[a-f0-9]{64}$/u.test(pointer.manifestSha256);
}

export async function retainPrevious(library, previousURL) {
  const current = JSON.parse(await fs.readFile(path.join(library, 'latest.json')));
  const history = [current];
  if (previousURL) {
    const base = new URL(previousURL);
    if (base.protocol !== 'https:') throw new Error('旧发布地址必须是 HTTPS。');
    const raw = await readRemote(new URL('content-library/latest.json', base), 16384, true);
    if (raw) {
      let previous = JSON.parse(raw);
      if (!validPointer(previous)) throw new Error('旧发布指针无效。');
      if (previous.releaseID === current.releaseID) {
        const historyBytes = await readRemote(new URL('content-library/release-history.json', base), 16384, true);
        previous = historyBytes ? JSON.parse(historyBytes).releases?.find(item => item.releaseID !== current.releaseID) : null;
      }
      if (previous) {
        if (!validPointer(previous)) throw new Error('回滚指针无效。');
        const manifestBytes = await readRemote(new URL('content-library/' + previous.manifestPath, base), 1048576);
        if (sha256(manifestBytes) !== previous.manifestSha256) throw new Error('旧发布清单校验失败。');
        const manifest = JSON.parse(manifestBytes);
        if (manifest.releaseID !== previous.releaseID || !Array.isArray(manifest.files) || manifest.files.length > 500) throw new Error('旧发布文件数或版本无效。');
        let total = 0;
        const destination = path.join(library, 'releases', previous.releaseID);
        for (const file of manifest.files) {
          if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') || !Number.isInteger(file.bytes) || file.bytes <= 0) throw new Error('旧发布文件路径或长度无效。');
          total += file.bytes;
          if (total > 20971520) throw new Error('旧发布超过 20 MiB。');
          const bytes = await readRemote(new URL('content-library/releases/' + previous.releaseID + '/' + file.path, base), file.bytes);
          if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('旧发布文件校验失败。');
          await fs.mkdir(path.dirname(path.join(destination, file.path)), { recursive: true });
          await fs.writeFile(path.join(destination, file.path), bytes, { flag: 'wx' });
        }
        await fs.writeFile(path.join(destination, 'manifest.json'), manifestBytes, { flag: 'wx' });
        history.push(previous);
      }
    }
  }
  await writeAtomicJSON(path.join(library, 'release-history.json'), { schemaVersion: 1, releases: history });
  return history;
}

export async function prepareSite(root, destination, previousURL = null) {
  const web = path.join(root, 'yueqian-training');
  await verifyLatest(path.join(web, 'content-library'));
  await fs.mkdir(destination, { recursive: true });
  if ((await fs.readdir(destination)).length) throw new Error('发布暂存目录必须为空。');
  for (const file of webFiles) await fs.copyFile(path.join(web, file), path.join(destination, file));
  const sync = await fs.readFile(path.join(web, 'sync-config.js'), 'utf8');
  if (sync.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '').trim()) throw new Error('同步配置不是空凭据模板。');
  await fs.cp(path.join(web, 'content-library'), path.join(destination, 'content-library'), { recursive: true, filter: source => path.basename(source) !== '.generated.json' });
  const history = await retainPrevious(path.join(destination, 'content-library'), previousURL);
  await fs.copyFile(path.join(root, 'output/content-pipeline/discovery.json'), path.join(destination, 'content-discovery.json'));
  const records = [];
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), prefix + entry.name + '/');
      else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(directory, entry.name));
        records.push({ path: prefix + entry.name, bytes: bytes.length, sha256: sha256(bytes) });
      } else throw new Error('发布目录不允许符号链接。');
    }
  }
  await visit(destination);
  const report = { schemaVersion: 1, webVersion: '1.14.0', cache: 'yueqian-v16', contentRelease: history[0].releaseID, retainedReleases: history.map(item => item.releaseID), files: records.sort((left, right) => left.path.localeCompare(right.path)) };
  await writeAtomicJSON(path.join(destination, 'release-manifest.json'), report);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.length < 3 || process.argv.length > 4) throw new Error('用法：node content-pipeline/production.mjs <空发布目录> [现有站点 HTTPS 地址]');
  const report = await prepareSite(root, path.resolve(process.argv[2]), process.argv[3]);
  console.log(JSON.stringify({ ...report, files: report.files.length }, null, 2));
}
