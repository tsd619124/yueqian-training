import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, verifyLatest, writeAtomicJSON } from './lib.mjs';
import { copySearchDirectory, loadPublishedIndex, writePublishedIndex } from './search-index.mjs';

// Service Worker 之外仍需发布、但不进入预缓存的文件。
export const unprecachedWebFiles = ['sw.js', '使用说明-手机同步与部署.md'];

// Web 1.15 起课程内容拆为 content/*.json；除根目录文件外只允许这一层子目录。
function webFileName(reference) {
  const name = reference.replace(/^\.\//u, '');
  if (!name || name === '/') return 'index.html';
  const parts = name.split('/');
  if (name.includes('\\') || /[?#]/u.test(name) || parts.some(part => !part || part.startsWith('.')) || parts.length > 2 || (parts.length === 2 && parts[0] !== 'content')) throw new Error('Web 文件引用超出发布根目录：' + reference);
  return name;
}

// 显式发布的数据文件：version.json（更新检查）与 content/*.json（课程内容），存在即发布。
async function dataWebFiles(web) {
  const files = [];
  if ((await fs.stat(path.join(web, 'version.json')).catch(() => null))?.isFile()) files.push('version.json');
  for (const entry of await fs.readdir(path.join(web, 'content'), { withFileTypes: true }).catch(() => [])) if (entry.isFile() && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/u.test(entry.name)) files.push('content/' + entry.name);
  return files;
}

// 版本号与缓存名只在 index.html 和 sw.js 中维护，发布清单读取它们，避免三处手工同步。
export async function readWebRelease(web) {
  const index = await fs.readFile(path.join(web, 'index.html'), 'utf8');
  const worker = await fs.readFile(path.join(web, 'sw.js'), 'utf8');
  const webVersion = /\bvar\s+APP_VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'/u.exec(index)?.[1];
  const prefix = /\bvar\s+CACHE_PREFIX\s*=\s*'([^']+)'/u.exec(worker)?.[1];
  const cacheMatch = /\bvar\s+CACHE\s*=\s*(?:CACHE_PREFIX\s*\+\s*)?'([^']+)'/u.exec(worker);
  const assetsBlock = /\bvar\s+ASSETS\s*=\s*\[([^\]]*)\]/u.exec(worker)?.[1];
  if (!webVersion || !cacheMatch || assetsBlock === undefined) throw new Error('无法从 index.html / sw.js 读取 APP_VERSION、CACHE 或 ASSETS。');
  const cache = (/CACHE_PREFIX\s*\+/u.test(cacheMatch[0]) ? (prefix ?? '') : '') + cacheMatch[1];
  const precached = [...assetsBlock.matchAll(/'([^']*)'|"([^"]*)"/gu)].map(match => webFileName(match[1] ?? match[2]));
  const referenced = [];
  for (const page of ['index.html', 'materials.html']) {
    let html;
    try { html = await fs.readFile(path.join(web, page), 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const match of html.matchAll(/\b(?:src|href)\s*=\s*"(?:\.\/)?((?:content\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]+)"/gu)) referenced.push(match[1]);
  }
  const files = [...new Set([...precached, ...referenced, ...unprecachedWebFiles, ...await dataWebFiles(web)])].sort();
  for (const file of files) {
    const stat = await fs.stat(path.join(web, file)).catch(() => null);
    if (!stat?.isFile()) throw new Error((precached.includes(file) ? 'sw.js ASSETS 列出的文件不存在：' : '页面引用或发布文件不存在：') + file);
  }
  return { webVersion, cache, precached: [...new Set(precached)].sort(), files };
}

