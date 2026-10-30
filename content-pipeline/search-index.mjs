import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { discoveryCandidates, digest, gitBlobSHA, markdownText, sourceURL } from './external-search.mjs';
import { sha256, validateRegistry, validateTopics, verifyLatest } from './lib.mjs';

// 契约见 STATIC-SEARCH-INDEX.md（schema v1）。客户端按同一组上限校验，任何改动需同步三端。
export const searchIndexLimits = Object.freeze({ maxIndexBytes: 4194304, maxPointerBytes: 16384, maxDocuments: 400, maxTitle: 400, maxText: 12000, maxID: 200, maxTopics: 100 });
export const allowedSearchSources = Object.freeze({ 'microsoft-genai': 'microsoft/generative-ai-for-beginners', 'microsoft-agents': 'microsoft/ai-agents-for-beginners', 'openai-cookbook': 'openai/openai-cookbook' });
const buildDefaults = { concurrency: 4, maxDocumentBytes: 700000, maxRunMs: 300000, requestTimeoutMs: 30000, reuseUnchangedForMs: 7 * 86400000 };
const revisionPattern = /^[a-f0-9]{40}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const sourceStatuses = new Set(['ready', 'retained', 'partial']);

function check(condition, message) {
  if (!condition) throw new Error('静态检索索引无效：' + message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && isoPattern.test(value) && Number.isFinite(Date.parse(value));
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 1200 && !value.startsWith('/') && !value.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(value) && value.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

function boundedText(value, maximum) {
  return typeof value === 'string' && value.length <= maximum && value.isWellFormed();
}

// 按 UTF-16 长度截断，并避免留下孤立代理项（否则 Swift 等客户端解码失败）。
export function truncateText(value, maximum) {
  if (value.length <= maximum) return value;
  const cut = value.slice(0, maximum);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// 同一来源、同一课程目录视为同一课程：translations/zh-CN/15-x/README.md ⇔ 15-x/README.md。
export function courseKey(sourceID, sourcePath) {
  const normalized = sourcePath.replace(/^translations\/[^/]+\//u, '');
  const slash = normalized.lastIndexOf('/');
  return sourceID + ':' + (slash > 0 ? normalized.slice(0, slash) : normalized);
}

export function validateSearchIndex(index, { bytes = null } = {}) {
  if (bytes !== null) check(bytes.length > 0 && bytes.length <= searchIndexLimits.maxIndexBytes, '文件超过 4 MiB 或为空');
  check(isPlainObject(index) && index.schemaVersion === 1 && index.kind === 'external-candidates' && index.reviewStatus === 'unreviewed' && isTimestamp(index.generatedAt), '头部字段');
  check(Array.isArray(index.sources) && index.sources.length <= Object.keys(allowedSearchSources).length, 'sources');
  const sources = new Map();
  for (const source of index.sources) {
    check(isPlainObject(source) && allowedSearchSources[source.id] === source.repository && !sources.has(source.id), '来源 ID 或仓库');
    check(typeof source.publisher === 'string' && source.publisher.length > 0 && source.publisher.length <= 80, '来源发布者');
    check(revisionPattern.test(source.revision) && isTimestamp(source.checkedAt) && sourceStatuses.has(source.status), '来源版本、时间或状态');
    check(Number.isInteger(source.documentCount) && source.documentCount >= 0 && Number.isInteger(source.totalMatchingFiles) && source.totalMatchingFiles >= 0 && typeof source.selectionLimited === 'boolean', '来源统计');
    sources.set(source.id, 0);
  }
  check(Array.isArray(index.topics) && index.topics.length <= searchIndexLimits.maxTopics, 'topics');
  for (const topic of index.topics) {
    check(isPlainObject(topic) && boundedText(topic.id, 80) && topic.id && boundedText(topic.title, 200) && Array.isArray(topic.terms) && topic.terms.length <= 20 && topic.terms.every(term => boundedText(term, 100) && term.length > 0), '主题词表');
  }
  check(Array.isArray(index.documents) && index.documents.length <= searchIndexLimits.maxDocuments, 'documents 数量');
  const identities = new Set();
  for (const document of index.documents) {
    check(isPlainObject(document) && typeof document.id === 'string' && document.id.length <= searchIndexLimits.maxID && /^[a-z0-9-]+:[a-f0-9]{16}$/u.test(document.id) && !identities.has(document.id), '文档 ID');
    check(document.id.startsWith(document.sourceID + ':') && sources.has(document.sourceID) && allowedSearchSources[document.sourceID] === document.repository, '文档来源：' + document.id);
    check(revisionPattern.test(document.revision) && safePath(document.path) && document.url === sourceURL(document.repository, document.revision, document.path), '文档版本、路径或地址：' + document.id);
    check(revisionPattern.test(document.blobSHA) && hashPattern.test(document.sha256), '文档哈希：' + document.id);
    check(boundedText(document.title, searchIndexLimits.maxTitle) && document.title.length > 0 && boundedText(document.text, searchIndexLimits.maxText), '文档标题或正文长度：' + document.id);
    identities.add(document.id);
    sources.set(document.sourceID, sources.get(document.sourceID) + 1);
  }
  for (const source of index.sources) check(source.documentCount === sources.get(source.id), '来源文档数：' + source.id);
  return index;
}

export function searchPointer(index, bytes) {
  const indexSha256 = sha256(bytes);
  return { schemaVersion: 1, indexPath: `search/index-${indexSha256}.json`, indexSha256, bytes: bytes.length, generatedAt: index.generatedAt, documentCount: index.documents.length };
}

export function validateSearchPointer(pointer, indexBytes = null) {
  check(isPlainObject(pointer) && pointer.schemaVersion === 1 && hashPattern.test(pointer.indexSha256) && pointer.indexPath === `search/index-${pointer.indexSha256}.json`, '指针路径或哈希');
  check(Number.isInteger(pointer.bytes) && pointer.bytes > 0 && pointer.bytes <= searchIndexLimits.maxIndexBytes && isTimestamp(pointer.generatedAt) && Number.isInteger(pointer.documentCount) && pointer.documentCount >= 0 && pointer.documentCount <= searchIndexLimits.maxDocuments, '指针字段');
  if (indexBytes === null) return { pointer, index: null };
  check(indexBytes.length === pointer.bytes && sha256(indexBytes) === pointer.indexSha256, '索引字节数或 SHA-256 与指针不一致');
  let index;
  try { index = JSON.parse(indexBytes.toString('utf8')); } catch { check(false, '索引不是有效 JSON'); }
  validateSearchIndex(index, { bytes: indexBytes });
  check(index.generatedAt === pointer.generatedAt && index.documents.length === pointer.documentCount, '指针与索引的时间或文档数不一致');
  return { pointer, index };
}

function encodeIndex(index) {
  return Buffer.from(JSON.stringify(index));
}

function encodePointer(pointer) {
  return Buffer.from(JSON.stringify(pointer) + '\n');
}

async function readLimited(response, maximum) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maximum) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error('document-too-large'), { code: 'document-too-large' });
  }
  if (!response.body) throw Object.assign(new Error('empty-body'), { code: 'empty-body' });
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw Object.assign(new Error('document-too-large'), { code: 'document-too-large' });
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}

