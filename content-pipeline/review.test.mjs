import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRelease, discoverSources, sha256, sourceURL, writeAtomicJSON, writeRelease } from './lib.mjs';
import { collectDocuments, documentVersion, gitBlobSHA, reconcileIntake } from './intake.mjs';
import { applyReviewDecisions, buildReviewQueue, validateHistory } from './review.mjs';
import { renderReviewHTML } from './review-page.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
const configuration = JSON.parse(await fs.readFile(path.join(directory, 'sources.json'), 'utf8'));
const registry = { ...configuration, sources: [configuration.sources[0]] };
const topics = JSON.parse(await fs.readFile(path.join(directory, 'topics.json'), 'utf8'));
const revision = 'a'.repeat(40);
const laterRevision = 'b'.repeat(40);
const now = new Date('2026-10-28T06:00:00Z');
const licenseText = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n';
const bodies = ['# Agent Memory\n\nAI agents use context engineering to retain information and support function calling.\n\n![Memory diagram](images/memory.png)\n', '# Agentic RAG\n\nRetrieval augmented generation connects AI agents with evidence from source documents.\n'];
const emptyIndex = { schemaVersion: 1, documents: [] };
const emptyHistory = { schemaVersion: 1, records: [] };
const allChecks = { source: true, relevance: true, versions: true, rights: true, prerequisites: true };

function fixture(markdowns = bodies, nextRevision = revision, license = licenseText) {
  const source = registry.sources[0];
  const files = markdowns.map((markdown, index) => ({ path: `0${index + 1}-topic/README.md`, markdown }));
  const discovery = { schemaVersion: 1, sources: [{ id: source.id, repository: source.repository, revision: nextRevision, checkedAt: now.toISOString(), status: 'checked', totalMatchingFiles: files.length, selectionLimited: false, licenseFile: license === null ? null : { path: source.licensePath, blobSHA: gitBlobSHA(Buffer.from(license)), url: sourceURL(source.repository, nextRevision, source.licensePath) }, candidates: files.map(file => ({ id: source.id + ':' + sha256(file.path).slice(0, 16), sourceID: source.id, path: file.path, revision: nextRevision, blobSHA: gitBlobSHA(Buffer.from(file.markdown)), url: sourceURL(source.repository, nextRevision, file.path) })) }] };
  const responses = new Map(files.map(file => [sourceURL(source.repository, nextRevision, file.path, true), file.markdown]));
  responses.set(sourceURL(source.repository, nextRevision, source.licensePath, true), license);
  function fetcher(url, options) {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(responses.has(url));
    return new Response(responses.get(url));
  }
  return { discovery, fetcher };
}

async function intakeFor(markdowns = bodies) {
  const current = fixture(markdowns);
  return collectDocuments(registry, current.discovery, null, {}, current.fetcher, now);
}

function batchFor(item, decision = 'approve') {
  return { schemaVersion: 1, reviewer: '测试审核人', exportedAt: now.toISOString(), decisions: [{ itemID: item.id, fingerprint: item.fingerprint, decision, action: ['new-topic', 'material-update'].includes(item.kind) ? 'add-topic' : 'resolve', note: '测试：已核对原文证据、适用版本与前置能力。', prerequisiteTopicIDs: ['agents'], checks: allChecks }] };
}

test('正文和许可证固定到提交，逐字校验 Git blob 与 SHA-256，不自动发布', async () => {
  const intake = await intakeFor();
  assert.equal(intake.budget.requests, 3);
  assert.equal(intake.failures.length, 0);
  assert.equal(intake.documents.length, 2);
  assert.equal(intake.scope.complete, true);
  for (const entry of intake.documents) {
    assert.ok(bodies.includes(entry.current.markdown));
    assert.equal(entry.current.sha256, sha256(entry.current.markdown));
    assert.equal(entry.current.blobSHA, gitBlobSHA(Buffer.from(entry.current.markdown)));
    assert.equal(entry.current.license.text, licenseText);
    assert.equal(entry.current.publishedAt, undefined);
  }
});

