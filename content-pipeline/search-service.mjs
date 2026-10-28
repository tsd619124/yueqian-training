import { normalizeQuery, rankDocuments } from './search-common.mjs';

const defaults = {
  cacheTtlMs: 300000, maxStaleMs: 86400000, maxCacheEntries: 128,
  windowMs: 60000, requestsPerClient: 30, requestsPerWindow: 120,
  externalQueriesPerWindow: 10, maxClients: 1000, externalTimeoutMs: 8500
};

export function createMemoryCache(maximum = 128) {
  const entries = new Map();
  return {
    async get(key) { return entries.has(key) ? structuredClone(entries.get(key)) : null; },
    async put(key, entry) {
      entries.delete(key);
      entries.set(key, structuredClone(entry));
      while (entries.size > maximum) entries.delete(entries.keys().next().value);
    }
  };
}

function safeExternalResult(result, sources) {
  const source = sources.find(item => item.id === result.sourceID);
  if (!source || result.kind !== 'external' || result.reviewStatus !== 'unreviewed' || result.repository !== source.repository || !/^[a-f0-9]{40}$/u.test(result.revision) || !/^[a-f0-9]{64}$/u.test(result.sha256)) return false;
  try {
    const url = new URL(result.url);
    return url.origin === 'https://github.com' && !url.search && !url.hash && url.pathname.startsWith(`/${source.repository}/blob/${result.revision}/`) && typeof result.title === 'string' && typeof result.excerpt === 'string' && result.excerpt.length <= 1000;
  } catch { return false; }
}

function publicExternal(result) {
  const { id, title, url, sourceID, publisher, repository, revision, sha256, path, score, matchedTerms, excerpt, checkedAt, downloadedAt } = result;
  return { id, title, url, sourceID, publisher, repository, revision, sha256, path, score, matchedTerms, excerpt, checkedAt, downloadedAt, kind: 'external', reviewStatus: 'unreviewed' };
}

