// 导入遗留项：parseBackup 结构上限、写满横幅的重试保存、下载诚实文案、导入后的 UI 一致性。
// 与 import-storage.test.mjs 一样用 fnSource() 从 app.js 抠真实函数体在 vm 里跑，不重抄实现。
// 运行：node --test yueqian-training/tests/import-followup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
// 真实课程数据：第 4 项要证明的是「对着线上这份课表，未知 lesson ID 会发生什么」
const course = JSON.parse(fs.readFileSync(path.join(web, 'content/course.json'), 'utf8'));

const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---------- 从 app.js 里取出真实代码 ----------
function fnSource(name) {
  const start = app.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '在 app.js 里找不到 function ' + name);
  let depth = 0;
  for (let i = app.indexOf('{', start); i < app.length; i += 1) {
    if (app[i] === '{') depth += 1;
    else if (app[i] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, i + 1);
    }
  }
  throw new Error('函数未闭合：' + name);
}
function lineWith(marker) {
  const line = app.split('\n').find(text => text.includes(marker));
  assert.ok(line, '在 app.js 里找不到：' + marker);
  return line;
}

// ================= 环境：parseBackup 全链路（真 normalize） =================
// 这一组刻意跑真的 normalize：结构上限要证明的是「超限的树根本没进 normalize」，
// 所以把 normalize 包一层计数器，而不是替换成桩。
function runParseBackup() {
  let normalizeCalls = 0;
  const context = {
    console,
    // 真实 normalize 里会引用到的宿主全局
    LESSONS: course.lessons,
    QUIZ: course.quizzes,
    SRC: Object.assign({}, course.skillLessons),
    STAGES: course.stages,
    TRACKS: course.tracks,
    quizQuestion() { return null; },
    safeEvidenceUrl() { return ''; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  vm.createContext(context);
  const api = vm.runInContext(
    [
      fnSource('defaults'),
      'var KNOWN_TOP=Object.keys(defaults());',
      fnSource('safeKey'),
      fnSource('publicLc'),
      fnSource('keepExtra'),
      fnSource('withExtra'),
      fnSource('normalize'),
      fnSource('normalizedState'),
      lineWith('var BACKUP_MAX_DEPTH='),
      fnSource('backupTooComplex'),
      fnSource('backupStructure'),
      fnSource('parseBackup'),
      'var parseBackupReal=parseBackup;',
      // 计数的包装：解析成功一次就说明走过了 normalize（超限的树根本到不了这里）
      'var normalizeCalls=0;',
      'parseBackup=function(raw){var result=parseBackupReal(raw);normalizeCalls+=1;return result};',
      ';({ parseBackup:function(raw){return parseBackup(raw)}, calls:function(){return normalizeCalls} })'
    ].join('\n'),
    context
  );
  return { parse: raw => api.parseBackup(raw), calls: () => api.calls() };
}

// 一份形状合法、内容正常的备份（和「导出进度」写出来的结构一致）
function validState(overrides) {
  return Object.assign(
    {
      name: '小跃', theme: 'auto', skills: { 'w1.0': 2 }, checks: { 'w1.0': true },
      days: ['2026-10-01', '2026-10-02'], quiz: { m1: 80 }, co: [], start: '2026-09-01',
      reroll: {}, mil: {}, read: { 'w1.0': true }, readDone: {}, wrong: {}, quizSeen: {},
      attempts: [], latestQuiz: {}, evidence: [], interviewAnswers: {}, rev: 7
    },
    overrides
  );
}
function envelope(state) {
  return { format: 'yueqian-progress', version: 3, exportedAt: '2026-11-04T00:00:00.000Z', data: state };
}
// 造一棵深度为 depth 的对象（depth 层嵌套的键）
function nested(depth) {
  let node = { leaf: true };
  for (let i = 0; i < depth; i += 1) node = { ['k' + i]: node };
  return node;
}
function captureError(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

// ================= 1. parseBackup 的结构上限 =================
// 上限值不是拍的：下面的 fatState() 复刻「把 60 门课、56 个任务、400 天打卡、100 次自测、
// 200 条证据、4 段面试作答全部填满」的真实备份形状（实测 1.2 MB、深度 4、单对象 60 键、
// 顶层 25 键、对象键总数约 2400），上限必须留在它的三倍以上。

// 真实备份的「最胖」形态，用来证明结构闸门不会误伤真实用户数据
function fatState() {
  const lessonIDs = Object.keys(course.lessons);
  const taskIDs = [
    ...course.phases.flatMap(phase => phase.ws.flatMap(week => week.tasks.map((_, index) => week.id + '.' + index))),
    ...course.projects.flatMap(project => project.tasks.map((_, index) => project.id + '.' + index))
  ];
  return {
    name: '小跃', theme: 'dark',
    skills: Object.fromEntries(lessonIDs.map((id, index) => [id, index % 4])),
    checks: Object.fromEntries(taskIDs.map(id => [id, true])),
    days: Array.from({ length: 400 }, () => '2026-01-01'),
    quiz: { m1: 80, m2: 90 },
    co: [{ n: 'a', s: 1, t: 2, d: '2026-10-01' }],
    start: '2026-09-01', reroll: { '2026-11-04': 3 }, mil: { m1: true },
    read: Object.fromEntries(lessonIDs.map(id => [id, true])),
    readDone: Object.fromEntries(lessonIDs.map(id => [id, true])),
    wrong: { 'm1.0': { n: 3, s: 1, next: '2026-11-10' } },
    quizSeen: {},
    attempts: Array.from({ length: 100 }, () => ({ mod: 'm1', at: '2026-10-01', correct: 3, total: 5, score: 60 })),
    latestQuiz: {},
    evidence: Array.from({ length: 200 }, (_, index) => ({
      id: 'e' + index, lesson: lessonIDs[index % lessonIDs.length], title: 't',
      note: 'n'.repeat(6000), url: 'https://example.com', goals: ['w1.0', 'w1.1'],
      confirmedGoals: ['w1.0'], at: '2026-10-01'
    })),
    interviewAnswers: Object.fromEntries(['1', '2', '3', '4'].map(key => [key, '答'.repeat(4000)])),
    rev: 99, pushedRev: 5, pushedAt: '2026-11-01', pushedHash: 'abcdef01', syncBase: 'abcdef01',
    lc: { backend: 'gist', gist: 'abcdef' },
    extra: { top: {}, ids: { readDone: {}, quizSeen: {}, evidence: [], attempts: [], goals: {} } }
  };
}
// 量一棵树的深度、单对象最大键数、对象键总数（数组下标不算「字段」）
function shapeOf(root) {
  let maxDepth = 0, maxKeys = 0, totalKeys = 0;
  const stack = [{ value: root, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== 'object') continue;
    maxDepth = Math.max(maxDepth, depth);
    if (Array.isArray(value)) { for (const item of value) stack.push({ value: item, depth: depth + 1 }); continue; }
    const keys = Object.keys(value);
    maxKeys = Math.max(maxKeys, keys.length);
    totalKeys += keys.length;
    for (const key of keys) stack.push({ value: value[key], depth: depth + 1 });
  }
  return { maxDepth, maxKeys, totalKeys };
}

test('最胖的真实备份照常解析：结构闸门不误伤真实形状', () => {
  const run = runParseBackup();
  const fat = fatState();
  const shape = shapeOf(envelope(fat));
  // 先钉住「真实备份长什么样」，上限才有意义
  assert.ok(shape.maxDepth <= 4, '真实备份深度不超过 4，实际 ' + shape.maxDepth);
  assert.ok(shape.maxKeys <= 60, '真实备份单对象不超过 60 个键，实际 ' + shape.maxKeys);
  assert.ok(shape.totalKeys <= 2500, '真实备份对象键总数约 2400，实际 ' + shape.totalKeys);
  assert.equal(Object.keys(fat).length, 25, '真实备份顶层 25 个键');

  const parsed = run.parse(envelope(fat));
  assert.equal(parsed.state.name, '小跃');
  assert.equal(parsed.state.days.length, 400, '400 天打卡应原样收下');
  assert.equal(parsed.state.evidence.length, 200, '200 条证据应原样收下');
  assert.equal(Object.keys(parsed.state.skills).length, 60, '60 门课的技能状态应原样收下');
  assert.equal(run.calls(), 1, '正常备份应走到 normalize 一次');

  // 不带信封的裸状态同样放行（旧版导出的就是这种）
  assert.equal(run.parse(fat).state.name, '小跃');
});

test('深嵌套：超过深度上限直接拒绝，且根本不进 normalize', () => {
  const run = runParseBackup();
  const limit = 12;
  const deep = validState({ extra: nested(20) });
  const error = captureError(() => run.parse(envelope(deep)));
  assert.ok(error, '深层嵌套应抛错');
  assert.match(error.message, /结构过于复杂/u, '应归入「结构过于复杂」这一类：' + error.message);
  assert.match(error.message, new RegExp('嵌套超过 ' + limit + ' 层', 'u'), '应写明是深度超限：' + error.message);
  assert.equal(run.calls(), 0, '超限的树一次都不该进 normalize');

  // 边界：远浅于上限的真实形状放行；贴着上限的结构也不该误伤
  assert.ok(run.parse(validState({ extra: nested(6) })), '浅结构应放行');
  assert.ok(run.parse(validState({ extra: nested(limit - 3) })), '仍在上限内应放行');
});

test('顶层键过多：超过上限直接拒绝，且根本不进 normalize', () => {
  const run = runParseBackup();
  const limit = 500;
  const wide = validState();
  const extraKeys = 600;
  for (let i = 0; i < extraKeys; i += 1) wide['unknown' + i] = i;
  const error = captureError(() => run.parse(envelope(wide)));
  assert.ok(error, '超宽顶层应抛错');
  assert.match(error.message, /结构过于复杂/u);
  const reported = Number((/顶层有 (\d+) 个字段/u.exec(error.message) || [])[1]);
  assert.ok(reported > limit, '应报出实际字段数：' + error.message);
  assert.ok(reported >= extraKeys, '报出的字段数不应小于注入的键数：' + error.message);
  assert.match(error.message, new RegExp(limit + ' 上限', 'u'), '应报出上限：' + error.message);
  assert.equal(run.calls(), 0, '超限的树一次都不该进 normalize');
});

test('键总数过多（宽度摊到很多小对象里）：总量兜底同样拦得住，不进 normalize', () => {
  const run = runParseBackup();
  // 每个对象都很窄、也不算深，但总量远超真实备份
  const many = {};
  for (let i = 0; i < 400; i += 1) {
    const bucket = {};
    for (let j = 0; j < 30; j += 1) bucket['k' + j] = j;
    many['bucket' + i] = bucket;
  }
  const error = captureError(() => run.parse(validState({ extra: many })));
  assert.ok(error, '键总数超限应抛错');
  assert.match(error.message, /结构过于复杂/u);
  assert.match(error.message, /字段总数超过 8000 个/u, '应说明是总量超限：' + error.message);
  assert.equal(run.calls(), 0, '超限的树一次都不该进 normalize');
});

test('三类错误文案可区分：版本过新 / 不是本产品备份 / 结构过于复杂', () => {
  const run = runParseBackup();

  const tooNew = captureError(() => run.parse({ format: 'yueqian-progress', version: 9, data: validState() }));
  assert.ok(tooNew);
  assert.match(tooNew.message, /版本过新/u, '版本过新要有自己的说法：' + tooNew.message);

  const notBackup = captureError(() => run.parse({ hello: 'world' }));
  assert.ok(notBackup);
  assert.match(notBackup.message, /不是跃迁计划的完整进度备份/u, '非本产品备份要有自己的说法：' + notBackup.message);
  assert.match(notBackup.message, /导出进度/u, '应告诉用户下一步该选什么文件');

  const complex = captureError(() => run.parse(envelope(validState({ extra: nested(12) }))));
  assert.ok(complex);
  assert.match(complex.message, /结构过于复杂/u);

  // 三者互不包含：用户看到的文案能直接区分
  const messages = [tooNew.message, notBackup.message, complex.message];
  assert.equal(new Set(messages).size, 3, '三类文案必须互不相同');
  assert.ok(!/结构过于复杂/u.test(tooNew.message), '版本过新不该说成结构问题');
  assert.ok(!/版本过新/u.test(notBackup.message), '非本产品备份不该说成版本问题');

  // 非对象的 JSON（数组 / 字符串）也归到「格式不正确」
  for (const raw of [[1, 2, 3], 'text', 42]) {
    const error = captureError(() => run.parse(envelope(raw)));
    assert.ok(error, '非对象数据应拒绝：' + JSON.stringify(raw));
    assert.match(error.message, /格式不正确/u);
  }
});

test('safeKey 的 __proto__/constructor/prototype 防护没被削弱', () => {
  const run = runParseBackup();
  // 原型污染键混在合法备份里：不该让 normalize 把它们写进状态
  const polluted = validState({ unknownField: 1 });
  const parsed = run.parse(
    JSON.parse(
      '{"format":"yueqian-progress","version":3,"data":' +
        JSON.stringify(polluted).replace('{', '{"__proto__":{"polluted":true},"constructor":{"x":1},')
        .replace('}', '}') +
      '}'
    )
  );
  assert.equal(parsed.state.polluted, undefined, '__proto__ 不应被搬进状态');
  assert.equal({}.polluted, undefined, '不应污染 Object.prototype');
  assert.equal(Object.prototype.polluted, undefined);
  // safeKey 本身仍在，且仍然拦这三个键
  assert.match(app, /function safeKey\(key\)\{return typeof key==='string'&&key\.length<=120&&key!=='__proto__'&&key!=='constructor'&&key!=='prototype'\}/u);
});

// ================= 2. 写满横幅的「重试保存」 =================

const flush = () => new Promise(resolve => setTimeout(resolve, 10));

function makeStorage() {
  const map = new Map();
  const store = {
    map,
    writes: [],
    full: false,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (store.full) {
        const error = new Error('The quota has been exceeded.');
        error.name = 'QuotaExceededError';
        throw error;
      }
      store.writes.push({ key, value: String(value) });
      map.set(key, String(value));
    },
    removeItem: key => map.delete(key)
  };
  return store;
}

function runRetry() {
  const local = makeStorage();
  local.setItem('yueqian.v1', JSON.stringify({ name: '内存里的最新进度' }));
  local.writes.length = 0;
  const toasts = [];
  const signals = [];
  const banner = { hidden: null };
  const context = {
    console,
    setTimeout,
    localStorage: local,
    KEY: 'yueqian.v1',
    UI_KEY: 'yueqian.v1.experience',
    UI: {},
    S: { name: '内存里的最新进度', rev: 3 },
    store: {
      listeners: {},
      on(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      emit(type, detail) { signals.push(type); (this.listeners[type] || []).forEach(fn => fn(detail)); }
    },
    storageToastAt: 0,
    persistable: state => JSON.parse(JSON.stringify(state)),
    doExport: () => toasts.push(['导出备份被点了']),
    '$': () => banner,
    toast: (...args) => toasts.push(args)
  };
  vm.createContext(context);
  const api = vm.runInContext(
    [
      'var storageFull=null;',
      fnSource('storageBanner'),
      fnSource('storageFailed'),
      fnSource('storageRecovered'),
      fnSource('persist'),
      fnSource('retryPersist'),
      'var storageToastAt=0;',
      callSource("store.on('storage-full'"),
      ';({ storageFailed:storageFailed, storageRecovered:storageRecovered, persist:persist, retryPersist:retryPersist, full:function(){return storageFull} })'
    ].join('\n'),
    context
  );
  return { context, api, local, toasts, signals, banner };
}
function callSource(marker) {
  const start = app.indexOf(marker);
  assert.ok(start >= 0, '在 app.js 里找不到：' + marker);
  let depth = 0;
  for (let i = app.indexOf('{', start); i < app.length; i += 1) {
    if (app[i] === '{') depth += 1;
    else if (app[i] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, i + 1) + ');';
    }
  }
  throw new Error('调用块未闭合：' + marker);
}

test('重试保存：写满时点一下不会假装成功，横幅留着并明说仍然没存上', async () => {
  const run = runRetry();
  run.local.full = true;
  assert.equal(run.api.persist(), false);
  await flush();
  const bannerBefore = run.banner.hidden;
  assert.equal(bannerBefore, false, '写满后横幅应可见');
  const toastCountBefore = run.toasts.length;

  run.api.retryPersist();
  await flush();

  assert.equal(run.banner.hidden, false, '重试失败后横幅必须留着');
  assert.equal(run.api.full(), true, '仍应处于写满状态');
  const last = run.toasts[run.toasts.length - 1];
  assert.ok(run.toasts.length > toastCountBefore, '重试失败应给出反馈，不能点了没反应');
  assert.match(last[0], /还是没存上|没存上/u, '应明说仍然失败：' + last[0]);
  assert.match(last[0], /本机空间仍然不足/u);
  assert.equal(last[3] && last[3].t, '导出备份', '失败提示里应仍带逃生口「导出备份」');
  // 不能给出任何成功口吻的文案
  assert.ok(!/已保存/u.test(last[0]), '失败时不能说「已保存」');
});

test('重试保存：用户清理空间后点一下即可落盘，横幅消失并提示成功', async () => {
  const run = runRetry();
  run.local.full = true;
  assert.equal(run.api.persist(), false);
  await flush();
  assert.equal(run.banner.hidden, false, '写满后横幅可见');

  // 用户清理了空间
  run.local.full = false;
  run.api.retryPersist();
  await flush();

  assert.equal(run.local.writes.filter(entry => entry.key === 'yueqian.v1').length, 1, '应真的写了一次盘');
  assert.equal(JSON.parse(run.local.map.get('yueqian.v1')).name, '内存里的最新进度', '写的应是当前内存状态');
  assert.equal(run.banner.hidden, true, '重试成功后横幅应消失');
  assert.equal(run.api.full(), null, '写满标记应清掉');
  const last = run.toasts[run.toasts.length - 1];
  assert.match(last[0], /已保存到本机/u, '成功要说清楚：' + last[0]);
});

test('横幅上有第二个动作：重试保存按钮走 data-action 分发约定', () => {
  assert.match(html, /id="storageBar"[\s\S]{0,600}?data-action="storage-retry"/u, '横幅里应有重试保存按钮');
  assert.match(html, /id="storageRetry"[^>]*data-action="storage-retry"[^>]*>重试保存</u, '按钮文案应为「重试保存」');
  assert.match(html, /id="storageExport"[\s\S]{0,300}?data-action="storage-retry"/u, '导出备份与重试保存应在同一横幅内');
  // 分发表里真的注册了，不是只有个按钮摆着
  assert.match(app, /'storage-retry':retryPersist,/u, 'ACTIONS 里应注册 storage-retry');
});

// ================= 3. 下载诚实文案 =================

function runConfirm({ failWrite = false, keepCopyFails = false, importState } = {}) {
  const local = makeStorage();
  local.setItem('yueqian.v1', JSON.stringify({ name: '磁盘上的进度' }));
  const setItemRaw = local.setItem;
  if (keepCopyFails) {
    // 主状态写得进，只有 .pre-import 这份恢复副本写不进（空间刚好用完的典型情形）
    local.setItem = (key, value) => {
      if (key.endsWith('.pre-import') && local.full === false) {
        const error = new Error('The quota has been exceeded.');
        error.name = 'QuotaExceededError';
        throw error;
      }
      setItemRaw(key, value);
    };
  }
  local.full = failWrite;
  local.writes.length = 0;
  const toasts = [];
  const downloads = [];
  const replaced = [];
  const previewEl = { classList: { add() {} } };
  const next = importState || validState({ name: '导入后', rev: 2 });
  const context = {
    console,
    localStorage: local,
    KEY: 'yueqian.v1',
    S: validState({ name: '导入前' }),
    backupPayload: () => ({ format: 'yueqian-progress', version: 3, data: { name: '当前' } }),
    storageToastAt: 0,
    todayStr: () => '2026-11-04',
    syncBase: () => 'base-01',
    persistable: state => JSON.parse(JSON.stringify(state)),
    persistCandidate: state => {
      if (local.full) return false;
      local.writes.push({ key: 'yueqian.v1', value: JSON.stringify(state) });
      local.map.set('yueqian.v1', JSON.stringify(state));
      return true;
    },
    downloadJson: (name, data) => downloads.push({ name, data }),
    replaceState: state => replaced.push(plain(state)),
    save: () => {},
    doExport: () => {},
    toast: (...args) => toasts.push(args),
    '$': () => previewEl
  };
  vm.createContext(context);
  const api = vm.runInContext(
    [
      'var pendingImport=null;',
      fnSource('closeImportPreview'),
      fnSource('confirmImport'),
      ';({ confirmImport:confirmImport, state:function(){return S}, pending:function(){return pendingImport}, setPending:function(v){pendingImport=v} })'
    ].join('\n'),
    context
  );
  api.setPending({ raw: {}, state: next });
  return { api, local, toasts, downloads, replaced };
}

test('下载诚实文案：不提「已先下载」，改成两步式并给出看不到文件时怎么办', () => {
  const run = runConfirm();
  run.api.confirmImport();

  const message = run.toasts[0][0];
  assert.equal(run.toasts.length, 1);
  assert.ok(!/已先下载/u.test(message), '不应再断言「已先下载」——下载是否被拦无法探测：' + message);
  assert.match(message, /恢复完成/u);
  assert.match(message, /恢复前的进度已导出到下载目录/u, '应说清导出去了哪：' + message);
  assert.match(message, /若没看到文件，请先用「导出进度」手动保存一份/u, '应给出看不到文件时的补救动作：' + message);
  // 下载确实仍被触发（文案变化不能顺带把功能删掉）
  assert.equal(run.downloads.length, 1, '成功路径仍要导出恢复前备份');
  assert.equal(run.downloads[0].name, 'yueqian-before-import-2026-11-04.json');
});

test('恢复副本没写成功时不再提「已导出」：只提醒用户自己存一份', () => {
  const run = runConfirm({ keepCopyFails: true });
  run.api.confirmImport();

  const message = run.toasts[0][0];
  assert.equal([...run.local.map.keys()].some(key => key.endsWith('.pre-import')), false, '前提：.pre-import 确实没写进去');
  assert.ok(!/恢复前的进度已导出到下载目录/u.test(message), '.pre-import 没写成功时不该提这句：' + message);
  assert.match(message, /恢复完成/u);
  assert.match(message, /没能在本机留下副本/u, '应如实说明：' + message);
  assert.match(message, /导出进度/u, '应告诉用户怎么补一份');
});

// ================= 4. 导入后的 UI 一致性 =================
// 结论：现有实现已经安全，这一组是「固定住」当前行为，防止以后有人为了别的目的把保护拆掉。
// 保护点：loadUI 用 LESSONS[id] 过滤 lastLesson/reading/drafts；renderStudyHub 用
// UI.lastLesson && LESSONS[UI.lastLesson] 兜底；会话内的 openLesson 对未知 id 直接 return。

function runLoadUI(storedUI) {
  const stored = new Map([['yueqian.v1.experience', JSON.stringify(storedUI)]]);
  const context = {
    console,
    localStorage: {
      getItem: key => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: key => stored.delete(key)
    },
    LESSONS: course.lessons,
    SRC: Object.assign({}, course.skillLessons),
    UI_KEY: 'yueqian.v1.experience',
    UI: null
  };
  vm.createContext(context);
  const api = vm.runInContext(
    [lineWith('function uiDefaults()'), 'var UI=uiDefaults();', fnSource('loadUI'), ';({ loadUI:loadUI, UI:UI })'].join('\n'),
    context
  );
  api.loadUI();
  return api;
}

test('导入另一台设备的 UI：指向本机不存在课程 ID 的 lastLesson/reading/drafts 被丢掉，不崩不留空白', () => {
  const ui = runLoadUI({
    view: 'me',
    lastLesson: 'w99.7', // 本机没有这门课
    reading: { 'w99.7': { top: 500, open: [0, 1, 50] }, 'w1.0': { top: 42, open: [2] } },
    drafts: { 'w99.7': { title: 'x', note: 'y', url: 'https://a', goals: ['w1.0'] } },
    font: 99,
    week: 'w5'
  });
  const state = plain(ui.UI);

  assert.equal(state.lastLesson, '', '未知课程 ID 不应留在 lastLesson');
  assert.deepEqual(Object.keys(state.reading), ['w1.0'], '未知课程的阅读位置应被丢掉');
  assert.deepEqual(Object.keys(state.drafts), [], '未知课程的草稿应被丢掉');
  // 合法的那一份原样保留，不会因为同一次备份里有脏数据就一起清空
  assert.equal(state.reading['w1.0'].top, 42);
  assert.deepEqual(state.reading['w1.0'].open, [2]);
  // 其余字段照常恢复，说明是「精确清理」而不是「整体重置」
  assert.equal(state.view, 'me');
  assert.equal(state.font, 24, '字号仍被夹到上限 24');
  assert.equal(state.week, 'w5');

  // 每一份 reading/drafts 的键都必须能在 LESSONS 里找到——这就是「不显示空白」的判据
  for (const id of Object.keys(state.reading)) assert.ok(course.lessons[id], 'reading 里残留了不存在的课程：' + id);
  for (const id of Object.keys(state.drafts)) assert.ok(course.lessons[id], 'drafts 里残留了不存在的课程：' + id);
  if (state.lastLesson) assert.ok(course.lessons[state.lastLesson], 'lastLesson 残留了不存在的课程：' + state.lastLesson);
});

test('导入后首页「继续上次」不会拿未知课程 ID 去查课表：兜底成「去学习中心挑一篇」', () => {
  // 直接跑真实 renderStudyHub：它是唯一读 UI.lastLesson 渲染页面的地方
  let captured = '';
  const context = {
    console,
    LESSONS: course.lessons,
    SRC: Object.assign({}, course.skillLessons),
    S: { name: '', checks: {}, read: {}, readDone: {}, wrong: {}, days: [] },
    // 导入后最坏的情况：UI.lastLesson 里塞着一个本机不存在的课程
    UI: { view: 'ov', lastLesson: 'w99.7', reading: {}, drafts: {}, group: { train: 'daily', plan: 'plan' } },
    esc: value => String(value == null ? '' : value),
    icon: () => '<i></i>',
    hasDay: () => false,
    todayStr: () => '2026-11-04',
    currentWeek: () => 3,
    wrongDue: () => 0,
    suggestedLesson: () => 'w3.0',
    '$': () => ({ set innerHTML(value) { captured = value; } })
  };
  vm.createContext(context);
  vm.runInContext(fnSource('renderStudyHub') + '\nrenderStudyHub();', context);

  assert.ok(captured.length > 0, '首页应渲染出内容，不是空白');
  assert.ok(!captured.includes('w99.7'), '渲染结果不应出现不存在的课程 ID');
  assert.match(captured, /data-goto="learn"/u, '未知「上次阅读」应兜底成去学习中心');
  assert.match(captured, /还没有阅读记录，从学习中心选一篇开始/u, '兜底文案应说清下一步');
  // 建议课程照常可用（不因为 UI 脏数据连正常入口也丢了）
  assert.match(captured, /data-lesson="w3\.0"/u, '正常的「今天学什么」入口应照常渲染');
});

test('会话内打开未知课程 ID：openLesson 直接 return，不写状态也不开抽屉', () => {
  const body = fnSource('openLesson');
  const guard = body.indexOf('var lesson=LESSONS[id];if(!lesson)return;');
  assert.ok(guard > 0, 'openLesson 应在立刻查 LESSONS 后对未知 id 直接 return');
  // 保护必须排在任何状态写入之前
  for (const marker of ['captureReading()', 'DRL=id', 'UI.lastLesson=id']) {
    const at = body.indexOf(marker);
    assert.ok(at > guard, '对未知课程的保护必须排在 ' + marker + ' 之前');
  }
  // pushState 的路由入口同样有 LESSONS 检查（两个方向：初始化与 popstate）
  const guards = [...app.matchAll(/if\(lesson&&LESSONS\[lesson\]\)openLesson\(lesson,true\)/gu)];
  assert.ok(guards.length >= 1, 'initNavigation 打开恢复的课程前应查 LESSONS');
  assert.ok(/if\(route\.lesson&&LESSONS\[route\.lesson\]\)openLesson\(route\.lesson,true\)/u.test(app), 'popstate 同样应查 LESSONS');
});
