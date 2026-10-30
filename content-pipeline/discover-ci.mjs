import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSources, validateRegistry, writeAtomicJSON } from './lib.mjs';
import { discoveryCandidates, validateDiscovery } from './external-search.mjs';

// 用法：node content-pipeline/discover-ci.mjs [--fallback <线上 content-discovery.json 的 HTTPS 地址>]
// 发现或校验失败时沿用线上已发布的发现目录（记录警告）；两者都不可用才失败。
const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = validateRegistry(JSON.parse(await fs.readFile(path.join(root, 'content-pipeline/sources.json'))));
const output = path.join(root, 'output/content-pipeline/discovery.json');
const argumentsList = process.argv.slice(2);
const fallbackIndex = argumentsList.indexOf('--fallback');
const fallbackURL = fallbackIndex >= 0 ? argumentsList.splice(fallbackIndex, 2)[1] : null;
if (argumentsList.length || (fallbackIndex >= 0 && !/^https:\/\//u.test(fallbackURL || ''))) throw new Error('用法：node content-pipeline/discover-ci.mjs [--fallback <HTTPS 地址>]');
const warn = message => console.warn((process.env.GITHUB_ACTIONS ? '::warning::' : '警告：') + message);

async function readPublished() {
  if (!fallbackURL) return null;
  try {
    const response = await fetch(fallbackURL, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > registry.budget.maxResponseBytes) throw new Error('超过大小上限');
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    warn('线上发现目录不可读取：' + String(error.message).slice(0, 200));
    return null;
  }
}

let previous = null;
try { previous = JSON.parse(await fs.readFile(output)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const published = await readPublished();
const fetcher = async (address, options) => {
  const url = new URL(address);
  if (url.origin !== 'https://api.github.com' || !registry.sources.some(source => url.pathname.startsWith('/repos/' + source.repository + '/'))) throw new Error('来源不在配置范围。');
  const { stdout } = await execute('gh', ['api', '--method', 'GET', url.pathname + url.search], { maxBuffer: registry.budget.maxResponseBytes, signal: options.signal });
  return new Response(stdout, { headers: { 'content-type': 'application/json' } });
};
try {
  // 本地没有缓存时，用线上目录作为增量基准：版本未变的来源不再下载文件树。
  const result = await discoverSources(registry, previous || published, fetcher);
  await validateDiscovery(registry, result);
  await writeAtomicJSON(output, result);
  console.log(JSON.stringify({ status: '公开来源已核对；GitHub CLI 安全使用已有认证', checkedAt: result.checkedAt, budget: result.budget, sources: result.sources.map(({ id, status, candidates }) => ({ id, status, candidates: candidates.length })) }, null, 2));
} catch (error) {
  warn('来源发现或校验失败：' + String(error.message).slice(0, 240));
  if (!published) throw new Error('来源发现失败，且没有可沿用的线上发现目录。', { cause: error });
  // 只做结构校验，不限制时效：过期来源由 Worker 与索引构建按 72 小时规则各自暂停或保留旧条目。
  const found = await discoveryCandidates(registry, published, Date.now(), 24 * 365 * 10);
  if (!found.sources.some(source => source.status === 'ready')) throw new Error('线上发现目录也无法通过校验，停止发布。', { cause: error });
  await writeAtomicJSON(output, published);
  warn(`沿用线上已发布的发现目录（检查时间 ${published.checkedAt}）；本次发布继续。`);
  console.log(JSON.stringify({ status: '沿用线上发现目录', checkedAt: published.checkedAt, sources: found.sources }, null, 2));
}
