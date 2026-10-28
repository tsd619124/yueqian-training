import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './lib.mjs';

const base = new URL(process.argv[2]);
const directory = path.resolve(process.argv[3]);
const report = JSON.parse(await fs.readFile(path.join(directory, 'release-manifest.json')));
const results = [];
for (const record of report.files) {
  const address = new URL(record.path, base);
  address.searchParams.set('verify', record.sha256.slice(0, 12));
  const response = await fetch(address, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
  assert.equal(response.status, 200, record.path);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, record.bytes, record.path);
  assert.equal(sha256(bytes), record.sha256, record.path);
  results.push({ path: record.path, status: response.status, matching: true });
}
const services = await fs.readFile(path.join(directory, 'material-services.js'), 'utf8');
const searchURL = services.match(/searchURL:\s*['"]([^'"]+)['"]/u)?.[1];
if (searchURL) {
  const address = new URL(searchURL);
  address.searchParams.set('q', '向量数据库');
  address.searchParams.set('scope', 'library');
  const response = await fetch(address, { headers: { origin: base.origin }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), base.origin);
  const result = await response.json();
  assert.equal(result.releaseID, report.contentRelease);
  assert.ok(result.library.results.length > 0);
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), base: base.href, webVersion: report.webVersion, contentRelease: report.contentRelease, filesMatching: results.length, searchVerified: Boolean(searchURL), results }, null, 2));
