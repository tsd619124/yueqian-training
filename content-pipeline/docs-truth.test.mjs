// P2-10 文档事实源检查的回归测试。
//
// 约定：**一律在临时目录里复刻一份最小仓库**（yueqian-training/index.html、sw.js、
// native-app/.../project.pbxproj、三份文档、STATUS.md），绝不改真实文件做变异测试——
// 真实仓库的 README 一旦忘了还原，就是又一次「文档说谎」，正是这条检查要防的事。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOC_TRUTH_FILES, DOC_TRUTH_SOURCE, docsTruthApplicable, docsTruthCheck, readVersions } from './release.mjs';

const REFERENCE = '当前版本、测试数、签名到期、部署目标一律见 [STATUS.md](STATUS.md)。';

// 三份文档的「干净」样板：各自只有一个 STATUS.md 指针，没有当前版本号。
const CLEAN = {
  'README.md': `# 项目\n\n${REFERENCE}\n\n## 历史记录\n\n原生 3.4.0（17）、Web 1.20.0 / yueqian-v24 都是当时的状态。\n`,
  'native-app/README.md': `# 原生 App\n\n${REFERENCE}\n\n签名的到期时间见 [STATUS.md](../STATUS.md)。\n`,
  'NEXT-SESSION.md': `# 下一次从这里继续\n\n当前状态不在本页维护，见 \`STATUS.md\`。\n`
};

async function fixture(context, { native = '9.9.9', build = '99', web = '8.8.8', cache = 'yueqian-v88', docs = {}, status } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-docs-truth-'));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(base, 'yueqian-training'), { recursive: true });
  await fs.mkdir(path.join(base, 'native-app/Yueqian.xcodeproj'), { recursive: true });
  await fs.mkdir(path.join(base, 'native-app'), { recursive: true });
  await fs.writeFile(path.join(base, 'yueqian-training/index.html'), `<script>var APP_VERSION = '${web}';</script>`);
  await fs.writeFile(path.join(base, 'yueqian-training/sw.js'), `var CACHE_PREFIX = 'yueqian-';\nvar CACHE = CACHE_PREFIX + '${cache.replace('yueqian-', '')}';\n`);
  await fs.writeFile(path.join(base, 'native-app/Yueqian.xcodeproj/project.pbxproj'), `MARKETING_VERSION = ${native};\nCURRENT_PROJECT_VERSION = ${build};\n`);
  const files = { ...CLEAN, ...docs };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(base, name)), { recursive: true });
    await fs.writeFile(path.join(base, name), body);
  }
  await fs.writeFile(path.join(base, DOC_TRUTH_SOURCE), status ?? `# 当前状态\n\n| 原生 | ${native} |\n| Web | ${web} |\n`);
  return base;
}

test('文档事实源：干净仓库通过，且结论里带出三份文件的引用数', async context => {
  const base = await fixture(context);
  const detail = await docsTruthCheck(base);
  assert.match(detail, /均未出现当前版本 9\.9\.9 \/ 8\.8\.8/u);
  assert.match(detail, /各 1 \/ 2 \/ 1 处引用/u);
});

test('文档事实源：当前原生版本出现在 README 时报红，并给出文件、行号与命中的版本', async context => {
  const base = await fixture(context, { docs: { 'README.md': `${REFERENCE}\n\n原生源码 **9.9.9（99）** 已装机。\n` } });
  await assert.rejects(docsTruthCheck(base), error => {
    assert.match(error.message, /README\.md:3 写了当前版本号（原生 9\.9\.9）/u);
    assert.match(error.message, /原生源码 \*\*9\.9\.9（99）\*\* 已装机/u);
    return true;
  });
});

test('文档事实源：当前 Web 版本出现在任一份文档都报红', async context => {
  for (const file of DOC_TRUTH_FILES) {
    const base = await fixture(context, { docs: { [file]: `${REFERENCE}\n\nWeb **8.8.8 / yueqian-v88** 已上线。\n` } });
    await assert.rejects(docsTruthCheck(base), new RegExp(`${file.replace(/[./]/gu, '\\$&')}:3 写了当前版本号（Web 8\\.8\\.8）`, 'u'));
  }
});

test('文档事实源：没有 STATUS.md 指针也算失败，顺口提一句不够', async context => {
  const base = await fixture(context, { docs: { 'NEXT-SESSION.md': '# 下一次从这里继续\n\n当前版本看 STATUS.md 那个文件就行。\n' } });
  await assert.rejects(docsTruthCheck(base), /NEXT-SESSION\.md 没有指向 STATUS\.md 的引用/u);
  // 行内代码与自动链接两种写法都认。
  const inline = await fixture(context, { docs: { 'NEXT-SESSION.md': '# 下一次\n\n版本见 `STATUS.md`。\n' } });
  assert.match(await docsTruthCheck(inline), /均未出现当前版本/u);
  const automatic = await fixture(context, { docs: { 'README.md': `${REFERENCE}\n\n详见 <STATUS.md>。\n` } });
  assert.match(await docsTruthCheck(automatic), /均未出现当前版本/u);
});

