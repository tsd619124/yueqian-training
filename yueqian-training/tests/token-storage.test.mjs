// 同步凭据的存放位置：令牌与 LeanCloud 凭据只进 sessionStorage，不进 localStorage。
// 应用发布在共享的 GitHub Pages 源上（同一账号下其他项目同源），写进 localStorage 的
// gist 令牌同源任何页面或扩展都能读到，所以这里断言的是「实际落盘的内容」，不是「文件里有没有 token 这个词」。
// 运行：node --test yueqian-training/tests/token-storage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');

const SECRET_FIELDS = ['token', 'id', 'key', 'host', 'code'];

// ---------- 从 app.js 里取出真实代码片段，而不是在测试里重写一遍 ----------
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
// 取出包含某个标记的匿名 IIFE：向前找到 (function(){，再向后配对到 })();
function iifeSource(marker) {
  const at = app.indexOf(marker);
  assert.ok(at >= 0, '在 app.js 里找不到：' + marker);
  const start = app.lastIndexOf('(function(){', at);
  assert.ok(start >= 0, marker + ' 不在 IIFE 内');
  let depth = 0;
  for (let i = app.indexOf('{', start); i < app.length; i += 1) {
    if (app[i] === '{') depth += 1;
    else if (app[i] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, i + 1) + ')();';
    }
  }
  throw new Error('IIFE 未闭合：' + marker);
}

// 跑在 vm 里的状态层：真实的 defaults / normalize / syncData / syncHash / 凭据辅助函数
function loadState() {
  const source = [
    lineWith("var KEY='yueqian.v1'"),
    lineWith("var SECRET_KEY="),
    lineWith("var SECRET_FIELDS="),
    'var secret={};',
    fnSource('defaults'),
    'var KNOWN_TOP=Object.keys(defaults());',
    fnSource('safeKey'),
    fnSource('keepExtra'),
    fnSource('withExtra'),
    fnSource('normalize'),
    fnSource('syncData'),
    fnSource('syncCanonical'),
    fnSource('syncHash'),
    fnSource('normalizedState'),
    fnSource('secretArea'),
    fnSource('secretValue'),
    fnSource('loadSecret'),
    fnSource('saveSecret'),
    fnSource('clearSecret'),
    fnSource('migrateSecret'),
    fnSource('publicLc'),
    fnSource('persistable'),
    fnSource('persist'),
    fnSource('syncPayload'),
    fnSource('backupPayload'),
    'var S=defaults();',
    'secret=loadSecret();migrateSecret();'
  ].join('\n');
  return source;
}

function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    writes: []
  };
}

function runState({ local, session } = {}) {
  const localStore = local || makeStorage();
  const sessionStore = session || makeStorage();
  const setItem = localStore.setItem.bind(localStore);
  localStore.setItem = (key, value) => { localStore.writes.push({ key, value: String(value) }); setItem(key, value); };
  const context = {
    console,
    localStorage: localStore,
    sessionStorage: sessionStore,
    window: { sessionStorage: sessionStore },
    storageFailed: () => {},
    navigator: { userAgent: 'test', onLine: true },
    LESSONS: {}, QUIZ: {}, SRC: {}, STAGES: [], TRACKS: [],
    quizQuestion: () => null,
    safeEvidenceUrl: () => ''
  };
  vm.createContext(context);
  const api = vm.runInContext(
    loadState() + '\n;({ defaults:defaults, normalize:normalize, normalizedState:normalizedState, syncData:syncData, syncHash:syncHash, syncPayload:syncPayload, backupPayload:backupPayload, publicLc:publicLc, persistable:persistable, persist:persist, loadSecret:loadSecret, saveSecret:saveSecret, clearSecret:clearSecret, secretValue:secretValue, setState:function(next){S=next}, getState:function(){return S} })',
    context
  );
  return { api, localStore, sessionStore, context };
}

// vm 里造出来的对象原型不同，deepStrictEqual 会报「结构相同但不是同一引用」；比较前统一成本地 JSON 形状
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function secretFieldsOf(text) {
  return SECRET_FIELDS.filter(field => new RegExp('"' + field + '"\\s*:', 'u').test(text));
}

