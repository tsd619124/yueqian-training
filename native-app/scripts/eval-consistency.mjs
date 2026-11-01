#!/usr/bin/env node
// AI rubric 反馈 · 校准集自检与真实模型一致率评估
//
// 用法：
//   node scripts/eval-consistency.mjs --self-check
//   OPENAI_COMPAT_BASE=... OPENAI_COMPAT_API_KEY=... OPENAI_COMPAT_MODEL=... \
//     node scripts/eval-consistency.mjs --self-check
//
// 说明：
// - 无 Key 时只做结构自检，并明确打印「未验证真实模型」，不会伪造一致率；
// - 有 Key 时对同一批答案调用真实模型，按同样的三档口径（covered/partial/missing，
//   完全相等才算一致）计算一致率与 Cohen's κ，写出 JSON + Markdown 报告；
// - 本脚本只读校准集，不写任何训练存档，也不打印 Key。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CALIBRATION = join(ROOT, 'eval/calibration-set.jsonl');
const TRAINING = join(ROOT, 'Sources/YueqianCore/Resources/training.json');
const REPORT_MD = join(ROOT, 'eval/model-consistency-report.md');
const REPORT_JSON = join(ROOT, 'eval/model-consistency-report.json');

const LABELS = ['covered', 'partial', 'missing'];
const THRESHOLD = 0.7;
const MIN_SAMPLES = 20;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function loadSamples() {
  if (!existsSync(CALIBRATION)) fail(`找不到校准集：${CALIBRATION}`);
  const lines = readFileSync(CALIBRATION, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`第 ${index + 1} 行不是合法 JSON：${error.message}`);
    }
  });
}

function loadCatalog() {
  if (!existsSync(TRAINING)) return null;
  return JSON.parse(readFileSync(TRAINING, 'utf8'));
}

// ── 结构自检 ────────────────────────────────────────────────────────────────

function selfCheck(samples, catalog) {
  const problems = [];
  if (samples.length < MIN_SAMPLES) problems.push(`样本数 ${samples.length} < ${MIN_SAMPLES}`);
  const ids = new Set();
  const cases = new Set();
  for (const sample of samples) {
    const where = sample?.id ?? '(缺少 id)';
    if (!sample.id) problems.push(`${where}：缺少 id`);
    if (ids.has(sample.id)) problems.push(`${where}：id 重复`);
    ids.add(sample.id);
    cases.add(sample.caseID);
    if (sample.annotator !== 'lead-1') problems.push(`${where}：annotator 应为 lead-1`);
    if (!Array.isArray(sample.rubric) || sample.rubric.length === 0) problems.push(`${where}：rubric 为空`);
    if (typeof sample.answer !== 'string' || sample.answer.trim() === '') problems.push(`${where}：answer 为空`);
    if (typeof sample.note !== 'string' || sample.note.trim() === '') problems.push(`${where}：缺少 note`);
    const rubricIDs = new Set((sample.rubric ?? []).map((item) => item.id));
    for (const rubric of sample.rubric ?? []) {
      if (!rubric.id || !rubric.text) problems.push(`${where}：rubric 缺少 id 或 text`);
      if (catalog && !rubricMatchesCatalog(catalog, sample.caseID, rubric)) {
        problems.push(`${where}/${rubric.id}：与 training.json 中的 rubric 不一致（内容可能已升级，需要重新标注）`);
      }
    }
    if (catalog) {
      const item = (catalog.cases ?? []).find((value) => value.id === sample.caseID);
      if (!item) problems.push(`${where}：caseID ${sample.caseID} 不在 training.json`);
      else if (new Set(item.rubric.map((value) => value.id)) !== undefined) {
        const catalogRubrics = item.rubric.map((value) => value.id).sort();
        const sampleRubrics = [...rubricIDs].sort();
        if (JSON.stringify(catalogRubrics) !== JSON.stringify(sampleRubrics)) {
          problems.push(`${where}：labels 未覆盖该案例当前全部 rubric（${catalogRubrics.join(', ')}）`);
        }
      }
    }
    for (const key of Object.keys(sample.labels ?? {})) {
      if (!rubricIDs.has(key)) problems.push(`${where}：labels 含未知 rubricID ${key}`);
    }
    for (const rubricID of rubricIDs) {
      const value = sample.labels?.[rubricID];
      if (value === undefined) problems.push(`${where}：缺少 ${rubricID} 的 label`);
      else if (!LABELS.includes(value)) problems.push(`${where}：${rubricID} 的 label「${value}」不合法`);
    }
  }
  if (cases.size < 3) problems.push(`案例数 ${cases.size} < 3`);
  return { problems, cases: [...cases].sort() };
}

function rubricMatchesCatalog(catalog, caseID, rubric) {
  const item = (catalog.cases ?? []).find((value) => value.id === caseID);
  if (!item) return false;
  return item.rubric.some((value) => value.id === rubric.id && value.text === rubric.text);
}

