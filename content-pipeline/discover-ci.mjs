import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSources, validateRegistry, writeAtomicJSON } from './lib.mjs';
import { validateDiscovery } from './external-search.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = validateRegistry(JSON.parse(await fs.readFile(path.join(root, 'content-pipeline/sources.json'))));
const output = path.join(root, 'output/content-pipeline/discovery.json');
let previous = null;
try { previous = JSON.parse(await fs.readFile(output)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const fetcher = async (address, options) => {
  const url = new URL(address);
  if (url.origin !== 'https://api.github.com' || !registry.sources.some(source => url.pathname.startsWith('/repos/' + source.repository + '/'))) throw new Error('来源不在配置范围。');
  const { stdout } = await execute('gh', ['api', '--method', 'GET', url.pathname + url.search], { maxBuffer: registry.budget.maxResponseBytes, signal: options.signal });
  return new Response(stdout, { headers: { 'content-type': 'application/json' } });
};
const result = await discoverSources(registry, previous, fetcher);
await validateDiscovery(registry, result);
await writeAtomicJSON(output, result);
console.log(JSON.stringify({ status: '公开来源已核对；GitHub CLI 安全使用已有认证', checkedAt: result.checkedAt, budget: result.budget, sources: result.sources.map(({ id, status, candidates }) => ({ id, status, candidates: candidates.length })) }, null, 2));
