(function (root) {
  'use strict';
  const repositories = {
    'microsoft-genai': 'microsoft/generative-ai-for-beginners',
    'microsoft-agents': 'microsoft/ai-agents-for-beginners',
    'openai-cookbook': 'openai/openai-cookbook'
  };
  const aliases = [
    ['上下文工程', 'context engineering'], ['智能体', 'agent', 'agents'], ['记忆', 'memory'],
    ['向量数据库', 'vector database', 'vector'], ['检索增强', 'retrieval augmented', 'rag'],
    ['函数调用', 'function calling'], ['工具调用', 'tool calling'], ['评测', 'evaluation'],
    ['提示工程', 'prompt engineering'], ['多模态', 'multimodal'], ['微调', 'fine tuning']
  ];
  const legacySearchURLs = ['https://yueqian-content-search.ricardofeng619.workers.dev/api/search'];
  const indexKey = 'search-index-v1';
  const maximumIndexBytes = 4 * 1024 * 1024;
  const hex40 = /^[a-f0-9]{40}$/;
  const hex64 = /^[a-f0-9]{64}$/;
  let cacheWriting = Promise.resolve();
  let indexMemory = null;
  let indexRefreshing = null;
  function normalize(value) {
    if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('检索词需为 1–256 字。');
    const query = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!query || !/[\p{L}\p{N}]/u.test(query)) throw new Error('请输入检索词。');
    return query;
  }
  function text(markdown) { return markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, ' ').replace(/[#*_`|]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function sourceFor(snapshot, article) {
    if (Array.isArray(snapshot.sources)) return snapshot.sources.find(source => source.id === article.sourceID) || snapshot.sources[0];
    return { id: 'microsoft-genai', repository: snapshot.repository, revision: snapshot.revision };
  }
  function local(snapshot, value) {
    const query = normalize(value);
    const terms = new Set([query, ...(query.match(/[a-z0-9][a-z0-9_.-]*/g) || [])]);
    for (const sequence of query.match(/[\u3400-\u9fff]+/g) || []) for (let i = 0; i < sequence.length - 1; i++) terms.add(sequence.slice(i, i + 2));
    for (const group of aliases) if (group.some(alias => query.includes(alias))) for (const alias of group) terms.add(alias);
    return snapshot.articles.flatMap(article => {
      const body = text(article.markdown);
      const haystack = (article.title + ' ' + body).toLowerCase();
      const matched = [...terms].filter(term => haystack.includes(term));
      if (!matched.length) return [];
      const positions = matched.map(term => body.toLowerCase().indexOf(term)).filter(index => index >= 0);
      const offset = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 50);
      const source = sourceFor(snapshot, article);
      return [{ id: article.id, title: article.title, excerpt: body.slice(offset, offset + 240), url: root.YueqianMaterials.sourceURL(snapshot, article), repository: source.repository, revision: source.revision, sourceID: source.id, kind: 'library', reviewStatus: 'approved', score: matched.length + (article.title.toLowerCase().includes(query) ? 20 : 0), checkedAt: null }];
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 20);
  }
  // 与 content-pipeline/search-common.mjs 的 queryTerms / rankDocuments 逐行一致，改动需同步三端并重跑一致性测试。
  function tokens(value) {
    const english = value.match(/[a-z0-9][a-z0-9_.-]*/gu) || [];
    const stopWords = new Set(['a', 'an', 'and', 'are', 'for', 'how', 'in', 'is', 'of', 'the', 'to', 'what', 'with']);
    const result = english.filter(term => !stopWords.has(term));
    for (const sequence of value.match(/[\u3400-\u9fff]+/gu) || []) {
      if (sequence.length === 1) result.push(sequence);
      else for (let offset = 0; offset < sequence.length - 1; offset++) result.push(sequence.slice(offset, offset + 2));
    }
    return result;
  }
  function queryTerms(query, configuration = { topics: [] }) {
    const normalized = normalize(query);
    const direct = [...new Set(tokens(normalized))].slice(0, 64);
    const expanded = new Set();
    for (const topic of configuration.topics || []) {
      const aliases = [topic.id, topic.title, ...topic.terms].map(term => term.normalize('NFKC').toLowerCase());
      if (aliases.some(term => term && normalized.includes(term))) for (const term of aliases) {
        expanded.add(term);
        for (const token of tokens(term.replace(/-/gu, ' '))) expanded.add(token);
      }
    }
    return { normalized, direct, expanded: [...expanded].filter(term => !direct.includes(term)).slice(0, 100) };
  }
  function includesTerm(text, term) {
    if (!/^[a-z0-9_.-]+$/u.test(term)) return text.includes(term);
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'u').test(text);
  }
  function rankDocuments(documents, query, configuration, limit = 10) {
    const { normalized, direct, expanded } = queryTerms(query, configuration);
    return documents.flatMap(document => {
      const title = (document.title || '').normalize('NFKC').toLowerCase();
      const text = (document.text || '').normalize('NFKC').toLowerCase();
      const sourcePath = (document.path || '').normalize('NFKC').toLowerCase().replace(/[-_/]/gu, ' ');
      const matchedTerms = [...direct, ...expanded].filter(term => includesTerm(title + ' ' + sourcePath + ' ' + text, term));
      if (!matchedTerms.length) return [];
      const score = (title.includes(normalized) ? 20 : 0) + (text.includes(normalized) ? 8 : 0) + matchedTerms.reduce((total, term) => total + (direct.includes(term) ? 2 : 1) * (includesTerm(title, term) ? 4 : includesTerm(sourcePath, term) ? 3 : 1), 0);
      const original = document.text || '';
      const lowerOriginal = original.toLowerCase();
      const positions = matchedTerms.map(term => lowerOriginal.indexOf(term)).filter(position => position >= 0);
      const offset = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 60);
      return [{ ...document, score, matchedTerms, excerpt: original.slice(offset, offset + 280) }];
    }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, 'en')).slice(0, limit);
  }
  function isLegacySearchURL(value) { return typeof value === 'string' && legacySearchURLs.includes(value.trim()); }
  function invalidIndex(condition) { if (!condition) throw new Error('官方来源索引未通过校验，继续使用上一版。'); }
  function isoTime(value) { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)); }
  function documentURL(repository, revision, path) { return 'https://github.com/' + repository + '/blob/' + revision + '/' + path.split('/').map(encodeURIComponent).join('/'); }
  function indexPointer(value) {
    invalidIndex(value && value.schemaVersion === 1 && hex64.test(value.indexSha256) && value.indexPath === 'search/index-' + value.indexSha256 + '.json' && Number.isInteger(value.bytes) && value.bytes > 0 && value.bytes <= maximumIndexBytes && isoTime(value.generatedAt) && Number.isInteger(value.documentCount) && value.documentCount >= 0 && value.documentCount <= 400);
    return { schemaVersion: 1, indexPath: value.indexPath, indexSha256: value.indexSha256, bytes: value.bytes, generatedAt: value.generatedAt, documentCount: value.documentCount };
  }
  function validIndex(value, pointer) {
    invalidIndex(value && value.schemaVersion === 1 && value.kind === 'external-candidates' && value.reviewStatus === 'unreviewed' && isoTime(value.generatedAt) && Array.isArray(value.sources) && Array.isArray(value.topics) && Array.isArray(value.documents));
    invalidIndex(value.sources.length <= Object.keys(repositories).length && value.topics.length <= 100 && value.documents.length <= 400 && (!pointer || value.documents.length === pointer.documentCount));
    const sources = new Set();
    for (const source of value.sources) {
      invalidIndex(source && typeof source === 'object' && repositories[source.id] === source.repository && !sources.has(source.id) && hex40.test(source.revision) && isoTime(source.checkedAt) && ['ready', 'retained', 'partial'].includes(source.status) && Number.isInteger(source.documentCount) && source.documentCount >= 0 && Number.isInteger(source.totalMatchingFiles) && source.totalMatchingFiles >= 0 && typeof source.selectionLimited === 'boolean');
      sources.add(source.id);
    }
    for (const topic of value.topics) invalidIndex(topic && typeof topic.id === 'string' && typeof topic.title === 'string' && Array.isArray(topic.terms) && topic.terms.every(term => typeof term === 'string'));
    const ids = new Set();
    for (const document of value.documents) {
      invalidIndex(document && typeof document.id === 'string' && document.id.length > 0 && document.id.length <= 200 && !ids.has(document.id) && sources.has(document.sourceID) && repositories[document.sourceID] === document.repository && hex40.test(document.revision) && typeof document.path === 'string' && document.path.length > 0 && !/[\\\u0000-\u001f\u007f]/.test(document.path) && document.path.split('/').every(part => part && part !== '.' && part !== '..') && document.url === documentURL(document.repository, document.revision, document.path) && hex40.test(document.blobSHA) && hex64.test(document.sha256) && typeof document.title === 'string' && document.title.length <= 400 && typeof document.text === 'string' && document.text.length <= 12000);
      ids.add(document.id);
    }
    return value;
  }
  async function sha256(bytes) { return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); }
  function parseBytes(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('官方来源索引编码无效，继续使用上一版。'); } }
  async function fetchLimited(url, limit, fetcher, milliseconds) {
    const controller = new AbortController();
    let reader;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reader?.cancel().catch(() => {}); reject(new Error('官方来源索引下载超时。')); }, milliseconds); });
    const operation = (async () => {
      const response = await fetcher(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok || response.url && response.url !== url.href) throw new Error('官方来源索引暂时无法访问。');
      if (Number(response.headers.get('content-length')) > limit) throw new Error('官方来源索引超出大小限制。');
      const chunks = [];
      let size = 0;
      if (response.body) {
        reader = response.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read(); controller.signal.throwIfAborted();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > limit) throw new Error('官方来源索引超出大小限制。');
            chunks.push(chunk.value);
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      } else { const bytes = new Uint8Array(await response.arrayBuffer()); size = bytes.length; chunks.push(bytes); }
      if (!size || size > limit) throw new Error('官方来源索引为空或过大。');
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    })();
    try { return await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
  }
  async function cachedIndex() {
    if (indexMemory) return indexMemory;
    try {
      const saved = await root.YueqianMaterials.cachedValue(indexKey);
      if (!saved || saved.schemaVersion !== 1) return null;
      const pointer = indexPointer(saved.pointer);
      validIndex(saved.index, pointer);
      indexMemory = { schemaVersion: 1, pointer, index: saved.index, savedAt: isoTime(saved.savedAt) ? saved.savedAt : null };
      return indexMemory;
    } catch { return null; }
  }
  function online() { return root.navigator?.onLine !== false; }
  async function refreshIndex({ contentBaseURL, fetcher = fetch } = {}) {
    if (indexRefreshing) return indexRefreshing;
    indexRefreshing = (async () => {
      const current = await cachedIndex();
      if (!online()) return { status: 'offline', state: current };
      try {
        const base = root.YueqianContentRelease.baseURL(contentBaseURL);
        const pointer = indexPointer(parseBytes(await fetchLimited(new URL('search/latest.json', base), 4096, fetcher, 15000)));
        if (current && current.pointer.indexSha256 === pointer.indexSha256) return { status: 'current', state: current };
        const bytes = await fetchLimited(new URL(pointer.indexPath, base), pointer.bytes, fetcher, 60000);
        invalidIndex(bytes.length === pointer.bytes && await sha256(bytes) === pointer.indexSha256);
        const index = validIndex(parseBytes(bytes), pointer);
        const state = { schemaVersion: 1, pointer, index, savedAt: new Date().toISOString() };
        await root.YueqianMaterials.cachedValue(indexKey, state);
        indexMemory = state;
        return { status: 'updated', state };
      } catch (error) { return { status: 'failed', state: current, error }; }
    })();
    try { return await indexRefreshing; } finally { indexRefreshing = null; }
  }
  function indexTime(state) { return new Date(state.index.generatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); }
  function indexResults(state, query, limit = 10) {
    const checkedAt = new Map(state.index.sources.map(source => [source.id, source.checkedAt]));
    return rankDocuments(state.index.documents, query, { topics: state.index.topics }, limit).map(item => ({ id: item.id, title: item.title, excerpt: item.excerpt, url: item.url, repository: item.repository, revision: item.revision, sourceID: item.sourceID, kind: 'external', reviewStatus: 'unreviewed', sha256: item.sha256, score: item.score, checkedAt: checkedAt.get(item.sourceID) || null }));
  }
  async function staticExternal(query, contentBaseURL, fetcher) {
    let state = await cachedIndex();
    if (!state && contentBaseURL && online()) state = (await refreshIndex({ contentBaseURL, fetcher })).state;
    if (!state) return { state: null, external: [], message: online() ? '官方来源索引暂未获取，已显示本机原文结果。' : '官方来源索引尚未下载，联网后自动获取。' };
    return { state, external: indexResults(state, query), message: '已搜索保存的原文与官方来源索引（更新于 ' + indexTime(state) + '）。' };
  }
  function validItem(item, kind) {
    if (!item || item.kind !== kind || item.reviewStatus !== (kind === 'external' ? 'unreviewed' : 'approved') || typeof item.id !== 'string' || item.id.length > 200 || typeof item.title !== 'string' || item.title.length > 400 || typeof item.excerpt !== 'string' || item.excerpt.length > 1500 || repositories[item.sourceID] !== item.repository || !/^[a-f0-9]{40}$/.test(item.revision)) return false;
    if (kind === 'external' && !/^[a-f0-9]{64}$/.test(item.sha256)) return false;
    try {
      const url = new URL(item.url);
      const prefix = '/' + item.repository + '/blob/' + item.revision + '/';
      return url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith(prefix) && url.pathname.length > prefix.length && !/%2e|%2f|%5c/i.test(url.pathname);
    } catch { return false; }
  }
  function responseValue(value, query, releaseID) {
    if (value?.schemaVersion !== 1 || normalize(value.query) !== query || value.releaseID !== releaseID || !['none', 'miss', 'fresh', 'stale'].includes(value.cache?.status) || !Array.isArray(value.library?.results) || !Array.isArray(value.external?.results) || value.library.results.length > 20 || value.external.results.length > 20 || !value.library.results.every(item => validItem(item, 'library')) || !value.external.results.every(item => validItem(item, 'external'))) throw new Error('检索服务返回的来源或内容版本无效。');
    const stale = value.cache.status === 'stale';
    const savedAt = Date.parse(value.cache.savedAt ?? value.generatedAt);
    if (!Number.isFinite(savedAt) || savedAt > Date.now() + 60000 || Date.now() - savedAt > 86400000 || stale && !value.cache.savedAt) throw new Error('检索缓存时间无效。');
    return { query, releaseID, library: value.library.results, external: value.external.results, degraded: value.degraded === true || stale, reason: typeof value.reason === 'string' ? value.reason.slice(0, 100) : null, stale, savedAt: Math.min(savedAt, Date.now()) };
  }
  async function readCache() {
    try {
      const saved = await root.YueqianMaterials.cachedValue('search-cache-v1');
      if (saved?.schemaVersion === 1 && Array.isArray(saved.entries) && saved.entries.length <= 48) return saved.entries;
    } catch {}
    return [];
  }
  async function cached(key, query, releaseID) {
    const entry = (await readCache()).find(item => item.key === key);
    if (!entry || !Number.isFinite(entry.savedAt) || entry.savedAt > Date.now() || Date.now() - entry.savedAt > 86400000) return null;
    try {
      if (entry.value.query !== query || entry.value.releaseID !== releaseID || entry.value.savedAt !== entry.savedAt || typeof entry.value.stale !== 'boolean' || !Array.isArray(entry.value.library) || !Array.isArray(entry.value.external) || entry.value.library.length > 20 || entry.value.external.length > 20 || !entry.value.library.every(item => validItem(item, 'library')) || !entry.value.external.every(item => validItem(item, 'external'))) return null;
      return entry;
    } catch { return null; }
  }
  async function saveCache(key, value) {
    cacheWriting = cacheWriting.catch(() => {}).then(async () => {
      const entries = (await readCache()).filter(item => item.key !== key && Date.now() - item.savedAt <= 86400000);
      entries.push({ key, savedAt: value.savedAt, value });
      await root.YueqianMaterials.cachedValue('search-cache-v1', { schemaVersion: 1, entries: entries.slice(-48) });
    });
    return cacheWriting;
  }
  async function remote(url, fetcher, query, releaseID) {
    const controller = new AbortController();
    let reader;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reader?.cancel().catch(() => {}); reject(new Error('联网检索超时。')); }, 12000); });
    const operation = (async () => {
      const response = await fetcher(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok || response.url && response.url !== url.href) throw new Error('联网检索暂时不可用。');
      if (Number(response.headers.get('content-length')) > 1048576) throw new Error('检索响应过大。');
      const chunks = [];
      let size = 0;
      if (response.body) {
        reader = response.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read(); controller.signal.throwIfAborted();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 1048576) throw new Error('检索响应过大。');
            chunks.push(chunk.value);
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      } else { const bytes = new Uint8Array(await response.arrayBuffer()); size = bytes.length; chunks.push(bytes); }
      if (size > 1048576 || !size) throw new Error('检索响应为空或过大。');
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return responseValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), query, releaseID);
    })();
    try { return await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
  }
  async function search({ query: value, snapshot, releaseID, searchURL, contentBaseURL = null, fetcher = fetch }) {
    const query = normalize(value);
    const library = local(snapshot, query);
    if (isLegacySearchURL(searchURL)) searchURL = null;
    if (!searchURL) {
      const indexed = await staticExternal(query, contentBaseURL, fetcher);
      return { library, external: indexed.external, degraded: false, message: indexed.message, cache: indexed.state ? 'index' : 'none', indexGeneratedAt: indexed.state?.index.generatedAt || null };
    }
    const endpoint = root.YueqianContentRelease.endpoint(searchURL);
    const key = releaseID + ':' + endpoint.href + ':' + query;
    const entry = await cached(key, query, releaseID);
    function combine(value) {
      const map = new Map(library.map(item => [item.url, item]));
      for (const item of value.library) if (!map.has(item.url)) map.set(item.url, item);
      return [...map.values()].slice(0, 20);
    }
    if (entry && !entry.value.stale && Date.now() - entry.savedAt < 300000) return { ...entry.value, library: combine(entry.value), cache: 'fresh', message: entry.value.degraded ? '联网资料暂不完整，已保留可用结果。' : '已搜索保存资料与配置的官方来源。' };
    endpoint.search = new URLSearchParams({ q: query, scope: 'all', limit: '10' }).toString();
    try {
      const value = await remote(endpoint, fetcher, query, releaseID);
      if (value.degraded && entry) return { library: combine(entry.value), external: entry.value.external, degraded: true, cache: 'stale', message: '联网检索受限，正在显示此前保存的检索结果。' };
      try { await saveCache(key, value); } catch {}
      return { ...value, library: combine(value), cache: value.stale ? 'stale' : 'miss', message: value.stale ? '联网检索受限，正在显示此前保存的检索结果。' : value.degraded ? '联网资料暂不完整，已保留可用结果。' : '已搜索保存资料与配置的官方来源。' };
    } catch {
      if (entry) return { library: combine(entry.value), external: entry.value.external, degraded: true, cache: 'stale', message: '联网检索未完成，正在显示此前保存的检索结果。' };
      const indexed = await staticExternal(query, null, fetcher);
      return indexed.state ? { library, external: indexed.external, degraded: true, cache: 'index', message: '联网检索未完成，' + indexed.message } : { library, external: [], degraded: true, cache: 'miss', message: '联网检索未完成，已保留本机原文结果。' };
    }
  }
  root.YueqianMaterialSearch = { normalize, local, search, validItem, queryTerms, rankDocuments, validIndex, indexPointer, refreshIndex, cachedIndex, indexResults, isLegacySearchURL, resetIndexMemory: () => { indexMemory = null; } };
})(globalThis);