// ---------- 1. 落盘内容：任何形状的 S.lc 都不能把凭据写进 localStorage ----------
test('persist() 写进 localStorage 的对象里没有任何凭据字段', () => {
  const { api, localStore } = runState();
  const state = api.defaults();
  state.name = '测试';
  state.lc = { backend: 'gist', token: 'tl-leak-3', gist: 'a1b2c3d4e5' };
  api.setState(state);
  assert.equal(api.persist(), true);
  api.saveSecret({ token: 'tl-leak-3' });

  const written = localStore.writes.at(-1);
  assert.equal(written.key, 'yueqian.v1');
  assert.deepEqual(secretFieldsOf(written.value), []);
  assert.ok(!written.value.includes('tl-leak-3'), '令牌原文本出现在 localStorage 里');
  const stored = JSON.parse(written.value);
  assert.deepEqual(stored.lc, { backend: 'gist', gist: 'a1b2c3d4e5' }, '只保留非机密的 backend 与 Gist ID');
});

test('persistable() 对任意 S.lc 形状都只输出 backend 与 gist', () => {
  const { api } = runState();
  const shapes = [
    { backend: 'gist', token: 't', gist: 'gid' },
    { backend: 'gist', gist: 'gid', id: 'aid', key: 'akey', host: 'h', code: 'c' },
    { backend: 'lc', id: 'aid', key: 'akey', host: 'h', code: 'c' },
    { backend: 'lc' },
    null
  ];
  for (const lc of shapes) {
    const out = plain(api.persistable({ name: 'x', lc }));
    assert.deepEqual(secretFieldsOf(JSON.stringify(out)), [], '形状 ' + JSON.stringify(lc));
    if (lc && lc.gist) assert.equal(out.lc.gist, lc.gist);
    if (lc && lc.backend === 'lc') assert.deepEqual(out.lc, { backend: 'lc' });
  }
  assert.equal(plain(api.persistable({ name: 'x', lc: null })).lc, undefined);
});

// ---------- 2. 凭据读写都经过同一组辅助函数 ----------
test('S.lc 上不读也不写凭据字段：全部经由 secretValue / saveSecret', () => {
  for (const field of SECRET_FIELDS) {
    assert.doesNotMatch(app, new RegExp('S\\.lc\\.' + field + '\\b', 'u'), '仍直接读写 S.lc.' + field);
    assert.doesNotMatch(app, new RegExp('S\\.lc&&S\\.lc\\.' + field + '\\b', 'u'), '仍直接读 S.lc.' + field);
  }
  // 所有赋值给 S.lc 的地方，右侧都不含凭据字段（S.lc 只装 backend 与 gist）
  const writes = [...app.matchAll(/S\.lc\s*=\s*([^;]+);/gu)].map(match => match[1]);
  assert.ok(writes.length >= 4, '应仍有多处写入 S.lc（Gist ID 与断开），实际 ' + writes.length);
  for (const right of writes) {
    assert.deepEqual(secretFieldsOf('{' + right.replace(/=/gu, ':') + '}'), [], 'S.lc 赋值里带了凭据：' + right);
  }
  assert.match(app, /function secretValue\(field\)/u);
  assert.match(app, /function saveSecret\(next\)/u);
  assert.match(app, /function clearSecret\(\)\{saveSecret\(null\)\}/u);
});

test('凭据只写 sessionStorage，不写 localStorage', () => {
  const { api, localStore, sessionStore } = runState();
  api.saveSecret({ token: 'tl-leak-4' });
  assert.equal(api.secretValue('token'), 'tl-leak-4');
  const saved = sessionStore.map.get('yueqian.v1.secret');
  assert.ok(saved && JSON.parse(saved).token === 'tl-leak-4', '令牌应写进 sessionStorage');
  assert.ok(![...localStore.map.values()].some(value => value.includes('tl-leak-4')), '令牌出现在 localStorage');
  api.clearSecret();
  assert.equal(api.secretValue('token'), '');
  assert.equal(sessionStore.map.has('yueqian.v1.secret'), false, '断开后会话凭据应删除');
});