test('发现目录登记许可证 blob，旧目录缺少元数据时重新核对文件树', async () => {
  const current = fixture();
  const found = current.discovery.sources[0];
  function fetcher(url) {
    return new Response(JSON.stringify(url.includes('/commits/') ? { sha: revision, commit: { tree: { sha: laterRevision } } } : { sha: laterRevision, truncated: false, tree: [...found.candidates.map(candidate => ({ type: 'blob', mode: '100644', path: candidate.path, sha: candidate.blobSHA })), { type: 'blob', mode: '100644', path: 'LICENSE', sha: found.licenseFile.blobSHA }] }));
  }
  const discovery = await discoverSources(registry, null, fetcher, now);
  assert.deepEqual(discovery.sources[0].licenseFile, found.licenseFile);
  const old = structuredClone(discovery);
  delete old.sources[0].licenseFile;
  const refreshed = await discoverSources(registry, old, fetcher, now);
  assert.equal(refreshed.budget.requests, 2);
  assert.deepEqual(refreshed.sources[0].licenseFile, found.licenseFile);
});

test('相同正文和许可复用缓存，无关仓库提交不制造新正文版本或下载时间', async () => {
  const previous = await intakeFor();
  const next = fixture(bodies, laterRevision);
  const intake = await collectDocuments(registry, next.discovery, previous, {}, () => assert.fail('不应重新下载'), new Date('2026-10-28T07:00:00Z'));
  assert.equal(intake.budget.requests, 0);
  assert.deepEqual(intake.documents.map(entry => entry.current), previous.documents.map(entry => entry.current));
  assert.ok(intake.documents.every(entry => entry.verifiedRevision === laterRevision));
});

test('小批量轮转采集与显式路径限制，不重复采集已校验正文', async () => {
  const current = fixture();
  const first = await collectDocuments(registry, current.discovery, null, { limit: 1 }, current.fetcher, now);
  assert.equal(first.documents.length, 1);
  assert.equal(first.scope.remaining, 1);
  const second = await collectDocuments(registry, current.discovery, first, { limit: 1 }, current.fetcher, now);
  assert.equal(second.budget.requests, 1);
  assert.equal(second.documents.length, 2);
  const selected = await collectDocuments(registry, current.discovery, null, { sourceID: registry.sources[0].id, paths: ['02-topic/README.md'] }, current.fetcher, now);
  assert.equal(selected.documents[0].current.path, '02-topic/README.md');
  await assert.rejects(() => collectDocuments(registry, current.discovery, null, { limit: 100 }, current.fetcher), /上限/);
  await assert.rejects(() => collectDocuments(registry, current.discovery, null, { sourceID: registry.sources[0].id, paths: ['not-found.md'] }, current.fetcher), /发现目录/);
});

test('正文变化只下载变化文档，保留前一正文与可回溯的增删证据', async () => {
  const previous = await intakeFor();
  const next = fixture([bodies[0].replace('retain information', 'retain verified memories'), bodies[1]], laterRevision);
  const intake = await collectDocuments(registry, next.discovery, previous, {}, next.fetcher, now);
  assert.equal(intake.budget.requests, 1);
  const entry = intake.documents.find(item => item.previous);
  assert.equal(entry.previous.markdown, bodies[0]);
  const report = buildReviewQueue(registry, topics, intake, emptyIndex);
  const change = report.queue.find(item => item.kind === 'content-change');
  assert.ok(change.evidence.some(proof => proof.version === 'previous' && proof.quote.includes('retain information')));
  assert.ok(change.evidence.some(proof => proof.version === 'current' && proof.quote.includes('retain verified memories')));
});

test('许可变化复用原正文，旧审核随许可版本变化而失效', async () => {
  const previous = await intakeFor();
  const report = buildReviewQueue(registry, topics, previous, emptyIndex);
  const item = report.queue.find(candidate => candidate.kind === 'new-topic');
  const history = applyReviewDecisions(report, emptyHistory, batchFor(item), now);
  const next = fixture(bodies, laterRevision, licenseText + '\nCopyright additional contributor\n');
  const intake = await collectDocuments(registry, next.discovery, previous, {}, next.fetcher, now);
  assert.equal(intake.budget.requests, 1);
  assert.ok(intake.documents.every(entry => entry.previous && documentVersion(entry.previous) !== documentVersion(entry.current)));
  const updated = buildReviewQueue(registry, topics, intake, emptyIndex, history);
  assert.equal(updated.queue.find(candidate => candidate.id === item.id).status, 'needs-review');
  assert.equal(updated.approvedProposals.length, 0);
  assert.throws(() => applyReviewDecisions(updated, history, batchFor(item)), /版本已变化/);
});

