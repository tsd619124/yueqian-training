import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadSearchBundle, createFileCache } from './search-runtime.mjs';
import { createExternalSearch } from './external-search.mjs';
import { createSearchHandler, createSearchService } from './search-service.mjs';

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

export async function startClientPreview(output, { webDirectory, port = 8788, fetcher = fetch } = {}) {
  if (!webDirectory || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('请指定 Web 目录和有效端口。');
  const root = await fs.realpath(webDirectory);
  const bundle = await loadSearchBundle(output);
  const cache = await createFileCache(path.join(output, 'search', 'preview-cache.json'));
  const service = createSearchService({ ...bundle, cache, externalSearch: createExternalSearch({ registry: bundle.registry, discovery: bundle.discovery, topics: bundle.topics, fetcher }) });
  const handleSearch = createSearchHandler(service);
  const server = http.createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/api/search' || url.pathname === '/health') {
        const result = await handleSearch(new Request(url, { method: request.method, headers: request.headers }), { clientID: request.socket.remoteAddress });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
      const relative = decodeURIComponent(url.pathname).replace(/^\//u, '') || 'index.html';
      if (relative.split('/').some(segment => segment === '..' || segment.startsWith('.')) || relative.includes('\\') || relative.includes('\0')) throw new Error('invalid-path');
      const file = await fs.realpath(path.join(root, relative));
      if (!file.startsWith(root + path.sep)) throw new Error('invalid-path');
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 33554432) throw new Error('invalid-file');
      response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (request.method === 'HEAD') { response.end(); return; }
      response.end(await fs.readFile(file));
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Not found');
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = 'http://127.0.0.1:' + server.address().port;
  return { server, url, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