async function readRemote(fetcher, url, maximum, { optional = false, timeoutMs = 30000 } = {}) {
  const response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (optional && response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`读取失败（HTTP ${response.status}）：${url}`);
  }
  return readLimited(response, maximum);
}

// 读取目录内 latest.json 与其指向的索引；任何一项不通过即抛错。
export async function readSearchDirectory(directory) {
  const pointerBytes = await fs.readFile(path.join(directory, 'latest.json'));
  check(pointerBytes.length <= searchIndexLimits.maxPointerBytes, '指针超过 16 KiB');
  const pointer = JSON.parse(pointerBytes.toString('utf8'));
  validateSearchPointer(pointer);
  const indexBytes = await fs.readFile(path.join(directory, path.basename(pointer.indexPath)));
  const { index } = validateSearchPointer(pointer, indexBytes);
  return { pointer, pointerBytes, index, indexBytes };
}

// 读取上一版已发布索引：contentBaseURL（https://…/content-library/）或本地 search 目录。失败返回 null 并给出原因。
export async function loadPublishedIndex(location, { fetcher = fetch } = {}) {
  if (!location) return { previous: null, warning: null };
  try {
    if (/^https:\/\//u.test(location)) {
      const base = new URL(location.endsWith('/') ? location : location + '/');
      const pointerBytes = await readRemote(fetcher, new URL('search/latest.json', base).href, searchIndexLimits.maxPointerBytes, { optional: true });
      if (!pointerBytes) return { previous: null, warning: null };
      const pointer = JSON.parse(pointerBytes.toString('utf8'));
      validateSearchPointer(pointer);
      const indexBytes = await readRemote(fetcher, new URL(pointer.indexPath, base).href, searchIndexLimits.maxIndexBytes);
      const { index } = validateSearchPointer(pointer, indexBytes);
      return { previous: { pointer, pointerBytes, index, indexBytes }, warning: null };
    }
    if (/^[a-z]+:\/\//iu.test(location)) throw new Error('上一版索引地址必须是 HTTPS。');
    return { previous: await readSearchDirectory(path.resolve(location)), warning: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { previous: null, warning: null };
    return { previous: null, warning: '上一版索引不可用，按首次构建处理：' + String(error.message).slice(0, 240) };
  }
}

async function fetchDocument(candidate, { fetcher, signal, maxDocumentBytes, requestTimeoutMs }) {
  signal.throwIfAborted();
  const url = sourceURL(candidate.repository, candidate.revision, candidate.path, true);
  const response = await fetcher(url, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { Accept: 'text/plain' }, signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) });
  if (!response.ok || (response.url && response.url !== url)) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error('upstream'), { code: response.status === 429 || response.status === 403 ? 'upstream-rate-limited' : 'upstream-unavailable' });
  }
  const bytes = await readLimited(response, maxDocumentBytes);
  if (!bytes.length) throw Object.assign(new Error('empty-body'), { code: 'empty-body' });
  if (await gitBlobSHA(bytes) !== candidate.blobSHA) throw Object.assign(new Error('integrity-failed'), { code: 'integrity-failed' });
  let markdown;
  try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw Object.assign(new Error('invalid-encoding'), { code: 'invalid-encoding' }); }
  const heading = markdownText(/^\s*#{1,6}\s+(.+)$/mu.exec(markdown)?.[1] || '');
  const title = truncateText(heading || candidate.title || candidate.path, searchIndexLimits.maxTitle);
  return { id: candidate.id, sourceID: candidate.sourceID, repository: candidate.repository, revision: candidate.revision, path: candidate.path, url: candidate.url, blobSHA: candidate.blobSHA, sha256: await digest('SHA-256', bytes), title: title || candidate.path, text: truncateText(markdownText(markdown), searchIndexLimits.maxText) };
}

