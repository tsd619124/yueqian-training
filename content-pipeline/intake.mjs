import { createHash } from 'node:crypto';
import { sha256, sourceURL, validateRegistry } from './lib.mjs';

const revisionPattern = /^[a-f0-9]{40}$/;
const defaults = { maxDocumentsPerRun: 6, maxDocumentBytes: 700000, maxStoredBytes: 16777216, maxDiscoveryAgeHours: 72 };

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function gitBlobSHA(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function validateDocument(document, registry) {
  const source = registry.sources.find(item => item.id === document?.sourceID);
  requireValue(source && document.repository === source.repository && revisionPattern.test(document.revision), '正文来源或版本无效。');
  sourceURL(source.repository, document.revision, document.path);
  requireValue(new RegExp(source.candidatePattern).test(document.path) && document.id === source.id + ':' + sha256(document.path).slice(0, 16), '正文路径或 ID 无效。');
  const maximum = (registry.collection || defaults).maxDocumentBytes;
  requireValue(typeof document.markdown === 'string' && Buffer.byteLength(document.markdown) > 0 && Buffer.byteLength(document.markdown) <= maximum && sha256(document.markdown) === document.sha256 && gitBlobSHA(Buffer.from(document.markdown)) === document.blobSHA, '正文缓存完整性校验失败。');
  requireValue(Number.isFinite(Date.parse(document.downloadedAt)), '正文下载时间无效。');
  if (document.license !== null) {
    const license = document.license;
    requireValue(license?.path === source.licensePath && revisionPattern.test(license.revision) && typeof license.text === 'string' && Buffer.byteLength(license.text) <= maximum && sha256(license.text) === license.sha256 && gitBlobSHA(Buffer.from(license.text)) === license.blobSHA && Number.isFinite(Date.parse(license.downloadedAt)), '许可证缓存完整性校验失败。');
  }
  return document;
}

export function documentVersion(document) {
  return sha256(JSON.stringify([document.sourceID, document.repository, document.path, document.blobSHA, document.sha256, document.license?.path, document.license?.blobSHA, document.license?.sha256]));
}

function validateDiscovery(registry, discovery) {
  requireValue(discovery?.schemaVersion === 1 && Array.isArray(discovery.sources), '请先运行 discover，生成有效的候选目录。');
  const identities = new Set();
  for (const found of discovery.sources) {
    const source = registry.sources.find(item => item.id === found?.id && item.repository === found.repository);
    requireValue(source && !identities.has(found.id) && Array.isArray(found.candidates) && found.candidates.length <= registry.budget.maxCandidatesPerSource, '候选来源无效或重复。');
    identities.add(found.id);
    requireValue(['checked', 'unchanged', 'stale', 'unavailable'].includes(found.status), '候选来源状态无效。');
    if (found.status === 'unavailable') continue;
    requireValue(revisionPattern.test(found.revision) && Number.isFinite(Date.parse(found.checkedAt)) && typeof found.selectionLimited === 'boolean', '候选目录缺少版本、时间或完整性状态。');
    requireValue(Object.hasOwn(found, 'licenseFile'), '候选目录缺少许可证元数据，请重新运行 discover。');
    if (found.licenseFile !== null) requireValue(found.licenseFile?.path === source.licensePath && revisionPattern.test(found.licenseFile.blobSHA) && found.licenseFile.url === sourceURL(source.repository, found.revision, source.licensePath), '许可证来源无效。');
    const paths = new Set();
    for (const candidate of found.candidates) {
      requireValue(candidate && candidate.sourceID === source.id && candidate.revision === found.revision && revisionPattern.test(candidate.blobSHA), '候选版本无效。');
      requireValue(candidate.url === sourceURL(source.repository, found.revision, candidate.path) && new RegExp(source.candidatePattern).test(candidate.path) && candidate.id === source.id + ':' + sha256(candidate.path).slice(0, 16) && !paths.has(candidate.path), '候选路径、ID 或来源无效。');
      paths.add(candidate.path);
    }
  }
}

function cachedEntries(previous, registry) {
  const entries = new Map();
  const cacheErrors = [];
  if (previous === null) return { entries, cacheErrors };
  if (previous?.schemaVersion !== 1 || !Array.isArray(previous.documents) || previous.documents.length > 1500) return { entries, cacheErrors: ['正文缓存目录无效，重新采集。'] };
  for (const entry of previous.documents) {
    try {
      requireValue(!entries.has(entry?.id), '正文缓存 ID 重复。');
      if (entry.current) validateDocument(entry.current, registry);
      if (entry.previous) validateDocument(entry.previous, registry);
      requireValue(entry.current && entry.id === entry.current.id && (!entry.previous || entry.previous.id === entry.id), '正文缓存记录无效。');
      entries.set(entry.id, entry);
    } catch (error) { cacheErrors.push(String(error.message)); }
  }
  return { entries, cacheErrors };
}

function reconcileEntries(entries, registry, discovery, now = new Date()) {
  const maximumAge = (registry.collection?.maxDiscoveryAgeHours || defaults.maxDiscoveryAgeHours) * 3600000;
  const sourceStates = registry.sources.map(source => {
    const found = discovery.sources.find(item => item.id === source.id);
    const expired = found?.checkedAt && now.getTime() - Date.parse(found.checkedAt) > maximumAge;
    return { id: source.id, status: expired ? 'expired' : found?.status || 'unavailable', checkedAt: found?.checkedAt || null, revision: found?.revision || null, selectionLimited: found?.selectionLimited ?? true, totalMatchingFiles: found?.totalMatchingFiles ?? null, candidates: found?.candidates.length || 0 };
  });
  for (const [identity, entry] of entries) {
    const found = discovery.sources.find(source => source.id === entry.current.sourceID);
    const candidate = found?.candidates.find(item => item.id === identity);
    const healthy = sourceStates.some(source => source.id === entry.current.sourceID && ['checked', 'unchanged'].includes(source.status));
    const sameLicense = found?.licenseFile ? found.licenseFile.blobSHA === entry.current.license?.blobSHA : found?.licenseFile === null && entry.current.license === null;
    const status = !healthy ? 'stale' : !candidate ? (found.selectionLimited ? 'unverified' : 'removed') : candidate.blobSHA === entry.current.blobSHA && sameLicense ? 'ready' : 'pending';
    entries.set(identity, { ...entry, status, lastError: null, verifiedAt: healthy ? found.checkedAt : entry.verifiedAt, verifiedRevision: healthy ? found.revision : entry.verifiedRevision });
  }
  return sourceStates;
}

function collectionScope(entries, discovery, sourceStates) {
  const candidates = discovery.sources.flatMap(source => source.candidates);
  return { discovered: candidates.length, collected: [...entries.values()].filter(entry => entry.status === 'ready').length, remaining: candidates.filter(candidate => entries.get(candidate.id)?.status !== 'ready').length, complete: candidates.length > 0 && candidates.every(candidate => entries.get(candidate.id)?.status === 'ready') && sourceStates.every(source => !source.selectionLimited && ['checked', 'unchanged'].includes(source.status)) };
}

export function reconcileIntake(registry, discovery, intake, now = new Date()) {
  validateRegistry(registry);
  validateDiscovery(registry, discovery);
  requireValue(intake?.schemaVersion === 1 && Array.isArray(intake.documents), '请先运行 collect，采集候选正文。');
  const { entries, cacheErrors } = cachedEntries(intake, registry);
  requireValue(cacheErrors.length === 0, '正文缓存完整性校验失败，请先运行 collect 修复。');
  const sourceStates = reconcileEntries(entries, registry, discovery, now);
  return { ...intake, sourceStates, scope: collectionScope(entries, discovery, sourceStates), documents: [...entries.values()] };
}

export async function collectDocuments(registry, discovery, previous = null, options = {}, fetcher = fetch, now = new Date()) {
  validateRegistry(registry);
  validateDiscovery(registry, discovery);
  const limits = { ...defaults, ...registry.collection };
  const limit = options.limit ?? limits.maxDocumentsPerRun;
  requireValue(Number.isInteger(limit) && limit > 0 && limit <= limits.maxDocumentsPerRun, '正文批量超出配置上限。');
  requireValue(!options.sourceID || registry.sources.some(source => source.id === options.sourceID), '指定来源不存在。');
  requireValue(!options.paths || (options.sourceID && Array.isArray(options.paths) && options.paths.length > 0 && options.paths.every(value => typeof value === 'string')), '指定路径时需要来源 ID。');
  const started = Date.now();
  const attemptedAt = now.toISOString();
  const budget = { ...registry.budget, ...limits, requests: 0, downloadedBytes: 0 };
  const { entries, cacheErrors } = cachedEntries(previous, registry);
  const licenses = new Map();
  for (const entry of entries.values()) if (entry.current.license) licenses.set(entry.current.sourceID + ':' + entry.current.license.blobSHA, entry.current.license);

  async function requestText(url, expectedSHA) {
    requireValue(budget.requests < budget.maxRequests && budget.downloadedBytes < budget.maxDownloadBytes && Date.now() - started < budget.maxRunMs, '正文采集已达到本轮成本或时间上限。');
    budget.requests++;
    const remaining = Math.max(1, Math.min(budget.timeoutMs, budget.maxRunMs - (Date.now() - started)));
    const response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'text/plain' }, signal: AbortSignal.timeout(remaining) });
    const maximum = Math.min(limits.maxDocumentBytes, budget.maxResponseBytes);
    if (!response.ok || (response.url && response.url !== url)) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`固定版本正文下载失败（HTTP ${response.status}）。`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared > maximum || declared + budget.downloadedBytes > budget.maxDownloadBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error('正文采集已达到流量上限。');
    }
    requireValue(response.body, '来源没有返回正文。');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        budget.downloadedBytes += result.value.length;
        requireValue(size <= maximum && budget.downloadedBytes <= budget.maxDownloadBytes && Date.now() - started < budget.maxRunMs, '正文采集已达到流量或时间上限。');
        chunks.push(Buffer.from(result.value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    requireValue(bytes.length > 0 && gitBlobSHA(bytes) === expectedSHA, '下载字节与 Git blob SHA 不一致。');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }

  const candidates = discovery.sources.flatMap(source => source.candidates);
  const sourceStates = reconcileEntries(entries, registry, discovery, now);

  const groups = discovery.sources.filter(source => sourceStates.some(state => state.id === source.id && ['checked', 'unchanged'].includes(state.status)) && (!options.sourceID || source.id === options.sourceID)).map(source => source.candidates.filter(candidate => (!options.paths || options.paths.includes(candidate.path)) && entries.get(candidate.id)?.status !== 'ready').sort((left, right) => Number(!entries.has(left.id)) - Number(!entries.has(right.id)) || left.path.localeCompare(right.path)));
  if (options.paths) requireValue(options.paths.every(sourcePath => candidates.some(candidate => candidate.sourceID === options.sourceID && candidate.path === sourcePath)), '指定路径不在发现目录中。');
  const selected = [];
  while (selected.length < limit && groups.some(group => group.length)) for (const group of groups) if (group.length && selected.length < limit) selected.push(group.shift());
  const failures = [];
  for (const candidate of selected) {
    const found = discovery.sources.find(source => source.id === candidate.sourceID);
    const source = registry.sources.find(item => item.id === candidate.sourceID);
    const cached = entries.get(candidate.id);
    try {
      let license = null;
      if (found.licenseFile) {
        const licenseKey = source.id + ':' + found.licenseFile.blobSHA;
        if (!licenses.has(licenseKey)) {
          try {
            const text = await requestText(sourceURL(source.repository, found.revision, source.licensePath, true), found.licenseFile.blobSHA);
            licenses.set(licenseKey, { path: source.licensePath, revision: found.revision, blobSHA: found.licenseFile.blobSHA, sha256: sha256(text), text, downloadedAt: attemptedAt });
          } catch (error) { licenses.set(licenseKey, { error }); }
        }
        license = licenses.get(licenseKey);
        if (license.error) throw license.error;
      }
      const markdown = cached?.current.blobSHA === candidate.blobSHA ? cached.current.markdown : await requestText(sourceURL(source.repository, candidate.revision, candidate.path, true), candidate.blobSHA);
      const current = validateDocument({ id: candidate.id, sourceID: source.id, repository: source.repository, path: candidate.path, revision: candidate.revision, blobSHA: candidate.blobSHA, sha256: sha256(markdown), markdown, downloadedAt: cached?.current.blobSHA === candidate.blobSHA ? cached.current.downloadedAt : attemptedAt, license }, registry);
      const previousDocument = cached?.current && documentVersion(cached.current) !== documentVersion(current) ? cached.current : cached?.previous || null;
      const next = { id: current.id, current, previous: previousDocument, status: 'ready', attemptedAt, verifiedAt: found.checkedAt, verifiedRevision: found.revision, lastError: null };
      const storedBytes = Buffer.byteLength(JSON.stringify([...entries.values()].filter(entry => entry.id !== next.id).concat(next)));
      requireValue(storedBytes <= limits.maxStoredBytes - 16384, '正文缓存已达到存储上限，保留旧版本。');
      entries.set(candidate.id, next);
    } catch (error) {
      const message = String(error.message).slice(0, 240);
      failures.push({ documentID: candidate.id, sourceID: source.id, path: candidate.path, error: message });
      if (cached) entries.set(candidate.id, { ...cached, status: 'stale', attemptedAt, lastError: message });
    }
  }
  const documents = [...entries.values()].sort((left, right) => left.id.localeCompare(right.id));
  const result = { schemaVersion: 1, attemptedAt, budget, selected: selected.length, failures, cacheErrors, sourceStates, scope: collectionScope(entries, discovery, sourceStates), documents };
  requireValue(Buffer.byteLength(JSON.stringify(result)) <= limits.maxStoredBytes, '正文缓存已达到存储上限，未写入。');
  return result;
}