test('文档事实源：历史版本号照写不误报，只拦当前值', async context => {
  // 上一版、下一版、更早的历史版本、以及数字前缀相同但其实是别的版本，都不该报红。
  const base = await fixture(context, {
    native: '9.9.9',
    web: '8.8.8',
    docs: {
      'README.md': `${REFERENCE}\n\n历史：原生 3.4.0（17）、13.9.9.9 与 9.9.90 都不是当前值；Web 1.20.0 / yueqian-v24 也是历史。\n`
    }
  });
  assert.match(await docsTruthCheck(base), /均未出现当前版本 9\.9\.9 \/ 8\.8\.8/u);
});

test('文档事实源：判据跟着版本号动态走，换版本后旧值自动放行、新值自动拦下', async context => {
  const docs = { 'README.md': `${REFERENCE}\n\n原生 9.9.9 与 Web 8.8.8 是当前版本。\n` };
  await assert.rejects(fixture(context, { native: '9.9.9', web: '8.8.8', docs }).then(docsTruthCheck), /出现当前版本|写了当前版本号/u);
  // 同一份文档，版本号往前走了：9.9.9 / 8.8.8 变成历史，检查自动放行，无需改代码。
  const moved = await fixture(context, { native: '10.0.0', web: '9.0.0', docs });
  assert.match(await docsTruthCheck(moved), /均未出现当前版本 10\.0\.0 \/ 9\.0\.0/u);
});

test('文档事实源：读不到版本号或少了 STATUS.md 时给出可读错误，而不是静默通过', async context => {
  const withoutPbx = await fixture(context);
  await fs.rm(path.join(withoutPbx, 'native-app/Yueqian.xcodeproj/project.pbxproj'));
  await assert.rejects(docsTruthCheck(withoutPbx), /读不到当前版本号/u);
  assert.equal((await readVersions(withoutPbx)).native, null);

  // 只缺 STATUS.md（三份文档还在）→ 不能当成「公开发布仓」放过，必须报缺文件。
  const withoutStatus = await fixture(context);
  await fs.rm(path.join(withoutStatus, DOC_TRUTH_SOURCE));
  await assert.rejects(docsTruthCheck(withoutStatus), /前置文件缺失.*STATUS\.md/u);
});

// 3.16.0 第一次推送公开仓时，这条检查让 CI 亮红：公开仓只发布 Web 产物，
// 没有 STATUS.md、没有 project.pbxproj、也没有 NEXT-SESSION.md。
// 判据不成立时应该明确跳过，而不是把发布流程卡死。
test('文档事实源：公开发布仓（三份文档与 STATUS.md 都不在）判为不适用并跳过', async context => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-docs-publish-'));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  // 复刻公开仓最小形态：只有 Web 产物与一个模板生成的 README。
  await fs.mkdir(path.join(base, 'yueqian-training'), { recursive: true });
  await fs.writeFile(path.join(base, 'yueqian-training/index.html'), "<script>var APP_VERSION = '8.8.8';</script>");
  await fs.writeFile(path.join(base, 'yueqian-training/sw.js'), "var CACHE_PREFIX = 'yueqian-';\nvar CACHE = CACHE_PREFIX + 'v88';\n");
  await fs.writeFile(path.join(base, 'README.md'), '# 公开仓\n\nWeb 8.8.8，原生配套内容 9.9.9（1）。\n');

  assert.equal((await docsTruthApplicable(base)).applicable, false);
  const detail = await docsTruthCheck(base);
  assert.match(detail, /不适用/u);
  // 关键：不适用时**不抛错**，也不去读那些不存在的文件。
  assert.match(detail, /公开发布仓/u);
  // 三份文档一份都不在，所以即便 README 里写了当前版本号也不该报错。
  assert.match(await docsTruthCheck(base), /不适用/u);
});

test('文档事实源：只缺一部分文档时报缺失，不静默降级', async context => {
  const base = await fixture(context);
  await fs.rm(path.join(base, 'NEXT-SESSION.md'));
  await assert.rejects(docsTruthCheck(base), /前置文件缺失.*NEXT-SESSION\.md/u);
});

test('文档事实源：真实仓库当前通过（三份文档已收口到 STATUS.md）', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // 这条测试要同时在两种工作副本里成立：源码仓（全套文件）与公开发布仓（只有 Web 产物）。
  // 曾经因为默认「这里是源码仓」，在发布仓 CI 上抛 `Cannot read properties of null`。
  const { applicable } = await docsTruthApplicable(root);
  const detail = await docsTruthCheck(root);
  if (!applicable) {
    assert.match(detail, /不适用/u, '发布仓应返回「不适用」而不是抛错');
    return;
  }
  const versions = await readVersions(root);
  const native = versions.native?.marketing?.[0];
  assert.ok(native, '源码仓应读得到原生 MARKETING_VERSION');
  assert.match(detail, new RegExp(`均未出现当前版本 ${native.replace(/\./gu, '\\.')} / ${versions.webVersion.replace(/\./gu, '\\.')}`, 'u'));
});
