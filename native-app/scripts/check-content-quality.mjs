// 训练内容质量门（Node，无依赖）：题库 100 题 / 案例 20 个 / 小方案字数 / 元数据 / ID 与答案下标。
//   node native-app/scripts/check-content-quality.mjs
// 通过时打印统计并以 0 退出；不达标时列出明细并以 1 退出。
// 最后一行是机器可读 JSON（便于接入发布检查）：
//   {"questions":100,"cases":20,"minPrompt":358,"minReference":352,...,"passed":true}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const contentPath = path.resolve(scriptDirectory, '../Sources/YueqianCore/Resources/training.json');
const LEVELS = ['基础', '应用', '诊断'];
const PROJECTS = ['rag', 'bi', 'agent'];
const EXPECTED_QUESTIONS = 100;
const EXPECTED_CASES = 20;
const MIN_PROMPT = 300;
const MIN_REFERENCE = 300;
const MIN_RUBRIC_ITEMS = 4;
const MIN_RUBRIC_TEXT = 20;
const MIN_EXPLANATION = 40;
const MIN_NEW_EXPLANATION = 80;
const MIN_CHOICES = 4;
const REVIEW_DATE = /^\d{4}-\d{2}-\d{2}$/u;
// 本次（3.5.0 / 第二阶段）新增并升级的诊断题：解析必须 ≥80 字。
const UPGRADED_QUESTIONS = new Set(['rag.source.9', 'rag.retrieve.9', 'rag.ground.9', 'rag.access.9']);

const failures = [];
function fail(scope, message) { failures.push(scope + '：' + message); }
const width = value => [...String(value)].reduce((total, character) => total + (/[\u1100-\uffff]/u.test(character) ? 2 : 1), 0);
const pad = (value, size) => String(value) + ' '.repeat(Math.max(0, size - width(value)));
function record(rows, columns, title) {
  if (!rows.length) return;
  console.log('\n' + title);
  for (const row of rows) console.log('  ' + row);
}

