import bundle from './search-bundle.json' with { type: 'json' };
import { createExternalSearch, validateDiscovery } from './external-search.mjs';
import { createMemoryCache, createSearchHandler, createSearchService } from './search-service.mjs';

function workerCache(storage) {
  const memory = createMemoryCache(128);
  const cacheKey = async key => {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return new Request('https://yueqian-search.invalid/cache/' + hash);
  };
  return {
    async get(key) {
      try {
        const saved = await storage?.default?.match(await cacheKey(key));
        if (saved) return await saved.json();
      } catch { /* Cache API 无法使用时，保留当前 isolate 的有界内存缓存。 */ }
      return memory.get(key);
    },
    async put(key, entry) {
      await memory.put(key, entry);
      try {
        await storage?.default?.put(await cacheKey(key), new Response(JSON.stringify(entry), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' } }));
      } catch { /* 缓存不可用不影响本次检索结果。 */ }
    }
  };
}

export function createWorkerHandler(content, { fetcher = fetch, cacheStorage = globalThis.caches, allowedOrigin = null, limits = {}, now = () => Date.now() } = {}) {
  const externalSearch = createExternalSearch({ registry: content.registry, discovery: content.discovery, topics: content.topics, fetcher, now });
  const service = createSearchService({ ...content, externalSearch, cache: workerCache(cacheStorage), limits, now });
  const handler = createSearchHandler(service, { allowedOrigin });
  return request => handler(request, { clientID: request.headers.get('cf-connecting-ip') || 'unknown' });
}

export function createLiveWorker(content, { fetcher = fetch, now = () => Date.now(), cacheStorage = globalThis.caches } = {}) {
  let handler;
  let configuration;
  let current = content;
  let nextCheck = 0;
  let refreshing;
  let discoveryStatus = 'bundled';
  const refresh = async address => {
    nextCheck = now() + 3600000;
    try {
      const response = await fetcher(address, { redirect: 'manual', signal: AbortSignal.timeout(5000), cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error('discovery-unavailable');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1048576) throw new Error('discovery-too-large');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const discovery = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      await validateDiscovery(content.registry, discovery, now());
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const bundleID = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content.releaseID + hash)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (current.bundleID !== bundleID) { current = { ...content, discovery, bundleID }; handler = null; }
      discoveryStatus = 'remote-verified';
    } catch { discoveryStatus = 'retained-after-refresh-failure'; }
  };
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      if (env.ASSETS && !url.pathname.startsWith('/api/') && url.pathname !== '/health') return env.ASSETS.fetch(request);
      const allowedOrigin = env.ALLOWED_ORIGIN || null;
      const discoveryURL = env.DISCOVERY_URL || null;
      const externalRequest = env.EXTERNAL_SEARCH_ENABLED !== 'false' && url.pathname === '/api/search' && url.searchParams.get('scope') !== 'library';
      if (discoveryURL && externalRequest && now() >= nextCheck && /^https:\/\//u.test(discoveryURL)) {
        refreshing ||= refresh(discoveryURL).finally(() => { refreshing = null; });
        await refreshing;
      }
      const nextConfiguration = JSON.stringify([allowedOrigin, env.EXTERNAL_SEARCH_ENABLED !== 'false']);
      if (!handler || configuration !== nextConfiguration) {
        configuration = nextConfiguration;
        handler = createWorkerHandler(env.EXTERNAL_SEARCH_ENABLED === 'false' ? { ...current, discovery: null } : current, { allowedOrigin, fetcher, now, cacheStorage });
      }
      const response = await handler(request);
      if (url.pathname !== '/health' || !response.ok) return response;
      return Response.json({ ...await response.json(), discoveryStatus, discoveryCheckedAt: current.discovery?.sources?.map(source => ({ id: source.id, checkedAt: source.checkedAt })) || [], externalSearchEnabled: env.EXTERNAL_SEARCH_ENABLED !== 'false' }, { headers: response.headers });
    }
  };
}

export default createLiveWorker(bundle);
