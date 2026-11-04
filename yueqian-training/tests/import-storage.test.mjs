// 导入上限、写满可见与导入原子性。
// 这里全部用 fnSource() 从 app.js 里抠出真实函数体在 vm 里跑，不在测试里重抄一遍实现：
// 被测的就是线上那份代码，重构后测试跟着真实实现走。
// 运行：node --test yueqian-training/tests/import-storage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');

const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---------- 从 app.js 里取出真实代码片段 ----------
function lineWith(marker) {
  const line = app.split('\n').find(text => text.includes(marker));
  assert.ok(line, '在 app.js 里找不到：' + marker);
  return line;
}
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
// 取出包含某个标记的 register 调用块（store.on(...) 那种跨行注册）
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

// ---------- 假 localStorage：可以随时切成「写满」 ----------
// storageFailed 用 setTimeout(…,0) 发信号：等一轮宏任务再断言，别只等 setImmediate
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

// ---------- 环境 1：只跑 doImport（尺寸闸门） ----------
function runDoImport({ size, sizeMissing = false } = {}) {
  const toasts = [];
  const reads = [];
  let constructed = 0;
  // 只暴露 readAsText：超限时一次都不该被调用
  class FakeFileReader {
    constructor() { constructed += 1; }
    readAsText(file) { reads.push(file); }
  }
  const context = {
    console,
    FileReader: FakeFileReader,
    pendingImport: null,
    parseBackup: () => ({ raw: {}, state: {} }),
    importSummary: () => '摘要',
    // doImport 只在 onload 里碰 DOM；尺寸闸门这几条根本走不到那里，给个空桩即可
    '$': () => ({ set textContent(_value) {} }),
    toast: (...args) => toasts.push(args),
    document: { querySelector: () => null }
  };
  vm.createContext(context);
  vm.runInContext(
    lineWith('var IMPORT_MAX_BYTES=') + '\n' + fnSource('bytesCn') + '\n' + fnSource('doImport') +
      '\n;({ doImport:doImport, MAX:IMPORT_MAX_BYTES, readerCount:function(){return 0} })',
    context
  );
  const file = { name: 'backup.json' };
  if (!sizeMissing) file.size = size;
  context.doImport(file);
  return { toasts, reads, context, constructedCount: () => constructed };
}

// ---------- 环境 2：存储层 storageFailed / persist / persistCandidate ----------
function runStorage() {
  const local = makeStorage();
  const toasts = [];
  const signals = [];
  const banner = { hidden: null };
  // store 只需要 on/emit 两个方法：宿主真实的 store 也是这么实现的（见 app.js 的 store 定义）
  const context = {
    console,
    // storageFailed 用 setTimeout(…,0) 把信号推到下一个事件循环；测试里原样保留这个异步行为
    setTimeout,
    localStorage: local,
    KEY: 'yueqian.v1',
    UI_KEY: 'yueqian.v1.experience',
    UI: {},
    S: { name: '本机进度' },
    store: {
      listeners: {},
      on(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      // 先记信号、再派发给真实订阅者：测试既能看到「发了几次」,又能验证监听器确实被调到
      emit(type, detail) { signals.push(type); (this.listeners[type] || []).forEach(fn => fn(detail)); }
    },
    storageToastAt: 0,
    persistable: state => JSON.parse(JSON.stringify(state)),
    // storageBanner 用 $('#storageBar') 拿横幅；这里用同一个对象模拟 hidden 开关
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
      fnSource('persistUI'),
      fnSource('persist'),
      fnSource('persistCandidate'),
      lineWith('var storageToastAt=0;'),
      callSource("store.on('storage-full'"),
      // 暴露 storageFull 本身，横幅的可见性由宿主的 banner 对象在测试侧读取
      ';({ storageFailed:storageFailed, storageRecovered:storageRecovered, persist:persist, persistCandidate:persistCandidate, persistUI:persistUI, full:function(){return storageFull} })'
    ].join('\n'),
    context
  );
  return { context, api, local, toasts, signals, banner };
}
// 横幅可见性 = hidden 是否为 false；banner.hidden 初值是 null（未设置）
const flagsOf = run => ({ full: run.api.full(), banner: run.banner.hidden === false });