async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

function kept(previous) {
  return { pointer: previous.pointer, pointerBytes: previous.pointerBytes || encodePointer(previous.pointer), index: previous.index, indexBytes: previous.indexBytes };
}

function comparable(index) {
  return JSON.stringify({ sources: index.sources.map(({ checkedAt, revision, ...rest }) => rest), topics: index.topics, documents: index.documents });
}

/**
 * 生成静态外部检索索引。
 * previous：loadPublishedIndex 返回的已校验上一版（可为 null）。
 * published：已发布正式资料 [{ sourceID, path }]，同课程目录的候选不进入索引。
 * 返回 status：built | unchanged | retained-previous | empty（无可发布结果）。
 */
export async function buildSearchIndex({ registry, topics, discovery, published = [], previous = null, fetcher = fetch, now = () => Date.now(), limits = {} }) {
  validateRegistry(registry);
  validateTopics(topics);
  for (const source of registry.sources) if (allowedSearchSources[source.id] !== source.repository) throw new Error('来源不在静态索引契约内：' + source.id);
  const settings = { ...buildDefaults, ...limits };
  const timestamp = Number(now());
  const generatedAt = new Date(timestamp).toISOString();
  const excluded = new Set(published.map(item => courseKey(item.sourceID, item.path)));
  const previousIndex = previous?.index || null;
  const previousDocuments = new Map((previousIndex?.documents || []).map(document => [document.sourceID + '\u0000' + document.path, document]));
  const report = { generatedAt, fetched: 0, reused: 0, excluded: 0, failures: [], sources: [] };

  let found = { candidates: [], sources: [], failures: [] };
  try { found = await discoveryCandidates(registry, discovery, timestamp); }
  catch (error) { report.failures.push({ reason: error.code || 'invalid-discovery' }); }
  report.failures.push(...found.failures);

  const plans = [];
  const tasks = [];
  for (const source of registry.sources) {
    const state = found.sources.find(item => item.id === source.id);
    const discovered = discovery?.sources?.find?.(item => item?.id === source.id);
    const plan = { source, state, discovered, ready: state?.status === 'ready', entries: [], fetchTasks: 0, fetched: 0, reused: 0, failed: [] };
    plans.push(plan);
    if (!plan.ready) continue;
    for (const candidate of found.candidates.filter(item => item.sourceID === source.id)) {
      if (excluded.has(courseKey(source.id, candidate.path))) { report.excluded++; continue; }
      const prior = previousDocuments.get(source.id + '\u0000' + candidate.path);
      if (prior && prior.blobSHA === candidate.blobSHA && prior.id === candidate.id) {
        plan.entries.push(prior);
        plan.reused++;
        continue;
      }
      plan.fetchTasks++;
      tasks.push({ plan, candidate, prior });
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.maxRunMs);
  try {
    await pool(tasks, settings.concurrency, async task => {
      try {
        task.plan.entries.push(await fetchDocument(task.candidate, { fetcher, signal: controller.signal, maxDocumentBytes: settings.maxDocumentBytes, requestTimeoutMs: settings.requestTimeoutMs }));
        task.plan.fetched++;
      } catch (error) {
        const reason = controller.signal.aborted ? 'timeout' : error.code || error.name || 'upstream-unavailable';
        task.plan.failed.push(task);
        report.failures.push({ sourceID: task.candidate.sourceID, path: task.candidate.path, reason, retainedPrevious: Boolean(task.prior) });
        if (task.prior) task.plan.entries.push(task.prior);
      }
    });
  } finally { clearTimeout(timer); }

  const sources = [];
  const documents = [];
  for (const plan of plans) {
    const priorSource = previousIndex?.sources.find(item => item.id === plan.source.id) || null;
    plan.sourceFailed = !plan.ready || (plan.fetchTasks > 0 && plan.fetched === 0 && plan.reused === 0);
    if (plan.sourceFailed) {
      const retained = priorSource ? previousIndex.documents.filter(document => document.sourceID === plan.source.id && !excluded.has(courseKey(document.sourceID, document.path))) : [];
      if (priorSource) {
        sources.push({ ...priorSource, status: 'retained', documentCount: retained.length });
        documents.push(...retained);
      }
      report.sources.push({ id: plan.source.id, status: priorSource ? 'retained' : 'omitted', documents: retained.length, reason: plan.ready ? 'all-fetches-failed' : plan.state?.status || 'invalid-discovery' });
      continue;
    }
    const status = plan.failed.length ? 'partial' : 'ready';
    sources.push({ id: plan.source.id, repository: plan.source.repository, publisher: plan.source.publisher, revision: plan.discovered.revision, checkedAt: plan.state.checkedAt, status, documentCount: plan.entries.length, totalMatchingFiles: plan.state.totalMatchingFiles, selectionLimited: plan.state.selectionLimited });
    documents.push(...plan.entries);
    report.fetched += plan.fetched;
    report.reused += plan.reused;
    report.sources.push({ id: plan.source.id, status, documents: plan.entries.length, fetched: plan.fetched, reused: plan.reused, failed: plan.failed.length });
  }

  const usable = plans.some(plan => !plan.sourceFailed && plan.fetched + plan.reused > 0);
  if (!usable) {
    if (previous) return { ...kept(previous), status: 'retained-previous', report: { ...report, reason: 'no-usable-result' } };
    return { status: 'empty', report: { ...report, reason: 'no-usable-result' } };
  }
  documents.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const index = { schemaVersion: 1, generatedAt, kind: 'external-candidates', reviewStatus: 'unreviewed', sources, topics: topics.topics.map(({ id, title, terms }) => ({ id, title, terms })), documents };
  if (previous && comparable(previous.index) === comparable(index) && timestamp - Date.parse(previous.index.generatedAt) < settings.reuseUnchangedForMs) {
    return { ...kept(previous), status: 'unchanged', report: { ...report, reason: 'content-unchanged' } };
  }
  const indexBytes = encodeIndex(index);
  try { validateSearchIndex(index, { bytes: indexBytes }); }
  catch (error) {
    const reason = String(error.message).slice(0, 240);
    if (previous) return { ...kept(previous), status: 'retained-previous', report: { ...report, reason } };
    return { status: 'empty', report: { ...report, reason } };
  }
  const pointer = searchPointer(index, indexBytes);
  return { status: 'built', pointer, pointerBytes: encodePointer(pointer), index, indexBytes, report };
}

// 写出 latest.json 与 index-<sha256>.json；上一版索引文件一并保留，供正在下载旧指针的客户端读取。
export async function writeSearchOutput(directory, result, previous = null) {
  validateSearchPointer(result.pointer, result.indexBytes);
  const parent = path.dirname(directory);
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, '.search-staging-'));
  try {
    await fs.writeFile(path.join(staging, path.basename(result.pointer.indexPath)), result.indexBytes, { flag: 'wx' });
    if (previous && previous.pointer.indexSha256 !== result.pointer.indexSha256) {
      validateSearchPointer(previous.pointer, previous.indexBytes);
      await fs.writeFile(path.join(staging, path.basename(previous.pointer.indexPath)), previous.indexBytes, { flag: 'wx' });
    }
    await fs.writeFile(path.join(staging, 'latest.json'), encodePointer(result.pointer), { flag: 'wx' });
    await readSearchDirectory(staging);
    let existing = [];
    try { existing = await fs.readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing.some(name => name !== 'latest.json' && !/^index-[a-f0-9]{64}\.json$/u.test(name))) throw new Error('输出目录含索引以外的文件，拒绝覆盖：' + directory);
    await fs.rm(directory, { recursive: true, force: true });
    await fs.chmod(staging, 0o755);
    await fs.rename(staging, directory);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  return readSearchDirectory(directory);
}

