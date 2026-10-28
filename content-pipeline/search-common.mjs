export function normalizeQuery(value) {
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('检索词需为 1–256 个字符。');
  const query = value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  if (!query || !/[\p{L}\p{N}]/u.test(query)) throw new Error('请输入有效检索词。');
  return query;
}

function tokens(value) {
  const english = value.match(/[a-z0-9][a-z0-9_.-]*/gu) || [];
  const stopWords = new Set(['a', 'an', 'and', 'are', 'for', 'how', 'in', 'is', 'of', 'the', 'to', 'what', 'with']);
  const result = english.filter(term => !stopWords.has(term));
  for (const sequence of value.match(/[\u3400-\u9fff]+/gu) || []) {
    if (sequence.length === 1) result.push(sequence);
    else for (let offset = 0; offset < sequence.length - 1; offset++) result.push(sequence.slice(offset, offset + 2));
  }
  return result;
}

export function queryTerms(query, configuration = { topics: [] }) {
  const normalized = normalizeQuery(query);
  const direct = [...new Set(tokens(normalized))].slice(0, 64);
  const expanded = new Set();
  for (const topic of configuration.topics || []) {
    const aliases = [topic.id, topic.title, ...topic.terms].map(term => term.normalize('NFKC').toLowerCase());
    if (aliases.some(term => term && normalized.includes(term))) for (const term of aliases) {
      expanded.add(term);
      for (const token of tokens(term.replace(/-/gu, ' '))) expanded.add(token);
    }
  }
  return { normalized, direct, expanded: [...expanded].filter(term => !direct.includes(term)).slice(0, 100) };
}

function includesTerm(text, term) {
  if (!/^[a-z0-9_.-]+$/u.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'u').test(text);
}

export function rankDocuments(documents, query, configuration, limit = 10) {
  const { normalized, direct, expanded } = queryTerms(query, configuration);
  return documents.flatMap(document => {
    const title = (document.title || '').normalize('NFKC').toLowerCase();
    const text = (document.text || '').normalize('NFKC').toLowerCase();
    const sourcePath = (document.path || '').normalize('NFKC').toLowerCase().replace(/[-_/]/gu, ' ');
    const matchedTerms = [...direct, ...expanded].filter(term => includesTerm(title + ' ' + sourcePath + ' ' + text, term));
    if (!matchedTerms.length) return [];
    const score = (title.includes(normalized) ? 20 : 0) + (text.includes(normalized) ? 8 : 0) + matchedTerms.reduce((total, term) => total + (direct.includes(term) ? 2 : 1) * (includesTerm(title, term) ? 4 : includesTerm(sourcePath, term) ? 3 : 1), 0);
    const original = document.text || '';
    const lowerOriginal = original.toLowerCase();
    const positions = matchedTerms.map(term => lowerOriginal.indexOf(term)).filter(position => position >= 0);
    const offset = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 60);
    return [{ ...document, score, matchedTerms, excerpt: original.slice(offset, offset + 280) }];
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, 'en')).slice(0, limit);
}
