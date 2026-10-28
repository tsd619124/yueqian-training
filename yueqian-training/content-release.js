(function (root) {
  'use strict';

  const maximumFileBytes = 4 * 1024 * 1024;
  const maximumReleaseBytes = 25 * 1024 * 1024;
  const hashPattern = /^[a-f0-9]{64}$/;
  const revisionPattern = /^[a-f0-9]{40}$/;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function assert(value, message) { if (!value) throw new Error(message); }
  function decode(value, maximum = maximumFileBytes) {
    assert(typeof value === 'string' && value.length <= Math.ceil(maximum / 3) * 4, '资料文件大小无效。');
    let bytes;
    try { bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
    catch { throw new Error('资料文件编码无效。'); }
    assert(bytes.length > 0 && bytes.length <= maximum && encode(bytes) === value, '资料文件编码或大小无效。');
    return bytes;
  }
  function encode(bytes) {
    let value = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(value);
  }
  function parse(bytes) { try { return JSON.parse(decoder.decode(bytes)); } catch { throw new Error('资料清单或原文编码无效。'); } }
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  async function digest(bytes) { return root.YueqianMaterials.digest(bytes); }
  function pointer(value) {
    assert(value?.schemaVersion === 1 && hashPattern.test(value.releaseID) && hashPattern.test(value.manifestSha256) && value.manifestPath === 'releases/' + value.releaseID + '/manifest.json', '资料版本指针无效。');
    return value;
  }
  function safeFilePath(value) {
    return typeof value === 'string' && !/[\\\u0000-\u001f\u007f]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..') && /^(?:assets\/[a-f0-9]{64}\.(?:png|jpg|webp)|documents\/[a-z0-9-]+\.json|index\.json|coverage\.json|LICENSE\.txt)$/.test(value);
  }
  function endpoint(value, base = root.location?.href || 'http://localhost/') {
    assert(typeof value === 'string' && value.length > 0 && value.length <= 2048, '请填写资料服务地址。');
    const url = new URL(value, base);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    assert((url.protocol === 'https:' || url.protocol === 'http:' && loopback) && !url.username && !url.password && !url.search && !url.hash, '服务地址需为 HTTPS；本机调试可使用 localhost HTTP。');
    return url;
  }
  function baseURL(value) { const url = endpoint(value); if (!url.pathname.endsWith('/')) url.pathname += '/'; return url; }
  async function manifestFor(latest, manifestBase64, catalog) {
    pointer(latest);
    const bytes = decode(manifestBase64, 1048576);
    assert(await digest(bytes) === latest.manifestSha256, '资料清单哈希校验失败。');
    const manifest = parse(bytes);
    assert(manifest.schemaVersion === 1 && manifest.releaseID === latest.releaseID && Array.isArray(manifest.sources) && manifest.sources.length === 1, '资料清单版本或来源无效。');
    const { releaseID, ...content } = manifest;
    assert(await digest(encoder.encode(JSON.stringify(canonical(content)) + '\n')) === releaseID, '资料版本与内容哈希不一致。');
    const source = manifest.sources[0];
    assert(source.id === 'microsoft-genai' && source.repository === catalog.repository && revisionPattern.test(source.revision) && Number.isFinite(Date.parse(source.downloadedAt)), '资料发布来源未经审核。');
    assert(Array.isArray(manifest.documents) && manifest.documents.length === catalog.articles.length && Array.isArray(manifest.files) && manifest.files.length <= 200, '资料清单未完整。');
    const paths = new Set();
    let total = 0;
    for (const record of manifest.files) {
      assert(safeFilePath(record.path) && !paths.has(record.path) && hashPattern.test(record.sha256) && Number.isInteger(record.bytes) && record.bytes > 0 && record.bytes <= maximumFileBytes, '资料文件记录无效。');
      paths.add(record.path); total += record.bytes;
    }
    assert(total <= maximumReleaseBytes && ['index.json', 'coverage.json', 'LICENSE.txt'].every(path => paths.has(path)), '资料大小或必要文件无效。');
    const ids = new Set();
    for (const [index, definition] of catalog.articles.entries()) {
      const document = manifest.documents[index];
      assert(document && document.id === definition.id && !ids.has(document.id) && document.title === definition.title && document.sourceID === source.id && document.path === 'documents/' + definition.id + '.json' && paths.has(document.path) && JSON.stringify(document.lessonIDs) === JSON.stringify(definition.lessonIDs), '资料课程关联未经审核。');
      const expectedURL = root.YueqianMaterials.sourceURL({ revision: source.revision }, definition);
      assert(document.url === expectedURL && Number.isInteger(document.imageCount) && document.imageCount >= 0 && document.imageCount <= 24, '资料出处或配图记录无效。');
      ids.add(document.id);
    }
    const assetCount = manifest.files.filter(record => record.path.startsWith('assets/')).length;
    assert(assetCount === manifest.assetCount && manifest.imageReferences === manifest.documents.reduce((total, item) => total + item.imageCount, 0) && manifest.files.length === catalog.articles.length + assetCount + 3, '资料文件集合不完整。');
    return manifest;
  }
  function imageFiles(snapshot) {
    const files = new Map();
    for (const image of snapshot?.articles?.flatMap(article => article.images) || []) files.set(image.sha256, image.data);
    return files;
  }
  async function validateState(state, catalog, imageSnapshot = state?.snapshot) {
    assert(state?.schemaVersion === 1 && state.files && typeof state.files === 'object' && !Array.isArray(state.files), '资料缓存格式无效。');
    const manifest = await manifestFor(state.latest, state.manifestBase64, catalog);
    assert(Object.keys(state.files).length <= manifest.files.length, '资料缓存包含未知文件。');
    const images = imageFiles(imageSnapshot);
    const bytesByPath = new Map();
    const cleanFiles = Object.create(null);
    for (const record of manifest.files) {
      const encoded = state.files[record.path] || (record.path.startsWith('assets/') ? images.get(record.sha256) : null);
      const bytes = decode(encoded);
      assert(bytes.length === record.bytes && await digest(bytes) === record.sha256, '资料文件校验失败：' + record.path);
      bytesByPath.set(record.path, bytes);
      if (!record.path.startsWith('assets/')) cleanFiles[record.path] = encoded;
    }
    for (const file of Object.keys(state.files)) assert(manifest.files.some(record => record.path === file), '资料缓存包含未知文件。');
    const source = manifest.sources[0];
    const articles = [];
    for (const [index, summary] of manifest.documents.entries()) {
      const definition = catalog.articles[index];
      const document = parse(bytesByPath.get(summary.path));
      assert(document.schemaVersion === 1 && document.id === definition.id && document.title === definition.title && JSON.stringify(document.lessonIDs) === JSON.stringify(definition.lessonIDs) && Array.isArray(document.images) && document.images.length === summary.imageCount, '原文定义与资料清单不一致。');
      assert(document.source?.id === source.id && document.source.repository === source.repository && document.source.revision === source.revision && document.source.path === definition.path && document.source.url === summary.url && document.source.license === 'MIT' && document.source.downloadedAt === source.downloadedAt && document.source.rawURL === root.YueqianMaterials.rawURL(source.revision, definition.path), '原文来源与资料清单不一致。');
      const articleImages = document.images.map(image => {
        assert(safeFilePath(image.path) && image.path.startsWith('assets/') && hashPattern.test(image.sha256) && image.path.split('/')[1].startsWith(image.sha256 + '.') && bytesByPath.has(image.path) && typeof image.sourcePath === 'string' && typeof image.alt === 'string' && image.sourceURL === root.YueqianMaterials.rawURL(source.revision, image.sourcePath), '原图来源与清单不一致。');
        return { path: image.sourcePath, alt: image.alt, mimeType: image.mimeType, sha256: image.sha256, data: encode(bytesByPath.get(image.path)) };
      });
      articles.push({ ...definition, markdown: document.markdown, sha256: document.sha256, images: articleImages });
    }
    const snapshot = { schemaVersion: 1, repository: source.repository, revision: source.revision, fetchedAt: source.downloadedAt, licenseText: decoder.decode(bytesByPath.get('LICENSE.txt')), articles };
    await root.YueqianMaterials.validateSnapshot(snapshot, catalog);
    const index = parse(bytesByPath.get('index.json'));
    assert(index.schemaVersion === 1 && Array.isArray(index.documents) && index.documents.length === articles.length && index.documents.every((document, offset) => document.id === articles[offset].id && document.url === manifest.documents[offset].url), '检索索引与资料不一致。');
    return { schemaVersion: 1, latest: state.latest, manifestBase64: state.manifestBase64, files: cleanFiles, snapshot };
  }
  async function fromSeed(seed, snapshot, catalog) { return validateState(seed, catalog, snapshot); }
  async function fetchBytes(url, limit, fetcher, budget) {
    const controller = new AbortController();
    let reader;
    let timer;
    const remaining = 120000 - (Date.now() - budget.startedAt);
    assert(remaining > 0, '资料更新超时。');
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reader?.cancel().catch(() => {}); reject(new Error('资料请求超时。')); }, Math.min(20000, remaining)); });
    const operation = (async () => {
      budget.requests++;
      const response = await fetcher(url.href, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal });
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
  async function refresh(value, current, catalog, fetcher = fetch, onProgress = () => {}) {
    const base = baseURL(value);
    const valid = await validateState(current, catalog);
    const budget = { requests: 0, downloadedBytes: 0, reusedFiles: 0, startedAt: Date.now() };
    const latest = pointer(parse(await fetchBytes(new URL('latest.json', base), 4096, fetcher, budget)));
    if (latest.releaseID === valid.latest.releaseID) {
      assert(latest.manifestSha256 === valid.latest.manifestSha256, '相同版本的清单发生冲突。');
      return { state: valid, changed: false, budget };
    }
    const manifestBase64 = encode(await fetchBytes(new URL(latest.manifestPath, base), 1048576, fetcher, budget));
    const manifest = await manifestFor(latest, manifestBase64, catalog);
    const previousManifest = parse(decode(valid.manifestBase64, 1048576));
    const images = imageFiles(valid.snapshot);
    const previousByHash = new Map(previousManifest.files.map(record => [record.sha256, valid.files[record.path] || images.get(record.sha256)]));
    const files = Object.create(null);
    for (const [offset, record] of manifest.files.entries()) {
      assert(Date.now() - budget.startedAt < 120000, '资料更新超时。');
      onProgress('正在校验 ' + (offset + 1) + ' / ' + manifest.files.length);
      let data = previousByHash.get(record.sha256);
      if (data) budget.reusedFiles++;
      else data = encode(await fetchBytes(new URL('releases/' + latest.releaseID + '/' + record.path, base), record.bytes, fetcher, budget));
      files[record.path] = data;
    }
    const state = await validateState({ schemaVersion: 1, latest, manifestBase64, files }, catalog);
    return { state, changed: true, budget };
  }
  root.YueqianContentRelease = { fromSeed, validateState, refresh, endpoint, baseURL };
})(globalThis);