// ---------- 3. #t= 导入路径已删除，#g= 仍可用 ----------
test('不再接受地址栏里的令牌：#t= 路径已删除', () => {
  assert.ok(!app.includes('#t='), 'app.js 仍含 #t= 处理');
  assert.doesNotMatch(app, /t=\(\[\^&\]\+\)&g=/u, 'app.js 仍含令牌+Gist 的 URL 正则');
  assert.doesNotMatch(app, /location\.hash[^;]*token/u, '仍从 hash 读 token');
});

test('旧版 #t= 链接：只清理地址栏并提示，不写入任何状态', () => {
  const localStore = makeStorage();
  const sessionStore = makeStorage();
  const replaced = [];
  const toasts = [];
  const context = {
    console,
    localStorage: localStore,
    sessionStorage: sessionStore,
    window: { sessionStorage: sessionStore },
    location: { hash: '#t=tl-leak-5&g=a1b2c3d4', pathname: '/app/', search: '' },
    history: { replaceState: (...args) => replaced.push(args) },
    S: { lc: null },
    persist: () => { throw new Error('不应写盘'); },
    renderSyncCard: () => {},
    toast: (...args) => toasts.push(args),
    decodeURIComponent
  };
  vm.createContext(context);
  vm.runInContext(iifeSource('var gistMatch='), context);
  assert.equal(replaced.length, 1, '应清掉地址栏');
  assert.equal(plain(context.S.lc), null, '不应把令牌或 Gist 写进状态');
  assert.equal(sessionStore.map.size, 0, '不应产生会话凭据');
  assert.equal(localStore.map.size, 0, '不应产生本机存储');
  assert.equal(toasts.length, 1, '应提示旧链接失效');
  assert.match(toasts[0][0], /令牌不再导入/u);
});

test('#g= 仍能预填 Gist ID（只填非机密那项）', () => {
  const localStore = makeStorage();
  const sessionStore = makeStorage();
  const replaced = [];
  const written = [];
  const context = {
    console,
    localStorage: localStore,
    sessionStorage: sessionStore,
    window: { sessionStorage: sessionStore },
    location: { hash: '#g=a1b2c3d4e5', pathname: '/app/', search: '' },
    history: { replaceState: (...args) => replaced.push(args) },
    S: { lc: null },
    persist: () => written.push(JSON.stringify(context.S)),
    renderSyncCard: () => {},
    toast: () => {},
    decodeURIComponent
  };
  vm.createContext(context);
  vm.runInContext(iifeSource('var gistMatch='), context);
  assert.equal(replaced.length, 1);
  assert.deepEqual(plain(context.S.lc), { backend: 'gist', gist: 'a1b2c3d4e5' });
  assert.equal(written.length, 1);
  assert.equal(sessionStore.map.size, 0, 'Gist ID 不是凭据，不进会话凭据');
});

// ---------- 4. sync-config.js 是公开文件：其中的令牌一律忽略 ----------
test('sync-config.js 里的令牌不会被保存，只接受 Gist ID', async () => {
  const localStore = makeStorage();
  const sessionStore = makeStorage();
  const config = JSON.stringify({ backend: 'gist', gist: 'pubgist123', token: 'tl-leak-1' });
  const context = {
    console,
    localStorage: localStore,
    sessionStorage: sessionStore,
    window: { sessionStorage: sessionStore },
    S: { lc: null },
    persist: () => {},
    renderSyncCard: () => {},
    fetch: async () => ({ ok: true, text: async () => 'var CONFIG = ' + config + ';' })
  };
  vm.createContext(context);
  vm.runInContext(iifeSource("fetch('sync-config.js'"), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(context.S.lc), { backend: 'gist', gist: 'pubgist123' }, '只取 Gist ID');
  assert.equal(sessionStore.map.size, 0, '公开文件里的令牌不得成为会话凭据');
  assert.ok(![...localStore.map.values()].some(value => value.includes('tl-leak-1')));
});