test('下载中断或错误 blob 保留有效旧正文和真实下载时间', async () => {
  const previous = await intakeFor();
  const next = fixture([bodies[0] + '\nNew paragraph.\n', bodies[1]], laterRevision);
  for (const fetcher of [() => new Response('unavailable', { status: 503 }), () => new Response('wrong bytes'), () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('# partial')); controller.error(new Error('interrupted')); } }))]) {
    const intake = await collectDocuments(registry, next.discovery, previous, {}, fetcher, now);
    assert.equal(intake.failures.length, 1);
    assert.ok(intake.documents.some(entry => entry.status === 'stale'));
    assert.deepEqual(intake.documents.map(entry => entry.current), previous.documents.map(entry => entry.current));
  }
});

test('坏缓存重新采集，审核不能消费损坏的正文或许可', async () => {
  const previous = await intakeFor();
  const corrupt = structuredClone(previous);
  corrupt.documents[0].current.markdown += 'tampered';
  const current = fixture();
  assert.throws(() => reconcileIntake(registry, current.discovery, corrupt), /完整性/);
  assert.throws(() => buildReviewQueue(registry, topics, corrupt, emptyIndex), /完整性/);
  const repaired = await collectDocuments(registry, current.discovery, corrupt, {}, current.fetcher, now);
  assert.equal(repaired.cacheErrors.length, 1);
  assert.equal(repaired.budget.requests, 1);
  assert.deepEqual(repaired.documents.map(entry => entry.current), previous.documents.map(entry => entry.current));
});

test('请求、流式流量与存储预算阻断采集，不留下半篇正文', async () => {
  const current = fixture();
  const limited = { ...registry, budget: { ...registry.budget, maxRequests: 1 } };
  const intake = await collectDocuments(limited, current.discovery, null, {}, current.fetcher, now);
  assert.equal(intake.budget.requests, 1);
  assert.equal(intake.documents.length, 0);
  assert.equal(intake.failures.length, 2);
  let cancelled = false;
  const streamLimited = { ...registry, budget: { ...registry.budget, maxDownloadBytes: 100 } };
  const streamed = await collectDocuments(streamLimited, current.discovery, null, {}, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(200)); }, cancel() { cancelled = true; } })), now);
  assert.equal(cancelled, true);
  assert.equal(streamed.documents.length, 0);
  const stored = await collectDocuments({ ...registry, collection: { ...registry.collection, maxStoredBytes: 17000 } }, current.discovery, null, {}, current.fetcher, now);
  assert.equal(stored.documents.length, 0);
  assert.ok(stored.failures.every(failure => failure.error.includes('存储上限')));
});

test('来源故障保留旧正文，取样之外的文件标记未核实，不误判为删除', async () => {
  const previous = await intakeFor();
  const current = fixture();
  current.discovery.sources[0].status = 'stale';
  const intake = await collectDocuments(registry, current.discovery, previous, {}, () => assert.fail('故障来源不下载'), now);
  assert.ok(intake.documents.every(entry => entry.status === 'stale'));
  current.discovery.sources[0].status = 'checked';
  current.discovery.sources[0].candidates.pop();
  current.discovery.sources[0].selectionLimited = true;
  const sampled = reconcileIntake(registry, current.discovery, previous);
  assert.ok(sampled.documents.some(entry => entry.status === 'unverified'));
  assert.equal(sampled.scope.complete, false);
  current.discovery.sources[0].selectionLimited = false;
  const removed = reconcileIntake(registry, current.discovery, previous);
  assert.ok(removed.documents.some(entry => entry.status === 'removed'));
});

