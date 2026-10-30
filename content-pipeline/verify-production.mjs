import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './lib.mjs';
import { readSearchDirectory } from './search-index.mjs';

// 用法：node content-pipeline/verify-production.mjs <站点 HTTPS 地址> <本次发布目录> [部署前线上 release-manifest.json]
// 读回全部文件，失败项按指数退避重试（默认总时长约 4.5 分钟）。最终仍不一致时区分：
//   propagation-lag：线上仍是部署前的旧文件或新文件尚未出现；corrupt：线上内容与新旧版本都不一致。
export const verifyDefaults = { budgetMs: 270000, initialDelayMs: 5000, maxDelayMs: 60000, requestTimeoutMs: 30000 };

async function readLive(fetcher, address, timeoutMs) {
  try {
    const response = await fetcher(address, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes: bytes.length, sha256: response.status === 200 ? sha256(bytes) : null };
  } catch (error) {
    return { status: 0, bytes: 0, sha256: null, error: String(error.message).slice(0, 160) };
  }
}

export function classifyMismatch(record, live, previousFiles) {
  const before = previousFiles.get(record.path);
  if (live.status === 200 && before && live.sha256 === before.sha256) return 'propagation-lag';
  if (live.status === 404 && !before) return 'propagation-lag';
  if (live.status === 0 || live.status === 429 || live.status >= 500) return 'unreachable';
  return 'corrupt';
}

export async function verifyFiles({ base, report, previousReport = null, fetcher = fetch, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), now = () => Date.now(), options = {} }) {
  const settings = { ...verifyDefaults, ...options };
  const previousFiles = new Map((previousReport?.files || []).map(record => [record.path, record]));
  const started = now();
  let pending = report.files;
  let attempt = 0;
  let delay = settings.initialDelayMs;
  const latest = new Map();
  while (true) {
    attempt++;
    const failed = [];
    for (const record of pending) {
      const address = new URL(record.path, base);
      address.searchParams.set('verify', record.sha256.slice(0, 12) + '-' + attempt);
      const live = await readLive(fetcher, address, settings.requestTimeoutMs);
      if (live.status === 200 && live.bytes === record.bytes && live.sha256 === record.sha256) latest.delete(record.path);
      else {
        latest.set(record.path, { path: record.path, ...live, expectedSha256: record.sha256, classification: classifyMismatch(record, live, previousFiles) });
        failed.push(record);
      }
    }
    pending = failed;
    if (!pending.length || now() - started + delay > settings.budgetMs) break;
    console.warn(`读回第 ${attempt} 轮：${pending.length} 个文件尚未一致，${Math.round(delay / 1000)} 秒后重试（${[...latest.values()].map(item => item.path + ':' + item.classification).slice(0, 5).join(', ')}）`);
    await sleep(delay);
    delay = Math.min(delay * 2, settings.maxDelayMs);
  }
  const mismatches = [...latest.values()];
  return { attempts: attempt, elapsedMs: now() - started, filesMatching: report.files.length - mismatches.length, mismatches, propagationLagOnly: mismatches.length > 0 && mismatches.every(item => item.classification === 'propagation-lag') };
}

// Workers 检索为可选服务：只告警，不阻断发布，也不要求 releaseID 与静态资料一致。
export async function checkWorkerSearch(directory, base, fetcher = fetch) {
  const services = await fs.readFile(path.join(directory, 'material-services.js'), 'utf8').catch(() => '');
  const searchURL = services.match(/searchURL:\s*['"]([^'"]+)['"]/u)?.[1];
  if (!searchURL) return { status: 'not-configured' };
  try {
    const address = new URL(searchURL);
    address.searchParams.set('q', '向量数据库');
    address.searchParams.set('scope', 'library');
    const response = await fetcher(address, { headers: { origin: base.origin }, signal: AbortSignal.timeout(15000) });
    const result = await response.json().catch(() => null);
    const warnings = [];
    if (response.status !== 200) warnings.push('HTTP ' + response.status);
    if (response.headers.get('access-control-allow-origin') !== base.origin) warnings.push('CORS 来源不匹配');
    if (!(result?.library?.results?.length > 0)) warnings.push('库内检索无结果');
    return { status: warnings.length ? 'warning' : 'ok', url: searchURL, releaseID: result?.releaseID || null, warnings };
  } catch (error) {
    return { status: 'warning', url: searchURL, warnings: [String(error.message).slice(0, 160)] };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 4 || process.argv.length > 5) throw new Error('用法：node content-pipeline/verify-production.mjs <站点 HTTPS 地址> <本次发布目录> [部署前 release-manifest.json]');
  const base = new URL(process.argv[2]);
  const directory = path.resolve(process.argv[3]);
  const report = JSON.parse(await fs.readFile(path.join(directory, 'release-manifest.json')));
  let previousReport = null;
  if (process.argv[4]) previousReport = await fs.readFile(path.resolve(process.argv[4]), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const options = process.env.VERIFY_BUDGET_MS ? { budgetMs: Number(process.env.VERIFY_BUDGET_MS) } : {};
  const files = await verifyFiles({ base, report, previousReport, options });
  const warn = message => console.warn((process.env.GITHUB_ACTIONS ? '::warning::' : '警告：') + message);

  let search = { status: 'absent' };
  try {
    const local = await readSearchDirectory(path.join(directory, 'content-library/search'));
    const listed = report.files.find(record => record.path === 'content-library/search/' + path.basename(local.pointer.indexPath));
    if (!listed || listed.sha256 !== local.pointer.indexSha256) throw new Error('发布清单未登记当前检索索引。');
    search = { status: 'valid', indexSha256: local.pointer.indexSha256, documentCount: local.pointer.documentCount, bytes: local.pointer.bytes, liveMatching: !files.mismatches.some(item => item.path.startsWith('content-library/search/')) };
  } catch (error) {
    if (error.code === 'ENOENT') warn('本次发布没有静态检索索引（search/latest.json）。');
    else search = { status: 'invalid', error: error.message };
  }
  const worker = await checkWorkerSearch(directory, base);
  if (worker.status === 'warning') warn('可选 Workers 检索检查未通过（不阻断发布）：' + worker.warnings.join('；'));

  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), base: base.href, webVersion: report.webVersion, cache: report.cache, contentRelease: report.contentRelease, filesMatching: files.filesMatching, filesTotal: report.files.length, attempts: files.attempts, elapsedMs: files.elapsedMs, mismatches: files.mismatches, searchIndex: search, workerSearch: worker }, null, 2));
  if (search.status === 'invalid') {
    console.error('静态检索索引校验失败：' + search.error);
    process.exitCode = 1;
  }
  if (files.mismatches.length) {
    console.error(files.propagationLagOnly
      ? `线上仍有 ${files.mismatches.length} 个文件是部署前版本或尚未出现（传播延迟，超过重试时限）；稍后重新运行读回检查，无需回滚。`
      : `线上有 ${files.mismatches.filter(item => item.classification !== 'propagation-lag').length} 个文件与新旧版本都不一致（损坏或不可达），需核对后重新发布。`);
    process.exitCode = 1;
  }
}
