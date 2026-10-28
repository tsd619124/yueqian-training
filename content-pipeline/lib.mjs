import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const revisionPattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(canonical(value)) + '\n');
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 1200 && !value.startsWith('/') && !value.includes('\\') && !/[\u0000-\u001f]/.test(value) && value.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

export function sourceURL(repository, revision, sourcePath, raw = false) {
  requireValue(safePath(sourcePath) && revisionPattern.test(revision), '来源路径或版本无效。');
  const encoded = sourcePath.split('/').map(encodeURIComponent).join('/');
  return raw ? `https://raw.githubusercontent.com/${repository}/${revision}/${encoded}` : `https://github.com/${repository}/blob/${revision}/${encoded}`;
}

export function validateRegistry(registry) {
  requireValue(registry?.schemaVersion === 1 && Array.isArray(registry.sources) && registry.sources.length > 0 && registry.sources.length <= 6, '来源目录格式无效。');
  const maxima = { maxRequests: 24, maxDownloadBytes: 33554432, maxResponseBytes: 10485760, maxCandidatesPerSource: 250, timeoutMs: 30000, maxRunMs: 300000, maxReleaseBytes: 25165824 };
  for (const [name, maximum] of Object.entries(maxima)) requireValue(Number.isInteger(registry.budget?.[name]) && registry.budget[name] > 0 && registry.budget[name] <= maximum, `成本上限无效：${name}`);
  if (registry.collection) {
    for (const [name, maximum] of Object.entries({ maxDocumentsPerRun: 12, maxDocumentBytes: 1000000, maxStoredBytes: 33554432 })) requireValue(Number.isInteger(registry.collection[name]) && registry.collection[name] > 0 && registry.collection[name] <= maximum, `正文成本上限无效：${name}`);
    if (registry.collection.maxDiscoveryAgeHours !== undefined) requireValue(Number.isInteger(registry.collection.maxDiscoveryAgeHours) && registry.collection.maxDiscoveryAgeHours > 0 && registry.collection.maxDiscoveryAgeHours <= 720, '来源检查时效无效。');
  }
  const identities = new Set();
  const repositories = new Set();
  for (const source of registry.sources) {
    requireValue(typeof source.id === 'string' && identifierPattern.test(source.id) && !identities.has(source.id), '来源 ID 无效或重复。');
    requireValue(typeof source.publisher === 'string' && source.publisher.length > 0 && source.publisher.length <= 80, '发布者无效。');
    requireValue(typeof source.repository === 'string' && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) && safePath(source.repository) && !repositories.has(source.repository), '来源仓库无效或重复。');
    requireValue(safePath(source.branch) && /^[A-Za-z0-9_./-]+$/.test(source.branch), '来源分支无效。');
    requireValue(typeof source.candidatePattern === 'string' && source.candidatePattern.length <= 160 && source.candidatePattern.startsWith('^') && source.candidatePattern.endsWith('$'), '候选路径规则无效。');
    new RegExp(source.candidatePattern);
    requireValue(typeof source.allowSnapshotPublication === 'boolean', '来源发布规则无效。');
    if (source.licensePath !== undefined) requireValue(safePath(source.licensePath), '许可证路径无效。');
    identities.add(source.id);
    repositories.add(source.repository);
  }
  return registry;
}

export function validateTopics(configuration) {
  requireValue(configuration?.schemaVersion === 1 && Array.isArray(configuration.topics) && configuration.topics.length <= 100, '主题规则无效。');
  const identities = new Set();
  for (const topic of configuration.topics) {
    requireValue(typeof topic.id === 'string' && identifierPattern.test(topic.id) && !identities.has(topic.id) && typeof topic.title === 'string', '主题 ID 或名称无效。');
    requireValue(Array.isArray(topic.terms) && topic.terms.length > 0 && topic.terms.length <= 20 && topic.terms.every(term => typeof term === 'string' && term.length > 1 && term.length <= 100), '主题关键词无效。');
    requireValue(Array.isArray(topic.lessonIDs) && topic.lessonIDs.every(identity => typeof identity === 'string'), '主题课程关联无效。');
    identities.add(topic.id);
  }
}