test('篡改来源地址、缺少许可元数据和非法 UTF-8 不能进入正文缓存', async () => {
  const current = fixture();
  const tampered = structuredClone(current.discovery);
  tampered.sources[0].candidates[0].url = 'https://unapproved.example/README.md';
  await assert.rejects(() => collectDocuments(registry, tampered, null, {}, () => assert.fail('非法地址不能请求')), /来源无效/);
  delete tampered.sources[0].licenseFile;
  await assert.rejects(() => collectDocuments(registry, tampered), /许可证元数据/);
  const bytes = Buffer.from([255, 255]);
  const invalid = fixture([bodies[0]], revision, null);
  invalid.discovery.sources[0].candidates[0].blobSHA = gitBlobSHA(bytes);
  const intake = await collectDocuments(registry, invalid.discovery, null, {}, () => new Response(bytes), now);
  assert.equal(intake.documents.length, 0);
  assert.equal(intake.failures.length, 1);
});

test('主题与能力线索保留原文行号、哈希及原图地址，不把命中等同完整覆盖', async () => {
  const intake = await intakeFor();
  const report = buildReviewQueue(registry, topics, intake, emptyIndex);
  assert.ok(report.queue.some(item => item.title === 'Agent Memory' && item.kind === 'new-topic' && item.suggestedPrerequisiteTopicIDs.includes('agents')));
  for (const item of report.queue) for (const proof of item.evidence) {
    const document = intake.documents.find(entry => entry.id === proof.documentID).current;
    assert.equal(document.markdown.split(/\r?\n/)[proof.lineStart - 1].slice(proof.columnStart - 1, proof.columnStart - 1 + proof.quote.length), proof.quote);
    assert.ok(proof.url.includes(revision));
    assert.equal(proof.sha256, document.sha256);
  }
  const memory = report.queue.find(item => item.title === 'Agent Memory');
  assert.ok(memory.images[0].url.includes('/' + revision + '/01-topic/images/memory.png'));
  assert.equal(memory.images[0].status, 'not-reviewed');
  assert.ok(report.coverage.every(topic => topic.status === 'no-evidence'));
  assert.ok(report.coverage.some(topic => topic.candidateEvidence.length > 0));
  assert.equal(report.approvedProposals.length, 0);
});

test('人工审核要求版本、理由、逐项确认和明确的前置能力，批量错误不部分写入', async () => {
  const report = buildReviewQueue(registry, topics, await intakeFor(), emptyIndex);
  const item = report.queue[0];
  for (const changes of [{ checks: {} }, { action: undefined }, { prerequisiteTopicIDs: undefined }, { prerequisiteTopicIDs: ['invented'] }, { note: '' }, { fingerprint: '0'.repeat(64) }]) {
    const batch = batchFor(item);
    Object.assign(batch.decisions[0], changes);
    assert.throws(() => applyReviewDecisions(report, emptyHistory, batch));
  }
  const batch = batchFor(item);
  batch.decisions.push({ ...batch.decisions[0], itemID: 'not-found' });
  assert.throws(() => applyReviewDecisions(report, emptyHistory, batch));
  assert.equal(emptyHistory.records.length, 0);
});

test('审核记录可重放去重、篡改可检测，通过仅进入编排候选', async () => {
  const intake = await intakeFor();
  const report = buildReviewQueue(registry, topics, intake, emptyIndex);
  const batch = batchFor(report.queue[0]);
  const history = applyReviewDecisions(report, emptyHistory, batch, now);
  assert.equal(history.records.length, 1);
  assert.equal(applyReviewDecisions(report, history, batch).records.length, 1);
  const updated = buildReviewQueue(registry, topics, intake, emptyIndex, history);
  assert.equal(updated.approvedProposals.length, 1);
  assert.equal(updated.approvedProposals[0].eligibleForPublication, false);
  const tampered = structuredClone(history);
  tampered.records[0].note = '篡改理由';
  assert.throws(() => validateHistory(tampered), /哈希/);
  for (const decision of ['reject', 'defer']) {
    const decided = applyReviewDecisions(report, history, batchFor(report.queue[0], decision));
    assert.equal(buildReviewQueue(registry, topics, intake, emptyIndex, decided).approvedProposals.length, 0);
  }
});