// 复制已校验的 search 目录：只复制 latest.json 与文件名哈希一致、内容可通过校验的 index-*.json。
export async function copySearchDirectory(source, destination) {
  const current = await readSearchDirectory(source);
  await fs.mkdir(destination, { recursive: true });
  const copied = [];
  for (const name of (await fs.readdir(source)).sort()) {
    const match = /^index-([a-f0-9]{64})\.json$/u.exec(name);
    if (!match) continue;
    const bytes = await fs.readFile(path.join(source, name));
    if (sha256(bytes) !== match[1] || bytes.length > searchIndexLimits.maxIndexBytes) continue;
    try { validateSearchIndex(JSON.parse(bytes.toString('utf8')), { bytes }); } catch { continue; }
    await fs.writeFile(path.join(destination, name), bytes, { flag: 'wx' });
    copied.push(name);
  }
  await fs.writeFile(path.join(destination, 'latest.json'), current.pointerBytes, { flag: 'wx' });
  return { ...current, files: ['latest.json', ...copied] };
}

export async function writePublishedIndex(destination, previous) {
  await fs.mkdir(destination, { recursive: true });
  validateSearchPointer(previous.pointer, previous.indexBytes);
  await fs.writeFile(path.join(destination, path.basename(previous.pointer.indexPath)), previous.indexBytes, { flag: 'wx' });
  await fs.writeFile(path.join(destination, 'latest.json'), previous.pointerBytes || encodePointer(previous.pointer), { flag: 'wx' });
  return readSearchDirectory(destination);
}