function isValidDate(value) {
  if (typeof value !== 'string' || !REVIEW_DATE.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function nonEmpty(value) { return typeof value === 'string' && value.trim() !== ''; }
const length = value => (typeof value === 'string' ? [...value.trim()].length : 0);

function main() {
  if (!fs.existsSync(contentPath)) {
    fail('文件', '找不到 ' + contentPath);
    return;
  }
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
  } catch (error) {
    fail('JSON', '解析失败：' + error.message);
    return;
  }

  const projects = Array.isArray(catalog.projects) ? catalog.projects : [];
  const knowledge = Array.isArray(catalog.knowledge) ? catalog.knowledge : [];
  const questions = Array.isArray(catalog.questions) ? catalog.questions : [];
  const cases = Array.isArray(catalog.cases) ? catalog.cases : [];
  const sources = Array.isArray(catalog.sources) ? catalog.sources : [];

  // ---------- 结构 ----------
  if (catalog.schemaVersion !== 1) fail('schemaVersion', '应为 1，实际 ' + catalog.schemaVersion);
  const projectIDs = projects.map(item => item?.id);
  if (JSON.stringify([...projectIDs].sort()) !== JSON.stringify([...PROJECTS].sort())) fail('projects', '项目必须固定为 rag/bi/agent，实际 ' + projectIDs.join('/'));
  const knowledgeIDs = new Set(knowledge.map(item => item?.id));
  const knowledgeByProject = new Map();
  for (const point of knowledge) {
    if (!knowledgeByProject.has(point?.projectID)) knowledgeByProject.set(point.projectID, new Set());
    knowledgeByProject.get(point.projectID).add(point?.id);
  }

  // ---------- 全局 ID 唯一 ----------
  // 「全局」指内容条目（题目、案例、案例 rubric、项目验收项）共用一套命名空间；
  // 项目/知识点/来源属于固定结构，各自内部唯一即可（历史上 source.id 与 project.id 同名，属既有约定）。
  const seen = new Map();
  const register = (id, scope) => {
    if (!nonEmpty(id)) { fail(scope, '缺少 id'); return; }
    if (seen.has(id)) fail(scope, 'id 重复：' + id + '（已出现在 ' + seen.get(id) + '）');
    else seen.set(id, scope);
  };
  for (const [scope, records] of [['project', projects], ['knowledge', knowledge], ['source', sources]]) {
    const ids = records.map(item => item?.id);
    const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicated.length) fail(scope, '内部 id 重复：' + duplicated.join('、'));
  }
  for (const item of questions) register(item?.id, 'question');
  for (const item of cases) register(item?.id, 'case');

  // ---------- 数量 ----------
  if (questions.length !== EXPECTED_QUESTIONS) fail('题库', '应为 ' + EXPECTED_QUESTIONS + ' 题，实际 ' + questions.length);
  if (cases.length !== EXPECTED_CASES) fail('案例', '应为 ' + EXPECTED_CASES + ' 个，实际 ' + cases.length);
  if (knowledge.length !== 12) fail('知识点', '应为 12 个，实际 ' + knowledge.length);

  // ---------- 题目 ----------
  const levelCount = Object.fromEntries(LEVELS.map(level => [level, 0]));
  const explanationLengths = [];
  for (const question of questions) {
    const scope = '题目 ' + (question?.id || '(无 id)');
    if (!knowledgeIDs.has(question?.knowledgeID)) fail(scope, 'knowledgeID 不存在：' + question?.knowledgeID);
    if (!LEVELS.includes(question?.level)) fail(scope, 'level 必须属于 ' + LEVELS.join('/') + '，实际 ' + question?.level);
    else levelCount[question.level] += 1;
    if (!nonEmpty(question?.question)) fail(scope, '题干为空');
    if (!Array.isArray(question?.choices) || question.choices.length < MIN_CHOICES) fail(scope, '选项应至少 ' + MIN_CHOICES + ' 个，实际 ' + (question?.choices?.length ?? 0));
    else if (!question.choices.every(nonEmpty)) fail(scope, '存在空选项');
    if (!Number.isInteger(question?.answer) || !Array.isArray(question?.choices) || question.answer < 0 || question.answer >= question.choices.length) fail(scope, 'answer 下标越界：' + question?.answer);
    if (!nonEmpty(question?.explanation)) fail(scope, '解析为空');
    const explanation = length(question?.explanation);
    explanationLengths.push(explanation);
    const minimum = UPGRADED_QUESTIONS.has(question?.id) ? MIN_NEW_EXPLANATION : MIN_EXPLANATION;
    if (explanation < minimum) fail(scope, '解析应 ≥' + minimum + ' 字，实际 ' + explanation);
    if (UPGRADED_QUESTIONS.has(question?.id) && question?.level !== '诊断') fail(scope, '新增题必须是「诊断」档，实际 ' + question?.level);
  }
  for (const id of UPGRADED_QUESTIONS) if (!questions.some(question => question?.id === id)) fail('题库', '缺少第二阶段新增诊断题：' + id);
  for (const point of knowledge) {
    if (!questions.some(question => question?.knowledgeID === point?.id && question?.level === '诊断')) fail('知识点 ' + point?.id, '缺少「诊断」档题目');
  }

  // ---------- 案例 ----------
  const rubricLengths = [];
  let rubricTotal = 0;
  for (const item of cases) {
    const scope = '案例 ' + (item?.id || '(无 id)');
    if (!PROJECTS.includes(item?.projectID)) fail(scope, 'projectID 无效：' + item?.projectID);
    if (!nonEmpty(item?.title)) fail(scope, '标题为空');
    const prompt = length(item?.prompt);
    if (prompt < MIN_PROMPT) fail(scope, 'prompt 应 ≥' + MIN_PROMPT + ' 字，实际 ' + prompt);
    if (!/按以下标准自查/u.test(item?.prompt || '')) fail(scope, 'prompt 缺少「按以下标准自查」');
    const reference = length(item?.reference);
    if (reference < MIN_REFERENCE) fail(scope, 'reference 应 ≥' + MIN_REFERENCE + ' 字，实际 ' + reference);
    if (!Array.isArray(item?.rubric) || item.rubric.length < MIN_RUBRIC_ITEMS) fail(scope, 'rubric 应 ≥' + MIN_RUBRIC_ITEMS + ' 条，实际 ' + (item?.rubric?.length ?? 0));
    const rubricIDs = new Set();
    const ownKnowledge = knowledgeByProject.get(item?.projectID) || new Set();
    for (const criterion of Array.isArray(item?.rubric) ? item.rubric : []) {
      const criterionScope = scope + ' 条目 ' + (criterion?.id || '(无 id)');
      register(criterion?.id, criterionScope);
      if (rubricIDs.has(criterion?.id)) fail(criterionScope, '同一案例内 rubric id 重复');
      rubricIDs.add(criterion?.id);
      const text = length(criterion?.text);
      rubricLengths.push(text);
      rubricTotal += 1;
      if (text < MIN_RUBRIC_TEXT) fail(criterionScope, '说明应 ≥' + MIN_RUBRIC_TEXT + ' 字，实际 ' + text);
      if (!Array.isArray(criterion?.knowledgeIDs) || criterion.knowledgeIDs.length === 0) fail(criterionScope, 'knowledgeIDs 不能为空');
      else {
        if (new Set(criterion.knowledgeIDs).size !== criterion.knowledgeIDs.length) fail(criterionScope, 'knowledgeIDs 有重复');
        for (const id of criterion.knowledgeIDs) if (!ownKnowledge.has(id)) fail(criterionScope, 'knowledgeIDs 不属于本项目：' + id);
      }
    }
  }

  // ---------- 项目验收项（Swift validate 同口径） ----------
  for (const project of projects) {
    const ownKnowledge = knowledgeByProject.get(project?.id) || new Set();
    for (const criterion of Array.isArray(project?.criteria) ? project.criteria : []) {
      register(criterion?.id, '项目验收项 ' + criterion?.id);
      if (!nonEmpty(criterion?.text)) fail('项目验收项 ' + criterion?.id, '说明为空');
      if (!Array.isArray(criterion?.knowledgeIDs) || !criterion.knowledgeIDs.length) fail('项目验收项 ' + criterion?.id, 'knowledgeIDs 不能为空');
      else for (const id of criterion.knowledgeIDs) if (!ownKnowledge.has(id)) fail('项目验收项 ' + criterion?.id, 'knowledgeIDs 不属于本项目：' + id);
    }
  }

  // ---------- 审核元数据（case 与 question 都必须有） ----------
  const metadataMissing = [];
  for (const [scope, records] of [['题目', questions], ['案例', cases]]) {
    for (const item of records) {
      const tag = scope + ' ' + (item?.id || '(无 id)');
      if (item?.reviewStatus !== 'approved') { fail(tag, 'reviewStatus 必须为 "approved"，实际 ' + JSON.stringify(item?.reviewStatus)); metadataMissing.push(tag); }
      if (item?.humanApproved !== true) { fail(tag, 'humanApproved 必须为 true，实际 ' + JSON.stringify(item?.humanApproved)); metadataMissing.push(tag); }
      if (!isValidDate(item?.lastReviewedAt)) { fail(tag, 'lastReviewedAt 必须是合法日期（YYYY-MM-DD），实际 ' + JSON.stringify(item?.lastReviewedAt)); metadataMissing.push(tag); }
    }
  }

  // ---------- 统计 ----------
  const average = list => (list.length ? (list.reduce((total, value) => total + value, 0) / list.length).toFixed(1) : '0');
  const statistics = {
    questions: questions.length,
    cases: cases.length,
    minPrompt: Math.min(...cases.map(item => length(item?.prompt))),
    minReference: Math.min(...cases.map(item => length(item?.reference))),
    minExplanation: Math.min(...explanationLengths),
    minRubricText: Math.min(...rubricLengths),
    rubricTotal,
    passed: failures.length === 0
  };

  if (failures.length) {
    console.log('✗ 内容质量检查未通过，共 ' + failures.length + ' 项：');
    for (const item of failures) console.log('  - ' + item);
    console.log('\n' + JSON.stringify({ ...statistics, failures: failures.length }));
    return false;
  }

  console.log('✓ 训练内容质量检查通过');
  const rows = [
    [pad('题库', 10), pad(questions.length + ' 题', 10), pad('案例', 8), cases.length + ' 个'],
    [pad('基础/应用/诊断', 10), pad(levelCount.基础 + ' / ' + levelCount.应用 + ' / ' + levelCount.诊断, 10), pad('rubric 条目', 8), rubricTotal + ' 条（每案例 ≥' + MIN_RUBRIC_ITEMS + '）'],
    [pad('prompt', 10), pad(Math.min(...cases.map(item => length(item?.prompt))) + '–' + Math.max(...cases.map(item => length(item?.prompt))) + ' 字', 10), pad('均', 8), average(cases.map(item => length(item?.prompt))) + ' 字'],
    [pad('reference', 10), pad(Math.min(...cases.map(item => length(item?.reference))) + '–' + Math.max(...cases.map(item => length(item?.reference))) + ' 字', 10), pad('均', 8), average(cases.map(item => length(item?.reference))) + ' 字'],
    [pad('rubric 说明', 10), pad(Math.min(...rubricLengths) + '–' + Math.max(...rubricLengths) + ' 字', 10), pad('均', 8), average(rubricLengths) + ' 字'],
    [pad('解析', 10), pad(Math.min(...explanationLengths) + '–' + Math.max(...explanationLengths) + ' 字', 10), pad('新题 ≥', 8), MIN_NEW_EXPLANATION + ' 字'],
    [pad('元数据', 10), pad('reviewStatus/humanApproved/lastReviewedAt', 10), pad('覆盖', 8), (questions.length + cases.length) + ' 条']
  ];
  for (const row of rows) console.log('  ' + row[0] + ' ' + row[1] + ' ' + row[2] + ' ' + row[3]);
  console.log('  项目分布：' + projects.map(project => project.id + ' ' + questions.filter(question => knowledgeByProject.get(project.id)?.has(question.knowledgeID)).length + ' 题 / ' + cases.filter(item => item.projectID === project.id).length + ' 案例').join('，'));
  console.log('\n' + JSON.stringify({ ...statistics, failures: 0 }));
  return true;
}

let passed = false;
try {
  passed = main() === true;
} catch (error) {
  console.error('✗ 内容质量检查异常：' + error.message);
  console.log(JSON.stringify({ passed: false, error: error.message }));
}
process.exitCode = passed ? 0 : 1;