async function placeSearchIndex(library, builtDirectory, previousURL) {
  const destination = path.join(library, 'search');
  try {
    const copied = await copySearchDirectory(builtDirectory, destination);
    return { status: 'built', indexSha256: copied.pointer.indexSha256, documentCount: copied.pointer.documentCount, files: copied.files };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('警告：本次检索索引无效，改为保留线上版本：' + error.message);
    await fs.rm(destination, { recursive: true, force: true });
  }
  if (previousURL) {
    const { previous, warning } = await loadPublishedIndex(new URL('content-library/', previousURL).href);
    if (warning) console.warn('警告：' + warning);
    if (previous) {
      const written = await writePublishedIndex(destination, previous);
      console.warn('警告：沿用线上已发布的检索索引 ' + written.pointer.indexSha256);
      return { status: 'retained', indexSha256: written.pointer.indexSha256, documentCount: written.pointer.documentCount, files: ['latest.json', 'index-' + written.pointer.indexSha256 + '.json'] };
    }
  }
  console.warn('警告：没有可发布的检索索引；客户端保留本机缓存。');
  return { status: 'absent', indexSha256: null, documentCount: 0, files: [] };
}

// 读取部署前线上 release-manifest.json，供读回检查区分「仍是旧文件（传播延迟）」与「内容损坏」。
export async function readPublishedReport(previousURL) {
  if (!previousURL) return null;
  try {
    const bytes = await readRemote(new URL('release-manifest.json', previousURL), 1048576, true);
    const report = bytes ? JSON.parse(bytes) : null;
    return report?.schemaVersion === 1 && Array.isArray(report.files) ? report : null;
  } catch (error) {
    console.warn('警告：线上旧发布清单不可读取：' + error.message);
    return null;
  }
}

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

export async function prepareSite(root, destination, previousURL = null, { searchDirectory = path.join(root, 'output/content-pipeline/search-index') } = {}) {
  const web = path.join(root, 'yueqian-training');
  const webRelease = await readWebRelease(web);
  await verifyLatest(path.join(web, 'content-library'));
  await fs.mkdir(destination, { recursive: true });
  if ((await fs.readdir(destination)).length) throw new Error('发布暂存目录必须为空。');
  for (const file of webRelease.files) {
    await fs.mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await fs.copyFile(path.join(web, file), path.join(destination, file));
  }
  const sync = await fs.readFile(path.join(web, 'sync-config.js'), 'utf8');
  if (sync.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '').trim()) throw new Error('同步配置不是空凭据模板。');
  await fs.cp(path.join(web, 'content-library'), path.join(destination, 'content-library'), { recursive: true, filter: source => path.basename(source) !== '.generated.json' });
  const history = await retainPrevious(path.join(destination, 'content-library'), previousURL);
  const searchIndex = await placeSearchIndex(path.join(destination, 'content-library'), searchDirectory, previousURL);
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
  const report = { schemaVersion: 1, webVersion: webRelease.webVersion, cache: webRelease.cache, contentRelease: history[0].releaseID, retainedReleases: history.map(item => item.releaseID), searchIndex: { status: searchIndex.status, indexSha256: searchIndex.indexSha256, documentCount: searchIndex.documentCount }, files: records.sort((left, right) => left.path.localeCompare(right.path)) };
  await writeAtomicJSON(path.join(destination, 'release-manifest.json'), report);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.length < 3 || process.argv.length > 4) throw new Error('用法：node content-pipeline/production.mjs <空发布目录> [现有站点 HTTPS 地址]');
  const destination = path.resolve(process.argv[2]);
  // 部署前线上清单保存在发布目录之外（不上传），供 verify-production.mjs 判断传播延迟。
  const previousReport = await readPublishedReport(process.argv[3]);
  const report = await prepareSite(root, destination, process.argv[3]);
  const previousReportPath = path.join(path.dirname(destination), 'previous-release-manifest.json');
  if (previousReport) await writeAtomicJSON(previousReportPath, previousReport);
  else await fs.rm(previousReportPath, { force: true });
  console.log(JSON.stringify({ ...report, files: report.files.length, previousReport: previousReport ? previousReportPath : null }, null, 2));
}
