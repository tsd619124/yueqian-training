import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRelease, discoverSources, readLibrarySnapshot, searchIndex, validateRegistry, verifyLatest, writeAtomicJSON, writeRelease } from './lib.mjs';
import { collectDocuments, reconcileIntake } from './intake.mjs';
import { applyReviewDecisions, buildReviewQueue } from './review.mjs';
import { renderReviewHTML } from './review-page.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
const registry = validateRegistry(JSON.parse(await fs.readFile(path.join(directory, 'sources.json'), 'utf8')));
const topics = JSON.parse(await fs.readFile(path.join(directory, 'topics.json'), 'utf8'));
const argumentsList = process.argv.slice(2);
const command = argumentsList.shift() || 'build';
const outputIndex = argumentsList.indexOf('--output');
const outputArgument = outputIndex >= 0 ? argumentsList.splice(outputIndex, 2)[1] : null;
if (outputIndex >= 0 && !outputArgument) throw new Error('--output 后需要目录。');
const output = outputArgument ? path.resolve(outputArgument) : path.join(root, 'output/content-pipeline');

async function readOptional(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function option(name) {
  const index = argumentsList.indexOf(name);
  if (index < 0) return null;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw new Error(name + ' 后需要参数。');
  argumentsList.splice(index, 2);
  return value;
}

async function writeReviewArtifacts(reviewDirectory, report) {
  await writeAtomicJSON(path.join(reviewDirectory, 'queue.json'), report);
  await writeAtomicJSON(path.join(reviewDirectory, 'approved-topics.json'), { schemaVersion: 1, publicationPolicy: report.publicationPolicy, proposals: report.approvedProposals });
  const temporary = path.join(reviewDirectory, `index.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, renderReviewHTML(report), { flag: 'wx' });
    await fs.rename(temporary, path.join(reviewDirectory, 'index.html'));
  } finally { await fs.rm(temporary, { force: true }); }
}

if (command === 'build') {
  if (argumentsList.length) throw new Error('build 只接受 --output。');
  // 正式图文的来源是随站点发布的资料库（yueqian-training/content-library）；更新来源原文用 native-app/scripts/update-external-materials.mjs。
  await import(pathToFileURL(path.join(root, 'yueqian-training/external-catalog.js')));
  await import(pathToFileURL(path.join(root, 'yueqian-training/external-materials.js')));
  const snapshot = await readLibrarySnapshot();
  await globalThis.YueqianMaterials.validateSnapshot(snapshot, globalThis.YUEQIAN_EXTERNAL_CATALOG);
  const bundle = buildRelease(snapshot, registry, topics);
  const result = await writeRelease(output, bundle);
  console.log(JSON.stringify({ status: '本地静态内容已构建并校验，未部署', ...result, documents: bundle.manifest.documents.length, imageReferences: bundle.manifest.imageReferences, uniqueImages: bundle.manifest.assetCount, output }, null, 2));
} else if (command === 'check') {
  if (argumentsList.length) throw new Error('check 只接受 --output。');
  const manifest = await verifyLatest(output);
  console.log(JSON.stringify({ status: '版本清单、原文与图片校验通过', releaseID: manifest.releaseID, documents: manifest.documents.length, files: manifest.files.length }, null, 2));
} else if (command === 'discover') {
  if (argumentsList.length) throw new Error('discover 只接受 --output。');
  const previous = await readOptional(path.join(output, 'discovery.json'));
  const discovery = await discoverSources(registry, previous);
  await writeAtomicJSON(path.join(output, 'discovery.json'), discovery);
  const failures = discovery.sources.filter(source => source.status === 'unavailable' || source.status === 'stale');
  console.log(JSON.stringify({ status: failures.length ? '部分来源检查失败，保留有效缓存' : '公开来源检查完成，仅生成未审核候选', budget: discovery.budget, sources: discovery.sources.map(({ id, status, revision, totalMatchingFiles, selectionLimited, candidates, lastError }) => ({ id, status, revision, totalMatchingFiles, selectionLimited, candidates: candidates.length, lastError })) }, null, 2));
  if (failures.length) process.exitCode = 1;
} else if (command === 'collect' || command === 'review') {
  const sourceID = command === 'collect' ? option('--source') : null;
  const limit = command === 'collect' ? option('--limit') : null;
  const paths = [];
  while (command === 'collect' && argumentsList.includes('--path')) paths.push(option('--path'));
  const decisionsPath = command === 'review' ? option('--decisions') : null;
  if (argumentsList.length) throw new Error('未知参数：' + argumentsList.join(' '));
  const reviewDirectory = path.join(output, 'review');
  await fs.mkdir(reviewDirectory, { recursive: true });
  const lockPath = path.join(reviewDirectory, '.lock');
  const lock = await fs.open(lockPath, 'wx').catch(error => { if (error.code === 'EEXIST') throw new Error('已有正文采集或审核命令正在运行；请等待该命令完成。'); throw error; });
  try {
    const discovery = await readOptional(path.join(output, 'discovery.json'));
    const manifest = await verifyLatest(output);
    const index = JSON.parse(await fs.readFile(path.join(output, 'releases', manifest.releaseID, 'index.json'), 'utf8'));
    const curriculum = JSON.parse(await fs.readFile(path.join(root, 'native-app/Sources/YueqianCore/Resources/catalog.json'), 'utf8'));
    const intakePath = path.join(reviewDirectory, 'intake.json');
    let intake = await readOptional(intakePath);
    if (command === 'collect') {
      intake = await collectDocuments(registry, discovery, intake, { sourceID, ...(limit === null ? {} : { limit: Number(limit) }), ...(paths.length ? { paths } : {}) });
      await writeAtomicJSON(intakePath, intake);
    }
    intake = reconcileIntake(registry, discovery, intake);
    const historyPath = path.join(reviewDirectory, 'reviews.json');
    let history = await readOptional(historyPath) || { schemaVersion: 1, records: [] };
    let report = buildReviewQueue(registry, topics, intake, index, history, curriculum);
    if (decisionsPath) {
      const stat = await fs.stat(path.resolve(decisionsPath));
      if (stat.size > 2097152) throw new Error('审核决定文件超过 2 MiB 上限。');
      const batch = JSON.parse(await fs.readFile(path.resolve(decisionsPath), 'utf8'));
      history = applyReviewDecisions(report, history, batch);
      report = buildReviewQueue(registry, topics, intake, index, history, curriculum);
      await writeAtomicJSON(historyPath, history);
    }
    await writeReviewArtifacts(reviewDirectory, report);
    console.log(JSON.stringify({ status: '本地审核队列已更新；正式课程与发布指针未更改', scope: report.scope, ...(command === 'collect' ? { budget: intake.budget, selected: intake.selected, failures: intake.failures, cacheErrors: intake.cacheErrors } : {}), queue: report.queue.reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] || 0) + 1 }), {}), approvedProposals: report.approvedProposals.length, reviewRecords: history.records.length, reviewPage: path.join(reviewDirectory, 'index.html') }, null, 2));
    if (command === 'collect' && (intake.failures.length || intake.sourceStates.some(source => !['checked', 'unchanged'].includes(source.status)))) process.exitCode = 1;
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
} else if (command === 'search') {
  const query = argumentsList.join(' ').trim();
  if (!query) throw new Error('search 后需要检索词。');
  const manifest = await verifyLatest(output);
  const index = JSON.parse(await fs.readFile(path.join(output, 'releases', manifest.releaseID, 'index.json'), 'utf8'));
  console.log(JSON.stringify({ scope: '已核准原文的本地关键词检索', query, results: searchIndex(index, query) }, null, 2));
} else if (command === 'serve-search') {
  const portArgument = option('--port');
  const allowedOrigin = option('--origin');
  if (argumentsList.length) throw new Error('未知参数：' + argumentsList.join(' '));
  if (portArgument !== null && (!/^[0-9]{1,5}$/u.test(portArgument) || Number(portArgument) > 65535)) throw new Error('--port 需为 0–65535。');
  if (allowedOrigin && new URL(allowedOrigin).origin !== allowedOrigin) throw new Error('--origin 需为完整来源，例如 https://example.com，不含路径或末尾斜杠。');
  const { startSearchServer } = await import('./search-runtime.mjs');
  const runtime = await startSearchServer(output, { port: portArgument === null ? 8787 : Number(portArgument), allowedOrigin });
  console.log(JSON.stringify({ status: '本地检索服务已启动', url: runtime.url, health: runtime.url + '/health', search: runtime.url + '/api/search?q=' + encodeURIComponent('上下文工程'), scope: '已核准资料与三个配置仓库的候选正文检索；未部署' }, null, 2));
  const stop = async () => { await runtime.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} else if (command === 'prepare-search-worker') {
  if (argumentsList.length) throw new Error('prepare-search-worker 只接受 --output。');
  const { prepareSearchWorker } = await import('./search-runtime.mjs');
  console.log(JSON.stringify({ status: '独立 Workers 工程已准备，未部署', ...(await prepareSearchWorker(output)) }, null, 2));
} else if (command === 'preview-clients') {
  const portArgument = option('--port');
  if (argumentsList.length || (portArgument !== null && (!/^[0-9]{1,5}$/u.test(portArgument) || Number(portArgument) > 65535))) throw new Error('preview-clients 只接受 --port 0–65535 和 --output。');
  const { startClientPreview } = await import('./client-preview.mjs');
  const runtime = await startClientPreview(output, { webDirectory: path.join(root, 'yueqian-training'), port: portArgument === null ? 8788 : Number(portArgument) });
  console.log(JSON.stringify({ status: '两端联调服务已启动，仅本机访问', reader: runtime.url + '/materials.html', contentBaseURL: runtime.url + '/content-library/', searchURL: runtime.url + '/api/search' }, null, 2));
  process.once('SIGINT', () => runtime.close());
  process.once('SIGTERM', () => runtime.close());
} else throw new Error('命令仅支持 build、check、discover、collect、review、search、serve-search、prepare-search-worker、preview-clients。');