// ---------- 环境 3：只跑 confirmImport（导入原子性） ----------
function makeState(overrides) {
  return Object.assign(
    {
      name: '导入前', theme: 'auto', skills: { 'a.1': 2 }, checks: { 'w1.0': true },
      days: ['2026-10-01'], quiz: { m1: 80 }, co: [], start: '2026-09-01', reroll: {},
      mil: {}, read: {}, readDone: {}, wrong: {}, quizSeen: {}, attempts: [],
      latestQuiz: {}, evidence: [], interviewAnswers: {}, rev: 7,
      pushedRev: 3, pushedAt: '旧时间', pushedHash: 'oldhash', syncBase: 'base-01',
      lc: { backend: 'gist', gist: 'abcdef' }, extra: null
    },
    overrides
  );
}

function runConfirmImport({ failWrite = false, importState } = {}) {
  const local = makeStorage();
  local.setItem('yueqian.v1', JSON.stringify({ name: '磁盘上的进度' }));
  local.full = failWrite;
  local.writes.length = 0;
  const toasts = [];
  const downloads = [];
  const replaced = [];
  const previewHidden = [];
  const previewEl = { classList: { add(name) { if (name === 'hidden') previewHidden.push(true); } } };
  const next = importState || makeState({ name: '导入后', rev: 2, pushedRev: 9, pushedHash: 'newhash', pushedAt: '新时间' });
  const context = {
    console,
    localStorage: local,
    KEY: 'yueqian.v1',
    S: makeState({}),
    backupPayload: () => ({ format: 'yueqian-progress', version: 3, data: { name: '当前' } }),
    // confirmImport 的失败分支会推后通用写满吐司的节流窗（避免连吃两条提示），这里给它一个可写的宿主变量
    storageToastAt: 0,
    todayStr: () => '2026-11-04',
    syncBase: () => 'base-01',
    persistable: state => JSON.parse(JSON.stringify(state)),
    // confirmImport 现在是「先 persistCandidate 落盘、成功才动内存」，这里给出同签名的真实语义桩：
    // 写盘成功返回 true，写满时走与产品一致的失败分支并返回 false
    persistCandidate: state => {
      if (local.full) {
        const error = new Error('The quota has been exceeded.');
        error.name = 'QuotaExceededError';
        local.lastQuotaError = error;
        return false;
      }
      local.writes.push({ key: 'yueqian.v1', value: JSON.stringify(state) });
      local.map.set('yueqian.v1', JSON.stringify(state));
      return true;
    },
    downloadJson: (name, data) => downloads.push({ name, data }),
    replaceState: state => replaced.push(plain(state)),
    save: () => {},
    doExport: () => {},
    toast: (...args) => toasts.push(args),
    // closeImportPreview 会 $('#importPreview').classList.add('hidden')，据 hidden 是否被加过来判断有没有关窗
    '$': () => previewEl,
    document: { querySelector: () => null }
  };
  vm.createContext(context);
  const api = vm.runInContext(
    [
      'var pendingImport=null;',
      // 用真实的关闭函数：它会清 pendingImport 并给预览窗加 hidden，
      // 这样「失败路径不能清 pendingImport」测的才是产品行为，不是桩行为
      fnSource('closeImportPreview'),
      fnSource('confirmImport'),
      ";({ confirmImport:confirmImport, state:function(){return S}, pending:function(){return pendingImport}, setPending:function(v){pendingImport=v} })"
    ].join('\n'),
    context
  );
  // pendingImport 是 IIFE 里的模块级变量，先塞进待确认的导入结果（相当于 doImport 解析成功后）
  api.setPending({ raw: {}, state: next });
  return { context, api, local, toasts, downloads, replaced, previewHidden, next };
}

// ================= 1. 导入大小上限 =================

test('超限文件：readAsText 一次都没被调用，并给出含上限与文件大小的错误', () => {
  const fiveMB = 5 * 1024 * 1024;
  const over = runDoImport({ size: fiveMB + 1 });
  assert.equal(over.reads.length, 0, '超限文件不应启动 FileReader');
  assert.equal(over.toasts.length, 1, '应给一条错误提示');
  const message = over.toasts[0][0];
  assert.match(message, /5 MB 上限/u, '错误里应写明上限值：' + message);
  assert.match(message, /MB|字节/u, '错误里应写明文件实际大小：' + message);
  assert.match(message, /拒绝导入/u);
});

