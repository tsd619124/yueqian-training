import { coverageReport, plainText, sha256, sourceURL, validateTopics } from './lib.mjs';
import { documentVersion, validateDocument } from './intake.mjs';

const prerequisiteRules = {
  rag: ['context'], agents: ['tools'], tools: ['structured-output'], evaluation: [], security: [], context: [],
  mcp: ['tools', 'security'], 'structured-output': [], multimodal: ['context'], observability: ['evaluation'], cost: ['evaluation'], deployment: ['security', 'cost']
};
const checkNames = ['source', 'relevance', 'versions', 'rights', 'prerequisites'];
const stateNames = { approve: 'approved', reject: 'rejected', defer: 'deferred' };

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return sha256(JSON.stringify(stable(value)));
}

function textMatch(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(/^[\x00-\x7f]+$/.test(term) ? `(?<![a-z0-9])${escaped}(?![a-z0-9])` : escaped, 'iu').exec(text);
}

function contentLines(document) {
  const lines = document.markdown.split(/\r?\n/);
  let fence = null;
  return lines.flatMap((text, offset) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return [];
    }
    return fence || /^\s{4}/.test(text) ? [] : [{ text, line: offset + 1 }];
  });
}

function evidence(document, line, offset = 0, version = 'current') {
  const text = document.markdown.split(/\r?\n/)[line - 1];
  const start = Math.max(0, offset - 70);
  const quote = text.slice(start, start + 420);
  return { documentID: document.id, revision: document.revision, sha256: document.sha256, version, lineStart: line, lineEnd: line, columnStart: start + 1, quote, truncated: start + quote.length < text.length, url: sourceURL(document.repository, document.revision, document.path) + '?plain=1#L' + line };
}

function topicEvidence(document, topic) {
  for (const line of contentLines(document)) {
    const match = topic.terms.map(term => textMatch(line.text, term)).find(Boolean);
    if (match) return { ...evidence(document, line.line, match.index), term: match[0] };
  }
  return null;
}

function prerequisites(title, matchedTopics) {
  const hints = new Set(matchedTopics.flatMap(topic => prerequisiteRules[topic.id] || []));
  if (/\bagents?\b|智能体|代理/iu.test(title)) hints.add('agents');
  if (/\brag\b|retrieval|检索/iu.test(title)) hints.add('rag');
  if (/context|memory|上下文|记忆/iu.test(title)) hints.add('context');
  return [...hints].sort();
}

export function imageReferences(document) {
  const references = [];
  const expression = /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu;
  for (const match of document.markdown.matchAll(expression)) {
    const target = match[2] || match[3];
    let url = null;
    let scope = 'unresolved';
    try {
      const base = sourceURL(document.repository, document.revision, document.path, true);
      const resolved = new URL(target, base);
      if (resolved.protocol === 'https:' && !resolved.username && !resolved.password) {
        const prefix = `https://raw.githubusercontent.com/${document.repository}/${document.revision}/`;
        scope = resolved.href.startsWith(prefix) ? 'repository' : 'external';
        url = resolved.href;
      }
    } catch {}
    references.push({ alt: match[1] || '', original: target, url, scope, status: 'not-reviewed' });
    if (references.length === 100) break;
  }
  return references;
}

function reviewID(batch, decision) {
  return digest({ reviewer: batch.reviewer, exportedAt: batch.exportedAt, ...decision });
}

export function validateHistory(history) {
  requireValue(history?.schemaVersion === 1 && Array.isArray(history.records) && history.records.length <= 10000, '审核历史无效。');
  const identities = new Set();
  for (const record of history.records) {
    const { id, reviewedAt, ...decision } = record;
    requireValue(typeof record.reviewer === 'string' && record.reviewer.trim() && Number.isFinite(Date.parse(record.exportedAt)) && Number.isFinite(Date.parse(reviewedAt)) && typeof record.itemID === 'string' && /^[a-f0-9]{64}$/.test(record.fingerprint) && Object.hasOwn(stateNames, record.decision) && typeof record.note === 'string' && record.note.trim() && Array.isArray(record.prerequisiteTopicIDs), '审核记录字段无效。');
    requireValue(record.decision !== 'approve' || (checkNames.every(name => record.checks?.[name] === true) && ['add-topic', 'update-material', 'resolve'].includes(record.action)), '通过记录缺少人工核对项或编排方式。');
    requireValue(id === digest(decision) && !identities.has(id), '审核记录哈希无效或重复。');
    identities.add(id);
  }
  return history;
}