export function plainText(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1').replace(/<[^>]*>/g, ' ').replace(/^\s*(?:#{1,6}\s+|```[^\n]*|~~~[^\n]*)/gm, '').replace(/[*_`|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function evidenceMatch(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = /^[\x00-\x7f]+$/.test(term) ? `(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])` : escaped;
  const match = new RegExp(expression, 'iu').exec(text);
  return match ? { term: match[0], excerpt: text.slice(Math.max(0, match.index - 70), Math.min(text.length, match.index + match[0].length + 130)) } : null;
}

export function coverageReport(index, configuration) {
  validateTopics(configuration);
  return {
    schemaVersion: 1,
    method: configuration.method,
    requiresReview: true,
    topics: configuration.topics.map(topic => {
      const evidence = index.documents.flatMap(document => {
        const match = topic.terms.map(term => evidenceMatch(document.text, term)).find(Boolean);
        return match ? [{ documentID: document.id, url: document.url, ...match }] : [];
      });
      return { id: topic.id, title: topic.title, lessonIDs: topic.lessonIDs, status: evidence.length ? 'mentioned' : 'no-evidence', evidence };
    })
  };
}

function imageExtension(image, bytes) {
  if (image.mimeType === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (image.mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (image.mimeType === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  throw new Error('图片格式与实际字节不一致。');
}

export function buildRelease(snapshot, registry, topicConfiguration) {
  validateRegistry(registry);
  validateTopics(topicConfiguration);
  const source = registry.sources.find(item => item.repository === snapshot?.repository && item.allowSnapshotPublication);
  requireValue(source && snapshot.schemaVersion === 1 && revisionPattern.test(snapshot.revision) && Number.isFinite(Date.parse(snapshot.fetchedAt)), '快照没有获准发布的来源或版本。');
  requireValue(typeof snapshot.licenseText === 'string' && snapshot.licenseText.includes('MIT License') && Array.isArray(snapshot.articles) && snapshot.articles.length > 0 && snapshot.articles.length <= 100, '原文授权或文档清单无效。');
  const files = new Map();
  const index = { schemaVersion: 1, documents: [] };
  const summaries = [];
  const identities = new Set();
  let imageReferences = 0;
  for (const article of snapshot.articles) {
    requireValue(typeof article.id === 'string' && identifierPattern.test(article.id) && !identities.has(article.id) && typeof article.title === 'string' && Array.isArray(article.lessonIDs), '文档 ID、标题或关联无效。');
    requireValue(typeof article.markdown === 'string' && Buffer.byteLength(article.markdown) <= 700000 && sha256(article.markdown) === article.sha256, '原文哈希校验失败。');
    requireValue(Array.isArray(article.images) && article.images.length <= 24, '文档图片清单无效。');
    identities.add(article.id);
    const url = sourceURL(source.repository, snapshot.revision, article.path);
    const images = article.images.map(image => {
      requireValue(typeof image.data === 'string' && image.data.length <= 6000000 && typeof image.alt === 'string', '原图数据无效。');
      const bytes = Buffer.from(image.data, 'base64');
      requireValue(bytes.length > 32 && bytes.length <= 4194304 && bytes.toString('base64') === image.data && sha256(bytes) === image.sha256, '原图哈希校验失败。');
      const assetPath = `assets/${image.sha256}.${imageExtension(image, bytes)}`;
      files.set(assetPath, bytes);
      imageReferences++;
      return { path: assetPath, sourcePath: image.path, sourceURL: sourceURL(source.repository, snapshot.revision, image.path, true), alt: image.alt, mimeType: image.mimeType, sha256: image.sha256 };
    });
    const documentPath = `documents/${article.id}.json`;
    const document = { schemaVersion: 1, id: article.id, title: article.title, lessonIDs: article.lessonIDs, markdown: article.markdown, sha256: article.sha256, images, source: { id: source.id, publisher: source.publisher, repository: source.repository, revision: snapshot.revision, path: article.path, url, rawURL: sourceURL(source.repository, snapshot.revision, article.path, true), downloadedAt: snapshot.fetchedAt, license: 'MIT' } };
    files.set(documentPath, jsonBytes(document));
    summaries.push({ id: article.id, title: article.title, path: documentPath, sourceID: source.id, url, lessonIDs: article.lessonIDs, imageCount: images.length });
    index.documents.push({ id: article.id, title: article.title, url, path: documentPath, sourceID: source.id, lessonIDs: article.lessonIDs, text: plainText(article.markdown) });
  }
  const coverage = coverageReport(index, topicConfiguration);
  files.set('index.json', jsonBytes(index));
  files.set('coverage.json', jsonBytes(coverage));
  files.set('LICENSE.txt', Buffer.from(snapshot.licenseText));
  const records = [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([filePath, bytes]) => ({ path: filePath, bytes: bytes.length, sha256: sha256(bytes) }));
  const content = { schemaVersion: 1, sources: [{ id: source.id, repository: source.repository, revision: snapshot.revision, downloadedAt: snapshot.fetchedAt }], documents: summaries, imageReferences, assetCount: records.filter(record => record.path.startsWith('assets/')).length, files: records };
  const releaseID = sha256(jsonBytes(content));
  const manifest = { ...content, releaseID };
  files.set('manifest.json', jsonBytes(manifest));
  const totalBytes = [...files.values()].reduce((total, bytes) => total + bytes.length, 0);
  requireValue(totalBytes <= registry.budget.maxReleaseBytes, '发布内容超出成本大小上限。');
  return { releaseID, manifest, files, totalBytes };
}

function verifyManifest(manifest, manifestBytes, expectedHash) {
  requireValue(manifest?.schemaVersion === 1 && hashPattern.test(manifest.releaseID) && Array.isArray(manifest.files) && manifest.files.length <= 3000, '发布清单格式无效。');
  const { releaseID, ...content } = manifest;
  requireValue(sha256(jsonBytes(content)) === releaseID && (!expectedHash || sha256(manifestBytes) === expectedHash), '发布清单哈希校验失败。');
  const identities = new Set();
  for (const record of manifest.files) {
    requireValue(safePath(record.path) && !identities.has(record.path) && record.path !== 'manifest.json' && hashPattern.test(record.sha256) && Number.isInteger(record.bytes) && record.bytes > 0, '发布文件记录无效。');
    identities.add(record.path);
  }
}

export async function verifyReleaseDirectory(directory, expectedHash) {
  const manifestBytes = await fs.readFile(path.join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  verifyManifest(manifest, manifestBytes, expectedHash);
  for (const record of manifest.files) {
    const bytes = await fs.readFile(path.join(directory, record.path));
    requireValue(bytes.length === record.bytes && sha256(bytes) === record.sha256, `发布文件校验失败：${record.path}`);
  }
  return manifest;
}

export async function writeAtomicJSON(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, jsonBytes(value), { flag: 'wx' });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function writeRelease(output, bundle) {
  const manifestBytes = bundle.files.get('manifest.json');
  verifyManifest(bundle.manifest, manifestBytes);
  requireValue(bundle.releaseID === bundle.manifest.releaseID && jsonBytes(bundle.manifest).equals(manifestBytes), '内存清单与发布文件不一致。');
  for (const record of bundle.manifest.files) {
    const bytes = bundle.files.get(record.path);
    requireValue(Buffer.isBuffer(bytes) && bytes.length === record.bytes && sha256(bytes) === record.sha256, `待写文件校验失败：${record.path}`);
  }
  requireValue(bundle.files.size === bundle.manifest.files.length + 1, '发布包含未登记文件。');
  const releases = path.join(output, 'releases');
  await fs.mkdir(releases, { recursive: true });
  const target = path.join(releases, bundle.releaseID);
  let exists = false;
  try { await fs.access(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) await verifyReleaseDirectory(target, sha256(manifestBytes));
  else {
    const staging = await fs.mkdtemp(path.join(releases, '.staging-'));
    try {
      for (const [filePath, bytes] of bundle.files) {
        await fs.mkdir(path.dirname(path.join(staging, filePath)), { recursive: true });
        await fs.writeFile(path.join(staging, filePath), bytes, { flag: 'wx' });
      }
      await verifyReleaseDirectory(staging, sha256(manifestBytes));
      await fs.rename(staging, target);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  const latestPath = path.join(output, 'latest.json');
  let previous = null;
  try { previous = JSON.parse(await fs.readFile(latestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const latest = { schemaVersion: 1, releaseID: bundle.releaseID, manifestPath: `releases/${bundle.releaseID}/manifest.json`, manifestSha256: sha256(manifestBytes) };
  if (previous?.releaseID !== bundle.releaseID) await writeAtomicJSON(latestPath, latest);
  else requireValue(JSON.stringify(canonical(previous)) === JSON.stringify(canonical(latest)), '现有版本指针与发布内容不一致。');
  return { ...latest, reused: exists, bytes: bundle.totalBytes };
}

export async function verifyLatest(output) {
  const latest = JSON.parse(await fs.readFile(path.join(output, 'latest.json'), 'utf8'));
  requireValue(latest.schemaVersion === 1 && hashPattern.test(latest.releaseID) && hashPattern.test(latest.manifestSha256) && latest.manifestPath === `releases/${latest.releaseID}/manifest.json`, '当前版本指针无效。');
  const manifest = await verifyReleaseDirectory(path.join(output, 'releases', latest.releaseID), latest.manifestSha256);
  requireValue(manifest.releaseID === latest.releaseID, '当前版本与内容不一致。');
  return manifest;
}

export function searchIndex(index, query, limit = 10) {
  requireValue(index?.schemaVersion === 1 && Array.isArray(index.documents), '检索索引无效。');
  requireValue(typeof query === 'string' && query.length <= 256 && Number.isInteger(limit) && limit > 0 && limit <= 50, '检索参数无效。');
  const normalized = query.normalize('NFKC').toLowerCase().trim();
  if (!normalized) return [];
  const terms = new Set(normalized.match(/[a-z0-9][a-z0-9_.-]+/g) || []);
  for (const sequence of normalized.match(/[\u3400-\u9fff]+/g) || []) {
    if (sequence.length === 1) terms.add(sequence);
    else for (let offset = 0; offset < sequence.length - 1; offset++) terms.add(sequence.slice(offset, offset + 2));
  }
  const tokens = [...terms].slice(0, 64);
  return index.documents.flatMap(document => {
    const title = document.title.normalize('NFKC').toLowerCase();
    const text = document.text.normalize('NFKC').toLowerCase();
    const matchedTerms = tokens.filter(term => title.includes(term) || text.includes(term));
    if (!matchedTerms.length && !text.includes(normalized) && !title.includes(normalized)) return [];
    const score = (title.includes(normalized) ? 20 : 0) + (text.includes(normalized) ? 8 : 0) + matchedTerms.reduce((total, term) => total + (title.includes(term) ? 4 : 1), 0);
    const offset = Math.max(0, matchedTerms.map(term => text.indexOf(term)).filter(position => position >= 0).sort((left, right) => left - right)[0] - 60 || 0);
    return [{ id: document.id, title: document.title, url: document.url, path: document.path, lessonIDs: document.lessonIDs, score, matchedTerms, excerpt: document.text.slice(offset, offset + 240) }];
  }).sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).slice(0, limit);
}

async function limitedJSON(response, budget, maximum) {
  const chunks = [];
  let size = 0;
  requireValue(response.body, '公开来源没有返回正文。');
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      budget.downloadedBytes += result.value.length;
      requireValue(size <= maximum && budget.downloadedBytes <= budget.maxDownloadBytes, '采集已达到流量上限。');
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function previousSource(previous, source, maximum) {
  const cached = previous?.schemaVersion === 1 && Array.isArray(previous.sources) && previous.sources.find(item => item && item.id === source.id && item.repository === source.repository);
  if (!cached || !revisionPattern.test(cached.revision) || !revisionPattern.test(cached.treeSHA) || !Number.isFinite(Date.parse(cached.checkedAt)) || !Array.isArray(cached.candidates) || cached.candidates.length > maximum) return null;
  const pattern = new RegExp(source.candidatePattern);
  if (!cached.candidates.every(candidate => safePath(candidate.path) && pattern.test(candidate.path) && revisionPattern.test(candidate.blobSHA) && candidate.sourceID === source.id && candidate.revision === cached.revision && candidate.url === sourceURL(source.repository, cached.revision, candidate.path))) return null;
  if (source.licensePath && (!Object.hasOwn(cached, 'licenseFile') || (cached.licenseFile !== null && (!cached.licenseFile || cached.licenseFile.path !== source.licensePath || !revisionPattern.test(cached.licenseFile.blobSHA) || cached.licenseFile.url !== sourceURL(source.repository, cached.revision, source.licensePath))))) return null;
  return cached;
}

export async function discoverSources(registry, previous = null, fetcher = fetch, now = new Date()) {
  validateRegistry(registry);
  const started = Date.now();
  const checkedAt = now.toISOString();
  const budget = { ...registry.budget, requests: 0, downloadedBytes: 0 };
  async function request(url, etag) {
    requireValue(budget.requests < budget.maxRequests && budget.downloadedBytes < budget.maxDownloadBytes && Date.now() - started < budget.maxRunMs, '采集已达到本轮成本或时间上限。');
    budget.requests++;
    const headers = { Accept: 'application/vnd.github+json' };
    if (typeof etag === 'string' && etag.length < 200) headers['If-None-Match'] = etag;
    const remaining = Math.max(1, Math.min(budget.timeoutMs, budget.maxRunMs - (Date.now() - started)));
    const response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers, signal: AbortSignal.timeout(remaining) });
    requireValue(!response.url || response.url === url, '来源返回了未经审核的跳转。');
    if (response.status === 304) return { unchanged: true };
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`公开来源检查失败（HTTP ${response.status}）。`); }
    const declared = Number(response.headers.get('content-length'));
    if (declared && (declared > budget.maxResponseBytes || declared + budget.downloadedBytes > budget.maxDownloadBytes)) { await response.body?.cancel().catch(() => {}); throw new Error('采集已达到流量上限。'); }
    return { body: await limitedJSON(response, budget, budget.maxResponseBytes), etag: response.headers.get('etag') };
  }
  const sources = [];
  for (const source of registry.sources) {
    const cached = previousSource(previous, source, budget.maxCandidatesPerSource);
    try {
      const head = await request(`https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(source.branch)}`, cached?.headEtag);
      if (head.unchanged || (cached && head.body?.sha === cached.revision)) {
        requireValue(cached, '来源返回未变化状态但本地没有有效缓存。');
        sources.push({ ...cached, checkedAt, attemptedAt: checkedAt, status: 'unchanged', lastError: null, headEtag: head.etag || cached.headEtag });
        continue;
      }
      const revision = head.body?.sha;
      const treeSHA = head.body?.commit?.tree?.sha;
      requireValue(revisionPattern.test(revision) && revisionPattern.test(treeSHA), '来源版本或文件树无效。');
      const tree = await request(`https://api.github.com/repos/${source.repository}/git/trees/${treeSHA}?recursive=1`);
      requireValue(tree.body?.sha === treeSHA && tree.body.truncated === false && Array.isArray(tree.body.tree), '来源文件树不完整，保留上次发现记录。');
      const pattern = new RegExp(source.candidatePattern);
      const matches = tree.body.tree.filter(item => item.type === 'blob' && item.mode === '100644' && safePath(item.path) && pattern.test(item.path) && revisionPattern.test(item.sha)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      const candidates = matches.slice(0, budget.maxCandidatesPerSource).map(item => ({ id: source.id + ':' + sha256(item.path).slice(0, 16), sourceID: source.id, path: item.path, revision, blobSHA: item.sha, url: sourceURL(source.repository, revision, item.path), state: 'discovered', licenseStatus: 'not-checked' }));
      const licenseEntry = tree.body.tree.find(item => item.type === 'blob' && item.mode === '100644' && item.path === source.licensePath && revisionPattern.test(item.sha));
      const licenseFile = licenseEntry ? { path: licenseEntry.path, blobSHA: licenseEntry.sha, url: sourceURL(source.repository, revision, licenseEntry.path) } : null;
      const commitDate = head.body?.commit?.committer?.date;
      sources.push({ id: source.id, publisher: source.publisher, repository: source.repository, revision, treeSHA, checkedAt, attemptedAt: checkedAt, lastRepositoryCommitAt: Number.isFinite(Date.parse(commitDate)) ? commitDate : null, status: 'checked', lastError: null, headEtag: head.etag, totalMatchingFiles: matches.length, selectionLimited: candidates.length < matches.length, licenseFile, candidates });
    } catch (error) {
      sources.push({ ...(cached || { id: source.id, publisher: source.publisher, repository: source.repository, checkedAt: null, candidates: [] }), attemptedAt: checkedAt, status: cached ? 'stale' : 'unavailable', lastError: String(error.message).slice(0, 240) });
    }
  }
  return { schemaVersion: 1, checkedAt, budget: { requests: budget.requests, downloadedBytes: budget.downloadedBytes, maxRequests: budget.maxRequests, maxDownloadBytes: budget.maxDownloadBytes }, sources };
}