test('上限边界：刚好 5 MB 放行、5 MB + 1 字节拒绝；空文件与无 size 也拒绝', () => {
  const fiveMB = 5 * 1024 * 1024;
  const exact = runDoImport({ size: fiveMB });
  assert.equal(exact.toasts.length, 0, '刚好等于上限应放行');
  assert.equal(exact.reads.length, 1, '放行后应真正读文件');

  const empty = runDoImport({ size: 0 });
  assert.equal(empty.reads.length, 0, '空文件不应启动 FileReader');
  assert.equal(empty.toasts.length, 1);
  assert.match(empty.toasts[0][0], /空/u);

  const missing = runDoImport({ sizeMissing: true });
  assert.equal(missing.reads.length, 0, '读不到 size 时不应启动 FileReader');
  assert.match(missing.toasts[0][0], /大小/u);
});

test('旧实现的无限读盘路径已删除：doImport 里 readAsText 之前必有 size 判断', () => {
  const body = fnSource('doImport');
  const gate = body.indexOf('file.size');
  const read = body.indexOf('readAsText');
  assert.ok(gate > 0, 'doImport 里应有 file.size 检查');
  assert.ok(read > gate, 'size 检查必须排在 readAsText 之前');
  // 全文件范围内不再有「直接 readAsText、前面没有 size 检查」的写法
  assert.doesNotMatch(app, /function doImport\(file\)\{var rd=\s*new FileReader/u, '仍存在未做 size 检查的旧版 doImport');
});

// ================= 2. 写满每次可见 =================

test('写满后连续两次失败，两次都能观察到信号（不再只提示一次）', async () => {
  const run = runStorage();
  run.local.full = true;

  assert.equal(run.api.persist(), false);
  assert.equal(run.api.persist(), false);
  await flush();

  assert.equal(run.signals.length, 2, '两次失败应发两次 storage-full 信号，实际 ' + run.signals.length);
  assert.deepEqual(run.signals, ['storage-full', 'storage-full']);
  // 吐司有 8 秒节流，只出一条是刻意的；信号本身没被吞掉才是这条测试要盯的
  assert.equal(run.toasts.length, 1, '吐司应被节流成一条，不该刷屏');

  const flags = flagsOf(run);
  assert.equal(flags.full, true, '应处于「写满」状态');
  assert.equal(flags.banner, true, '横幅应可见（hidden=false）');
  assert.equal(run.banner.hidden, false, 'storageBanner(true) 应把 hidden 置 false');
});

test('节流窗口结束后再失败，用户又能看到一次提示', async () => {
  const run = runStorage();
  run.local.full = true;
  assert.equal(run.api.persist(), false);
  await flush();

  // 把节流时间戳往前拨到窗口之外，模拟 8 秒后用户又点了一次
  // storageToastAt 是 IIFE 里的模块级变量：改它得在同一个 vm 上下文里改
  vm.runInContext('storageToastAt=Date.now()-9000;', run.context);
  assert.equal(run.api.persist(), false);
  await flush();

  assert.equal(run.signals.length, 2, '两次都应有信号');
  assert.equal(run.toasts.length, 2, '窗口外再失败应再给一条吐司');
  assert.match(run.toasts[1][0], /存储空间已满/u);
  assert.equal(run.toasts[1][3] && run.toasts[1][3].t, '导出备份', '提示里应带「导出备份」动作');
});

test('页面里有一条常驻横幅，写满出现、写盘成功后自动消失', () => {
  assert.match(html, /id="storageBar"[^>]*hidden/u, '横幅默认隐藏');
  assert.match(html, /id="storageBar"[^>]*role="alert"/u, '横幅应对读屏软件播报');
  assert.match(html, /data-action="export"/u, '横幅里应有导出备份动作');
  assert.match(html, /本机存储空间已满/u, '横幅文案应说明写满');

  const run = runStorage();
  run.local.full = true;
  assert.equal(run.api.persist(), false);
  assert.equal(flagsOf(run).banner, true, '写满后横幅出现');

  run.local.full = false;
  assert.equal(run.api.persist(), true);
  assert.equal(flagsOf(run).banner, false, '写盘成功后横幅消失');
  assert.equal(flagsOf(run).full, null);
});

// ================= 3. 导入原子性 =================

test('localStorage.setItem 抛 QuotaExceededError 时，confirmImport 后 S 与导入前逐字段一致', () => {
  const run = runConfirmImport({ failWrite: true });
  const before = plain(run.api.state());

  run.api.confirmImport();

  const after = plain(run.api.state());
  assert.deepEqual(after, before, '导入失败后内存状态必须逐字段保持不变');
  // 逐字段再对一遍，防止 deepEqual 在某种结构下漏掉差异
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), '字段集合不应变化');
  for (const key of Object.keys(before)) {
    assert.deepEqual(after[key], before[key], '字段 ' + key + ' 被改动');
  }
  assert.equal(after.rev, 7, 'rev 不应自增');
  assert.equal(after.name, '导入前', '名字不应被替换成导入内容');

  assert.equal(run.replaced.length, 0, '失败路径不应替换界面状态');
  assert.equal(run.previewHidden.length, 0, '失败路径不应关闭预览窗');
  assert.notEqual(run.api.pending(), null, '失败路径不应清掉 pendingImport');
  assert.equal(run.downloads.length, 0, '失败路径不应下载「导入前备份」假装成功');
  // 写满时 persistCandidate 内部会发一次通用「存储满」信号；导入失败分支要把它压掉，
  // 只留导入专用的那一条（否则用户连吃两条几乎同义的提示）
  assert.equal(run.toasts.length, 1, '失败路径只应有一条导入专用的提示');
  assert.match(run.toasts[0][0], /导入已取消/u);
  assert.match(run.toasts[0][0], /当前进度未改动/u);
  assert.equal(
    [...run.local.map.keys()].some(key => key.endsWith('.pre-import')),
    false,
    '失败路径不应留下 .pre-import 半份状态'
  );
});

