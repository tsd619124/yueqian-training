// 审核通过 → catalog 候选生成器。
// 读取 approved-topics.json、review/intake.json、topics.json 与当前 external-catalog.js，
// 把已通过审核的提案转成可编排的 catalog 条目候选；不修改正式资料库、发布指针或客户端。
// 多来源 manifest 尚未实现，因此来自非当前来源的候选会标记 requiresMultiSource: true。
//   node content-pipeline/catalog.mjs
//   node content-pipeline/catalog.mjs --output output/content-pipeline --check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
const argumentsList = process.argv.slice(2);
function option(name) {
  const index = argumentsList.indexOf(name);
  if (index < 0) return null;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw new Error(name + ' 后需要参数。');
  argumentsList.splice(index, 2);
  return value;
}
const output = option('--output') || path.join(root, 'output/content-pipeline');
const checkOnly = argumentsList.includes('--check');
if (argumentsList.some(argument => argument !== '--check')) throw new Error('未知参数：' + argumentsList.join(' '));

const candidateIDs = {
  'microsoft-agents:13-agent-memory/README.md': 'ma-agent-memory',
  'microsoft-agents:12-context-engineering/README.md': 'ma-context-engineering',
  'microsoft-agents:05-agentic-rag/README.md': 'ma-agentic-rag',
  'microsoft-agents:08-multi-agent/README.md': 'ma-multi-agent',
  'openai-cookbook:examples/agents_api/README.md': 'oc-agents-api'
};

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
function readOptional(filePath) {
  try { return readJSON(filePath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function safePath(value) {
  return typeof value === 'string' && value.endsWith('.md') && !value.startsWith('/') && !value.includes('\\') &&
    !value.includes('..') && value.split('/').every(part => part && part !== '.' && part !== '..');
}
function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function unique(values) {
  return [...new Set(values)];
}
function existingCatalogArticles() {
  return globalThis.YUEQIAN_EXTERNAL_CATALOG?.articles || [];
}
function comparablePath(value) {
  return value.replace(/^translations\/zh-CN\//, '');
}
function lessonIDsFor(topics, prerequisiteTopicIDs, knownLessonIDs) {
  const selected = new Set();
  for (const topicID of prerequisiteTopicIDs || []) {
    const topic = (topics.topics || []).find(item => item.id === topicID);
    for (const lessonID of topic?.lessonIDs || []) selected.add(lessonID);
  }
  const result = [...selected].filter(id => knownLessonIDs.has(id)).sort();
  return result.length ? result : ['ref.agent'];
}

export function buildCatalogCandidates({ approved, intake, topics, registry, catalog }) {
  const knownLessonIDs = new Set(catalog.lessons ? Object.keys(catalog.lessons) : []);
  // 以正式外部 catalog 的来源为准；旧 catalog 默认属于 microsoft-genai。
  const externalSources = globalThis.YUEQIAN_EXTERNAL_CATALOG?.sources || catalog.sources || [{ id: 'microsoft-genai' }];
  const currentSourceIDs = new Set(externalSources.map(source => source.id));
  const articles = existingCatalogArticles();
  const existing = new Map();
  for (const article of articles) {
    const sourceID = article.sourceID || 'microsoft-genai';
    existing.set(sourceID + ':' + article.path, article);
    if (sourceID === 'microsoft-genai') existing.set('microsoft-genai:' + comparablePath(article.path), article);
  }
  const documents = new Map();
  for (const record of intake.documents || []) {
    const current = record.current;
    if (current) documents.set(current.id, current);
  }
  const registrySources = new Map((registry.sources || []).map(source => [source.id, source]));
  const candidates = [];
  const skipped = [];
  const usedIDs = new Set();
  for (const proposal of approved.proposals || []) {
    const evidenceDoc = (proposal.evidence || []).map(item => documents.get(item.documentID)).find(Boolean);
    if (!evidenceDoc) {
      skipped.push({ proposal: proposal.id, title: proposal.title, reason: '找不到已采集的审核正文' });
      continue;
    }
    const source = registrySources.get(evidenceDoc.sourceID);
    if (!source) {
      skipped.push({ proposal: proposal.id, title: proposal.title, reason: '来源未登记：' + evidenceDoc.sourceID });
      continue;
    }
    const licenseText = evidenceDoc.license?.text || '';
    if (!licenseText.includes('MIT License')) {
      skipped.push({ proposal: proposal.id, title: proposal.title, reason: '许可证不是已识别的 MIT' });
      continue;
    }
    if (!safePath(evidenceDoc.path) || !/^[a-f0-9]{40}$/.test(evidenceDoc.revision || '')) {
      skipped.push({ proposal: proposal.id, title: proposal.title, reason: '正文路径或 revision 无效' });
      continue;
    }
    const duplicate = existing.get(evidenceDoc.sourceID + ':' + evidenceDoc.path) ||
      existing.get(evidenceDoc.sourceID + ':' + comparablePath(evidenceDoc.path));
    if (duplicate) {
      skipped.push({ proposal: proposal.id, title: proposal.title, reason: '已在 catalog 中：' + duplicate.id, duplicateOf: duplicate.id });
      continue;
    }
    const key = evidenceDoc.sourceID + ':' + evidenceDoc.path;
    const id = candidateIDs[key] || (source.id.split('-')[0] + '-' + slug(path.basename(evidenceDoc.path, '.md')));
    if (usedIDs.has(id)) {
      skipped.push({ proposal: proposal.id, title: proposal.title, reason: '候选 ID 冲突：' + id });
      continue;
    }
    usedIDs.add(id);
    candidates.push({
      id,
      title: proposal.title,
      sourceID: evidenceDoc.sourceID,
      publisher: source.publisher,
      repository: evidenceDoc.repository || source.repository,
      path: evidenceDoc.path,
      revision: evidenceDoc.revision,
      license: 'MIT',
      lessonIDs: lessonIDsFor(topics, proposal.prerequisiteTopicIDs, knownLessonIDs),
      prerequisiteTopicIDs: proposal.prerequisiteTopicIDs || [],
      proposalID: proposal.id,
      evidenceDocumentID: evidenceDoc.id,
      status: 'candidate',
      requiresMultiSource: !currentSourceIDs.has(evidenceDoc.sourceID),
      reason: currentSourceIDs.has(evidenceDoc.sourceID)
        ? '与当前来源一致，可加入现有 catalog'
        : '审核已通过；等待多来源 manifest 支持后才能发布'
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    policy: '只生成 catalog 候选，不修改正式资料库、客户端内容或发布指针。',
    currentSourceIDs: [...currentSourceIDs],
    candidates,
    skipped
  };
}

export function renderReport(report) {
  let text = 'catalog 候选：' + report.candidates.length + ' 项，跳过 ' + report.skipped.length + ' 项\n';
  for (const item of report.candidates) {
    text += `- ${item.id} | ${item.sourceID} | ${item.title} | lessonIDs=${item.lessonIDs.join(',')} | ${item.requiresMultiSource ? '需要多来源' : '可加入当前来源'}\n`;
  }
  for (const item of report.skipped) text += `- 跳过 ${item.proposal} | ${item.title} | ${item.reason}\n`;
  return text;
}

async function main() {
  await import(pathToFileURL(path.join(root, 'yueqian-training/external-catalog.js')));
  const approved = readJSON(path.join(output, 'review/approved-topics.json'));
  const intake = readJSON(path.join(output, 'review/intake.json'));
  const topics = readJSON(path.join(directory, 'topics.json'));
  const registry = readJSON(path.join(directory, 'sources.json'));
  const catalog = readJSON(path.join(root, 'native-app/Sources/YueqianCore/Resources/catalog.json'));
  const report = buildCatalogCandidates({ approved, intake, topics, registry, catalog });
  const target = path.join(output, 'review/catalog-candidates.json');
  if (checkOnly) {
    const existing = readOptional(target);
    if (!existing || JSON.stringify(existing.candidates) !== JSON.stringify(report.candidates)) {
      throw new Error('catalog 候选与现有文件不一致，请重新运行 catalog.mjs。');
    }
    console.log(JSON.stringify({ status: 'catalog 候选一致', candidates: report.candidates.length, skipped: report.skipped.length, target }, null, 2));
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'w' });
  fs.renameSync(temporary, target);
  process.stdout.write(renderReport(report));
  console.log(JSON.stringify({ status: 'catalog 候选已生成；正式资料库未修改', candidates: report.candidates.length, skipped: report.skipped.length, target }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
