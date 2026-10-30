import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'Sources/YueqianCore/Resources/catalog.json'), 'utf8'));
// 期望版本只来自 Web 源 index.html 的 APP_VERSION，避免脚本内写死版本号。
const webVersion = fs.readFileSync(path.join(root, '../yueqian-training/index.html'), 'utf8').match(/\bvar\s+APP_VERSION\s*=\s*'([^']+)'/)?.[1];
const materials = Object.values(catalog.lessons).flatMap(lesson => lesson.mat);
const checks = [];
function check(label, action) {
  action();
  checks.push({ label, passed: true });
}
function material(title) {
  const matches = materials.filter(item => item.n === title);
  assert.equal(matches.length, 1, title);
  return matches[0].b;
}
function blocks(text, language) {
  return [...text.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g'))].map(match => match[1]);
}
function jsonBlocks(title) {
  return blocks(material(title), 'json').map(value => JSON.parse(value));
}
function identifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]*$/);
  return '"' + value + '"';
}
function literal(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value));
    return String(value);
  }
  assert.equal(typeof value, 'string');
  return "'" + value.replaceAll("'", "''") + "'";
}
function query(fixture, sql) {
  assert.match(sql.trim(), /^(SELECT|WITH)\s/i);
  assert.ok(!/^\s*\./m.test(sql));
  const setup = fixture.tables.map(table => {
    const columns = Object.entries(table.columns).map(([name, type]) => {
      assert.ok(['TEXT', 'INTEGER', 'REAL'].includes(type));
      return identifier(name) + ' ' + type;
    });
    const rows = table.rows.map(row => {
      assert.equal(row.length, columns.length);
      return '(' + row.map(literal).join(',') + ')';
    });
    return 'CREATE TABLE ' + identifier(table.name) + '(' + columns.join(',') + ');\n'
      + 'INSERT INTO ' + identifier(table.name) + ' VALUES ' + rows.join(',') + ';';
  }).join('\n');
  const result = spawnSync('sqlite3', ['-batch', '-bail', '-json', ':memory:'], {
    input: setup + '\nPRAGMA query_only=ON;\n' + sql,
    encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const expectedAdditions = [
  "模型本体与工具增强：一次请求的责任边界",
  "技术选型决策表：提示词、RAG、微调与工作流",
  "结构化输出：字段契约、正反样本与业务校验",
  "多模态实训：清晰与遮挡收据的字段提取",
  "RAG 冲突样本：版本、切分和不可信资料",
  "RAG 评测报告：逐题证据、拒答和缺口",
  "复杂问数指标字典：支付、退款、粒度与时间",
  "自然语言问数 Demo：先澄清，再校验 SQL",
  "问数权限矩阵：身份、行列范围与导出边界",
  "完整 POC 交付包：目录、范围和变更控制",
  "POC 验收报告：实际结果、失败与签字",
  "POC 调研纪要：已确认、假设与行动项",
  "POC 成本测算：人天、用量和敏感性",
  "POC 上线、回滚与交接：按责任逐项销项",
  "20 项 POC 测试集：预期答案、引用与失败边界",
  "制造业完整案例：质量指标、样本数据与演示",
  "制造业案例：失败归因、验收与客户追问",
  "金融运营完整案例：服务工单、分母与权限",
  "金融运营案例：失败归因、验收与客户追问",
  "零售完整案例：订单、退款与可复现净收款",
  "零售案例：失败归因、验收与客户追问",
  "医药材料完整案例：证据齐备、版本与人工审核",
  "医药材料案例：失败归因、验收与客户追问",
  "指标卡实填范例：净收款与不可计算的比例",
  "项目作品复现：环境、命令和运行证据",
  "行业方案答辩：业务、IT 与负责人三轮追问",
  "POC 交付自核：质量、权限、费用和移交",
  "七类成果索引：从选型到入职计划"
];
check('新增 28 份材料、60 个主题及完整入口', () => {
  assert.ok(webVersion, '无法从 yueqian-training/index.html 读取 APP_VERSION');
  assert.equal(catalog.sourceVersion, webVersion, '原生教材版本与 Web 不一致，请运行 native-app/scripts/export-content.mjs');
  assert.equal(materials.length, 141);
  assert.equal(Object.keys(catalog.lessons).length, 60);
  assert.equal(catalog.entries.length, 60);
  for (const title of expectedAdditions) material(title);
  for (const item of materials.filter(item => expectedAdditions.includes(item.n))) {
    assert.equal((item.b.match(/```/g) ?? []).length % 2, 0, item.n);
    for (const block of blocks(item.b, 'json')) JSON.parse(block);
  }
});
check('原有任务、题目、能力、路线与入口完整保留', () => {
  const { lessons, sourceVersion, sourceSHA256, ...stable } = catalog;
  const hash = crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  assert.equal(hash, '94e1a2a2ab3d835dd6f12a75aefb870950eb77557cad960061b1f73974f44fc3');
});

const industry = [];
for (const item of [
  {
    "title": "制造业完整案例：质量指标、样本数据与演示",
    "failureTitle": "制造业案例：失败归因、验收与客户追问"
  },
  {
    "title": "金融运营完整案例：服务工单、分母与权限",
    "failureTitle": "金融运营案例：失败归因、验收与客户追问"
  },
  {
    "title": "零售完整案例：订单、退款与可复现净收款",
    "failureTitle": "零售案例：失败归因、验收与客户追问"
  },
  {
    "title": "医药材料完整案例：证据齐备、版本与人工审核",
    "failureTitle": "医药材料案例：失败归因、验收与客户追问"
  }
]) {
  const [fixture, expected] = jsonBlocks(item.title);
  const [referenceSQL] = blocks(material(item.title), 'sql');
  const [failureSQL] = blocks(material(item.failureTitle), 'sql');
  const [failureExpected] = jsonBlocks(item.failureTitle);
  const actual = query(fixture, referenceSQL);
  const failureActual = query(fixture, failureSQL);
  check(item.title + '：参考 SQL 对账', () => assert.deepEqual(actual, expected));
  check(item.title + '：错误 SQL 的反例确实存在', () => {
    assert.deepEqual(failureActual, failureExpected);
    assert.notDeepEqual(failureActual, actual);
  });
  industry.push({ title: item.title, actual, failureActual });
}

const [rag] = jsonBlocks('RAG 冲突样本：版本、切分和不可信资料');
const terms = ['退货', '质量', '拆封', '照片', '订单', '奖金', '底价', '发货', '30天'];
const ragRuns = [];
for (const mode of ['document', 'paragraph']) {
  for (const test of rag.tests) {
    const tokens = terms.filter(term => test.query.includes(term));
    const candidates = rag.documents
      .filter(doc => doc.active && !doc.quarantined && (test.role === 'internal' || !doc.internal))
      .flatMap(doc => (mode === 'paragraph' ? doc.text.split('\n') : [doc.text])
        .map((text, index) => ({
          document: doc.id, chunk: doc.id + '#' + (index + 1), text,
          score: tokens.length ? tokens.filter(term => text.includes(term)).length / tokens.length : 0,
          internal: doc.internal
        })))
      .filter(chunk => chunk.score > 0 && chunk.score >= 0.5)
      .sort((first, second) => second.score - first.score || first.chunk.localeCompare(second.chunk, 'en'))
      .slice(0, 2);
    check('RAG ' + mode + ' ' + test.id + '：证据与过滤', () => {
      assert.equal(candidates.length === 0, test.refuse);
      if (test.expectedDocument) assert.ok(candidates.some(chunk => chunk.document === test.expectedDocument));
      if (test.role === 'public') assert.ok(candidates.every(chunk => !chunk.internal));
      assert.ok(candidates.every(chunk => !['return.old', 'untrusted.note'].includes(chunk.document)));
      if (test.id === 'R02') assert.ok(candidates.some(chunk => chunk.text.includes('人工复核')));
    });
    ragRuns.push({ mode, id: test.id, documents: candidates.map(chunk => chunk.document),
      chunks: candidates.map(chunk => chunk.chunk), contextCharacters: candidates.reduce((sum, chunk) => sum + chunk.text.length, 0),
      refused: candidates.length === 0 });
  }
}

const [schema, structured] = jsonBlocks('结构化输出：字段契约、正反样本与业务校验');
function validFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (schema.required.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
  return Object.entries(schema.properties).every(([key, rule]) => {
    const entry = value[key];
    if (rule.type === 'integer' ? !Number.isInteger(entry) : typeof entry !== rule.type) return false;
    if (rule.minimum !== undefined && entry < rule.minimum) return false;
    return !rule.enum || rule.enum.includes(entry);
  });
}
for (const test of structured) {
  check('字段契约 ' + test.id, () => assert.equal(validFields(test.value), test.valid));
}
check('字段正确不等于原文真实', () => {
  assert.equal(validFields({ ...structured[0].value, days_since_delivery: 60 }), true);
  assert.notEqual(60, structured[0].value.days_since_delivery);
});

const [cost] = jsonBlocks('POC 成本测算：人天、用量和敏感性');
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const requests = cost.dailyRequests * cost.workdays;
const modelFee = requests * (cost.inputTokens * cost.inputPerMillion + cost.outputTokens * cost.outputPerMillion) / 1e6;
const fixedMonthly = cost.retrievalMonthly + cost.storageMonthly + cost.monitoringMonthly + cost.operationsDays * cost.dayRate;
const setupFee = Object.values(cost.setupDays).reduce((sum, value) => sum + value, 0) * cost.dayRate;
const monthlyFee = money(modelFee + fixedMonthly);
const reserve = money((setupFee + monthlyFee) * cost.contingencyRate);
check('成本：月调用量与模型费', () => { assert.equal(requests, 44000); assert.equal(money(modelFee), 211.20); });
check('成本：一次性与每月经常项', () => { assert.equal(setupFee, 24000); assert.equal(monthlyFee, 2721.20); });
check('成本：预备金与首月合计', () => { assert.equal(reserve, 4008.18); assert.equal(money(setupFee + monthlyFee + reserve), 30729.38); });
check('成本：半量与倍量情景', () => {
  assert.equal(money(modelFee / 2 + fixedMonthly), 2615.60);
  assert.equal(money(modelFee * 2 + fixedMonthly), 2932.40);
});

const [imageAnswers] = jsonBlocks('多模态实训：清晰与遮挡收据的字段提取');
check('两图参考答案区分可读与不可读金额', () => {
  assert.equal(imageAnswers[0].amount, 128);
  assert.equal(imageAnswers[1].amount, null);
});
for (const name of ['training-receipt.png', 'training-receipt-obscured.png']) {
  check('图片完整且两端一致：' + name, () => {
    const data = fs.readFileSync(path.join(root, '../yueqian-training', name));
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(data.readUInt32BE(16), 600);
    assert.equal(data.readUInt32BE(20), 680);
    assert.ok(data.equals(fs.readFileSync(path.join(root, 'Sources/YueqianCore/Resources', name))));
  });
}

console.log(JSON.stringify({
  sourceVersion: catalog.sourceVersion, lessons: 60, materials: materials.length,
  addedMaterials: expectedAdditions.length, passed: checks.length, checks, industry, ragRuns,
  cost: { monthlyRequests: requests, modelFee: money(modelFee), monthlyFee, setupFee, reserve, firstMonth: money(setupFee + monthlyFee + reserve) },
  limits: ['仅执行教学样本的确定性检查', '未调用生成模型或图像识别服务', '未验证生产权限、真实接口或客户验收']
}, null, 2));
