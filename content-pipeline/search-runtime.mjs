import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateRegistry, validateTopics, verifyLatest, writeAtomicJSON } from './lib.mjs';
import { createExternalSearch } from './external-search.mjs';
import { createSearchHandler, createSearchService } from './search-service.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const maximumBundleBytes = 4194304;
const generatedFiles = ['worker.mjs', 'search-common.mjs', 'search-service.mjs', 'external-search.mjs', 'search-bundle.json', 'wrangler.jsonc', 'package.json'];

async function readJSON(filePath, maximum, optional = false) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maximum) throw new Error('检索文件超过大小上限：' + path.basename(filePath));
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

export async function loadSearchBundle(output) {
  const manifest = await verifyLatest(output);
  const registry = validateRegistry(await readJSON(path.join(directory, 'sources.json'), 131072));
  const topics = await readJSON(path.join(directory, 'topics.json'), 131072);
  validateTopics(topics);
  const index = await readJSON(path.join(output, 'releases', manifest.releaseID, 'index.json'), 3145728);
  if (index?.schemaVersion !== 1 || !Array.isArray(index.documents) || index.documents.length !== manifest.documents.length) throw new Error('检索索引与发布清单不一致。');
  for (const document of index.documents) {
    const expected = manifest.documents.find(item => item.id === document.id);
    if (!expected || document.path !== expected.path || document.url !== expected.url || document.sourceID !== expected.sourceID || typeof document.text !== 'string') throw new Error('检索文档与发布清单不一致。');
  }
  let discovery = null;
  let discoveryWarning = null;
  try { discovery = await readJSON(path.join(output, 'discovery.json'), 1048576, true); }
  catch { discoveryWarning = 'invalid-discovery-file'; }
  const sources = registry.sources.map(source => ({ ...source, revision: manifest.sources.find(item => item.id === source.id)?.revision || null }));
  const content = { schemaVersion: 1, releaseID: manifest.releaseID, index, registry, topics, discovery, sources, discoveryWarning };
  const bytes = JSON.stringify(content);
  if (Buffer.byteLength(bytes) > maximumBundleBytes) throw new Error('检索内容包超过 4 MiB 上限。');
  return { ...content, bundleID: sha256(bytes) };
}

export async function createFileCache(filePath, maximumEntries = 128) {
  if (!Number.isInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 128) throw new Error('查询缓存数量上限无效。');
  const entries = new Map();
  try {
    const saved = await readJSON(filePath, 2097152, true);
    if (saved?.schemaVersion === 1 && Array.isArray(saved.entries) && saved.entries.length <= maximumEntries) {
      for (const [key, entry] of saved.entries) {
        if (typeof key !== 'string' || key.length > 600 || !Number.isFinite(entry?.createdAt) || Buffer.byteLength(JSON.stringify(entry)) > 131072) throw new Error('查询缓存格式无效。');
        entries.set(key, entry);
      }
    }
  } catch { entries.clear(); }
  let writing = Promise.resolve();
  return {
    async get(key) { return entries.has(key) ? structuredClone(entries.get(key)) : null; },
    async put(key, entry) {
      if (typeof key !== 'string' || key.length > 600 || Buffer.byteLength(JSON.stringify(entry)) > 131072) throw new Error('查询缓存条目超出上限。');
      entries.delete(key);
      entries.set(key, structuredClone(entry));
      while (entries.size > maximumEntries || Buffer.byteLength(JSON.stringify([...entries])) > 2000000) entries.delete(entries.keys().next().value);
      const value = { schemaVersion: 1, entries: [...entries] };
      writing = writing.catch(() => {}).then(() => writeAtomicJSON(filePath, value));
      await writing;
    }
  };
}

export async function startSearchServer(output, { host = '127.0.0.1', port = 8787, allowedOrigin = null, fetcher = fetch, limits = {}, now = () => Date.now(), cache } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('检索服务仅支持本机地址和有效端口。');
  if (allowedOrigin !== null && (!/^https?:\/\//u.test(allowedOrigin) || new URL(allowedOrigin).origin !== allowedOrigin)) throw new Error('CORS 来源必须是完整且不含路径的 HTTP(S) origin。');
  const bundle = await loadSearchBundle(output);
  const externalSearch = createExternalSearch({ registry: bundle.registry, discovery: bundle.discovery, topics: bundle.topics, fetcher, now });
  const storage = cache || await createFileCache(path.join(output, 'search', 'cache.json'));
  const service = createSearchService({ ...bundle, externalSearch, cache: storage, limits, now });
  const handler = createSearchHandler(service, { allowedOrigin });
  const server = http.createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const url = new URL(request.url || '/', 'http://localhost');
      const result = await handler(new Request(url, { method: request.method, headers }), { clientID: request.socket.remoteAddress || 'unknown' });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'search-unavailable' }));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  return {
    server, service, bundle,
    url: `http://${address.family === 'IPv6' ? '[' + address.address + ']' : address.address}:${address.port}`,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); })
  };
}

async function verifyGeneratedDirectory(destination) {
  const marker = await readJSON(path.join(destination, '.generated.json'), 16384);
  const files = await fs.readdir(destination);
  if (marker?.schemaVersion !== 1 || !Array.isArray(marker.files) || marker.files.length !== generatedFiles.length || files.length !== generatedFiles.length + 1) throw new Error('目标目录含未登记文件，保留现状。');
  for (const name of generatedFiles) {
    const expected = marker.files.find(item => item.path === name);
    if (!expected || sha256(await fs.readFile(path.join(destination, name))) !== expected.sha256) throw new Error('目标目录含人工修改，保留现状。');
  }
}

export async function prepareSearchWorker(output, { destination = path.join(output, 'search-worker') } = {}) {
  const bundle = await loadSearchBundle(output);
  const target = path.resolve(destination);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(target), '.search-worker-'));
  let backup = null;
  try {
    await fs.copyFile(path.join(directory, 'deployment/search-worker.mjs'), path.join(staging, 'worker.mjs'));
    for (const name of ['search-common.mjs', 'search-service.mjs', 'external-search.mjs']) await fs.copyFile(path.join(directory, name), path.join(staging, name));
    await fs.copyFile(path.join(directory, 'deployment/wrangler.search.jsonc'), path.join(staging, 'wrangler.jsonc'));
    await fs.writeFile(path.join(staging, 'search-bundle.json'), JSON.stringify(bundle) + '\n', { flag: 'wx' });
    await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'yueqian-content-search-worker', private: true, type: 'module' }) + '\n', { flag: 'wx' });
    const records = [];
    for (const name of generatedFiles) records.push({ path: name, sha256: sha256(await fs.readFile(path.join(staging, name))) });
    await writeAtomicJSON(path.join(staging, '.generated.json'), { schemaVersion: 1, bundleID: bundle.bundleID, files: records });
    try {
      await fs.access(target);
      await verifyGeneratedDirectory(target);
      backup = target + '.previous-' + crypto.randomUUID();
      await fs.rename(target, backup);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(staging, target); }
    catch (error) { if (backup) { await fs.rename(backup, target); backup = null; } throw error; }
    if (backup) await fs.rm(backup, { recursive: true, force: true });
    return { status: 'prepared-not-deployed', directory: target, releaseID: bundle.releaseID, bundleID: bundle.bundleID, documents: bundle.index.documents.length, files: generatedFiles.length + 1 };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