export function createSearchService({ index, releaseID, bundleID = releaseID, sources, topics, externalSearch, cache, limits: overrides = {}, now = () => Date.now() }) {
  if (index?.schemaVersion !== 1 || !Array.isArray(index.documents) || !/^[a-f0-9]{64}$/u.test(releaseID) || !/^[a-f0-9]{64}$/u.test(bundleID) || !Array.isArray(sources)) throw new Error('检索内容包格式无效。');
  const limits = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(limits)) if (!(key in defaults) || !Number.isInteger(value) || value <= 0 || value > defaults[key]) throw new Error('检索限制超出允许范围：' + key);
  if (limits.maxStaleMs < limits.cacheTtlMs) throw new Error('缓存保留时间不能短于有效时间。');
  const store = cache || createMemoryCache(limits.maxCacheEntries);
  const clients = new Map();
  const pending = new Map();
  let windowStart = now();
  let requests = 0;
  let externalQueries = 0;
  let cooldownUntil = 0;

  function consume(clientID, timestamp) {
    if (timestamp - windowStart >= limits.windowMs || timestamp < windowStart) { windowStart = timestamp; requests = 0; externalQueries = 0; }
    for (const [key, value] of clients) if (timestamp - value.startedAt >= limits.windowMs) clients.delete(key);
    const client = clients.get(clientID);
    if (requests >= limits.requestsPerWindow || (!client && clients.size >= limits.maxClients) || (client && client.count >= limits.requestsPerClient)) return false;
    requests++;
    clients.set(clientID, { startedAt: client?.startedAt ?? timestamp, count: (client?.count || 0) + 1 });
    return true;
  }

  async function cached(key, timestamp) {
    try {
      const entry = await store.get(key);
      if (!entry || !Number.isFinite(entry.createdAt) || entry.createdAt > timestamp || timestamp - entry.createdAt > limits.maxStaleMs || !['ok', 'partial'].includes(entry.value?.status) || !Array.isArray(entry.value.results) || !entry.value.results.every(result => safeExternalResult(result, sources))) return null;
      return entry;
    } catch { return null; }
  }

  async function lookup(query, key) {
    const timestamp = now();
    let timer;
    try {
      const result = await Promise.race([
        externalSearch(query, { limit: 20 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), limits.externalTimeoutMs); })
      ]);
      if (!['ok', 'partial', 'unavailable'].includes(result?.status) || !Array.isArray(result.results) || result.results.length > 20 || !result.results.every(item => safeExternalResult(item, sources))) throw new Error('invalid-result');
      const value = { ...result, results: result.results.map(publicExternal) };
      if (value.status === 'ok' || (value.status === 'partial' && value.results.length)) {
        try {
          const previous = await cached(key, now());
          if (value.status === 'ok' || !previous) await store.put(key, { createdAt: now(), value });
        } catch { value.cacheWarning = 'cache-write-failed'; }
      }
      if (value.status !== 'ok') cooldownUntil = now() + Math.min(30000, limits.windowMs);
      return value;
    } catch (error) {
      cooldownUntil = now() + Math.min(30000, limits.windowMs);
      return { status: 'unavailable', results: [], reason: error.message === 'timeout' ? 'timeout' : 'upstream-unavailable', checkedAt: new Date(timestamp).toISOString() };
    } finally { clearTimeout(timer); }
  }

  async function search({ query: input, scope = 'all', limit = 10 }, { clientID = 'local' } = {}) {
    const query = normalizeQuery(input);
    if (!['all', 'library', 'external'].includes(scope) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('scope 或 limit 参数无效。');
    const timestamp = now();
    const allowed = consume(String(clientID).slice(0, 128), timestamp);
    const localResults = scope === 'external' ? [] : rankDocuments(index.documents, query, topics, limit).map(result => {
      const source = sources.find(item => item.id === result.sourceID);
      const { id, title, url, path, sourceID, lessonIDs, score, matchedTerms, excerpt } = result;
      return { id, title, url, path, sourceID, publisher: source?.publisher, lessonIDs, score, matchedTerms, excerpt, repository: source?.repository, revision: source?.revision, kind: 'library', reviewStatus: 'approved' };
    });
    const key = `${bundleID}:${query}`;
    const entry = scope === 'library' ? null : await cached(key, timestamp);
    let cacheStatus = 'none';
    let external = { status: 'not-requested', results: [] };
    let reason = allowed ? null : 'rate-limited';
    let savedAt = null;
    if (scope !== 'library') {
      if (entry && timestamp - entry.createdAt < limits.cacheTtlMs) {
        external = entry.value; cacheStatus = 'fresh'; savedAt = entry.createdAt;
      } else if (!allowed || externalQueries >= limits.externalQueriesPerWindow || timestamp < cooldownUntil || !externalSearch) {
        reason ||= !externalSearch ? 'external-not-configured' : timestamp < cooldownUntil ? 'upstream-cooldown' : 'external-budget';
        external = entry ? entry.value : { status: 'unavailable', results: [], reason };
        cacheStatus = entry ? 'stale' : 'miss'; savedAt = entry?.createdAt ?? null;
      } else {
        let operation = pending.get(key);
        if (!operation) {
          externalQueries++;
          operation = lookup(query, key);
          pending.set(key, operation);
          operation.finally(() => pending.delete(key));
        }
        const live = await operation;
        if (live.status !== 'ok' && entry) {
          const combined = new Map(entry.value.results.map(item => [item.url, item]));
          for (const item of live.results) combined.set(item.url, item);
          external = { ...live, results: [...combined.values()] };
          cacheStatus = 'stale'; savedAt = entry.createdAt;
          reason ||= live.reason || 'partial-upstream';
        } else { external = live; cacheStatus = 'miss'; }
      }
      reason ||= external.status === 'ok' ? null : external.reason || 'partial-upstream';
    }
    const approvedURLs = new Set(localResults.map(item => item.url));
    external = { ...external, results: external.results.filter(item => !approvedURLs.has(item.url)).slice(0, limit) };
    const degraded = Boolean(reason) || cacheStatus === 'stale';
    return {
      statusCode: !allowed && !localResults.length && !external.results.length ? 429 : scope === 'external' && external.status === 'unavailable' && !external.results.length ? 503 : 200,
      retryAfter: !allowed || reason === 'external-budget' || reason === 'upstream-cooldown' ? Math.max(1, Math.ceil((Math.max(windowStart + limits.windowMs, (clients.get(String(clientID).slice(0, 128))?.startedAt ?? windowStart) + limits.windowMs, cooldownUntil) - now()) / 1000)) : null,
      body: {
        schemaVersion: 1, query, scope, releaseID, generatedAt: new Date(now()).toISOString(),
        method: 'keyword-with-topic-aliases', degraded, reason,
        library: { status: scope === 'external' ? 'not-requested' : 'ok', results: localResults }, external,
        results: [...localResults, ...external.results].slice(0, limit),
        cache: { status: cacheStatus, savedAt: savedAt === null ? null : new Date(savedAt).toISOString(), ttlSeconds: limits.cacheTtlMs / 1000, maxStaleSeconds: limits.maxStaleMs / 1000 }
      }
    };
  }
  return { search, info: { releaseID, documents: index.documents.length, method: 'keyword-with-topic-aliases', rateLimitScope: 'process-or-worker-isolate' } };
}

export function createSearchHandler(service, { allowedOrigin = null } = {}) {
  return async function handle(request, { clientID = 'local' } = {}) {
    const origin = request.headers.get('origin');
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (allowedOrigin && origin === allowedOrigin) { headers['access-control-allow-origin'] = allowedOrigin; headers.vary = 'Origin'; }
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    const url = new URL(request.url);
    if (!['/api/search', '/health'].includes(url.pathname)) return reply({ error: 'not-found' }, 404);
    if (request.method === 'OPTIONS' && origin === allowedOrigin) return new Response(null, { status: 204, headers: { ...headers, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '600' } });
    if (request.method !== 'GET') { headers.allow = 'GET, OPTIONS'; return reply({ error: 'method-not-allowed' }, 405); }
    if (url.pathname === '/health') return reply({ status: 'ok', ...service.info });
    if (request.url.length > 2048 || [...url.searchParams.keys()].some(key => !['q', 'scope', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1)) return reply({ error: 'invalid-parameters' }, 400);
    const limit = url.searchParams.get('limit');
    if (limit !== null && !/^(?:[1-9]|1[0-9]|20)$/u.test(limit)) return reply({ error: 'invalid-limit' }, 400);
    try {
      const result = await service.search({ query: url.searchParams.get('q'), scope: url.searchParams.get('scope') || 'all', limit: limit === null ? 10 : Number(limit) }, { clientID });
      if (result.retryAfter) headers['retry-after'] = String(result.retryAfter);
      return reply(result.body, result.statusCode);
    } catch { return reply({ error: 'invalid-query', message: '请使用 1–256 字检索词、scope=all/library/external，以及 1–20 的 limit。' }, 400); }
  };
}
