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
  let cacheWriting = Promise.resolve();
  function normalize(value) {
    if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('检索词需为 1–256 字。');
    const query = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!query || !/[\p{L}\p{N}]/u.test(query)) throw new Error('请输入检索词。');
    return query;
  }
  function text(markdown) { return markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, ' ').replace(/[#*_`|]/g, ' ').replace(/\s+/g, ' ').trim(); }
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
      return [{ id: article.id, title: article.title, excerpt: body.slice(offset, offset + 240), url: root.YueqianMaterials.sourceURL(snapshot, article), repository: snapshot.repository, revision: snapshot.revision, sourceID: 'microsoft-genai', kind: 'library', reviewStatus: 'approved', score: matched.length + (article.title.toLowerCase().includes(query) ? 20 : 0), checkedAt: null }];
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 20);
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
  async function search({ query: value, snapshot, releaseID, searchURL, fetcher = fetch }) {
    const query = normalize(value);
    const library = local(snapshot, query);
    if (!searchURL) return { library, external: [], degraded: false, message: '已搜索保存的原文。可在服务连接中接入联网检索。', cache: 'none' };
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
      return entry ? { library: combine(entry.value), external: entry.value.external, degraded: true, cache: 'stale', message: '联网检索未完成，正在显示此前保存的检索结果。' } : { library, external: [], degraded: true, cache: 'miss', message: '联网检索未完成，已保留本机原文结果。' };
    }
  }
  root.YueqianMaterialSearch = { normalize, local, search, validItem };
})(globalThis);