test('sync-config.js 里的 LeanCloud 凭据同样被忽略', async () => {
  const sessionStore = makeStorage();
  const config = JSON.stringify({ id: 'appid', key: 'appkey', host: 'h.lncld.net', code: 'ABCD1234' });
  const context = {
    console,
    localStorage: makeStorage(),
    sessionStorage: sessionStore,
    window: { sessionStorage: sessionStore },
    S: { lc: null },
    persist: () => {},
    renderSyncCard: () => {},
    fetch: async () => ({ ok: true, text: async () => 'var CONFIG = ' + config + ';' })
  };
  vm.createContext(context);
  vm.runInContext(iifeSource("fetch('sync-config.js'"), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plain(context.S.lc), null, '公开配置文件不得注入任何凭据');
  assert.equal(sessionStore.map.size, 0);
});

// ---------- 5. 老用户迁移：令牌搬进会话存储，并从 localStorage 删除 ----------
test('迁移：旧版留在 localStorage 的令牌搬进 sessionStorage 并从 localStorage 删除', () => {
  const legacy = {
    name: '老用户', theme: 'auto', days: ['2026-10-01'], rev: 7,
    lc: { backend: 'gist', token: 'tl-leak-6', gist: 'oldgist42' }
  };
  const localStore = makeStorage();
  localStore.map.set('yueqian.v1', JSON.stringify(legacy));
  const { api, sessionStore } = runState({ local: localStore });

  assert.equal(api.secretValue('token'), 'tl-leak-6', '旧令牌应搬进本次会话');
  assert.equal(JSON.parse(sessionStore.map.get('yueqian.v1.secret')).token, 'tl-leak-6');
  const afterMigrate = JSON.parse(localStore.map.get('yueqian.v1'));
  assert.ok(!JSON.stringify(afterMigrate).includes('tl-leak-6'), 'localStorage 里仍留着旧令牌');
  assert.deepEqual(afterMigrate.lc, { backend: 'gist', gist: 'oldgist42' }, '只保留非机密配置');
  assert.equal(afterMigrate.name, '老用户', '其余进度不应丢失');
  assert.deepEqual(afterMigrate.days, ['2026-10-01']);

  // 迁移之后再来一次正常写盘，结果同样干净
  const state = api.defaults();
  state.lc = { backend: 'gist', token: 'tl-leak-6', gist: 'oldgist42' };
  api.setState(state);
  api.persist();
  assert.ok(!localStore.writes.at(-1).value.includes('tl-leak-6'));
});

test('迁移：旧存档里的 LeanCloud 凭据一并搬走', () => {
  const legacy = { lc: { id: 'appid', key: 'appkey', host: 'abc.api.lncld.net', code: 'ABCD1234' } };
  const localStore = makeStorage();
  localStore.map.set('yueqian.v1', JSON.stringify(legacy));
  const { api } = runState({ local: localStore });
  assert.equal(api.secretValue('id'), 'appid');
  assert.equal(api.secretValue('code'), 'ABCD1234');
  const after = JSON.stringify(JSON.parse(localStore.map.get('yueqian.v1')));
  assert.ok(!after.includes('appkey') && !after.includes('ABCD1234'), 'localStorage 里仍留着 LeanCloud 凭据');
});

test('迁移：会话里已有凭据时不覆盖，旧值照样清掉', () => {
  const localStore = makeStorage();
  localStore.map.set('yueqian.v1', JSON.stringify({ lc: { backend: 'gist', token: 'tl-leak-7', gist: 'g1' } }));
  const sessionStore = makeStorage();
  sessionStore.map.set('yueqian.v1.secret', JSON.stringify({ token: 'tl-leak-8' }));
  const { api } = runState({ local: localStore, session: sessionStore });
  assert.equal(api.secretValue('token'), 'tl-leak-8');
  assert.ok(!localStore.map.get('yueqian.v1').includes('tl-leak-7'));
});