function statistics(samples) {
  const labelCounts = Object.fromEntries(LABELS.map((label) => [label, 0]));
  const perCase = {};
  let items = 0;
  for (const sample of samples) {
    perCase[sample.caseID] ??= { samples: 0, items: 0, labels: Object.fromEntries(LABELS.map((label) => [label, 0])) };
    perCase[sample.caseID].samples += 1;
    for (const value of Object.values(sample.labels ?? {})) {
      labelCounts[value] += 1;
      perCase[sample.caseID].labels[value] += 1;
      perCase[sample.caseID].items += 1;
      items += 1;
    }
  }
  return { samples: samples.length, items, labelCounts, perCase };
}

// ── 真实模型路径（有 Key 才执行）─────────────────────────────────────────────

function completionURL(base) {
  const trimmed = base.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function buildPrompt(sample) {
  const system = [
    '你是一位 AI 售前训练营的练习教练，不做判决：不评分、不排名、不判定是否通过。',
    '只依据【用户回答】原文判断，不得虚构候选人没有写过的经历、数据或项目。',
    '对每个评分点给出覆盖程度：covered（已覆盖）、partial（部分覆盖）、missing（缺失）。',
    'covered 与 partial 必须逐字引用回答中的原话作为 quote；没有依据时判 missing，quote 留空。',
    '禁止输出总分、百分比、等级。只输出一个 JSON 对象：',
    '{"judgements":[{"rubricID":"...","coverage":"covered|partial|missing","quote":"...","comment":"..."}],"improvements":["...","..."],"followUps":["...","..."],"summary":"..."}'
  ].join('\n');
  const user = [
    '【评分点】',
    ...sample.rubric.map((rubric, index) => `${index + 1}. [${rubric.id}] ${rubric.text}`),
    '',
    '【用户回答】只依据以下原文判断，不要补写：',
    sample.answer,
    '',
    `请按 system 中的 JSON 结构输出，覆盖全部 ${sample.rubric.length} 个评分点。`
  ].join('\n');
  return { system, user };
}

function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const character = body[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeCoverage(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['covered', 'cover', 'full', 'complete', 'done', 'yes', 'true', '已覆盖', '覆盖'].includes(text)) return 'covered';
  if (['partial', 'part', 'partly', 'some', 'maybe', '部分', '部分覆盖'].includes(text)) return 'partial';
  if (['missing', 'miss', 'none', 'no', 'false', '缺失', '未覆盖'].includes(text)) return 'missing';
  if (text.includes('cover')) return 'covered';
  if (text.includes('partial') || text.includes('部分')) return 'partial';
  return 'missing';
}

async function judgeWithModel(env, sample) {
  const prompt = buildPrompt(sample);
  const response = await fetch(completionURL(env.base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.key}` },
    body: JSON.stringify({
      model: env.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      temperature: 0,
      max_tokens: Math.min(1200, 200 + sample.rubric.length * 160),
      stream: false
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') throw new Error('响应缺少 choices[0].message.content');
  const object = extractJSON(content);
  if (!object) throw new Error('响应不是可解析的 JSON');
  const entries = Array.isArray(object.judgements) ? object.judgements
    : Array.isArray(object.judgments) ? object.judgments
    : object.rubric && typeof object.rubric === 'object' ? Object.entries(object.rubric).map(([key, value]) => ({ rubricID: key, ...value }))
    : [];
  const predictions = {};
  for (const entry of entries) {
    const id = entry?.rubricID ?? entry?.rubricId ?? entry?.rubric_id ?? entry?.id;
    if (!id || predictions[id] !== undefined) continue;
    predictions[id] = normalizeCoverage(entry.coverage ?? entry.status ?? entry.level);
  }
  const judgements = sample.rubric.map((rubric) => ({ rubricID: rubric.id, coverage: predictions[rubric.id] ?? 'missing' }));
  return { judgements, improvements: object.improvements ?? object.suggestions ?? [], followUps: object.followUps ?? object.follow_ups ?? [] };
}

function cohenKappa(pairs) {
  if (pairs.length === 0) return 0;
  const observed = pairs.filter((pair) => pair.gold === pair.predicted).length / pairs.length;
  let expected = 0;
  for (const label of LABELS) {
    const gold = pairs.filter((pair) => pair.gold === label).length / pairs.length;
    const predicted = pairs.filter((pair) => pair.predicted === label).length / pairs.length;
    expected += gold * predicted;
  }
  return expected >= 1 ? 1 : (observed - expected) / (1 - expected);
}

async function modelEvaluation(env, samples) {
  const pairs = [];
  const perSample = [];
  let failures = 0;
  for (const sample of samples) {
    try {
      const result = await judgeWithModel(env, sample);
      const row = { id: sample.id, caseID: sample.caseID, judgements: [] };
      for (const rubric of sample.rubric) {
        const gold = sample.labels[rubric.id];
        const predicted = result.judgements.find((item) => item.rubricID === rubric.id)?.coverage ?? 'missing';
        pairs.push({ gold, predicted });
        row.judgements.push({ rubricID: rubric.id, gold, predicted });
      }
      perSample.push(row);
    } catch (error) {
      failures += 1;
      console.error(`  ! ${sample.id} 调用失败：${error.message}`);
    }
  }
  const total = pairs.length;
  const correct = pairs.filter((pair) => pair.gold === pair.predicted).length;
  return {
    model: env.model,
    endpoint: completionURL(env.base),
    evaluatedSamples: perSample.length,
    failedSamples: failures,
    items: total,
    agreements: correct,
    agreement: total > 0 ? correct / total : 0,
    kappa: cohenKappa(pairs),
    confusion: LABELS.reduce((accumulator, gold) => {
      accumulator[gold] = LABELS.reduce((row, predicted) => {
        row[predicted] = pairs.filter((pair) => pair.gold === gold && pair.predicted === predicted).length;
        return row;
      }, {});
      return accumulator;
    }, {}),
    perSample
  };
}

function writeReports(evaluation, stats) {
  const payload = { generatedAt: new Date().toISOString(), threshold: THRESHOLD, statistics: stats, evaluation };
  writeFileSync(REPORT_JSON, `${JSON.stringify(payload, null, 2)}\n`);
  const passed = evaluation.agreement >= THRESHOLD;
  const markdown = [
    '# 真实模型一致率报告（自动生成）',
    '',
    `- 生成时间：${payload.generatedAt}`,
    `- 模型：${evaluation.model}`,
    `- 端点：${evaluation.endpoint}`,
    `- 样本：${evaluation.evaluatedSamples} / 失败 ${evaluation.failedSamples}`,
    `- 逐项三档一致率：${(evaluation.agreement * 100).toFixed(1)}%（${evaluation.agreements}/${evaluation.items}）`,
    `- Cohen's κ：${evaluation.kappa.toFixed(3)}`,
    `- 门槛：${(THRESHOLD * 100).toFixed(0)}%（${passed ? '通过' : '未通过'}）`,
    '',
    '| 人工 \\ 模型 | covered | partial | missing |',
    '|---|---|---|---|',
    ...LABELS.map((gold) => `| ${gold} | ${evaluation.confusion[gold].covered} | ${evaluation.confusion[gold].partial} | ${evaluation.confusion[gold].missing} |`),
    '',
    '> 口径：三个档完全相等才算一致。真实模型的结果只说明这一次调用的一致率，不代表上线后的稳定性。',
    ''
  ].join('\n');
  writeFileSync(REPORT_MD, markdown);
  console.log(`  报告已写入 eval/model-consistency-report.json 与 eval/model-consistency-report.md`);
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const selfCheckMode = args.includes('--self-check');
  if (!selfCheckMode) {
    console.log('提示：加 --self-check 运行结构自检；设置 OPENAI_COMPAT_BASE / OPENAI_COMPAT_API_KEY / OPENAI_COMPAT_MODEL 可评估真实模型。');
  }
  const samples = loadSamples();
  const catalog = loadCatalog();
  const { problems, cases } = selfCheck(samples, catalog);
  const stats = statistics(samples);

  console.log('校准集自检');
  console.log(`  样本：${stats.samples} 条，案例：${cases.length} 个（${cases.join('、')}）`);
  console.log(`  评分点：${stats.items} 项；标签分布 ${LABELS.map((label) => `${label}=${stats.labelCounts[label]}`).join('，')}`);
  for (const [caseID, value] of Object.entries(stats.perCase)) {
    console.log(`    · ${caseID}：${value.samples} 条 / ${value.items} 项（${LABELS.map((label) => `${label}=${value.labels[label]}`).join('，')}）`);
  }
  if (problems.length > 0) {
    console.error(`✗ 自检未通过，共 ${problems.length} 个问题：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('✓ 结构自检通过（≥20 条、labels 覆盖全部 rubric、取值合法、与 training.json 一致）');

  const base = process.env.OPENAI_COMPAT_BASE?.trim();
  const key = process.env.OPENAI_COMPAT_API_KEY?.trim();
  const model = process.env.OPENAI_COMPAT_MODEL?.trim();
  if (!base || !key || !model) {
    console.log('未验证真实模型：未设置 OPENAI_COMPAT_BASE / OPENAI_COMPAT_API_KEY / OPENAI_COMPAT_MODEL，本次只做结构自检，不产生模型一致率。');
    return;
  }

  console.log(`真实模型评估：${model} @ ${completionURL(base)}（${samples.length} 条样本，逐条调用）`);
  const evaluation = await modelEvaluation({ base, key, model }, samples);
  console.log(`  逐项一致率：${(evaluation.agreement * 100).toFixed(1)}%（${evaluation.agreements}/${evaluation.items}），Cohen's κ = ${evaluation.kappa.toFixed(3)}`);
  writeReports(evaluation, stats);
  if (evaluation.items === 0) fail('没有可比较的评分点，无法给出模型一致率。');
  if (evaluation.agreement < THRESHOLD) {
    console.log('  结论：未达到 70% 门槛，界面应继续只显示「参考反馈」。');
  } else {
    console.log('  结论：达到 70% 门槛；仍需人工抽查后再考虑显示为「模型反馈」。');
  }
}

main().catch((error) => fail(error?.message ?? String(error)));
