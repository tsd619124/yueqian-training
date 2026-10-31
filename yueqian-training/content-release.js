// 原文资料库客户端：latest.json → manifest.json → documents/*.json → assets/<sha256>.<ext>。
// 协议为 schema v2 多来源：manifest.sources 逐来源登记仓库与版本；每篇原文的 document.source 指向自己的来源；
// 逐来源许可位于 licenses/<sourceID>.txt（可选），LICENSE.txt 保留为全部来源的合并说明。
// 校验策略（见 content-pipeline/BUNDLED-CONTENT-LIBRARY.md）：只对从网络下载的指针、清单与文件做字节数 + SHA-256 校验，
// 通过后写入 Cache API（yueqian-content-v1）与 IndexedDB；之后打开直接信任本机缓存，不再逐个重算哈希。
// 原图用普通 <img src> 地址加载；首次查看后后台存入缓存，离线时从缓存取出显示。
(function (root) {
  'use strict';

  const cacheName = 'yueqian-content-v1';
  const maximumFileBytes = 4 * 1024 * 1024;
  const maximumReleaseBytes = 25 * 1024 * 1024;
  const maximumSources = 8;
  const maximumFiles = 3000;
  const hashPattern = /^[a-f0-9]{64}$/;
  const revisionPattern = /^[a-f0-9]{40}$/;
  const sourceIDPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function assert(value, message) { if (!value) throw new Error(message); }
  function parse(bytes) { try { return JSON.parse(decoder.decode(bytes)); } catch { throw new Error('资料清单或原文编码无效。'); } }
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  async function digest(bytes) { return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); }
  function pointer(value) {
    assert(value?.schemaVersion === 1 && hashPattern.test(value.releaseID) && hashPattern.test(value.manifestSha256) && value.manifestPath === 'releases/' + value.releaseID + '/manifest.json', '资料版本指针无效。');
    return value;
  }
  // 发布文件白名单：多来源时逐来源许可为 licenses/<sourceID>.txt，其余路径与单来源版一致。
  function safeFilePath(value) {
    return typeof value === 'string' && !/[\\\u0000-\u001f\u007f]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..') && /^(?:assets\/[a-f0-9]{64}\.(?:png|jpg|webp)|documents\/[a-z0-9-]+\.json|licenses\/[a-z0-9][a-z0-9-]{0,79}\.txt|index\.json|coverage\.json|LICENSE\.txt)$/.test(value);
  }
  function endpoint(value, base = root.location?.href || 'http://localhost/') {
    assert(typeof value === 'string' && value.length > 0 && value.length <= 2048, '请填写资料服务地址。');
    const url = new URL(value, base);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    assert((url.protocol === 'https:' || url.protocol === 'http:' && loopback) && !url.username && !url.password && !url.search && !url.hash, '服务地址需为 HTTPS；本机调试可使用 localhost HTTP。');
    return url;
  }
  function baseURL(value) { const url = endpoint(value); if (!url.pathname.endsWith('/')) url.pathname += '/'; return url; }
  // 随应用发布的来源目录（external-catalog.js）：按 sourceID 登记仓库与发布者，原文与许可都必须能映射到这里的来源。
  function catalogSources(catalog) {
    assert(catalog?.schemaVersion === 2 && Array.isArray(catalog.sources) && catalog.sources.length > 0 && catalog.sources.length <= maximumSources && Array.isArray(catalog.articles), '资料来源配置无效。');
    const approved = new Map();
    for (const source of catalog.sources) {
      assert(source && typeof source.id === 'string' && sourceIDPattern.test(source.id) && !approved.has(source.id) && typeof source.publisher === 'string' && typeof source.repository === 'string' && source.repository.includes('/'), '资料来源配置无效。');
      approved.set(source.id, source);
    }
    return approved;
  }
  function sourceMap(manifest) {
    const sources = new Map();
    for (const source of manifest.sources) sources.set(source.id, source);
    return sources;
  }

  // 清单校验：哈希、确定性版本号、逐来源登记与课程关联必须与随站点发布的原文目录一致。
  // 多来源：manifest.sources 的每一项都必须映射到 catalog.sources；每篇文章的 sourceID 必须指向自己的来源；
  // 文章 URL 用该来源自己的 repository/revision；licenses/<id>.txt 只允许登记已声明来源的逐来源许可。
  async function manifestFor(latest, bytes, catalog) {
    pointer(latest);
    assert(bytes.length > 0 && bytes.length <= 1048576 && await digest(bytes) === latest.manifestSha256, '资料清单哈希校验失败。');
    const manifest = parse(bytes);
    assert(manifest.schemaVersion === 2 && manifest.releaseID === latest.releaseID && Array.isArray(manifest.sources) && manifest.sources.length > 0 && manifest.sources.length <= maximumSources, '资料清单版本或来源无效。');
    const { releaseID, ...content } = manifest;
    assert(await digest(encoder.encode(JSON.stringify(canonical(content)) + '\n')) === releaseID, '资料版本与内容哈希不一致。');
    const approved = catalogSources(catalog);
    const sources = new Map();
    for (const source of manifest.sources) {
      const definition = approved.get(source?.id);
      assert(source && definition && !sources.has(source.id) && source.repository === definition.repository && source.publisher === definition.publisher && revisionPattern.test(source.revision) && Number.isFinite(Date.parse(source.downloadedAt)), '资料发布来源未经审核。');
      sources.set(source.id, { id: source.id, publisher: source.publisher, repository: source.repository, revision: source.revision, downloadedAt: source.downloadedAt });
    }
    assert(Array.isArray(manifest.documents) && manifest.documents.length === catalog.articles.length && Array.isArray(manifest.files) && manifest.files.length <= maximumFiles, '资料清单未完整。');
    const paths = new Set();
    let total = 0;
    for (const record of manifest.files) {
      assert(record && safeFilePath(record.path) && !paths.has(record.path) && hashPattern.test(record.sha256) && Number.isInteger(record.bytes) && record.bytes > 0 && record.bytes <= maximumFileBytes, '资料文件记录无效。');
      paths.add(record.path); total += record.bytes;
    }
    const licenseIDs = [...paths].filter(path => path.startsWith('licenses/')).map(path => path.slice('licenses/'.length, -'.txt'.length));
    assert(licenseIDs.every(id => sources.has(id)), '资料许可文件与来源不一致。');
    assert(total <= maximumReleaseBytes && ['index.json', 'coverage.json', 'LICENSE.txt'].every(path => paths.has(path)), '资料大小或必要文件无效。');
    const ids = new Set();
    for (const [index, definition] of catalog.articles.entries()) {
      const document = manifest.documents[index];
      assert(document && approved.has(definition.sourceID) && sources.has(document.sourceID) && document.id === definition.id && !ids.has(document.id) && document.title === definition.title && document.sourceID === definition.sourceID && document.path === 'documents/' + definition.id + '.json' && paths.has(document.path) && JSON.stringify(document.lessonIDs) === JSON.stringify(definition.lessonIDs), '资料课程关联未经审核。');
      assert(document.url === root.YueqianMaterials.sourceURL(sources.get(document.sourceID), definition) && Number.isInteger(document.imageCount) && document.imageCount >= 0 && document.imageCount <= 24, '资料出处或配图记录无效。');
      ids.add(document.id);
    }
    const assetCount = manifest.files.filter(record => record.path.startsWith('assets/')).length;
    assert(assetCount === manifest.assetCount && manifest.imageReferences === manifest.documents.reduce((sum, item) => sum + item.imageCount, 0) && manifest.files.length === catalog.articles.length + assetCount + 3 + licenseIDs.length, '资料文件集合不完整。');
    return manifest;
  }

  // 单篇文档校验：先按文章自己的 sourceID 找到 manifest 来源，再核对来源字段、出处与配图路径。
  // 配图 URL 必须使用该来源自己的 revision/repository，而不是其它来源或全局单一版本。
  function checkDocument(state, document, catalog) {
    const manifest = state.manifest;
    const summary = manifest.documents.find(item => item.id === document?.id);
    const definition = catalog.articles.find(item => item.id === document?.id);
    const approved = catalogSources(catalog);
    const sources = sourceMap(manifest);
    const source = summary && sources.get(summary.sourceID);
    const definitionSource = definition && approved.get(definition.sourceID);
    const files = new Set(manifest.files.map(record => record.path));
    assert(summary && definition && definitionSource && source && summary.sourceID === definition.sourceID && document.schemaVersion === 1 && document.title === definition.title && JSON.stringify(document.lessonIDs) === JSON.stringify(definition.lessonIDs) && Array.isArray(document.images) && document.images.length === summary.imageCount, '原文定义与资料清单不一致。');
    assert(document.source?.id === source.id && document.source.publisher === definitionSource.publisher && document.source.repository === source.repository && document.source.revision === source.revision && document.source.path === definition.path && document.source.url === root.YueqianMaterials.sourceURL(source, definition) && document.source.url === summary.url && document.source.license === 'MIT' && document.source.downloadedAt === source.downloadedAt && document.source.rawURL === root.YueqianMaterials.rawURL(source.revision, definition.path, source.repository), '原文来源与资料清单不一致。');
    for (const image of document.images) assert(safeFilePath(image.path) && image.path.startsWith('assets/') && hashPattern.test(image.sha256) && image.path.slice(7).startsWith(image.sha256 + '.') && files.has(image.path) && typeof image.sourcePath === 'string' && typeof image.alt === 'string' && image.sourceURL === root.YueqianMaterials.rawURL(source.revision, image.sourcePath, source.repository), '原图来源与清单不一致。');
    return document;
  }

  async function fetchBytes(url, limit, fetcher, budget, cache = 'no-store') {
    const controller = new AbortController();
    let reader;
    let timer;
    const remaining = 120000 - (Date.now() - budget.startedAt);
    assert(remaining > 0, '资料更新超时。');
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reader?.cancel().catch(() => {}); reject(new Error('资料请求超时。')); }, Math.min(20000, remaining)); });
    const operation = (async () => {
      budget.requests++;
      const response = await fetcher(url.href, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache, signal: controller.signal });
      assert(response.ok && (!response.url || response.url === url.href), '资料来源无法访问或发生跳转（HTTP ' + response.status + '）。');
      assert(Number(response.headers.get('content-length')) <= limit, '资料文件超出大小限制。');
      const chunks = [];
      let length = 0;
      if (!response.body) { const bytes = new Uint8Array(await response.arrayBuffer()); chunks.push(bytes); length = bytes.length; budget.downloadedBytes += length; }
      else {
        reader = response.body.getReader();
        try {
          while (true) {
            const result = await reader.read();
            controller.signal.throwIfAborted();
            if (result.done) break;
            length += result.value.length; budget.downloadedBytes += result.value.length;
            assert(length <= limit && budget.downloadedBytes <= maximumReleaseBytes + 1048576, '资料更新超出流量限制。');
            chunks.push(result.value);
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      }
      assert(length > 0 && length <= limit && budget.downloadedBytes <= maximumReleaseBytes + 1048576, '资料文件为空或过大。');
      const bytes = new Uint8Array(length);
      let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    })();
    try { return await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
  }
  function newBudget() { return { requests: 0, downloadedBytes: 0, reusedFiles: 0, startedAt: Date.now() }; }

  // Cache API 封装；测试或不支持的环境可注入内存实现。
  let cacheStorage = () => root.caches;
  async function openCache() { const storage = cacheStorage(); return storage ? storage.open(cacheName) : null; }
  function fileURL(state, path) { return new URL('releases/' + state.latest.releaseID + '/' + path, state.base).href; }
  function record(state, path) { const value = state.manifest.files.find(item => item.path === path); assert(value, '资料清单中没有该文件：' + path); return value; }
  async function cachedBytes(url) {
    const cache = await openCache().catch(() => null);
    const response = cache && await cache.match(url).catch(() => null);
    return response ? new Uint8Array(await response.arrayBuffer()) : null;
  }
  async function storeBytes(url, bytes, type) {
    const cache = await openCache().catch(() => null);
    if (cache) await cache.put(url, new Response(bytes, { headers: { 'Content-Type': type, 'Content-Length': String(bytes.length) } })).catch(() => {});
  }
  const types = { json: 'application/json', txt: 'text/plain; charset=utf-8', webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' };
  function typeOf(path) { return types[path.split('.').pop()] || 'application/octet-stream'; }

  // 读取资料文件：先读本机缓存（信任，不再校验）；缓存缺失时下载，校验字节数与 SHA-256 后写入缓存。
  async function file(state, path, fetcher = fetch, budget = newBudget()) {
    const url = fileURL(state, path);
    const cached = await cachedBytes(url);
    if (cached) return cached;
    const expected = record(state, path);
    const bytes = await fetchBytes(new URL(url), expected.bytes, fetcher, budget, 'default');
    assert(bytes.length === expected.bytes && await digest(bytes) === expected.sha256, '资料文件校验失败：' + path);
    await storeBytes(url, bytes, typeOf(path));
    return bytes;
  }
  const documents = new Map();
  async function documentFor(state, id, catalog, fetcher = fetch) {
    const key = state.latest.releaseID + ':' + id;
    if (!documents.has(key)) {
      const summary = state.manifest.documents.find(item => item.id === id);
      assert(summary, '资料中没有这篇原文。');
      documents.set(key, file(state, summary.path, fetcher).then(bytes => checkDocument(state, parse(bytes), catalog)).catch(error => { documents.delete(key); throw error; }));
    }
    return documents.get(key);
  }
  function assetURL(state, path) { return fileURL(state, path); }
  // 后台把已显示的原图存入缓存（浏览器 HTTP 缓存命中时不重复下载），离线时可读。
  async function cacheAssets(state, paths, fetcher = fetch) {
    let stored = 0;
    for (const path of paths) {
      try { if (!(await cachedBytes(fileURL(state, path)))) { await file(state, path, fetcher); stored++; } } catch { /* 下次查看再试 */ }
    }
    return stored;
  }
  async function cachedAssetBlobURL(url) {
    const bytes = await cachedBytes(url);
    return bytes ? URL.createObjectURL(new Blob([bytes], { type: typeOf(url) })) : null;
  }

  // 首次打开（本机没有已校验版本）：读取指针与清单并校验，正文与原图按需读取。
  async function load(value, catalog, fetcher = fetch) {
    const base = baseURL(value);
    const budget = newBudget();
    const latest = pointer(parse(await fetchBytes(new URL('latest.json', base), 4096, fetcher, budget)));
    const manifest = await manifestFor(latest, await fetchBytes(new URL(latest.manifestPath, base), 1048576, fetcher, budget, 'default'), catalog);
    return { schemaVersion: 2, base: base.href, latest, manifest, verifiedAt: new Date().toISOString() };
  }

  // 已保存状态只做结构检查（不重算哈希）；结构异常时由调用方重新下载。旧 v1 清单在这里明确拒绝。
  function restore(saved) {
    assert(saved?.schemaVersion === 2 && typeof saved.base === 'string', '保存的资料版本无效。');
    const manifest = saved.manifest;
    assert(manifest?.schemaVersion === 2 && manifest.releaseID === pointer(saved.latest).releaseID && Array.isArray(manifest.documents) && Array.isArray(manifest.files) && Array.isArray(manifest.sources) && manifest.sources.length > 0 && manifest.sources.length <= maximumSources, '保存的资料版本无效。');
    const ids = new Set();
    for (const source of manifest.sources) {
      assert(source && sourceIDPattern.test(source.id) && !ids.has(source.id) && typeof source.repository === 'string' && revisionPattern.test(source.revision) && Number.isFinite(Date.parse(source.downloadedAt)), '保存的资料版本无效。');
      ids.add(source.id);
    }
    assert(manifest.documents.every(document => document && ids.has(document.sourceID)), '保存的资料版本无效。');
    return saved;
  }

  // 检查更新：版本相同只读指针；版本变化时校验新清单，下载并校验检索索引与全部正文，原图按哈希复用已缓存文件，
  // 全部通过后才返回新状态（由调用方原子保存）；任一步失败保留旧版本。
  async function refresh(value, current, catalog, fetcher = fetch, onProgress = () => {}) {
    const base = baseURL(value);
    const budget = newBudget();
    const latest = pointer(parse(await fetchBytes(new URL('latest.json', base), 4096, fetcher, budget)));
    if (current && current.base === base.href && latest.releaseID === current.latest.releaseID) {
      assert(latest.manifestSha256 === current.latest.manifestSha256, '相同版本的清单发生冲突。');
      return { state: current, changed: false, budget };
    }
    const manifest = await manifestFor(latest, await fetchBytes(new URL(latest.manifestPath, base), 1048576, fetcher, budget), catalog);
    const state = { schemaVersion: 2, base: base.href, latest, manifest, verifiedAt: new Date().toISOString() };
    const previousByHash = new Map((current?.manifest.files || []).map(item => [item.sha256, fileURL(current, item.path)]));
    const required = manifest.files.filter(item => !item.path.startsWith('assets/') && item.path !== 'coverage.json');
    for (const [offset, item] of manifest.files.entries()) {
      assert(Date.now() - budget.startedAt < 120000, '资料更新超时。');
      onProgress('正在校验 ' + (offset + 1) + ' / ' + manifest.files.length);
      const reuse = previousByHash.get(item.sha256);
      const bytes = reuse ? await cachedBytes(reuse) : null;
      if (bytes && bytes.length === item.bytes) { await storeBytes(fileURL(state, item.path), bytes, typeOf(item.path)); budget.reusedFiles++; }
      else if (required.includes(item)) {
        const downloaded = await fetchBytes(new URL(fileURL(state, item.path)), item.bytes, fetcher, budget);
        assert(downloaded.length === item.bytes && await digest(downloaded) === item.sha256, '资料文件校验失败：' + item.path);
        await storeBytes(fileURL(state, item.path), downloaded, typeOf(item.path));
      }
    }
    for (const summary of manifest.documents) checkDocument(state, parse(await file(state, summary.path, fetcher, budget)), catalog);
    return { state, changed: true, budget };
  }

  // 删除旧版本的缓存条目（新版本已复制需要复用的文件）。
  async function prune(state) {
    const cache = await openCache().catch(() => null);
    if (!cache) return 0;
    const keep = new URL('releases/' + state.latest.releaseID + '/', state.base).href;
    let removed = 0;
    for (const request of await cache.keys()) if (request.url.includes('/releases/') && !request.url.startsWith(keep)) { await cache.delete(request); removed++; }
    return removed;
  }

  // 逐来源读取许可：优先 licenses/<sourceID>.txt；未随发布提供时从合并的 LICENSE.txt 中截取该来源段落，
  // 仍找不到分段则以整份合并文本兜底（兼容 v1 单来源与将来新增来源）。
  async function licenseText(state, sourceID, fetcher = fetch) {
    const source = state.manifest.sources.find(item => item.id === sourceID);
    assert(source, '资料中没有该来源：' + sourceID);
    const path = 'licenses/' + source.id + '.txt';
    if (state.manifest.files.some(item => item.path === path)) return decoder.decode(await file(state, path, fetcher));
    const merged = decoder.decode(await file(state, 'LICENSE.txt', fetcher));
    const heading = new RegExp('^===== ' + source.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' =====$', 'm');
    const match = heading.exec(merged);
    if (!match) return merged;
    const rest = merged.slice(match.index + match[0].length);
    const next = /^===== .+ =====$/m.exec(rest);
    return (next ? rest.slice(0, next.index) : rest).trim();
  }
  async function licenseTexts(state, fetcher = fetch) {
    const values = [];
    for (const source of state.manifest.sources) values.push({ id: source.id, publisher: source.publisher, repository: source.repository, licenseText: await licenseText(state, source.id, fetcher) });
    return values;
  }

  // 本机检索用的轻量快照（schema v2）：sources 逐来源登记，articles 带自己的 sourceID 与纯文本（来自 index.json），不含原图。
  async function searchSnapshot(state, catalog, fetcher = fetch) {
    const index = parse(await file(state, 'index.json', fetcher));
    assert(index.schemaVersion === 1 && Array.isArray(index.documents) && index.documents.length === state.manifest.documents.length, '检索索引与资料不一致。');
    const sources = sourceMap(state.manifest);
    const articles = catalog.articles.map(definition => {
      const entry = index.documents.find(item => item.id === definition.id);
      const source = sources.get(definition.sourceID);
      assert(entry && source && typeof entry.text === 'string' && entry.sourceID === definition.sourceID, '检索索引与资料不一致。');
      return { ...definition, sourceID: source.id, markdown: entry.text };
    });
    return {
      schemaVersion: 2,
      sources: state.manifest.sources.map(source => ({ id: source.id, publisher: source.publisher, repository: source.repository, revision: source.revision, fetchedAt: source.downloadedAt })),
      articles
    };
  }

  root.YueqianContentRelease = {
    cacheName, endpoint, baseURL, safeFilePath, manifestFor, checkDocument, load, restore, refresh, prune, file, documentFor, assetURL, cacheAssets, cachedAssetBlobURL, licenseText, licenseTexts, searchSnapshot,
    setCacheStorage(provider) { cacheStorage = provider; documents.clear(); }
  };
})(globalThis);