test('normalize 容忍旧存档带来的 lc，但不把凭据写回状态', () => {
  const { api } = runState();
  const state = api.normalizedState({
    name: '旧版', lc: { backend: 'gist', token: 'tl-leak-9', gist: 'gid123', id: 'aid', key: 'akey' }
  });
  assert.deepEqual(plain(state.lc), { backend: 'gist', gist: 'gid123' });
  api.setState(state);
  const out = api.persistable(state);
  assert.equal(JSON.stringify(out).includes('tl-leak-9'), false);
  assert.deepEqual(plain(api.normalizedState({ lc: { backend: 'lc', code: 'ABCD1234' } }).lc), { backend: 'lc' });
  assert.equal(plain(api.normalizedState({}).lc), null);
});

// ---------- 6. 备份与云同步都不含 lc ----------
test('syncData / syncPayload / backup 都不含 lc，也不含任何凭据', () => {
  const { api, context } = runState();
  const state = api.defaults();
  state.name = '备份测试';
  state.days = ['2026-10-01'];
  state.lc = { backend: 'gist', token: 'tl-leak-2', gist: 'gid' };
  api.setState(state);
  const data = api.syncData(state);
  assert.equal('lc' in data, false, 'syncData 不应带 lc');
  assert.equal(JSON.stringify(data).includes('tl-leak-2'), false);
  const payload = api.syncPayload();
  assert.equal('lc' in payload, false, 'syncPayload 不应带 lc');
  assert.equal(JSON.stringify(payload).includes('tl-leak-2'), false);
  const backup = JSON.stringify(api.backupPayload());
  assert.equal(JSON.parse(backup).data.lc, undefined, 'backupPayload 的 data 不应带 lc');
  assert.equal(backup.includes('tl-leak-2'), false);
  assert.equal(JSON.parse(backup).data.name, '备份测试', '备份仍应包含学习数据');
});

// ---------- 7. 设置页仍然可用，并且把「不记住」讲清楚 ----------
test('同步卡片仍可填令牌，并写明关掉浏览器后需要重填', () => {
  assert.match(app, /set\('#lcToken',token\)/u);
  assert.match(app, /saveSecret\(\{token:tok\.slice\(0,200\)\}\)/u);
  assert.match(app, /令牌仅在本次会话有效/u);
  assert.match(html, /令牌只用于本次会话/u);
  assert.match(html, /关掉浏览器就没有/u);
  assert.match(html, /id="lcToken"/u);
  assert.ok(!/🐤|🔑|🔒/u.test(html), '不要加 emoji');
});

// ---------- 8. 跨端同步指纹（与原生 contentHash 同一契约） ----------
test('同步指纹：空状态 72ccbd59，带面试作答的样例 226a0d59', () => {
  const { api } = runState();
  assert.equal(api.syncHash(api.defaults()), '72ccbd59');
  const fixture = api.defaults();
  fixture.name = '面试';
  fixture.interviewAnswers = { '1': '先讲结论', '3': '指标口径由我定义' };
  assert.equal(api.syncHash(fixture), '226a0d59');
});

test('interviewAnswers 参与同步与备份，清洗规则与原生一致', () => {
  const { api } = runState();
  const state = api.normalizedState({
    interviewAnswers: {
      '1': '  先讲结论  ',
      '2': '   ',
      '3': 42,
      '12345': '键太长',
      '4': 'x'.repeat(4200)
    }
  });
  assert.deepEqual(Object.keys(plain(state.interviewAnswers)).sort(), ['1', '4']);
  assert.equal(state.interviewAnswers['1'], '先讲结论', '应去掉首尾空白');
  assert.equal(state.interviewAnswers['4'].length, 4000, '应截断到 4000');
  assert.deepEqual(plain(api.normalizedState({ interviewAnswers: ['a'] }).interviewAnswers), {});
  assert.deepEqual(plain(api.normalizedState({ interviewAnswers: 'a' }).interviewAnswers), {});

  const data = plain(api.syncData(state));
  assert.deepEqual(data.interviewAnswers, plain(state.interviewAnswers));
  // 空作答不进入同步白名单，保证未写答案的用户指纹不变
  assert.equal('interviewAnswers' in api.syncData(api.defaults()), false);
});