test('写盘成功路径：先写盘再替换内存，既有语义（lc/rev/syncBase）保持不变', () => {
  const run = runConfirmImport({ failWrite: false });
  run.api.confirmImport();

  // 写盘发生在新状态上，且写的是不含凭据的那一份
  const written = run.local.writes.find(entry => entry.key === 'yueqian.v1');
  assert.ok(written, '成功路径应写盘');
  const disk = JSON.parse(written.value);
  assert.equal(disk.name, '导入后', '写进 localStorage 的应是导入后的状态');

  const state = plain(run.api.state());
  assert.equal(state.name, '导入后');
  assert.deepEqual(state.lc, { backend: 'gist', gist: 'abcdef' }, '保留本机同步配置');
  assert.equal(state.syncBase, 'base-01', 'syncBase 应保留');
  assert.equal(state.rev, 7, 'rev 取 max(本机 7, 备份 2) = 7');
  assert.equal(state.pushedRev, 0, 'pushedRev 清空');
  assert.equal(state.pushedHash, '', 'pushedHash 清空');
  assert.equal(state.pushedAt, '', 'pushedAt 清空');

  assert.equal(run.replaced.length, 1, '成功路径替换一次界面状态');
  assert.equal(run.previewHidden.length, 1, '成功路径关闭预览窗');
  assert.equal(run.api.pending(), null, '成功路径清掉 pendingImport');
  assert.equal(run.downloads.length, 1, '成功路径应下载导入前备份');
  assert.equal(run.toasts.length, 1);
  assert.match(run.toasts[0][0], /恢复完成/u);
  assert.equal(
    [...run.local.map.keys()].some(key => key.endsWith('.pre-import')),
    false,
    '成功收尾后不应残留 .pre-import'
  );
});

test('导入写盘顺序：候选状态落盘失败时一行内存都不改（代码顺序断言）', () => {
  const body = fnSource('confirmImport');
  const writeDisk = body.indexOf('persistCandidate(next)');
  const mutate = body.indexOf('S=next');
  const replace = body.indexOf('replaceState(next)');
  assert.ok(writeDisk > 0, 'confirmImport 应先用 persistCandidate 落盘');
  assert.ok(mutate > writeDisk, 'S=next 必须排在落盘之后');
  assert.ok(replace > mutate, 'replaceState 必须排在内存替换之后');
  // 旧版「先 S=next 再 persist()」的写法不能回来
  assert.doesNotMatch(app, /S=next;save\(\);\s*\n?\s*var stored=persist\(\)/u, '仍是先改内存再写盘的旧顺序');
});
