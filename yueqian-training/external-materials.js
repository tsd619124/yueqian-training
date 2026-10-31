(function (root) {
  'use strict';

  const defaultRepository = 'microsoft/generative-ai-for-beginners';
  const maximumSnapshotBytes = 32 * 1024 * 1024;
  const maximumImageBytes = 4 * 1024 * 1024;
  const imagePattern = /!\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function readableError(error, fallback = '请稍后重试。') {
    const message = String(error?.message || '');
    if (/[\u3400-\u9fff]/.test(message)) return message;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '请求超时，请稍后重试。';
    if (root.navigator?.onLine === false) return '当前离线，联网后再试。';
    return message ? '网络不可用或来源暂时无法访问，请稍后重试。' : fallback;
  }

  function validRevision(value) {
    return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  }

  function catalogSources(catalog) {
    assert(catalog?.schemaVersion === 2 && Array.isArray(catalog.sources) && catalog.sources.length > 0 && catalog.sources.length <= 8, '资料来源配置无效。');
    const ids = new Set();
    for (const source of catalog.sources) {
      assert(source && typeof source.id === 'string' && !ids.has(source.id) && typeof source.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository), '资料来源条目无效。');
      ids.add(source.id);
    }
    return catalog.sources;
  }

  function sourceForCatalog(catalog, sourceID) {
    const source = catalogSources(catalog).find(item => item.id === sourceID);
    assert(source, '资料来源未登记：' + sourceID);
    return source;
  }

  function sourceForSnapshot(snapshot, sourceID) {
    const source = Array.isArray(snapshot?.sources) ? snapshot.sources.find(item => item.id === sourceID) : null;
    assert(source && validRevision(source.revision) && typeof source.repository === 'string', '资料快照缺少来源：' + sourceID);
    return source;
  }

  function resolvedSource(value, article) {
    if (value && Array.isArray(value.sources)) return sourceForSnapshot(value, article?.sourceID || value.sources[0].id);
    return value;
  }

  function rawURL(revision, path, repository = defaultRepository) {
    assert(validRevision(revision), '来源版本无效。');
    assert(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), '来源仓库无效。');
    assert(typeof path === 'string' && /^[A-Za-z0-9_./-]+$/.test(path) && !path.split('/').includes('..') && !path.startsWith('/'), '来源路径无效。');
    return 'https://raw.githubusercontent.com/' + repository + '/' + revision + '/' + path;
  }

  function sourceURL(value, article, english) {
    const source = resolvedSource(value, article);
    const path = english ? article.path.replace('translations/zh-CN/', '') : article.path;
    return 'https://github.com/' + source.repository + '/blob/' + source.revision + '/' + path;
  }

  function imageReferences(markdown, articlePath, revision, repository = defaultRepository) {
    const references = new Map();
    for (const match of markdown.matchAll(imagePattern)) {
      if (/lesson-banner|lesson-\d+-thumbnail|img\.youtube\.com|img\.shields\.io/.test(match[2])) continue;
      const url = new URL(match[2], rawURL(revision, articlePath, repository));
      const prefix = '/' + repository + '/' + revision + '/';
      assert(url.protocol === 'https:' && url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith(prefix) && !url.search && !url.hash, '原文包含尚未审核的图片来源，请查看源站；本次更新未替换缓存。');
      const path = url.pathname.slice(prefix.length);
      assert((path.startsWith('translated_images/zh-CN/') || path.startsWith('images/') || path.includes('/images/')) && /\.(png|jpe?g|webp)$/i.test(path), '原文图片格式或路径未通过检查。');
      references.set(path, { path, alt: match[1] });
    }
    assert(references.size <= 24, '单篇图片数量超出上限。');
    return [...references.values()];
  }

  function imageMime(bytes) {
    const prefix = String.fromCharCode(...bytes.subarray(0, 12));
    if (bytes[0] === 137 && prefix.slice(1, 4) === 'PNG') return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp';
    throw new Error('下载的图片不是有效的 PNG、JPEG 或 WebP。');
  }

  function toBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
  }

  function fromBase64(value) {
    assert(typeof value === 'string' && value.length <= maximumImageBytes * 1.4, '图片缓存大小无效。');
    return Uint8Array.from(atob(value), character => character.charCodeAt(0));
  }

  async function digest(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  async function fetchBytes(url, limit, fetcher) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(25000), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    assert(response.ok, '来源暂时无法访问（HTTP ' + response.status + '）。');
    assert(!response.url || response.url === url, '来源发生了未经审核的跳转。');
    const declaredLength = Number(response.headers.get('content-length'));
    assert(!declaredLength || declaredLength <= limit, '来源文件超出大小限制。');
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert(bytes.length > 0 && bytes.length <= limit, '来源文件为空或超出大小限制。');
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.length;
        assert(length <= limit, '来源文件超出大小限制。');
        chunks.push(result.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    assert(length > 0, '来源文件为空。');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }

  async function fetchRetry(url, limit, fetcher) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await fetchBytes(url, limit, fetcher); }
      catch (error) {
        lastError = error;
        if (!/fetch failed|ECONNRESET|socket disconnected|ETIMEDOUT|network/i.test(String(error?.message || '')) || attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async function validateSnapshot(snapshot, catalog) {
    const definitions = catalogSources(catalog);
    assert(snapshot && snapshot.schemaVersion === 2 && Array.isArray(snapshot.sources) && snapshot.sources.length === definitions.length, '图文资料格式或来源不匹配。');
    for (const definition of definitions) {
      const source = snapshot.sources.find(item => item.id === definition.id);
      assert(source && source.repository === definition.repository && validRevision(source.revision) && Number.isFinite(Date.parse(source.fetchedAt)), '来源版本或日期无效：' + definition.id);
      assert(typeof source.licenseText === 'string' && source.licenseText.includes('MIT License'), '未找到有效的来源授权声明：' + definition.id);
    }
    assert(snapshot.articles?.length === catalog.articles.length && JSON.stringify(snapshot).length <= maximumSnapshotBytes, '图文资料数量或大小不匹配。');
    for (let index = 0; index < catalog.articles.length; index++) {
      const article = snapshot.articles[index];
      const definition = catalog.articles[index];
      const source = sourceForSnapshot(snapshot, definition.sourceID);
      assert(article && article.id === definition.id && article.sourceID === definition.sourceID && article.path === definition.path && article.title === definition.title && JSON.stringify(article.lessonIDs) === JSON.stringify(definition.lessonIDs), '图文资料与课程关联不匹配。');
      assert(typeof article.markdown === 'string' && article.markdown.length > 100 && article.markdown.length < 600000, '原文正文缺失或过大。');
      assert(await digest(new TextEncoder().encode(article.markdown)) === article.sha256, '原文缓存校验失败。');
      const expected = imageReferences(article.markdown, article.path, source.revision, source.repository);
      assert(Array.isArray(article.images) && expected.length === article.images.length, '原图未下载完整。');
      for (let imageIndex = 0; imageIndex < expected.length; imageIndex++) {
        const image = article.images[imageIndex];
        assert(image.path === expected[imageIndex].path && image.alt === expected[imageIndex].alt, '原图来源不匹配。');
        const bytes = fromBase64(image.data);
        assert(bytes.length > 32 && bytes.length <= maximumImageBytes && imageMime(bytes) === image.mimeType && await digest(bytes) === image.sha256, '原图缓存校验失败。');
      }
    }
    return snapshot;
  }

  async function downloadSnapshot(catalog, current, fetcher = fetch, onProgress = () => {}) {
    const definitions = catalogSources(catalog);
    assert(catalog.articles.length <= 48, '资料来源配置无效。');
    onProgress('正在检查 ' + definitions.length + ' 个来源…');
    const sources = [];
    const fetchedAt = new Date().toISOString();
    for (const definition of definitions) {
      const commit = JSON.parse(new TextDecoder().decode(await fetchRetry('https://api.github.com/repos/' + definition.repository + '/git/ref/heads/' + (definition.branch || 'main'), 500000, fetcher)));
      const revision = commit.object?.sha;
      assert(validRevision(revision), '来源返回的版本无效：' + definition.id);
      const licenseText = new TextDecoder('utf-8', { fatal: true }).decode(await fetchRetry(rawURL(revision, definition.licensePath || 'LICENSE', definition.repository), 30000, fetcher));
      assert(licenseText.includes('MIT License'), '来源授权已变化，请先核对；继续使用已有资料：' + definition.id);
      sources.push({ id: definition.id, repository: definition.repository, revision, fetchedAt, licenseText });
    }
    const sameSources = current?.schemaVersion === 2 && Array.isArray(current.sources) && definitions.every(definition => current.sources.find(source => source.id === definition.id && source.repository === definition.repository && source.revision === sources.find(item => item.id === definition.id)?.revision));
    const sameCatalog = sameSources && current.articles.length === catalog.articles.length && current.articles.every((article, index) => article.id === catalog.articles[index].id && article.sourceID === catalog.articles[index].sourceID && article.path === catalog.articles[index].path && article.title === catalog.articles[index].title && JSON.stringify(article.lessonIDs) === JSON.stringify(catalog.articles[index].lessonIDs));
    if (sameCatalog) return current;
    const snapshot = { schemaVersion: 2, sources, articles: [] };
    let downloadedBytes = 0;
    for (const definition of catalog.articles) {
      const source = sourceForSnapshot(snapshot, definition.sourceID);
      onProgress('正在下载 ' + (snapshot.articles.length + 1) + ' / ' + catalog.articles.length);
      const markdown = new TextDecoder('utf-8', { fatal: true }).decode(await fetchRetry(rawURL(source.revision, definition.path, source.repository), 600000, fetcher).catch(error => { throw new Error('下载原文失败：' + definition.id + '：' + error.message); }));
      const images = [];
      for (const reference of imageReferences(markdown, definition.path, source.revision, source.repository)) {
        const bytes = await fetchRetry(rawURL(source.revision, reference.path, source.repository), maximumImageBytes, fetcher).catch(error => { throw new Error('下载原图失败：' + definition.id + ' ' + reference.path + '：' + error.message); });
        downloadedBytes += bytes.length;
        assert(downloadedBytes <= 22 * 1024 * 1024, '图文资料总大小超出限制。');
        images.push({ ...reference, mimeType: imageMime(bytes), sha256: await digest(bytes), data: toBase64(bytes) });
      }
      snapshot.articles.push({ ...definition, markdown, sha256: await digest(new TextEncoder().encode(markdown)), images });
    }
    return validateSnapshot(snapshot, catalog);
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function safeLink(value, snapshot, article) {
    try {
      const url = new URL(value, sourceURL(snapshot, article));
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  function renderMarkdown(snapshot, article) {
    const source = resolvedSource(snapshot, article);
    const images = new Map(article.images.map(image => [image.path, image]));
    const tokens = [];
    const headings = [];
    let title = article.title;
    function token(html) { tokens.push(html); return '\u0000' + (tokens.length - 1) + '\u0000'; }
    function inline(value) {
      const protectedText = value.replace(/`([^`]+)`/g, (_, code) => token('<code>' + escapeHTML(code) + '</code>'))
        .replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, alt, target) => {
          const path = new URL(target, rawURL(source.revision, article.path, source.repository)).pathname.split('/' + source.revision + '/')[1];
          const image = images.get(path);
          if (!image) return escapeHTML(alt);
          // 资料库原图用普通地址（image.src）；Node 校验仍可传 base64（image.data）。
          const src = image.src || 'data:' + image.mimeType + ';base64,' + image.data;
          const size = Number.isInteger(image.width) && Number.isInteger(image.height) ? ' width="' + image.width + '" height="' + image.height + '"' : '';
          return token('<figure><a href="' + rawURL(source.revision, image.path, source.repository) + '" target="_blank" rel="noopener noreferrer"><img data-source-path="' + escapeHTML(image.path) + '" src="' + escapeHTML(src) + '" alt="' + escapeHTML(image.alt) + '"' + size + ' loading="lazy" decoding="async"></a></figure>');
        })
        .replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (_, label, target) => {
          if (/^\u0000\d+\u0000$/.test(label)) return label;
          const href = safeLink(target, snapshot, article);
          return href ? token('<a href="' + escapeHTML(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(label) + '</a>') : label;
        });
      let html = escapeHTML(protectedText.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?(?:strong|b)>/gi, '**').replace(/<[^>]*>/g, '')).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/_([^_]+)_/g, '<em>$1</em>');
      for (let pass = 0; pass < 8 && html.includes('\u0000'); pass++) html = html.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
      return html;
    }
    const lines = article.markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
    const output = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index].trim();
      index++;
      if (!line || /lesson-banner|lesson-\d+-thumbnail|img\.youtube\.com|img\.shields\.io/.test(line)) continue;
      if (/^```|^~~~/.test(line)) {
        const delimiter = line.slice(0, 3);
        const language = line.slice(3).trim();
        const code = [];
        while (index < lines.length && !lines[index].trim().startsWith(delimiter)) code.push(lines[index++]);
        index++;
        output.push('<details class="source-code"><summary>' + escapeHTML(language || '代码') + '</summary><pre><code>' + escapeHTML(code.join('\n')) + '</code></pre></details>');
      } else if (/^#{1,6}\s/.test(line)) {
        const match = line.match(/^(#{1,6})\s+(.+)$/);
        if (match[1].length === 1 && !output.length) { title = match[2]; continue; }
        const level = Math.min(match[1].length + 1, 4);
        const anchor = 'source-heading-' + headings.length;
        headings.push({ title: match[2].replace(/[*_`]/g, ''), anchor, level });
        output.push('<h' + level + ' id="' + anchor + '">' + inline(match[2]) + '</h' + level + '>');
      } else if (/^\|/.test(line) && index < lines.length && /^\|?[ :|-]+\|/.test(lines[index].trim())) {
        function cells(row) { return row.trim().replace(/^\||\|$/g, '').split('|'); }
        const header = cells(line); index++;
        let table = '<div class="source-table"><table><thead><tr>' + header.map(cell => '<th>' + inline(cell.trim()) + '</th>').join('') + '</tr></thead><tbody>';
        while (index < lines.length && /^\s*\|/.test(lines[index])) table += '<tr>' + cells(lines[index++]).map(cell => '<td>' + inline(cell.trim()) + '</td>').join('') + '</tr>';
        output.push(table + '</tbody></table></div>');
      } else if (/^>/.test(line)) {
        output.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>');
      } else if (/^[-*+]\s|^\d+\.\s/.test(line)) {
        const ordered = /^\d/.test(line);
        const items = [line];
        while (index < lines.length && /^\s*(?:[-*+]\s|\d+\.\s)/.test(lines[index])) items.push(lines[index++].trim());
        const tag = ordered ? 'ol' : 'ul';
        output.push('<' + tag + '>' + items.map(item => '<li>' + inline(item.replace(/^(?:[-*+]|\d+\.)\s+/, '')) + '</li>').join('') + '</' + tag + '>');
      } else if (/^[-*_]{3,}$/.test(line)) {
        output.push('<hr>');
      } else {
        const text = line.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '');
        if (text) output.push(/^!\[/.test(text) ? inline(text) : '<p>' + inline(text) + '</p>');
      }
    }
    return { html: output.join('\n'), headings, title };
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('yueqian-public-materials-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('library');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('无法访问图文缓存。'));
      request.onblocked = () => reject(new Error('图文缓存正在被其他窗口使用，请稍后重试。'));
    });
  }

  async function cachedValue(key, value) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const writing = arguments.length > 1;
        const transaction = database.transaction('library', writing ? 'readwrite' : 'readonly');
        const store = transaction.objectStore('library');
        const request = writing ? (value === undefined ? store.delete(key) : store.put(value, key)) : store.get(key);
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = transaction.onabort = () => reject(new Error('图文缓存未能保存，已有资料保留。'));
      });
    } finally { database.close(); }
  }

  // 资料版本与检查时间在同一事务写入；1.15 前的 base64 快照（snapshot / release）同时删除。
  async function commitCache(release, settings) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('library', 'readwrite');
        const store = transaction.objectStore('library');
        store.put(release, 'release-v2');
        store.put(settings, 'settings');
        store.delete('snapshot'); store.delete('release');
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(new Error('图文缓存未能保存，已有资料保留。'));
      });
    } finally { database.close(); }
  }

  const idle = callback => (root.requestIdleCallback ? root.requestIdleCallback(callback, { timeout: 4000 }) : setTimeout(callback, 1200));

  async function mountReader() {
    const mount = document.querySelector('[data-materials-root]');
    if (!mount) return;
    const catalog = root.YUEQIAN_EXTERNAL_CATALOG;
    const releaseClient = root.YueqianContentRelease;
    const searchClient = root.YueqianMaterialSearch;
    const status = document.getElementById('materials-status');
    const updateButton = document.getElementById('materials-update');
    const automatic = document.getElementById('materials-automatic');
    const query = document.getElementById('materials-search');
    const searchPanel = document.getElementById('materials-search-panel');
    const searchStatus = document.getElementById('materials-search-status');
    const searchResults = document.getElementById('materials-search-results');
    const servicesForm = document.getElementById('materials-services-form');
    const servicesStatus = document.getElementById('materials-services-status');
    let release = null;
    let searchSnapshot = null;
    let searchSnapshotLoading = null;
    let services = { contentBaseURL: './content-library/', searchURL: null, ...root.YUEQIAN_MATERIAL_SERVICES };
    let searchSerial = 0;
    let renderSerial = 0;
    let settings = { automatic: true, checkedAt: null, attemptedAt: null };
    let updating = false;
    let savingServices = false;
    let selectedID = new URL(location.href).searchParams.get('article') || mount.dataset.materialDefault || 'ms-rag';
    const lessonID = new URL(location.href).searchParams.get('lesson');
    if (lessonID) selectedID = catalog.articles.find(article => article.lessonIDs.includes(lessonID))?.id || selectedID;
    if (!catalog.articles.some(article => article.id === selectedID)) selectedID = catalog.articles[0].id;

    function sourceMeta(article) {
      const sources = release.manifest.sources;
      const source = article ? sources.find(item => item.id === article.sourceID) || sources[0] : sources[0];
      return { id: source.id, repository: source.repository, revision: source.revision, fetchedAt: source.downloadedAt };
    }
    function statusText() {
      if (settings.checkedAt) return '上次检查 ' + new Date(settings.checkedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      return release ? '已保存 ' + new Date(sourceMeta().fetchedAt).toLocaleDateString('zh-CN') + ' 的原文与原图' : '原文尚未下载。';
    }

    function revealCurrentArticle(list) {
      if (matchMedia('(max-width: 680px)').matches) {
        const current = list.querySelector('[aria-current]');
        if (current) list.scrollLeft = current.offsetLeft - list.offsetLeft - list.clientWidth / 2 + current.clientWidth / 2;
      }
    }

    // 检索用纯文本（index.json）只在第一次输入检索词时读取。
    function ensureSearchSnapshot() {
      if (searchSnapshot) return Promise.resolve(searchSnapshot);
      if (!release) return Promise.reject(new Error('原文尚未下载，联网后再试。'));
      const current = release;
      searchSnapshotLoading ||= releaseClient.searchSnapshot(current, catalog).then(value => {
        if (current === release) searchSnapshot = value;
        return value;
      }).finally(() => { searchSnapshotLoading = null; });
      return searchSnapshotLoading;
    }

    function renderList() {
      const term = query.value.trim().toLowerCase();
      let matchingIDs = null;
      if (term && searchClient) {
        if (searchSnapshot) {
          try { matchingIDs = new Set(searchClient.local(searchSnapshot, term).map(article => article.id)); }
          catch { matchingIDs = new Set(); }
        } else ensureSearchSnapshot().then(renderList, () => {});
      }
      const articles = catalog.articles.filter(article => (!lessonID || article.lessonIDs.includes(lessonID)) && (!term || (matchingIDs ? matchingIDs.has(article.id) : article.title.toLowerCase().includes(term))));
      const list = document.getElementById('materials-list');
      list.innerHTML = articles.map(article => '<button type="button" data-article="' + article.id + '"' + (article.id === selectedID ? ' aria-current="page"' : '') + '>' + escapeHTML(article.title) + '</button>').join('') || '<p class="source-muted">没有匹配的原文。</p>';
      revealCurrentArticle(list);
    }

    function selectArticle(articleID) {
      selectedID = articleID;
      const url = new URL(location.href); url.searchParams.set('article', selectedID);
      history.replaceState(null, '', url);
      if (searchPanel) searchPanel.hidden = true;
      searchSerial++;
      renderArticle(); renderList();
      document.getElementById('source-title').focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    }

    async function renderArticle() {
      const serial = ++renderSerial;
      const definition = catalog.articles.find(item => item.id === selectedID) || catalog.articles[0];
      selectedID = definition.id;
      document.title = definition.title + ' · 跃迁计划';
      if (!release) {
        document.getElementById('source-title').textContent = definition.title;
        document.getElementById('source-body').innerHTML = '<p class="source-muted">原文与配图需要联网下载一次，之后离线可读。</p>';
        return;
      }
      const current = release;
      let document_;
      try { document_ = await releaseClient.documentFor(current, definition.id, catalog); }
      catch (error) {
        if (serial !== renderSerial) return;
        document.getElementById('source-title').textContent = definition.title;
        document.getElementById('source-body').innerHTML = '<p class="source-muted">这篇原文暂时无法读取：' + escapeHTML(readableError(error)) + '</p>';
        document.getElementById('source-lead').replaceChildren();
        return;
      }
      if (serial !== renderSerial || current !== release) return;
      const article = { ...definition, markdown: document_.markdown, images: document_.images.map(image => ({ path: image.sourcePath, alt: image.alt, mimeType: image.mimeType, sha256: image.sha256, width: image.width, height: image.height, src: releaseClient.assetURL(current, image.path), file: image.path })) };
      const meta = sourceMeta(article);
      const rendered = renderMarkdown(meta, article);
      document.getElementById('source-title').textContent = rendered.title;
      document.getElementById('source-original').href = sourceURL(meta, article);
      document.getElementById('source-english').href = sourceURL(meta, article, true);
      document.getElementById('source-body').innerHTML = rendered.html;
      const lead = article.images.find(image => !/DALLE/i.test(image.path + image.alt)) || article.images[0];
      const leadFigure = [...document.querySelectorAll('#source-body img')].find(image => image.dataset.sourcePath === lead?.path)?.closest('figure');
      if (leadFigure) leadFigure.querySelector('img').loading = 'eager';
      document.getElementById('source-lead').replaceChildren(...(leadFigure ? [leadFigure] : []));
      document.getElementById('source-toc').innerHTML = rendered.headings.filter(heading => heading.level <= 3).map(heading => '<a href="#' + heading.anchor + '">' + escapeHTML(heading.title) + '</a>').join('');
      document.getElementById('source-revision').textContent = '资料版本 ' + current.latest.releaseID.slice(0, 12) + ' · 来源版本 ' + meta.revision.slice(0, 12) + ' · 下载于 ' + new Date(meta.fetchedAt).toLocaleString('zh-CN');
      // 首次查看后把本篇原图与许可存入缓存，供离线阅读；放在空闲时执行，不占首屏。
      idle(() => {
        releaseClient.cacheAssets(current, article.images.map(image => image.file)).catch(() => {});
        releaseClient.file(current, 'LICENSE.txt').then(bytes => { if (current === release) document.getElementById('source-license').textContent = new TextDecoder().decode(bytes); }).catch(() => {});
      });
    }

    // 原图加载失败（多为离线）时改用缓存中的副本。
    function useCachedImage(event) {
      const image = event.target;
      if (image?.tagName !== 'IMG' || image.dataset.cacheFallback || !image.src.startsWith('http')) return;
      image.dataset.cacheFallback = '1';
      releaseClient.cachedAssetBlobURL(image.src).then(url => { if (url) image.src = url; }).catch(() => {});
    }

    function renderSearchGroups(result, snapshot) {
      searchResults.replaceChildren();
      for (const [kind, title, items] of [['library', '已入库原文', result.library], ['external', '官方来源 · 未审核', result.external]]) {
        const group = document.createElement('section');
        group.className = 'source-search-group';
        group.dataset.resultGroup = kind;
        const heading = document.createElement('h3');
        heading.textContent = title + '（' + items.length + '）';
        group.append(heading);
        if (kind === 'external') {
          const note = document.createElement('p');
          note.textContent = '仅供扩展阅读，未经课程审核，不计入学习进度。';
          group.append(note);
        }
        if (!items.length) {
          const empty = document.createElement('p');
          empty.textContent = kind === 'library' ? '没有匹配的已入库原文。' : '暂无可显示的外部结果。';
          group.append(empty);
        }
        for (const item of items) {
          const article = document.createElement('article');
          article.className = 'source-search-item';
          article.dataset.resultID = item.id;
          const title = document.createElement('h4');
          if (kind === 'library' && snapshot.articles.some(article => article.id === item.id && sourceURL(snapshot, article) === item.url)) {
            const button = document.createElement('button');
            button.type = 'button'; button.textContent = item.title;
            button.addEventListener('click', () => selectArticle(item.id));
            title.append(button);
          } else {
            const link = document.createElement('a');
            link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = item.title || decodeURIComponent(new URL(item.url).pathname.split('/').slice(5).join('/'));
            title.append(link);
          }
          const excerpt = document.createElement('p');
          excerpt.textContent = item.excerpt;
          const metadata = document.createElement('p');
          metadata.className = 'source-result-meta';
          const source = document.createElement('a');
          source.href = item.url; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = item.repository + ' · ' + item.revision.slice(0, 12);
          metadata.append(source);
          metadata.append(document.createTextNode(kind === 'external' ? ' · 未审核' : ' · 已入库'));
          article.append(title, excerpt, metadata);
          group.append(article);
        }
        searchResults.append(group);
      }
    }

    async function search() {
      if (!searchPanel || !searchClient) return;
      const serial = ++searchSerial;
      searchPanel.hidden = false;
      try {
        const term = searchClient.normalize(query.value);
        const snapshot = await ensureSearchSnapshot().catch(() => ({ schemaVersion: 2, sources: [], articles: [] }));
        if (serial !== searchSerial) return;
        renderSearchGroups({ library: searchClient.local(snapshot, term), external: [] }, snapshot);
        searchStatus.textContent = services.searchURL ? '正在检索配置的官方来源，已显示本机原文…' : '正在搜索已保存的原文与官方来源索引…';
        const result = await searchClient.search({ query: term, snapshot, releaseID: release?.latest.releaseID || '0'.repeat(64), searchURL: services.searchURL, contentBaseURL: location.protocol === 'file:' ? null : services.contentBaseURL });
        if (serial !== searchSerial) return;
        renderSearchGroups(result, snapshot);
        searchStatus.textContent = result.message;
      } catch (error) {
        if (serial !== searchSerial) return;
        searchResults.replaceChildren();
        searchStatus.textContent = readableError(error, '搜索未完成，请稍后重试。');
      }
    }

    function validatedServices(value) {
      const content = String(value.contentBaseURL || '').trim();
      const entered = String(value.searchURL || '').trim();
      const searchURL = searchClient?.isLegacySearchURL(entered) ? '' : entered;
      const contentBaseURL = location.protocol === 'file:' && content === './content-library/' ? content : releaseClient.baseURL(content).href;
      return { contentBaseURL, searchURL: searchURL ? releaseClient.endpoint(searchURL).href : null };
    }

    function renderServices() {
      if (!servicesForm) return;
      document.getElementById('materials-content-url').value = services.contentBaseURL;
      document.getElementById('materials-search-url').value = services.searchURL || '';
    }

    async function refreshSearchIndex(contentURL) {
      if (!searchClient?.refreshIndex || location.protocol === 'file:') return null;
      const result = await searchClient.refreshIndex({ contentBaseURL: contentURL });
      return result.status === 'updated' ? '官方来源索引已更新。' : result.status === 'failed' ? (result.state ? '官方来源索引暂未更新，继续使用上一版。' : '官方来源索引暂未获取，稍后自动重试。') : null;
    }

    async function update(manual) {
      if (updating || savingServices) return;
      if (root.navigator?.onLine === false) {
        if (manual) status.textContent = '当前离线，继续使用已保存的资料。联网后再检查更新。';
        return;
      }
      if (!manual && release && (!settings.automatic || Date.now() - Date.parse(settings.checkedAt || 0) < 86400000 || Date.now() - Date.parse(settings.attemptedAt || 0) < 3600000)) {
        // 资料版本近期已检查时，仍需补取尚未保存的官方来源索引。
        if (searchClient?.cachedIndex && !(await searchClient.cachedIndex())) await refreshSearchIndex(services.contentBaseURL).catch(() => null);
        return;
      }
      const requestedContentURL = services.contentBaseURL;
      const servicesSaveButton = document.getElementById('materials-services-save');
      updating = true; updateButton.disabled = true;
      if (servicesSaveButton) servicesSaveButton.disabled = true;
      settings.attemptedAt = new Date().toISOString();
      try {
        await cachedValue('settings', settings);
        const result = await releaseClient.refresh(requestedContentURL, release, catalog, fetch, message => { status.textContent = message; });
        const nextSettings = { ...settings, checkedAt: new Date().toISOString() };
        assert(services.contentBaseURL === requestedContentURL, '资料服务已切换，请重新检查更新。');
        await commitCache(result.state, nextSettings);
        settings = nextSettings;
        if (result.changed) {
          release = result.state; searchSnapshot = null;
          releaseClient.prune(release).catch(() => {});
          await renderArticle(); renderList();
        }
        status.textContent = (result.changed ? '原文与原图已完整保存。' : '当前已是最新资料版本。') + statusText();
      } catch (error) {
        status.textContent = (release ? '更新未完成，继续使用已保存的资料。' : '原文下载未完成。') + readableError(error);
      }
      try {
        const indexMessage = await refreshSearchIndex(requestedContentURL);
        if (indexMessage) status.textContent += indexMessage;
        if (searchPanel && !searchPanel.hidden && query.value.trim()) await search();
      } finally {
        updating = false; updateButton.disabled = savingServices;
        if (servicesSaveButton) servicesSaveButton.disabled = savingServices;
      }
    }

    // 打开：读取已保存的资料版本（只查结构，不重算哈希）；没有时从资料库下载指针与清单并校验一次。
    try {
      const [savedRelease, savedSettings, savedServices] = await Promise.all([cachedValue('release-v2'), cachedValue('settings'), cachedValue('services')]);
      if (savedSettings && typeof savedSettings.automatic === 'boolean') settings = { automatic: savedSettings.automatic, checkedAt: Number.isFinite(Date.parse(savedSettings.checkedAt)) ? savedSettings.checkedAt : null, attemptedAt: Number.isFinite(Date.parse(savedSettings.attemptedAt)) ? savedSettings.attemptedAt : null };
      services = validatedServices(savedServices || services);
      if (savedServices && savedServices.searchURL !== services.searchURL) cachedValue('services', services).catch(() => {});
      if (servicesStatus) servicesStatus.textContent = services.searchURL ? '已连接自配检索服务；不可用时回退本机索引。' : '未连接检索服务，使用随资料发布的官方来源索引。';
      try { release = savedRelease ? releaseClient.restore(savedRelease) : null; } catch { release = null; }
    } catch (error) {
      status.textContent = '已有资料仍可阅读。' + readableError(error);
      if (servicesStatus) servicesStatus.textContent = '连接设置未能读取，正在使用默认地址。';
    }
    if (!release) {
      try {
        release = await releaseClient.load(services.contentBaseURL, catalog);
        settings = { ...settings, checkedAt: new Date().toISOString() };
        commitCache(release, settings).catch(() => {});
      } catch (error) { status.textContent = '原文需要联网下载一次。' + readableError(error); }
    }
    renderList();
    await renderArticle();
    if (release) status.textContent = statusText();
    renderServices();
    automatic.checked = settings.automatic;
    document.getElementById('materials-list').addEventListener('click', event => {
      const button = event.target.closest('[data-article]');
      if (button) selectArticle(button.dataset.article);
    });
    query.addEventListener('input', () => {
      searchSerial++;
      renderList();
      if (searchPanel && !searchPanel.hidden) {
        if (!query.value.trim()) searchPanel.hidden = true;
        else {
          searchResults.replaceChildren();
          searchStatus.textContent = '点击搜索或按回车查看结果。';
        }
      }
    });
    document.getElementById('materials-search-form')?.addEventListener('submit', event => { event.preventDefault(); search(); });
    document.getElementById('materials-search-close')?.addEventListener('click', () => { searchSerial++; searchPanel.hidden = true; query.focus(); });
    servicesForm?.addEventListener('submit', async event => {
      event.preventDefault();
      if (updating || savingServices) {
        servicesStatus.textContent = updating ? '资料正在更新，请完成后再保存服务地址。' : '服务地址正在保存，请稍候。';
        return;
      }
      const saveButton = document.getElementById('materials-services-save');
      savingServices = true; saveButton.disabled = true; updateButton.disabled = true;
      try {
        const next = validatedServices({ contentBaseURL: document.getElementById('materials-content-url').value, searchURL: document.getElementById('materials-search-url').value });
        await cachedValue('services', next);
        services = next;
        searchSerial++; renderServices();
        servicesStatus.textContent = '连接已保存。点击检查更新可同步资料。';
        if (query.value.trim()) await search();
      } catch (error) { servicesStatus.textContent = readableError(error, '连接未保存。'); }
      finally { savingServices = false; saveButton.disabled = updating; updateButton.disabled = updating; }
    });
    updateButton.addEventListener('click', () => update(true));
    automatic.addEventListener('change', async () => {
      settings.automatic = automatic.checked;
      try { await cachedValue('settings', settings); if (settings.automatic) await update(false); }
      catch (error) { status.textContent = readableError(error); }
    });
    document.getElementById('materials-type').addEventListener('click', event => {
      const enlarged = document.body.classList.toggle('source-large');
      event.currentTarget.setAttribute('aria-pressed', String(enlarged));
    });
    const imageDialog = document.getElementById('source-image-dialog');
    const imageScale = document.getElementById('source-image-scale');
    const enlargedImage = document.getElementById('source-image-large');
    function resizeImage() { enlargedImage.style.width = imageDialog.querySelector('.source-image-viewport').clientWidth * Number(imageScale.value) + 'px'; }
    const article = document.querySelector('.source-article');
    article.addEventListener('error', useCachedImage, true);
    article.addEventListener('click', event => {
      const link = event.target.closest('figure a');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      const image = link.querySelector('img');
      enlargedImage.src = image.currentSrc || image.src; enlargedImage.alt = image.alt; imageScale.value = '1';
      imageDialog.showModal(); resizeImage();
    });
    imageScale.addEventListener('input', resizeImage);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) update(false); });
    root.addEventListener('online', () => update(false));
    root.addEventListener('resize', () => revealCurrentArticle(document.getElementById('materials-list')));
    root.YueqianMaterials.currentRelease = () => release;
    root.YueqianMaterials.currentSearchSnapshot = ensureSearchSnapshot;
    root.YueqianMaterials.currentServices = () => ({ ...services });
    root.YueqianMaterials.update = () => update(true);
    if (location.protocol !== 'file:') idle(() => update(false));
  }

  root.YueqianMaterials = { rawURL, sourceURL, imageReferences, imageMime, digest, validateSnapshot, downloadSnapshot, renderMarkdown, cachedValue };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountReader, { once: true });
    else mountReader();
  }
})(globalThis);