test('对照真实 60 个课程主题，课程变更后旧审核失效，人工可调整编排方式', async () => {
  const curriculum = JSON.parse(await fs.readFile(path.join(root, 'native-app/Sources/YueqianCore/Resources/catalog.json'), 'utf8'));
  const intake = await intakeFor();
  const report = buildReviewQueue(registry, topics, intake, emptyIndex, emptyHistory, curriculum);
  assert.equal(report.curriculum.lessons, 60);
  assert.ok(report.queue.every(item => item.noveltyStatus === 'requires-review' && item.curriculumMatches.length > 0));
  assert.ok(report.coverage.every(topic => topic.curriculumMatches.every(lesson => curriculum.lessons[lesson.id].t === lesson.title)));
  const batch = batchFor(report.queue[0]);
  batch.decisions[0].action = 'update-material';
  const history = applyReviewDecisions(report, emptyHistory, batch);
  const approved = buildReviewQueue(registry, topics, intake, emptyIndex, history, curriculum);
  assert.equal(approved.approvedProposals[0].kind, 'material-update');
  const changed = structuredClone(curriculum);
  changed.lessons['ref.agent'].t += ' 更新';
  const updated = buildReviewQueue(registry, topics, intake, emptyIndex, history, changed);
  assert.equal(updated.approvedProposals.length, 0);
  assert.ok(updated.queue.some(item => item.status === 'needs-review'));
});

test('发现新 blob 后立即阻断旧审核，无需等到新正文下载成功', async () => {
  const intake = await intakeFor();
  const report = buildReviewQueue(registry, topics, intake, emptyIndex);
  const item = report.queue.find(candidate => candidate.title === 'Agent Memory');
  const history = applyReviewDecisions(report, emptyHistory, batchFor(item), now);
  const next = fixture([bodies[0] + '\nChanged.\n', bodies[1]], laterRevision);
  const reconciled = reconcileIntake(registry, next.discovery, intake);
  const updated = buildReviewQueue(registry, topics, reconciled, emptyIndex, history);
  assert.equal(updated.queue.find(candidate => candidate.id === item.id).status, 'needs-review');
  assert.equal(updated.approvedProposals.length, 0);
  assert.ok(updated.queue.some(candidate => candidate.kind === 'source-check'));
  assert.throws(() => applyReviewDecisions(updated, history, batchFor(updated.queue.find(candidate => candidate.id === item.id))), /阻塞/);
});

test('超过 72 小时未检查的来源暂停采集与审核，保留原文供阅读', async () => {
  const intake = await intakeFor();
  const report = buildReviewQueue(registry, topics, intake, emptyIndex);
  const history = applyReviewDecisions(report, emptyHistory, batchFor(report.queue[0]), now);
  const current = fixture();
  const later = new Date(now.getTime() + 73 * 3600000);
  const expired = await collectDocuments(registry, current.discovery, intake, {}, () => assert.fail('先刷新发现目录，不下载旧提交'), later);
  assert.equal(expired.budget.requests, 0);
  assert.ok(expired.sourceStates.every(source => source.status === 'expired'));
  assert.deepEqual(expired.documents.map(entry => entry.current), intake.documents.map(entry => entry.current));
  const updated = buildReviewQueue(registry, topics, expired, emptyIndex, history);
  assert.equal(updated.approvedProposals.length, 0);
  assert.ok(updated.queue.some(item => item.status === 'needs-review'));
});

test('正文缺少或使用未支持许可时保留证据，但不能通过审核', async () => {
  for (const license of [null, 'All rights reserved']) {
    const current = fixture(bodies, revision, license);
    const intake = await collectDocuments(registry, current.discovery, null, {}, current.fetcher, now);
    const report = buildReviewQueue(registry, topics, intake, emptyIndex);
    assert.ok(report.queue.every(item => item.blockers.length > 0));
    assert.throws(() => applyReviewDecisions(report, emptyHistory, batchFor(report.queue[0])), /阻塞/);
    assert.equal(applyReviewDecisions(report, emptyHistory, batchFor(report.queue[0], 'defer')).records.length, 1);
  }
});

