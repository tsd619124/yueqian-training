import { normalizeQuery, rankDocuments } from './search-common.mjs';

const encoder = new TextEncoder();
const revisionPattern = /^[a-f0-9]{40}$/u;
const defaults = { maxRequests: 3, maxDocumentBytes: 700000, maxDownloadBytes: 1500000, maxRunMs: 8000, maxDiscoveryAgeHours: 72 };

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function requireValue(condition, code) {
  if (!condition) fail(code);
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 1200 && !value.startsWith('/') && !value.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(value) && value.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

export function sourceURL(repository, revision, sourcePath, raw = false) {
  const encoded = sourcePath.split('/').map(encodeURIComponent).join('/');
  return raw ? `https://raw.githubusercontent.com/${repository}/${revision}/${encoded}` : `https://github.com/${repository}/blob/${revision}/${encoded}`;
}

export async function digest(algorithm, bytes) {
  return [...new Uint8Array(await crypto.subtle.digest(algorithm, bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function gitBlobSHA(bytes) {
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  const framed = new Uint8Array(header.byteLength + bytes.byteLength);
  framed.set(header);
  framed.set(bytes, header.byteLength);
  return digest('SHA-1', framed);
}

export function markdownText(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/gu, '').replace(/!\[([^\]]*)\]\([^\n)]*\)/gu, '$1').replace(/\[([^\]]+)\]\([^\n)]*\)/gu, '$1').replace(/<[^>]*>/gu, ' ').replace(/^\s*(?:#{1,6}\s+|```[^\n]*|~~~[^\n]*)/gmu, '').replace(/[*_`|]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function validateRegistry(registry) {
  requireValue(registry?.schemaVersion === 1 && Array.isArray(registry.sources) && registry.sources.length > 0 && registry.sources.length <= 6, 'invalid-registry');
  const ids = new Set();
  const repositories = new Set();
  for (const source of registry.sources) {
    requireValue(typeof source?.id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/u.test(source.id) && !ids.has(source.id), 'invalid-registry');
    requireValue(typeof source.repository === 'string' && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u.test(source.repository) && safePath(source.repository) && !repositories.has(source.repository), 'invalid-registry');
    requireValue(typeof source.candidatePattern === 'string' && source.candidatePattern.length <= 160 && source.candidatePattern.startsWith('^') && source.candidatePattern.endsWith('$'), 'invalid-registry');
    try { new RegExp(source.candidatePattern, 'u'); } catch { fail('invalid-registry'); }
    ids.add(source.id);
    repositories.add(source.repository);
  }
}

async function validatedCandidates(registry, discovery, timestamp, limits) {
  requireValue(discovery?.schemaVersion === 1 && Array.isArray(discovery.sources) && discovery.sources.length <= registry.sources.length, 'invalid-discovery');
  const foundIDs = new Set();
  for (const found of discovery.sources) {
    requireValue(registry.sources.some(source => source.id === found?.id && source.repository === found.repository) && !foundIDs.has(found.id), 'invalid-discovery');
    foundIDs.add(found.id);
  }
  const candidates = [];
  const sources = [];
  const failures = [];
  for (const source of registry.sources) {
    const found = discovery.sources.find(item => item.id === source.id);
    if (!found || !['checked', 'unchanged'].includes(found.status)) {
      sources.push({ id: source.id, status: 'unavailable', checkedAt: found?.checkedAt || null });
      failures.push({ sourceID: source.id, reason: 'source-unavailable' });
      continue;
    }
    const checkedAt = Date.parse(found.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt > timestamp || timestamp - checkedAt > limits.maxDiscoveryAgeHours * 3600000) {
      sources.push({ id: source.id, status: 'expired', checkedAt: found.checkedAt || null });
      failures.push({ sourceID: source.id, reason: checkedAt > timestamp ? 'invalid-discovery' : 'source-expired' });
      continue;
    }
    try {
      const maximumCandidates = Math.min(registry.budget?.maxCandidatesPerSource || 80, 250);
      requireValue(revisionPattern.test(found.revision) && Array.isArray(found.candidates) && found.candidates.length <= maximumCandidates && typeof found.selectionLimited === 'boolean' && Number.isInteger(found.totalMatchingFiles) && found.totalMatchingFiles >= found.candidates.length, 'invalid-discovery');
      requireValue(found.selectionLimited || found.totalMatchingFiles === found.candidates.length, 'invalid-discovery');
      const paths = new Set();
      const entries = [];
      for (const candidate of found.candidates) {
        requireValue(candidate?.sourceID === source.id && candidate.revision === found.revision && revisionPattern.test(candidate.blobSHA) && safePath(candidate.path) && !paths.has(candidate.path), 'invalid-discovery');
        requireValue(new RegExp(source.candidatePattern, 'u').test(candidate.path) && candidate.url === sourceURL(source.repository, found.revision, candidate.path), 'invalid-discovery');
        requireValue(candidate.id === source.id + ':' + (await digest('SHA-256', encoder.encode(candidate.path))).slice(0, 16), 'invalid-discovery');
        paths.add(candidate.path);
        entries.push({ ...candidate, repository: source.repository, publisher: source.publisher || source.id, checkedAt: found.checkedAt, title: candidate.path.replace(/(?:^|\/)README\.md$/iu, '').replace(/\.md$/iu, '').replace(/[-_/]/gu, ' '), text: '' });
      }
      candidates.push(...entries);
      sources.push({ id: source.id, status: 'ready', checkedAt: found.checkedAt, candidateCount: entries.length, totalMatchingFiles: found.totalMatchingFiles, selectionLimited: found.selectionLimited });
    } catch (error) {
      sources.push({ id: source.id, status: 'invalid', checkedAt: found.checkedAt });
      failures.push({ sourceID: source.id, reason: error.code || 'invalid-discovery' });
    }
  }
  return { candidates, sources, failures };
}

export async function discoveryCandidates(registry, discovery, timestamp = Date.now(), maxDiscoveryAgeHours = defaults.maxDiscoveryAgeHours) {
  validateRegistry(registry);
  requireValue(Number.isInteger(maxDiscoveryAgeHours) && maxDiscoveryAgeHours > 0, 'invalid-limits');
  return validatedCandidates(registry, discovery, timestamp, { ...defaults, maxDiscoveryAgeHours });
}

export async function validateDiscovery(registry, discovery, timestamp = Date.now()) {
  validateRegistry(registry);
  const result = await validatedCandidates(registry, discovery, timestamp, defaults);
  requireValue(result.failures.length === 0, 'invalid-or-expired-discovery');
  return result;
}

export function createExternalSearch({ registry, discovery, topics, fetcher = fetch, now = () => Date.now(), limits = {} }) {
  validateRegistry(registry);
  const budgetLimits = { ...defaults, ...limits };
  for (const [name, maximum] of Object.entries(defaults)) requireValue(Number.isInteger(budgetLimits[name]) && budgetLimits[name] > 0 && budgetLimits[name] <= maximum, 'invalid-limits');

  return async function externalSearch(query, { limit = 10 } = {}) {
    const normalized = normalizeQuery(query);
    requireValue(Number.isInteger(limit) && limit > 0 && limit <= 50, 'invalid-limit');
    const timestamp = Number(now());
    requireValue(Number.isFinite(timestamp), 'invalid-clock');
    const checkedAt = new Date(timestamp).toISOString();
    const budget = { requests: 0, downloadedBytes: 0 };
    const scope = { method: 'configured-repository-paths-then-verified-body', coverageLimited: true, fullWebSearch: false, candidateCount: 0, matchedCandidates: 0, selectedCandidates: 0, inspectedDocuments: 0, sources: [], failures: [] };
    const controller = new AbortController();
    let activeReader = null;
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        activeReader?.cancel().catch(() => {});
        const error = new Error('timeout');
        error.code = 'timeout';
        reject(error);
      }, budgetLimits.maxRunMs);
    });
    const results = [];
    const guarded = operation => Promise.race([operation, deadline]);

    try {
      const found = await guarded(validatedCandidates(registry, discovery, timestamp, budgetLimits));
      scope.sources = found.sources;
      scope.failures.push(...found.failures);
      scope.candidateCount = found.candidates.length;
      const ranked = rankDocuments(found.candidates, normalized, topics, 1500);
      scope.matchedCandidates = ranked.length;
      const selected = ranked.slice(0, Math.min(budgetLimits.maxRequests, limit));
      scope.selectedCandidates = selected.length;
      for (const candidate of selected) {
        if (controller.signal.aborted) break;
        try {
          const document = await guarded((async () => {
            controller.signal.throwIfAborted();
            requireValue(budget.downloadedBytes < budgetLimits.maxDownloadBytes, 'download-budget');
            budget.requests++;
            const url = sourceURL(candidate.repository, candidate.revision, candidate.path, true);
            const response = await fetcher(url, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { Accept: 'text/plain' }, signal: controller.signal });
            controller.signal.throwIfAborted();
            if (!response.ok || (response.url && response.url !== url)) {
              await response.body?.cancel().catch(() => {});
              fail(response.status === 429 || response.status === 403 ? 'upstream-rate-limited' : 'upstream-unavailable');
            }
            const declaredLength = Number(response.headers.get('content-length'));
            if (declaredLength > budgetLimits.maxDocumentBytes || declaredLength + budget.downloadedBytes > budgetLimits.maxDownloadBytes) {
              await response.body?.cancel().catch(() => {});
              fail('download-budget');
            }
            requireValue(response.body, 'empty-body');
            const reader = response.body.getReader();
            activeReader = reader;
            const chunks = [];
            let size = 0;
            try {
              while (true) {
                const chunk = await reader.read();
                controller.signal.throwIfAborted();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                budget.downloadedBytes += chunk.value.byteLength;
                requireValue(size <= budgetLimits.maxDocumentBytes && budget.downloadedBytes <= budgetLimits.maxDownloadBytes, 'download-budget');
                chunks.push(chunk.value);
              }
            } catch (error) {
              await reader.cancel().catch(() => {});
              throw error;
            } finally { activeReader = null; }
            requireValue(size > 0, 'empty-body');
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            requireValue(await gitBlobSHA(bytes) === candidate.blobSHA, 'integrity-failed');
            const sha256 = await digest('SHA-256', bytes);
            controller.signal.throwIfAborted();
            let markdown;
            try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid-encoding'); }
            const title = markdownText(/^\s*#{1,6}\s+(.+)$/mu.exec(markdown)?.[1] || candidate.title);
            return { id: candidate.id, title, text: markdownText(markdown), path: candidate.path, url: candidate.url, sourceID: candidate.sourceID, publisher: candidate.publisher, repository: candidate.repository, revision: candidate.revision, sha256, kind: 'external', reviewStatus: 'unreviewed', checkedAt: candidate.checkedAt, downloadedAt: new Date(Number(now())).toISOString() };
          })());
          scope.inspectedDocuments++;
          const matches = rankDocuments([document], normalized, topics, 1);
          for (const match of matches) {
            const { text, ...result } = match;
            results.push(result);
          }
        } catch (error) {
          scope.failures.push({ sourceID: candidate.sourceID, documentID: candidate.id, reason: controller.signal.aborted ? 'timeout' : error.code || 'upstream-unavailable' });
          if (controller.signal.aborted || budget.downloadedBytes >= budgetLimits.maxDownloadBytes) break;
        }
      }
    } catch (error) { scope.failures.push({ reason: controller.signal.aborted ? 'timeout' : error.code || 'invalid-discovery' }); }
    finally { clearTimeout(timer); }

    const successfulInspection = scope.inspectedDocuments > 0 || (scope.selectedCandidates === 0 && scope.sources.some(source => source.status === 'ready'));
    const status = scope.failures.length ? successfulInspection ? 'partial' : 'unavailable' : 'ok';
    return { status, results: results.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, 'en')).slice(0, limit), reason: scope.failures[0]?.reason || null, checkedAt, scope, budget };
  };
}
