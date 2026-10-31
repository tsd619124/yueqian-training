import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogCandidates } from './catalog.mjs';

const registry = {
  sources: [
    { id: 'microsoft-genai', publisher: 'Microsoft', repository: 'microsoft/generative-ai-for-beginners' },
    { id: 'microsoft-agents', publisher: 'Microsoft', repository: 'microsoft/ai-agents-for-beginners' }
  ]
};
const topics = {
  topics: [
    { id: 'agents', lessonIDs: ['ref.agent'] },
    { id: 'context', lessonIDs: ['w2.3'] },
    { id: 'evaluation', lessonIDs: ['w5.2'] },
    { id: 'tools', lessonIDs: ['ref.agent', 'w2.1'] }
  ]
};
const catalog = {
  lessons: { 'ref.agent': {}, 'w2.1': {}, 'w2.3': {}, 'w5.2': {} },
  sources: [{ id: 'microsoft-genai' }]
};
function document(id, sourceID, path, revision) {
  return {
    id,
    current: {
      id,
      sourceID,
      repository: sourceID === 'microsoft-agents' ? 'microsoft/ai-agents-for-beginners' : 'microsoft/generative-ai-for-beginners',
      path,
      revision,
      sha256: 'a'.repeat(64),
      license: { text: 'MIT License\n\nCopyright (c) Microsoft Corporation.\n' }
    }
  };
}

test('审核通过的非当前来源生成 catalog 候选并标记多来源', () => {
  globalThis.YUEQIAN_EXTERNAL_CATALOG = { articles: [] };
  const report = buildCatalogCandidates({
    approved: { proposals: [{ id: 'p1', title: 'Memory for AI Agents', prerequisiteTopicIDs: ['agents', 'context', 'evaluation', 'tools'], evidence: [{ documentID: 'd1' }] }] },
    intake: { documents: [document('d1', 'microsoft-agents', '13-agent-memory/README.md', 'b'.repeat(40))] },
    topics,
    registry,
    catalog
  });
  assert.equal(report.candidates.length, 1);
  const candidate = report.candidates[0];
  assert.equal(candidate.id, 'ma-agent-memory');
  assert.equal(candidate.sourceID, 'microsoft-agents');
  assert.deepEqual(candidate.lessonIDs, ['ref.agent', 'w2.1', 'w2.3', 'w5.2']);
  assert.equal(candidate.requiresMultiSource, true);
  assert.equal(candidate.status, 'candidate');
});

test('已有译文或正式条目时跳过，不重复生成', () => {
  globalThis.YUEQIAN_EXTERNAL_CATALOG = {
    articles: [{ id: 'ms-rag', sourceID: 'microsoft-genai', path: 'translations/zh-CN/15-rag-and-vector-databases/README.md' }]
  };
  const report = buildCatalogCandidates({
    approved: { proposals: [{ id: 'p2', title: 'RAG and Vector Databases', prerequisiteTopicIDs: ['context'], evidence: [{ documentID: 'd2' }] }] },
    intake: { documents: [document('d2', 'microsoft-genai', '15-rag-and-vector-databases/README.md', 'c'.repeat(40))] },
    topics,
    registry,
    catalog
  });
  assert.equal(report.candidates.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].duplicateOf, 'ms-rag');
});

test('许可证不是 MIT 或来源未登记时跳过', () => {
  globalThis.YUEQIAN_EXTERNAL_CATALOG = { articles: [] };
  const missingSource = document('d3', 'unknown-source', 'x/README.md', 'd'.repeat(40));
  const notMIT = document('d4', 'microsoft-agents', 'y/README.md', 'e'.repeat(40));
  notMIT.current.license.text = 'Apache License\nVersion 2.0';
  const report = buildCatalogCandidates({
    approved: { proposals: [
      { id: 'p3', title: 'Unknown', evidence: [{ documentID: 'd3' }] },
      { id: 'p4', title: 'Not MIT', evidence: [{ documentID: 'd4' }] }
    ] },
    intake: { documents: [missingSource, notMIT] },
    topics,
    registry,
    catalog
  });
  assert.equal(report.candidates.length, 0);
  assert.equal(report.skipped.length, 2);
});