// 已发布正式资料：读取并校验 Web 资料库当前版本，返回每篇文档的来源与路径。
export async function publishedDocuments(library) {
  const manifest = await verifyLatest(library);
  const release = path.join(library, 'releases', manifest.releaseID);
  const result = [];
  for (const summary of manifest.documents) {
    const document = JSON.parse(await fs.readFile(path.join(release, summary.path), 'utf8'));
    result.push({ sourceID: document.source.id, path: document.source.path });
  }
  return result;
}

function option(list, name, fallback = null) {
  const index = list.indexOf(name);
  if (index < 0) return fallback;
  const value = list[index + 1];
  if (!value || value.startsWith('--')) throw new Error(name + ' 后需要参数。');
  list.splice(index, 2);
  return value;
}

function warn(message) {
  console.warn((process.env.GITHUB_ACTIONS ? '::warning::' : '警告：') + message);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(directory, '..');
  const argumentsList = process.argv.slice(2);
  const discoveryPath = path.resolve(option(argumentsList, '--discovery', path.join(root, 'output/content-pipeline/discovery.json')));
  const output = path.resolve(option(argumentsList, '--output', path.join(root, 'output/content-pipeline/search-index')));
  const previousLocation = option(argumentsList, '--previous');
  const reportPath = option(argumentsList, '--report');
  if (argumentsList.length) throw new Error('用法：node content-pipeline/search-index.mjs [--discovery 发现目录.json] [--previous contentBaseURL 或 search 目录] [--output 目录] [--report 报告.json]');
  const started = Date.now();
  const registry = JSON.parse(await fs.readFile(path.join(directory, 'sources.json'), 'utf8'));
  const topics = JSON.parse(await fs.readFile(path.join(directory, 'topics.json'), 'utf8'));
  const published = await publishedDocuments(path.join(root, 'yueqian-training/content-library'));
  let discovery = null;
  try { discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8')); }
  catch (error) { warn('来源发现目录不可读取，全部来源按失败处理：' + error.message); }
  const { previous, warning } = await loadPublishedIndex(previousLocation);
  if (warning) warn(warning);
  const result = await buildSearchIndex({ registry, topics, discovery, published, previous });
  let written = null;
  if (result.status === 'empty') warn('没有可发布的检索索引，也没有上一版；本次不写入 search/，站点组装时会尝试保留线上版本。原因：' + result.report.reason);
  else {
    if (result.status === 'retained-previous') warn('本次索引不可用，原样保留上一版。原因：' + result.report.reason);
    written = await writeSearchOutput(output, result, previous);
  }
  const summary = {
    status: { built: '检索索引已生成并校验', unchanged: '内容未变化，沿用上一版索引', 'retained-previous': '保留上一版索引', empty: '未生成索引' }[result.status],
    result: result.status,
    output: written ? output : null,
    indexSha256: written?.pointer.indexSha256 || null,
    documentCount: written?.index.documents.length || 0,
    bytes: written?.indexBytes.length || 0,
    gzipBytes: written ? gzipSync(written.indexBytes, { level: 9 }).length : 0,
    fetched: result.report.fetched,
    reused: result.report.reused,
    excludedPublished: result.report.excluded,
    failures: result.report.failures,
    sources: result.report.sources,
    elapsedMs: Date.now() - started
  };
  if (reportPath) {
    await fs.mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await fs.writeFile(path.resolve(reportPath), JSON.stringify(summary, null, 2) + '\n');
  }
  console.log(JSON.stringify(summary, null, 2));
}