test('弃用和相近表述的版本或否定差异进入复核，代码片段不参与推断', async () => {
  const intake = await intakeFor(['# Agent Memory\n\nUse API version 1 for tool calling in the application.\nTool calls must be approved by a human reviewer.\nThis endpoint is deprecated.\n', '# Agentic RAG\n\nUse API version 2 for tool calling in the application.\nTool calls must not be approved by a human reviewer.\n```md\nThis other API is obsolete.\n```\n']);
  const report = buildReviewQueue(registry, topics, intake, emptyIndex);
  assert.equal(report.queue.filter(item => item.kind === 'deprecation').length, 1);
  assert.equal(report.queue.filter(item => item.kind === 'possible-conflict').length, 2);
  assert.ok(report.queue.every(item => item.status === 'pending'));
  assert.ok(report.queue.filter(item => item.kind === 'possible-conflict').every(item => item.evidence.length === 2));
  const history = applyReviewDecisions(report, emptyHistory, batchFor(report.queue.find(item => item.kind === 'deprecation')));
  const resolved = buildReviewQueue(registry, topics, intake, emptyIndex, history);
  assert.equal(resolved.approvedProposals.length, 0);
  assert.ok(resolved.queue.some(item => item.kind === 'deprecation' && item.status === 'approved'));
});

test('审核页转义来源文本且不加载远程图片，外部文本不能注入脚本', async () => {
  const intake = await intakeFor(['# Agent Memory </script><img src=x onerror=alert(1)>\n\nSome external paragraph describing context engineering and agent memory for evidence.\n![unsafe](javascript:alert)\n']);
  const report = buildReviewQueue(registry, topics, intake, emptyIndex);
  const html = renderReviewHTML(report);
  assert.ok(html.includes('&lt;/script&gt;'));
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.ok(!html.includes('<img src='));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('default-src \'none\''));
});

test('真实 CLI 导入与重新审核保持正式发布指针和材料文件不变', async context => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-topic-review-'));
  context.after(() => fs.rm(output, { recursive: true, force: true }));
  await import('../yueqian-training/external-snapshot.js');
  const bundle = buildRelease(globalThis.YUEQIAN_EXTERNAL_SEED, configuration, topics);
  await writeRelease(output, bundle);
  const pointerBefore = await fs.readFile(path.join(output, 'latest.json'), 'utf8');
  const current = fixture();
  const intake = await intakeFor();
  await writeAtomicJSON(path.join(output, 'discovery.json'), current.discovery);
  await writeAtomicJSON(path.join(output, 'review/intake.json'), intake);
  const execute = promisify(execFile);
  const run = (...argumentsList) => execute(process.execPath, [path.join(directory, 'run.mjs'), 'review', '--output', output, ...argumentsList], { cwd: root });
  await run();
  const report = JSON.parse(await fs.readFile(path.join(output, 'review/queue.json'), 'utf8'));
  const decisionsPath = path.join(output, 'decisions.json');
  await writeAtomicJSON(decisionsPath, batchFor(report.queue[0]));
  await run('--decisions', decisionsPath);
  await run('--decisions', decisionsPath);
  const history = JSON.parse(await fs.readFile(path.join(output, 'review/reviews.json'), 'utf8'));
  assert.equal(history.records.length, 1);
  const next = fixture(bodies.map(body => body + '\nNew evidence.\n'), laterRevision);
  await writeAtomicJSON(path.join(output, 'discovery.json'), next.discovery);
  await run();
  const updated = JSON.parse(await fs.readFile(path.join(output, 'review/queue.json'), 'utf8'));
  assert.equal(updated.approvedProposals.length, 0);
  assert.ok(updated.queue.some(item => item.status === 'needs-review'));
  assert.equal(await fs.readFile(path.join(output, 'latest.json'), 'utf8'), pointerBefore);
  assert.equal(bundle.files.get('index.json').toString(), await fs.readFile(path.join(output, 'releases', bundle.releaseID, 'index.json'), 'utf8'));
  assert.ok((await fs.readFile(path.join(output, 'review/index.html'), 'utf8')).includes('主题审核'));
});