export function buildReviewQueue(registry, topics, intake, approvedIndex, history = { schemaVersion: 1, records: [] }, curriculum = null) {
  validateTopics(topics);
  validateHistory(history);
  requireValue(intake?.schemaVersion === 1 && Array.isArray(intake.documents) && intake.documents.length <= 1500 && Array.isArray(intake.sourceStates), '正文采集记录无效。');
  const entries = intake.documents;
  const seen = new Set();
  for (const entry of entries) {
    validateDocument(entry.current, registry);
    requireValue(entry.id === entry.current.id && !seen.has(entry.id) && ['ready', 'pending', 'stale', 'unverified', 'removed'].includes(entry.status), '正文记录状态或 ID 无效。');
    if (entry.previous) { validateDocument(entry.previous, registry); requireValue(entry.previous.id === entry.id, '历史正文 ID 不一致。'); }
    seen.add(entry.id);
  }
  const curriculumEntries = curriculum ? curriculum.entries.map(entry => {
    const lesson = curriculum.lessons[entry.id];
    requireValue(typeof lesson?.t === 'string' && Array.isArray(lesson.mat), '现有课程目录无效。');
    return { id: entry.id, title: lesson.t, text: lesson.mat.map(material => [material.n, material.b].join('\n')).join('\n') };
  }) : [];
  requireValue(new Set(curriculumEntries.map(entry => entry.id)).size === curriculumEntries.length, '现有课程 ID 重复。');
  if (curriculum) requireValue(topics.topics.every(topic => topic.lessonIDs.every(identity => curriculumEntries.some(entry => entry.id === identity))), '能力表引用了不存在的课程 ID。');
  const rulesVersion = digest({ topics, prerequisiteRules, curriculumEntries, algorithm: 1 });
  const queue = [];
  const claims = new Map();
  function addItem(identity, kind, title, documents, proofs, suggestedPrerequisites, extra = {}) {
    const blockers = [];
    for (const entry of documents) {
      if (entry.status !== 'ready') blockers.push('正文状态为 ' + entry.status + '，需要重新检查来源。');
      const source = intake.sourceStates.find(item => item.id === entry.current.sourceID);
      if (!source || !['checked', 'unchanged'].includes(source.status)) blockers.push(source?.status === 'expired' ? '来源检查已过期，请先运行 discover。' : '来源检查未成功，请先运行 discover。');
      if (!entry.current.license) blockers.push('缺少来源许可证。');
      else if (!/MIT License/i.test(entry.current.license.text) || !entry.current.license.text.includes('Permission is hereby granted')) blockers.push('许可证尚未支持，需要单独核定授权。');
    }
    const content = { id: kind + ':' + digest(identity).slice(0, 20), kind, title, documents: documents.map(entry => ({ id: entry.id, sourceID: entry.current.sourceID, path: entry.current.path, revision: entry.current.revision, version: documentVersion(entry.current), url: sourceURL(entry.current.repository, entry.current.revision, entry.current.path), license: entry.current.license ? { sha256: entry.current.license.sha256, url: sourceURL(entry.current.repository, entry.current.license.revision, entry.current.license.path), status: 'requires-review' } : null })), evidence: proofs, suggestedPrerequisiteTopicIDs: suggestedPrerequisites, blockers: [...new Set(blockers)], ...extra };
    const fingerprint = digest({ content, rulesVersion });
    const latest = history.records.filter(record => record.itemID === content.id).at(-1);
    const matches = latest?.fingerprint === fingerprint;
    queue.push({ ...content, fingerprint, status: latest ? matches ? stateNames[latest.decision] : 'needs-review' : 'pending', review: latest ? { ...latest, current: matches } : null });
  }

  for (const entry of entries) {
    const document = entry.current;
    const lines = contentLines(document);
    const heading = lines.find(line => /^\s{0,3}#\s+\S/.test(line.text));
    const first = heading || lines.find(line => line.text.trim());
    if (!first) continue;
    const title = heading ? plainText(heading.text).slice(0, 160) : document.path;
    const matched = topics.topics.filter(topic => topic.terms.some(term => textMatch(title, term)));
    const related = topics.topics.filter(topic => topicEvidence(document, topic));
    const suggested = prerequisites(title, related).filter(identity => topics.topics.some(topic => topic.id === identity));
    const paragraph = lines.find(line => line.line > first.line && line.text.trim().length >= 50 && !/^\s*(?:#|!|<|>|\||\[)/.test(line.text) && !/click.*(?:image|video)|watch.*video|click here/iu.test(line.text));
    const primaryEvidence = [evidence(document, first.line), ...(paragraph ? [evidence(document, paragraph.line)] : [])];
    const relatedLessonIDs = new Set(topics.topics.filter(topic => related.includes(topic) || suggested.includes(topic.id)).flatMap(topic => topic.lessonIDs));
    const curriculumMatches = curriculumEntries.filter(lesson => relatedLessonIDs.has(lesson.id)).map(({ id, title: lessonTitle }) => ({ id, title: lessonTitle }));
    if (!/^(?:\d+[.\s-]*)?(?:course setup|getting started|setup|table of contents)\b/iu.test(title)) addItem(document.id, matched.length ? 'material-update' : 'new-topic', title, [entry], primaryEvidence, suggested, { noveltyStatus: 'requires-review', relatedTopicIDs: related.map(topic => topic.id), curriculumMatches, images: imageReferences(document) });

    if (entry.previous && documentVersion(entry.previous) !== documentVersion(document)) {
      const before = new Set(entry.previous.markdown.split(/\r?\n/).filter(line => line.trim()));
      const after = new Set(document.markdown.split(/\r?\n/).filter(line => line.trim()));
      const added = lines.filter(line => line.text.trim() && !before.has(line.text)).slice(0, 3).map(line => evidence(document, line.line));
      const removed = contentLines(entry.previous).filter(line => line.text.trim() && !after.has(line.text)).slice(0, 3).map(line => evidence(entry.previous, line.line, 0, 'previous'));
      addItem(document.id, 'content-change', title + ' · 内容变化', [entry], [...added, ...removed].length ? [...added, ...removed] : [evidence(document, first.line)], suggested, { before: { revision: entry.previous.revision, version: documentVersion(entry.previous), sha256: entry.previous.sha256, licenseSHA256: entry.previous.license?.sha256 || null }, after: { revision: document.revision, version: documentVersion(document), sha256: document.sha256, licenseSHA256: document.license?.sha256 || null } });
    }
    const deprecations = lines.filter(line => /\b(?:deprecated|deprecation|obsolete|superseded|no longer supported)\b|弃用|废弃|停止支持/iu.test(line.text)).slice(0, 3);
    if (deprecations.length) addItem(document.id, 'deprecation', title + ' · 弃用线索', [entry], deprecations.map(line => evidence(document, line.line)), suggested);
    if (entry.status !== 'ready') addItem(document.id, 'source-check', title + ' · 来源复核', [entry], [evidence(document, first.line)], suggested);

    for (const line of lines) {
      if (!/\b(?:must|should|requires?|recommend|use|supports?)\b|必须|应当|建议|支持/iu.test(line.text) || line.text.length < 20 || line.text.length > 420) continue;
      const normalized = plainText(line.text).toLowerCase().replace(/\bcannot\b/g, 'can not');
      const negative = /\b(?:not|never)\b|不应|不支持|不能/.test(normalized);
      const polarityKey = normalized.replace(/\b(?:not|never)\b/g, '').replace(/不应/g, '应').replace(/不支持/g, '支持').replace(/不能/g, '能').replace(/\s+/g, ' ').trim();
      const versionMatch = /\bversion\s+v?\d+(?:\.\d+)*/i.exec(normalized);
      const variants = [{ key: 'polarity:' + polarityKey, value: String(negative) }];
      if (versionMatch) variants.push({ key: 'version:' + normalized.replace(/\bversion\s+v?\d+(?:\.\d+)*/gi, 'version <number>'), value: versionMatch[0] });
      for (const variant of variants) {
        const previousClaim = claims.get(variant.key);
        if (previousClaim && previousClaim.entry.id !== entry.id && previousClaim.value !== variant.value) addItem([variant.key, previousClaim.entry.id, entry.id], 'possible-conflict', '原文表述存在差异，需核对适用条件', [previousClaim.entry, entry], [previousClaim.evidence, evidence(document, line.line)], suggested, { method: '相近句子的否定或版本号差异，仅提供复核线索' });
        else if (!previousClaim) claims.set(variant.key, { entry, value: variant.value, evidence: evidence(document, line.line) });
      }
    }
  }
  const approvedCoverage = coverageReport(approvedIndex, topics);
  const coverage = approvedCoverage.topics.map(topic => ({ ...topic, candidateEvidence: entries.flatMap(entry => {
    const match = topicEvidence(entry.current, topics.topics.find(item => item.id === topic.id));
    return match ? [{ ...match, availability: entry.status }] : [];
  }), curriculumMatches: curriculumEntries.filter(lesson => topic.lessonIDs.includes(lesson.id) || topics.topics.find(item => item.id === topic.id).terms.some(term => textMatch(lesson.title + '\n' + lesson.text, term))).map(({ id, title }) => ({ id, title })), suggestedPrerequisiteTopicIDs: prerequisiteRules[topic.id] || [] }));
  const unique = [...new Map(queue.map(item => [item.id, item])).values()].sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: 1, rulesVersion, generatedAt: intake.attemptedAt, scope: intake.scope, curriculum: { lessons: curriculumEntries.length, method: '现有课程及能力词表关联只提供复核线索，主题是否新增由人工判断' }, sourceStates: intake.sourceStates, coverage, queue: unique, approvedProposals: unique.filter(item => item.status === 'approved' && item.blockers.length === 0 && ['new-topic', 'material-update'].includes(item.kind)).map(item => ({ id: item.id, title: item.title, kind: item.review.action === 'add-topic' ? 'new-topic' : 'material-update', suggestedKind: item.kind, fingerprint: item.fingerprint, prerequisiteTopicIDs: item.review.prerequisiteTopicIDs, evidence: item.evidence, reviewID: item.review.id, eligibleForPublication: false })), publicationPolicy: '审核通过仅进入编排候选；不修改正式课程、App 内容或发布指针。' };
}

export function applyReviewDecisions(report, history, batch, now = new Date()) {
  validateHistory(history);
  requireValue(batch?.schemaVersion === 1 && typeof batch.reviewer === 'string' && batch.reviewer.trim().length > 0 && batch.reviewer.length <= 100 && Number.isFinite(Date.parse(batch.exportedAt)) && Array.isArray(batch.decisions) && batch.decisions.length > 0 && batch.decisions.length <= 500, '审核文件需要审核人、导出时间和决策。');
  const identities = new Set();
  const records = [...history.records];
  const topicIDs = new Set(report.coverage.map(topic => topic.id));
  for (const decision of batch.decisions) {
    const item = report.queue.find(candidate => candidate.id === decision?.itemID);
    requireValue(item && !identities.has(item.id) && decision.fingerprint === item.fingerprint, '审核对象不存在、重复或版本已变化，请重新生成审核页。');
    identities.add(item.id);
    requireValue(Object.hasOwn(stateNames, decision.decision) && typeof decision.note === 'string' && decision.note.trim().length > 0 && decision.note.length <= 2000, '审核决定或理由无效。');
    const prerequisiteTopicIDs = decision.prerequisiteTopicIDs || [];
    requireValue(Array.isArray(prerequisiteTopicIDs) && prerequisiteTopicIDs.length <= 30 && new Set(prerequisiteTopicIDs).size === prerequisiteTopicIDs.length && prerequisiteTopicIDs.every(identity => topicIDs.has(identity)), '前置能力需要使用能力覆盖表中的 ID。');
    if (decision.decision === 'approve') {
      requireValue(item.blockers.length === 0, '来源、正文或许可尚有阻塞，不能通过审核。');
      requireValue(checkNames.every(name => decision.checks?.[name] === true) && Array.isArray(decision.prerequisiteTopicIDs), '通过审核需要逐项核对并明确前置能力；基础主题可明确选择空数组。');
      requireValue(['new-topic', 'material-update'].includes(item.kind) ? ['add-topic', 'update-material'].includes(decision.action) : decision.action === 'resolve', '通过审核需要明确新增主题、补充材料或完成复核。');
    }
    const normalized = { itemID: item.id, fingerprint: item.fingerprint, decision: decision.decision, action: decision.decision === 'approve' ? decision.action : null, note: decision.note.trim(), prerequisiteTopicIDs: [...prerequisiteTopicIDs].sort(), checks: Object.fromEntries(checkNames.map(name => [name, decision.checks?.[name] === true])) };
    const id = reviewID(batch, normalized);
    if (!records.some(record => record.id === id)) records.push({ id, reviewer: batch.reviewer, exportedAt: batch.exportedAt, ...normalized, reviewedAt: now.toISOString() });
  }
  return validateHistory({ schemaVersion: 1, records });
}
