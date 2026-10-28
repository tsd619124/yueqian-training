(function (root) {
  'use strict';

  const repository = 'microsoft/generative-ai-for-beginners';
  const maximumSnapshotBytes = 32 * 1024 * 1024;
  const maximumImageBytes = 4 * 1024 * 1024;
  const commitURL = 'https://api.github.com/repos/' + repository + '/git/ref/heads/main';
  const imagePattern = /!\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function validRevision(value) {
    return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  }

  function rawURL(revision, path) {
    assert(validRevision(revision), '来源版本无效。');
    assert(typeof path === 'string' && /^[A-Za-z0-9_./-]+$/.test(path) && !path.split('/').includes('..') && !path.startsWith('/'), '来源路径无效。');
    return 'https://raw.githubusercontent.com/' + repository + '/' + revision + '/' + path;
  }

  function sourceURL(snapshot, article, english) {
    const path = english ? article.path.replace('translations/zh-CN/', '') : article.path;
    return 'https://github.com/' + repository + '/blob/' + snapshot.revision + '/' + path;
  }

  function imageReferences(markdown, articlePath, revision) {
    const references = new Map();
    for (const match of markdown.matchAll(imagePattern)) {
      if (/lesson-banner|img\.youtube\.com|img\.shields\.io/.test(match[2])) continue;
      const url = new URL(match[2], rawURL(revision, articlePath));
      const prefix = '/' + repository + '/' + revision + '/';
      assert(url.protocol === 'https:' && url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith(prefix) && !url.search && !url.hash, '原文包含尚未审核的图片来源，请查看源站；本次更新未替换缓存。');
      const path = url.pathname.slice(prefix.length);
      assert((path.startsWith('translated_images/zh-CN/') || path.includes('/images/')) && /\.(png|jpe?g|webp)$/i.test(path), '原文图片格式或路径未通过检查。');
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

  async function validateSnapshot(snapshot, catalog) {
    assert(snapshot && snapshot.schemaVersion === 1 && snapshot.repository === repository && catalog.repository === repository, '图文资料格式或来源不匹配。');
    assert(validRevision(snapshot.revision) && Number.isFinite(Date.parse(snapshot.fetchedAt)), '来源版本或日期无效。');
    assert(typeof snapshot.licenseText === 'string' && snapshot.licenseText.includes('MIT License') && snapshot.licenseText.includes('Copyright (c) Microsoft Corporation.'), '未找到有效的来源授权声明。');
    assert(snapshot.articles?.length === catalog.articles.length && JSON.stringify(snapshot).length <= maximumSnapshotBytes, '图文资料数量或大小不匹配。');
    for (let index = 0; index < catalog.articles.length; index++) {
      const article = snapshot.articles[index];
      const definition = catalog.articles[index];
      assert(article && article.id === definition.id && article.path === definition.path && article.title === definition.title && JSON.stringify(article.lessonIDs) === JSON.stringify(definition.lessonIDs), '图文资料与课程关联不匹配。');
      assert(typeof article.markdown === 'string' && article.markdown.length > 100 && article.markdown.length < 600000, '原文正文缺失或过大。');
      assert(await digest(new TextEncoder().encode(article.markdown)) === article.sha256, '原文缓存校验失败。');
      const expected = imageReferences(article.markdown, article.path, snapshot.revision);
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
    assert(catalog.repository === repository && catalog.articles.length <= 16, '资料来源配置无效。');
    onProgress('正在检查来源…');
    const commit = JSON.parse(new TextDecoder().decode(await fetchBytes(commitURL, 500000, fetcher)));
    const revision = commit.object?.sha;
    assert(validRevision(revision), '来源返回的版本无效。');
    if (current && revision === current.revision) return current;
    const licenseText = new TextDecoder('utf-8', { fatal: true }).decode(await fetchBytes(rawURL(revision, 'LICENSE'), 30000, fetcher));
    assert(licenseText.includes('MIT License') && licenseText.includes('Copyright (c) Microsoft Corporation.'), '来源授权已变化，请先核对；继续使用已有资料。');
    const snapshot = { schemaVersion: 1, repository, revision, fetchedAt: new Date().toISOString(), licenseText, articles: [] };
    let downloadedBytes = 0;
    for (const definition of catalog.articles) {
      onProgress('正在下载 ' + (snapshot.articles.length + 1) + ' / ' + catalog.articles.length);
      const markdown = new TextDecoder('utf-8', { fatal: true }).decode(await fetchBytes(rawURL(revision, definition.path), 600000, fetcher));
      const images = [];
      for (const reference of imageReferences(markdown, definition.path, revision)) {
        const bytes = await fetchBytes(rawURL(revision, reference.path), maximumImageBytes, fetcher);
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
    const images = new Map(article.images.map(image => [image.path, image]));
    const tokens = [];
    const headings = [];
    let title = article.title;
    function token(html) { tokens.push(html); return '\u0000' + (tokens.length - 1) + '\u0000'; }
    function inline(value) {
      const protectedText = value.replace(/`([^`]+)`/g, (_, code) => token('<code>' + escapeHTML(code) + '</code>'))
        .replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, alt, target) => {
          const path = new URL(target, rawURL(snapshot.revision, article.path)).pathname.split('/' + snapshot.revision + '/')[1];
          const image = images.get(path);
          return image ? token('<figure><a href="' + rawURL(snapshot.revision, image.path) + '" target="_blank" rel="noopener noreferrer"><img data-source-path="' + escapeHTML(image.path) + '" src="data:' + image.mimeType + ';base64,' + image.data + '" alt="' + escapeHTML(image.alt) + '" loading="lazy"></a></figure>') : escapeHTML(alt);
        })
        .replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (_, label, target) => {
          const href = safeLink(target, snapshot, article);
          return href ? token('<a href="' + escapeHTML(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(label) + '</a>') : label;
        });
      return escapeHTML(protectedText.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?(?:strong|b)>/gi, '**').replace(/<[^>]*>/g, '')).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/_([^_]+)_/g, '<em>$1</em>').replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
    }
    const lines = article.markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
    const output = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index].trim();
      index++;
      if (!line || /lesson-banner|img\.youtube\.com|img\.shields\.io/.test(line)) continue;
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
        const request = writing ? transaction.objectStore('library').put(value, key) : transaction.objectStore('library').get(key);
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = transaction.onabort = () => reject(new Error('图文缓存未能保存，已有资料保留。'));
      });
    } finally { database.close(); }
  }

  async function commitCache(snapshot, settings, release) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('library', 'readwrite');
        transaction.objectStore('library').put(snapshot, 'snapshot');
        transaction.objectStore('library').put(settings, 'settings');
        if (release) transaction.objectStore('library').put(release, 'release');
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(new Error('图文缓存未能保存，已有资料保留。'));
      });
    } finally { database.close(); }
  }

  async function mountReader() {
    const mount = document.querySelector('[data-materials-root]');
    if (!mount) return;
    const catalog = root.YUEQIAN_EXTERNAL_CATALOG;
    let snapshot = root.YUEQIAN_EXTERNAL_SEED;
    const status = document.getElementById('materials-status');
    const updateButton = document.getElementById('materials-update');
    const automatic = document.getElementById('materials-automatic');
    const query = document.getElementById('materials-search');
    const searchPanel = document.getElementById('materials-search-panel');
    const searchStatus = document.getElementById('materials-search-status');
    const searchResults = document.getElementById('materials-search-results');
    const servicesForm = document.getElementById('materials-services-form');
    const servicesStatus = document.getElementById('materials-services-status');
    const releaseClient = root.YueqianContentRelease;
    const searchClient = root.YueqianMaterialSearch;
    const usesReleases = Boolean(releaseClient && root.YUEQIAN_CONTENT_RELEASE);
    let release = null;
    let showingRelease = false;
    let services = { contentBaseURL: './content-library/', searchURL: null, ...root.YUEQIAN_MATERIAL_SERVICES };
    let searchSerial = 0;
    let settings = { automatic: true, checkedAt: null, attemptedAt: null };
    let updating = false;
    let savingServices = false;
    let selectedID = new URL(location.href).searchParams.get('article') || mount.dataset.materialDefault || 'ms-rag';
    const lessonID = new URL(location.href).searchParams.get('lesson');
    if (lessonID) selectedID = catalog.articles.find(article => article.lessonIDs.includes(lessonID))?.id || selectedID;

    function statusText() {
      return settings.checkedAt ? '上次检查 ' + new Date(settings.checkedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '已保存 ' + new Date(snapshot.fetchedAt).toLocaleDateString('zh-CN') + ' 的原文与原图';
    }

    function revealCurrentArticle(list) {
      if (matchMedia('(max-width: 680px)').matches) {
        const current = list.querySelector('[aria-current]');
        if (current) list.scrollLeft = current.offsetLeft - list.offsetLeft - list.clientWidth / 2 + current.clientWidth / 2;
      }
    }

    function renderList() {
      const term = query.value.trim().toLowerCase();
      let matchingIDs = null;
      if (term && searchClient) {
        try { matchingIDs = new Set(searchClient.local(snapshot, term).map(article => article.id)); }
        catch { matchingIDs = new Set(); }
      }
      const articles = snapshot.articles.filter(article => (!lessonID || article.lessonIDs.includes(lessonID)) && (!term || (matchingIDs ? matchingIDs.has(article.id) : (article.title + article.markdown).toLowerCase().includes(term))));
      const list = document.getElementById('materials-list');
      list.innerHTML = articles.map(article => '<button type="button" data-article="' + article.id + '"' + (article.id === selectedID ? ' aria-current="page"' : '') + '>' + escapeHTML(article.title) + '</button>').join('') || '<p class="source-muted">没有匹配的原文。</p>';
      list.querySelectorAll('[data-article]').forEach(button => button.addEventListener('click', () => {
        selectArticle(button.dataset.article);
      }));
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

    function renderArticle() {
      const article = snapshot.articles.find(item => item.id === selectedID) || snapshot.articles[0];
      selectedID = article.id;
      const rendered = renderMarkdown(snapshot, article);
      document.title = article.title + ' · 跃迁计划';
      document.getElementById('source-title').textContent = rendered.title;
      document.getElementById('source-original').href = sourceURL(snapshot, article);
      document.getElementById('source-english').href = sourceURL(snapshot, article, true);
      document.getElementById('source-body').innerHTML = rendered.html;
      const lead = article.images.find(image => !/DALLE/i.test(image.path + image.alt)) || article.images[0];
      const leadFigure = [...document.querySelectorAll('#source-body img')].find(image => image.dataset.sourcePath === lead?.path)?.closest('figure');
      document.getElementById('source-lead').replaceChildren(...(leadFigure ? [leadFigure] : []));
      document.getElementById('source-toc').innerHTML = rendered.headings.filter(heading => heading.level <= 3).map(heading => '<a href="#' + heading.anchor + '">' + escapeHTML(heading.title) + '</a>').join('');
      document.getElementById('source-revision').textContent = (showingRelease ? '资料版本 ' + release.latest.releaseID.slice(0, 12) + ' · ' : '') + '来源版本 ' + snapshot.revision.slice(0, 12) + ' · 下载于 ' + new Date(snapshot.fetchedAt).toLocaleString('zh-CN');
      document.getElementById('source-license').textContent = snapshot.licenseText;
    }

    function renderSearchGroups(result) {
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
            link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = item.title;
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
        renderSearchGroups({ library: searchClient.local(snapshot, term), external: [] });
        searchStatus.textContent = services.searchURL ? '正在检索官方来源，已显示本机原文…' : '正在搜索已保存的原文…';
        const result = await searchClient.search({ query: term, snapshot, releaseID: release?.latest.releaseID || snapshot.revision, searchURL: services.searchURL });
        if (serial !== searchSerial) return;
        renderSearchGroups(result);
        searchStatus.textContent = result.message;
      } catch (error) {
        if (serial !== searchSerial) return;
        searchResults.replaceChildren();
        searchStatus.textContent = error.message || '搜索未完成，请稍后重试。';
      }
    }

    function validatedServices(value) {
      const content = String(value.contentBaseURL || '').trim();
      const searchURL = String(value.searchURL || '').trim();
      const contentBaseURL = location.protocol === 'file:' && content === './content-library/' ? content : releaseClient.baseURL(content).href;
      return { contentBaseURL, searchURL: searchURL ? releaseClient.endpoint(searchURL).href : null };
    }

    function renderServices() {
      if (!servicesForm) return;
      document.getElementById('materials-content-url').value = services.contentBaseURL;
      document.getElementById('materials-search-url').value = services.searchURL || '';
    }

    async function update(manual) {
      if (updating || savingServices || (!manual && (!settings.automatic || Date.now() - Date.parse(settings.checkedAt || 0) < 86400000 || Date.now() - Date.parse(settings.attemptedAt || 0) < 3600000))) return;
      const requestedContentURL = services.contentBaseURL;
      const servicesSaveButton = document.getElementById('materials-services-save');
      updating = true; updateButton.disabled = true;
      if (servicesSaveButton) servicesSaveButton.disabled = true;
      settings.attemptedAt = new Date().toISOString();
      try {
        await cachedValue('settings', settings);
        let nextRelease = null;
        let next;
        let changed;
        if (usesReleases) {
          assert(release, '内置资料清单未通过检查，请重新加载页面。');
          const result = await releaseClient.refresh(requestedContentURL, release, catalog, fetch, message => { status.textContent = message; });
          nextRelease = result.state; next = nextRelease.snapshot; changed = result.changed;
        } else {
          next = await downloadSnapshot(catalog, snapshot, fetch, message => { status.textContent = message; });
          changed = next !== snapshot;
        }
        const checkedAt = new Date().toISOString();
        const nextSettings = { ...settings, checkedAt };
        assert(services.contentBaseURL === requestedContentURL, '资料服务已切换，请重新检查更新。');
        await commitCache(next, nextSettings, nextRelease);
        snapshot = next;
        if (nextRelease) { release = nextRelease; showingRelease = true; }
        renderArticle(); renderList();
        settings = nextSettings;
        status.textContent = (changed ? '原文与原图已完整保存。' : '当前已是最新资料版本。') + statusText();
        if (searchPanel && !searchPanel.hidden && query.value.trim()) await search();
      } catch (error) {
        status.textContent = '更新未完成，继续使用已保存的资料。' + (error.message || '请稍后重试。');
      } finally {
        updating = false; updateButton.disabled = savingServices;
        if (servicesSaveButton) servicesSaveButton.disabled = savingServices;
      }
    }

    try {
      await validateSnapshot(snapshot, catalog);
      if (usesReleases) {
        release = await releaseClient.fromSeed(root.YUEQIAN_CONTENT_RELEASE, snapshot, catalog);
        snapshot = release.snapshot; showingRelease = true;
      }
    } catch (error) { status.textContent = '正在使用内置的来源快照。' + error.message; }
    try {
      const [cached, savedSettings, savedRelease, savedServices] = await Promise.all([cachedValue('snapshot'), cachedValue('settings'), cachedValue('release'), cachedValue('services')]);
      if (savedSettings && typeof savedSettings.automatic === 'boolean') settings = { automatic: savedSettings.automatic, checkedAt: Number.isFinite(Date.parse(savedSettings.checkedAt)) ? savedSettings.checkedAt : null, attemptedAt: Number.isFinite(Date.parse(savedSettings.attemptedAt)) ? savedSettings.attemptedAt : null };
      if (usesReleases && savedRelease) {
        try { release = await releaseClient.validateState(savedRelease, catalog); snapshot = release.snapshot; showingRelease = true; }
        catch (error) { status.textContent = '保存的资料清单未通过检查，已保留内置资料。' + error.message; }
      } else if (!usesReleases && cached) { snapshot = await validateSnapshot(cached, catalog); showingRelease = false; }
      if (releaseClient) {
        services = validatedServices(savedServices || services);
        if (servicesStatus) servicesStatus.textContent = services.searchURL ? '已连接检索服务。' : '未连接检索服务，仍可搜索本机原文。';
      }
      status.textContent = statusText();
    } catch (error) {
      status.textContent = '已有资料仍可阅读。' + error.message;
      if (servicesStatus) servicesStatus.textContent = '连接设置未能读取，正在使用默认地址。';
    }
    renderServices();
    automatic.checked = settings.automatic;
    renderArticle(); renderList();
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
      } catch (error) { servicesStatus.textContent = error.message || '连接未保存。'; }
      finally { savingServices = false; saveButton.disabled = updating; updateButton.disabled = updating; }
    });
    updateButton.addEventListener('click', () => update(true));
    automatic.addEventListener('change', async () => {
      settings.automatic = automatic.checked;
      try { await cachedValue('settings', settings); if (settings.automatic) await update(false); }
      catch (error) { status.textContent = error.message; }
    });
    document.getElementById('materials-type').addEventListener('click', event => {
      const enlarged = document.body.classList.toggle('source-large');
      event.currentTarget.setAttribute('aria-pressed', String(enlarged));
    });
    const imageDialog = document.getElementById('source-image-dialog');
    const imageScale = document.getElementById('source-image-scale');
    const enlargedImage = document.getElementById('source-image-large');
    function resizeImage() { enlargedImage.style.width = imageDialog.querySelector('.source-image-viewport').clientWidth * Number(imageScale.value) + 'px'; }
    document.querySelector('.source-article').addEventListener('click', event => {
      const link = event.target.closest('figure a');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      const image = link.querySelector('img');
      enlargedImage.src = image.src; enlargedImage.alt = image.alt; imageScale.value = '1';
      imageDialog.showModal(); resizeImage();
    });
    imageScale.addEventListener('input', resizeImage);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) update(false); });
    root.addEventListener('online', () => update(false));
    root.addEventListener('resize', () => revealCurrentArticle(document.getElementById('materials-list')));
    root.YueqianMaterials.currentSnapshot = () => snapshot;
    root.YueqianMaterials.currentRelease = () => release;
    root.YueqianMaterials.currentServices = () => ({ ...services });
    root.YueqianMaterials.update = () => update(true);
    if (!usesReleases || location.protocol !== 'file:') await update(false);
  }

  root.YueqianMaterials = { rawURL, sourceURL, imageReferences, imageMime, digest, validateSnapshot, downloadSnapshot, renderMarkdown, cachedValue };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountReader, { once: true });
    else mountReader();
  }
})(globalThis);
