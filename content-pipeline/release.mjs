// 一键发布编排（Node 24，无依赖）。默认全部为演练，不推送、不安装。
//   node content-pipeline/release.mjs check [--ci] [--report <文件>] [--only=<项>] [--skip=<项>]
//                                         全部构建、导出、一致性检查与 Node 测试；--only/--skip 按项或分组取子集
//   node content-pipeline/release.mjs web [--push [--watch]] [--skip-check] [--clone <目录>]
//                                         同步白名单文件到公开仓库克隆；不带 --push 只在临时副本中演练
//   node content-pipeline/release.mjs ios [--install] [--skip-swift-test] 原生检查 + swift test + 同步到重签名源码目录
//   node content-pipeline/release.mjs version [--tags]                   显示 Web / 原生版本（可选附带已有 tag）
//   node content-pipeline/release.mjs bump [--web 1.15.0] [--native 2.6.0]   改版本号（CACHE 与构建号自动加 1）
//   node content-pipeline/release.mjs tag [--list] [--web] [--force] [--push] [--allow-dirty]
//                                         给当前提交打附注 tag（默认 v<原生版本>，v3.12.0 这类）；不带 --push 只打本地 tag
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'yueqian-training');
const pbxproj = path.join(root, 'native-app/Yueqian.xcodeproj/project.pbxproj');
const siteURL = 'https://tsd619124.github.io/yueqian-training/';
const resignSource = path.join(os.homedir(), 'Library/Application Support/YueqianResign/source');
const node = process.execPath;
const argumentsList = process.argv.slice(2);
const command = argumentsList.shift();
const flag = name => { const index = argumentsList.indexOf(name); if (index < 0) return false; argumentsList.splice(index, 1); return true; };
// 既接受 `--name 值`，也接受 `--name=值`（CI 里 `--only=web` 这种写法更好读）。
function option(name) {
  const equals = argumentsList.find(item => item.startsWith(name + '='));
  if (equals) {
    argumentsList.splice(argumentsList.indexOf(equals), 1);
    const value = equals.slice(name.length + 1);
    if (!value) throw new Error(name + ' 后需要参数。');
    return value;
  }
  const index = argumentsList.indexOf(name);
  if (index < 0) return null;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw new Error(name + ' 后需要参数。');
  argumentsList.splice(index, 2);
  return value;
}
const exists = file => fs.stat(file).then(() => true, () => false);
const relative = file => path.relative(root, file) || '.';

// ---------- 版本号：唯一来源为 index.html APP_VERSION、sw.js CACHE 与 project.pbxproj ----------
export async function readVersions() {
  const index = await fs.readFile(path.join(web, 'index.html'), 'utf8');
  const worker = await fs.readFile(path.join(web, 'sw.js'), 'utf8');
  const webVersion = /\bvar\s+APP_VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'/u.exec(index)?.[1] || null;
  const cacheMatch = /\bvar\s+CACHE\s*=\s*(CACHE_PREFIX\s*\+\s*)?'([^']+)'/u.exec(worker);
  const cache = cacheMatch ? (cacheMatch[1] ? /\bvar\s+CACHE_PREFIX\s*=\s*'([^']+)'/u.exec(worker)?.[1] || '' : '') + cacheMatch[2] : null;
  let versionFile = null;
  if (await exists(path.join(web, 'version.json'))) {
    const value = JSON.parse(await fs.readFile(path.join(web, 'version.json'), 'utf8'));
    versionFile = value.version ?? value.appVersion ?? value.webVersion ?? null;
  }
  let native = null;
  if (await exists(pbxproj)) {
    const project = await fs.readFile(pbxproj, 'utf8');
    const marketing = [...new Set([...project.matchAll(/MARKETING_VERSION = ([0-9.]+);/gu)].map(match => match[1]))];
    const builds = [...new Set([...project.matchAll(/CURRENT_PROJECT_VERSION = ([0-9]+);/gu)].map(match => match[1]))];
    native = { marketing, builds };
  }
  return { webVersion, cache, versionFile, native };
}

async function versionCheck() {
  const versions = await readVersions();
  const problems = [];
  if (!versions.webVersion) problems.push('index.html 缺少 APP_VERSION');
  if (!versions.cache) problems.push('sw.js 缺少 CACHE');
  if (versions.versionFile !== null && versions.versionFile !== versions.webVersion) problems.push(`version.json (${versions.versionFile}) 与 APP_VERSION (${versions.webVersion}) 不一致`);
  if (versions.native && (versions.native.marketing.length !== 1 || versions.native.builds.length !== 1)) problems.push('project.pbxproj 中 MARKETING_VERSION / CURRENT_PROJECT_VERSION 不唯一');
  if (problems.length) throw new Error(problems.join('；'));
  return `Web ${versions.webVersion} / ${versions.cache}${versions.versionFile ? ' / version.json' : ''}` + (versions.native ? ` · 原生 ${versions.native.marketing[0]}（${versions.native.builds[0]}）` : '');
}

async function bump(webVersion, nativeVersion) {
  const pattern = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
  if (!webVersion && !nativeVersion) throw new Error('用法：release.mjs bump [--web x.y.z] [--native x.y.z]');
  const changes = [];
  if (webVersion) {
    if (!pattern.test(webVersion)) throw new Error('--web 需为 x.y.z。');
    const indexPath = path.join(web, 'index.html');
    const index = await fs.readFile(indexPath, 'utf8');
    if (!/\bvar\s+APP_VERSION\s*=\s*'[^']+'/u.test(index)) throw new Error('index.html 缺少 APP_VERSION。');
    await fs.writeFile(indexPath, index.replace(/(\bvar\s+APP_VERSION\s*=\s*')[^']+(')/u, `$1${webVersion}$2`));
    const workerPath = path.join(web, 'sw.js');
    const worker = await fs.readFile(workerPath, 'utf8');
    let cache = null;
    const updated = worker.replace(/(\bvar\s+CACHE\s*=\s*(?:CACHE_PREFIX\s*\+\s*)?')([^']*?)([0-9]+)(')/u, (_, start, prefix, number, end) => { cache = prefix + (Number(number) + 1); return start + cache + end; });
    if (!cache) throw new Error('sw.js 的 CACHE 不以数字结尾，无法自动递增。');
    await fs.writeFile(workerPath, updated);
    changes.push(`APP_VERSION → ${webVersion}`, `CACHE → ${cache}`);
    const versionPath = path.join(web, 'version.json');
    if (await exists(versionPath)) {
      const value = JSON.parse(await fs.readFile(versionPath, 'utf8'));
      const key = ['version', 'appVersion', 'webVersion'].find(name => name in value) || 'version';
      value[key] = webVersion;
      if ('cache' in value) value.cache = (/CACHE_PREFIX\s*=\s*'([^']+)'/u.exec(updated)?.[1] || '') + cache;
      await fs.writeFile(versionPath, JSON.stringify(value, null, 2) + '\n');
      changes.push(`version.json → ${webVersion}`);
    }
  }
  if (nativeVersion) {
    if (!pattern.test(nativeVersion)) throw new Error('--native 需为 x.y.z。');
    const project = await fs.readFile(pbxproj, 'utf8');
    const builds = [...new Set([...project.matchAll(/CURRENT_PROJECT_VERSION = ([0-9]+);/gu)].map(match => Number(match[1])))];
    if (builds.length !== 1) throw new Error('CURRENT_PROJECT_VERSION 不唯一，先手工统一。');
    const build = builds[0] + 1;
    await fs.writeFile(pbxproj, project.replace(/MARKETING_VERSION = [0-9.]+;/gu, `MARKETING_VERSION = ${nativeVersion};`).replace(/CURRENT_PROJECT_VERSION = [0-9]+;/gu, `CURRENT_PROJECT_VERSION = ${build};`));
    changes.push(`MARKETING_VERSION → ${nativeVersion}`, `CURRENT_PROJECT_VERSION → ${build}`);
  }
  console.log('已更新：' + changes.join('；') + '。记得同步更新 App 内更新日志。');
}

// ---------- tag：给当前提交打附注 tag ----------
// 命名规则（本项目只此一套，别处不要自创）：
//   v<原生 MARKETING_VERSION>          发布原生 App 版本时用，例如 v3.12.0。默认就是这一种。
//   v<原生版本>-b<构建号>               同一个 MARKETING_VERSION 需要区分构建号时才用，例如 v3.12.0-b26。
//   web-v<Web APP_VERSION>             只发布 Web、不动原生版本时才用，例如 web-v1.21.0。
//   带 --web 时同时打 v<native> 与 web-v<web> 两个 tag；单独用 --web-version 只打 Web 那个。
// 约定：tag 只能由本命令创建，且必须指向「版本号已经写进代码」的那个提交。
// 历史 13 份 RELEASE-*.md 没有可靠的回填依据，本命令不回填旧版本。
function gitTag(args, options = {}) {
  try {
    return { ok: true, output: execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim() };
  } catch (error) {
    const stderr = (error.stderr ?? '').toString().trim();
    const stdout = (error.stdout ?? '').toString().trim();
    return { ok: false, code: error.status ?? 1, output: stderr || stdout || error.message };
  }
}

async function currentTags() {
  const listed = gitTag(['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)\t%(objectname:short)\t%(taggerdate:short)\t%(subject)', 'refs/tags']);
  if (!listed.ok) throw new Error('读取 tag 列表失败：' + listed.output);
  return listed.output ? listed.output.split('\n').map(line => { const [name, commit, date, subject] = line.split('\t'); return { name, commit, date, subject }; }) : [];
}

function printTags(tags) {
  if (!tags.length) { console.log('当前没有任何 tag。'); return; }
  console.log(`共 ${tags.length} 个 tag（新的在前）：`);
  for (const tag of tags) console.log(`  ${tag.name}  ${tag.commit}  ${tag.date ?? ''}  ${tag.subject ?? ''}`.trimEnd());
}

// 目标 tag 名与它应当指向的版本号。
//   --web-version 只打 web-v<x>；--web 打 v<原生> 和 web-v<x> 两个；--native 把构建号也带上；默认只打 v<原生>。
async function tagTargets({ web, native, webVersion }) {
  const versions = await readVersions();
  const webTarget = () => {
    if (!versions.webVersion) throw new Error('index.html 缺少 APP_VERSION，无法打 Web tag。');
    return { name: 'web-v' + versions.webVersion, version: versions.webVersion, kind: 'Web APP_VERSION（index.html）' };
  };
  if (webVersion) return [webTarget()];
  if (!versions.native) throw new Error('找不到 native-app/Yueqian.xcodeproj/project.pbxproj，无法读取原生版本。');
  if (versions.native.marketing.length !== 1) throw new Error('MARKETING_VERSION 不唯一（' + versions.native.marketing.join(' / ') + '），先统一再打 tag。');
  const build = versions.native.builds[0];
  const targets = [{
    name: native ? `v${versions.native.marketing[0]}-b${build ?? '?'}` : 'v' + versions.native.marketing[0],
    version: versions.native.marketing[0],
    kind: native ? `原生 ${versions.native.marketing[0]}（构建 ${build}）` : '原生 MARKETING_VERSION'
  }];
  if (web) targets.push(webTarget());
  return targets;
}

async function tag({ list, web, native, webVersionOnly, force, push, allowDirty }) {
  if (list) { printTags(await currentTags()); return; }
  const targets = await tagTargets({ web, native, webVersion: webVersionOnly });
  const head = gitTag(['rev-parse', '--short', 'HEAD']);
  if (!head.ok) throw new Error('不在 Git 仓库内或仓库损坏：' + head.output);
  const branch = gitTag(['rev-parse', '--abbrev-ref', 'HEAD']);

  // 有未提交改动时打 tag，tag 会指向「不包含这些改动」的提交，事后极易误判版本内容，所以默认拒绝。
  if (!allowDirty) {
    const status = gitTag(['status', '--porcelain']);
    if (!status.ok) throw new Error('git status 失败：' + status.output);
    if (status.output) {
      throw new Error('工作区不干净，拒绝打 tag（tag 会指向不含这些改动的提交）：\n' + status.output
        + '\n先提交或 stash，确认这些改动不该进版本再加 --allow-dirty。');
    }
  } else if (gitTag(['status', '--porcelain']).output) {
    console.log('注意：--allow-dirty 已生效，tag 指向的提交不包含当前未提交改动。');
  }

  // --push 先确认远端存在，避免「本地 tag 已建好、推的时候才发现没有远端」的半成品状态。
  if (push) {
    const remote = gitTag(['remote']);
    if (!remote.ok || !remote.output) throw new Error('没有配置远端（git remote 为空），无法 --push。先 git remote add origin <地址>，或去掉 --push 只打本地 tag。');
  }

  const existing = new Map((await currentTags()).map(item => [item.name, item]));
  const versions = await readVersions();
  const webText = versions.webVersion ?? '—';
  const nativeText = versions.native ? `${versions.native.marketing.join(' / ')}（构建 ${versions.native.builds.join(' / ')}）` : '—';
  // 先整体校验再动手：--web 会打两个 tag，若打完第一个才发现第二个已存在，
  // 会留下「一半打了、一半没打」的状态，比直接失败更难收拾。
  if (!force) {
    for (const target of targets) {
      const found = existing.get(target.name);
      if (!found) continue;
      const foundCommit = gitTag(['rev-list', '-n', '1', target.name]);
      throw new Error(`tag ${target.name} 已存在（指向 ${foundCommit.ok ? foundCommit.output.slice(0, 7) : '未知'}）。`
        + '不覆盖：先 git tag -d ' + target.name + ' 再重打；确认要改写历史时加 --force（会移动已有 tag）。');
    }
  }
  for (const target of targets) {
    const text = [
      `发布 ${target.name}`,
      '',
      `版本：${target.version}（来源：${target.kind}）`,
      `Web：${webText}`,
      `原生：${nativeText}`,
      '',
      '由 content-pipeline/release.mjs tag 创建'
    ].join('\n');
    if (existing.has(target.name)) {
      const foundCommit = gitTag(['rev-list', '-n', '1', target.name]);
      console.log(`--force：移动已有 tag ${target.name}（${foundCommit.output.slice(0, 7)} → ${head.output}），这是在改写历史。`);
      const removed = gitTag(['tag', '-d', target.name]);
      if (!removed.ok) throw new Error('删除旧 tag 失败：' + removed.output);
    }
    const created = gitTag(['tag', '-a', target.name, '-m', text, 'HEAD']);
    if (!created.ok) throw new Error(`创建 tag ${target.name} 失败：` + created.output);
    console.log(`已创建附注 tag ${target.name} → ${head.output}${branch.ok ? `（${branch.output}）` : ''}：${target.version}`);
  }
  if (push) {
    for (const target of targets) {
      const pushed = gitTag(['push', 'origin', target.name], { stdio: ['ignore', 'pipe', 'pipe'] });
      if (!pushed.ok) throw new Error(`推送 tag ${target.name} 失败（远端不存在或没有权限）：` + pushed.output + '\n本地 tag 已保留，修好远端后 git push origin ' + target.name);
      console.log(`已推送 ${target.name} → origin。`);
    }
  } else {
    console.log('只在本地打了 tag；接上远端后 git push origin ' + targets.map(item => item.name).join(' ') + ' 或用 --push。');
  }
  printTags(await currentTags());
}

// ---------- 子进程与检查清单 ----------
// 每步有时限（默认 4 分钟），超时结束整个进程组并记为失败，避免某个测试挂起拖住整轮检查。
function run(file, args, { cwd = root, env = {}, quiet = true, timeout = 240000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    const timer = timeout ? setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeout) : null;
    const collect = chunk => { output += chunk; if (!quiet) process.stdout.write(chunk); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => { clearTimeout(timer); resolve({ code: 127, output: output + error.message, ms: Date.now() - started }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: timedOut ? 124 : code, output: timedOut ? output + `\nError: 超过 ${timeout / 1000}s 未结束，已终止` : output, ms: Date.now() - started }); });
  });
}

async function testFiles(directory) {
  return (await fs.readdir(path.join(root, directory)).catch(() => [])).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(directory, name));
}

function summarize(output, failed = false) {
  if (failed) {
    const lines = output.split('\n').map(line => line.trim());
    const error = lines.find(line => /^(?:\w*Error(?: \[\w+\])?:|Error:)/u.test(line) && !/Command failed/u.test(line)) || lines.find(line => /^\s*Error:/u.test(line));
    if (error) return error.replace(/^\w*Error(?: \[\w+\])?:\s*/u, '').slice(0, 100);
  }
  const pass = /ℹ pass (\d+)/u.exec(output)?.[1];
  const fail = /ℹ fail (\d+)/u.exec(output)?.[1];
  if (pass !== undefined) return `${pass} 通过 / ${fail} 失败`;
  const passed = /"passed":\s*(\d+)/u.exec(output)?.[1];
  if (passed) return `${passed} 项通过`;
  const quality = /"questions":\s*(\d+),\s*"cases":\s*(\d+)/u.exec(output);
  if (quality) return `${quality[1]} 题 / ${quality[2]} 案例`;
  const last = output.trim().split('\n').filter(Boolean).pop() || '';
  if (last && !/^[\]}{\[]|^ℹ|^Node\.js/u.test(last.trim())) return last.trim().slice(0, 80);
  const status = /"status":\s*"([^"]+)"/u.exec(output)?.[1];
  if (status) return status;
  return output.trim().split('\n').filter(Boolean).pop()?.slice(0, 80) || '';
}

// 唯一的检查清单：本地 `release.mjs check` 与 CI `release.mjs check --ci` 共用。
//
// 平台分组（供 --only / --skip 使用，--ci 也复用同一套判断）：
//   web      纯 Node 步骤：管线测试、Web 测试、正式图文构建、清单校验、两端资料库、资料客户端、原文排版、站点文件清单。
//            在任何装了 Node 的机器上都能跑，GitHub 的 ubuntu-latest 走的就是这一组。
//   native   Xcode 工程静态检查：依赖 plutil（macOS 专有）与 swift（make-icon.swift 用 AppKit），
//            Linux runner 上必然失败，因此只跑在 macos-latest。
//   local    原作者标注的「仅本地」步骤：内容质量依赖 native-app/training.json，公开仓库只发布 Web 所需文件，
//            所以公开仓库 CI 上它自动跳过；它不是平台限制，macos-latest 上照常跑。
//
// 未指定 --only / --skip 时不改变任何既有行为：仍然跑完整 14 项。
export const CHECK_GROUPS = ['web', 'native', 'local'];

// 步骤名 → 分组。名字必须与 checkList 里的 id 完全一致，写错会在解析参数时直接报错而不是静默跳过。
const CHECK_GROUP_OF = new Map([
  ['管线测试', 'web'],
  ['Web 测试', 'web'],
  ['构建正式图文', 'web'],
  ['校验发布清单', 'web'],
  ['两端资料库一致', 'web'],
  ['资料库对照原文目录', 'web'],
  ['Web 资料客户端', 'web'],
  ['原文排版与下载', 'web'],
  ['原生教材一致', 'web'],
  ['教学套件', 'web'],
  ['内容质量', 'web'],
  ['版本号', 'web'],
  ['站点文件清单', 'web'],
  ['Xcode 工程静态检查', 'native']
]);

// 把 --only=a,b / --skip=a 的值解析成一组步骤名；分组名展开成该组全部步骤。
export function resolveCheckSelection(onlyValue, skipValue) {
  const parse = (value, flagName) => (value ?? '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    if (CHECK_GROUPS.includes(item)) return { group: item, items: [...CHECK_GROUP_OF].filter(([, group]) => group === item).map(([id]) => id) };
    if (CHECK_GROUP_OF.has(item)) return { group: null, items: [item] };
    throw new Error(`${flagName} 不认识「${item}」；可用步骤名：${[...CHECK_GROUP_OF.keys()].join('、')}；可用分组：${CHECK_GROUPS.join('、')}`);
  }).flatMap(entry => entry.items);
  const only = parse(onlyValue, '--only');
  const skip = parse(skipValue, '--skip');
  return { only: only.length ? new Set(only) : null, skip: new Set(skip) };
}

export async function checkList({ ci = false, only = null, skip = new Set() } = {}) {
  const pipelineTests = await testFiles('content-pipeline');
  const webTests = await testFiles('yueqian-training/tests');
  const script = name => ['native-app/scripts/' + name];
  const steps = [
    { id: '管线测试', args: ['--test', '--test-timeout=120000', ...pipelineTests] },
    { id: 'Web 测试', args: webTests.length ? ['--test', '--test-timeout=120000', ...webTests] : null },
    { id: '构建正式图文', args: ['content-pipeline/run.mjs', 'build'] },
    { id: '校验发布清单', args: ['content-pipeline/run.mjs', 'check'], after: '构建正式图文' },
    { id: '两端资料库一致', args: [...script('export-content-release.mjs'), '--check'], after: '构建正式图文' },
    { id: '资料库对照原文目录', args: [...script('update-external-materials.mjs'), '--check'] },
    { id: 'Web 资料客户端', args: script('test-content-release.mjs') },
    { id: '原文排版与下载', args: script('test-external-materials.mjs') },
    { id: '原生教材一致', args: [...script('export-content.mjs'), '--check'] },
    { id: '教学套件', args: script('verify-content-kit.mjs') },
    // 内容质量依赖 native-app 的 training.json；公开仓库只发布 Web 所需文件，因此该检查仅本地执行。
    { id: '内容质量', args: script('check-content-quality.mjs'), local: true, after: '教学套件' },
    { id: '版本号', run: versionCheck },
    { id: '站点文件清单', run: async () => { const { readWebRelease } = await import('./production.mjs'); const release = await readWebRelease(web); return `${release.files.length} 个文件，预缓存 ${release.precached.length} 个`; } },
    { id: 'Xcode 工程静态检查', args: script('check-project.mjs'), after: '构建正式图文', local: true }
  ];
  const hasXcode = await exists(pbxproj) && process.platform === 'darwin';
  for (const step of steps) if (step.local && (ci || !hasXcode)) step.skip = ci ? 'CI 跳过（本地检查）' : '无 Xcode 工程';
  for (const step of steps) if (step.args === null) step.skip = '没有测试文件';
  // --only / --skip 的选择结果优先于上面的自动跳过。
  // --only 会把被选中步骤的前置步骤一起带进来（否则「校验发布清单」会在没构建的情况下跑过，等于假绿）。
  if (only) {
    const byId = new Map(steps.map(step => [step.id, step]));
    const queue = [...only];
    while (queue.length) {
      const id = queue.pop();
      const parent = byId.get(id)?.after;
      if (parent && !only.has(parent)) { only.add(parent); queue.push(parent); }
    }
  }
  for (const step of steps) {
    if (only && !only.has(step.id)) { step.skip = '未选中（--only）'; continue; }
    if (skip.has(step.id)) { step.skip = '按 --skip 跳过'; continue; }
    // 显式点名的步骤如果因为环境跑不了（Linux 上没有 plutil、--ci 下的本地检查），保留原因照实跳过，不伪装成通过。
  }
  const results = new Map();
  const pending = new Set(steps.filter(step => !step.skip));
  for (const step of steps) if (step.skip) results.set(step.id, { id: step.id, status: '跳过', ms: 0, detail: step.skip });
  const limit = Math.max(2, Math.min(4, os.availableParallelism?.() || 2));
  const running = new Map();
  while (pending.size || running.size) {
    for (const step of [...pending]) {
      if (running.size >= limit) break;
      if (step.after && !results.has(step.after)) continue;
      pending.delete(step);
      const before = step.after && results.get(step.after);
      // 前置步骤没被选中时，依赖它的步骤也一起跳过：否则「校验发布清单」会在没构建的情况下跑过，等于假绿。
      const blocked = before && (before.status === '失败' ? '前置步骤失败' : before.status === '跳过' ? `前置步骤未执行（${step.after}）` : null);
      const promise = (blocked ? Promise.resolve({ status: '跳过', ms: 0, detail: blocked }) : step.run
        ? (async () => { const started = Date.now(); try { return { status: '通过', detail: await step.run(), ms: Date.now() - started }; } catch (error) { return { status: '失败', detail: error.message, output: error.stack, ms: Date.now() - started }; } })()
        : run(node, step.args).then(result => ({ status: result.code === 0 ? '通过' : '失败', ms: result.ms, detail: summarize(result.output, result.code !== 0), output: result.output, command: 'node ' + step.args.join(' ') }))
      ).then(result => { results.set(step.id, { id: step.id, ...result }); running.delete(step.id); });
      running.set(step.id, promise);
    }
    if (running.size) await Promise.race(running.values());
  }
  return steps.map(step => results.get(step.id));
}

function printTable(rows) {
  const width = value => [...String(value)].reduce((total, character) => total + (/[ᄀ-￿]/u.test(character) ? 2 : 1), 0);
  const pad = (value, size) => String(value) + ' '.repeat(Math.max(0, size - width(value)));
  const name = Math.max(...rows.map(row => width(row.id)), 4) + 2;
  console.log(pad('步骤', name) + pad('结果', 6) + pad('用时', 8) + '说明');
  for (const row of rows) console.log(pad(row.id, name) + pad(row.status, 6) + pad((row.ms / 1000).toFixed(1) + 's', 8) + (row.detail || ''));
  for (const row of rows.filter(item => item.status === '失败')) {
    console.log(`\n—— ${row.id} 失败${row.command ? '（' + row.command + '）' : ''}，输出末尾：`);
    console.log((row.output || row.detail || '').trim().split('\n').slice(-25).join('\n'));
  }
}

async function check({ ci, report, only = null, skip = new Set() }) {
  const started = Date.now();
  const rows = await checkList({ ci, only, skip });
  printTable(rows);
  const failed = rows.filter(row => row.status === '失败');
  console.log(`\n${failed.length ? '✗' : '✓'} ${rows.length} 项检查，${rows.filter(row => row.status === '通过').length} 通过，${failed.length} 失败，${rows.filter(row => row.status === '跳过').length} 跳过；总用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (report) await fs.writeFile(path.resolve(report), JSON.stringify({ generatedAt: new Date().toISOString(), ci, only: only ? [...only] : null, skip: [...skip], rows: rows.map(({ output, ...row }) => row) }, null, 2) + '\n');
  return failed.length === 0;
}

// ---------- Web：白名单同步到公开仓库克隆 ----------
const ignoredName = name => name === '.DS_Store' || name.endsWith('.tmp') || name.startsWith('.content-library-') || name.includes('.previous-');
async function walk(directory, prefix = '') {
  const found = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true }).catch(() => [])) {
    if (ignoredName(entry.name)) continue;
    const name = prefix + entry.name;
    if (entry.isDirectory()) found.push(...await walk(directory, name + '/'));
    else if (entry.isFile()) found.push(name);
  }
  return found;
}

// 公开仓库白名单：Web 源码（含测试）、管线代码与契约、原生跨端检查脚本与资源。内部验收记录、原生完整源码、日志与输出不公开。
export async function publicFiles() {
  const files = new Map();
  const add = async name => files.set(name, await fs.readFile(path.join(root, name)));
  for (const name of await walk(web)) {
    if (name.startsWith('content-library/search/')) continue;
    if (name.split('/').some(part => part.startsWith('.')) && name !== 'content-library/.generated.json') continue;
    await add('yueqian-training/' + name);
  }
  for (const name of await walk(path.join(root, 'content-pipeline'))) {
    if (/^[^/]+\.mjs$/u.test(name) || ['sources.json', 'topics.json', 'STATIC-SEARCH-INDEX.md', 'BUNDLED-CONTENT-LIBRARY.md'].includes(name) || name.startsWith('fixtures/') || name.startsWith('deployment/')) await add('content-pipeline/' + name);
  }
  for (const name of await walk(path.join(root, 'native-app/scripts'))) if (/^[^/]+\.mjs$/u.test(name)) await add('native-app/scripts/' + name);
  const resources = 'native-app/Sources/YueqianCore/Resources/';
  for (const name of await walk(path.join(root, resources))) if (name === 'catalog.json' || /^[^/]+\.png$/u.test(name) || name.startsWith('ContentLibrary/')) await add(resources + name);
  const versions = await readVersions();
  const latest = JSON.parse(await fs.readFile(path.join(web, 'content-library/latest.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(web, 'content-library', latest.manifestPath), 'utf8'));
  let readme = await fs.readFile(path.join(root, 'content-pipeline/deployment/PUBLIC-README.md'), 'utf8');
  readme = readme.replace(/^Web [0-9.]+，原生配套内容 [0-9.]+（[0-9]+）。/mu, `Web ${versions.webVersion}，原生配套内容 ${versions.native?.marketing[0] ?? '—'}（${versions.native?.builds[0] ?? '—'}）。`)
    .replace(/[0-9]+ 篇已核准原文、[0-9]+ 张原图/u, `${manifest.documents.length} 篇已核准原文、${manifest.assetCount} 张原图`);
  files.set('README.md', Buffer.from(readme));
  files.set('.github/workflows/publish.yml', await fs.readFile(path.join(root, 'content-pipeline/deployment/publish.yml')));
  return files;
}

const secretPatterns = [
  [/gh[pousr]_[A-Za-z0-9]{36,}/u, 'GitHub token'], [/github_pat_[A-Za-z0-9_]{40,}/u, 'GitHub fine-grained token'],
  [/AKIA[0-9A-Z]{16}/u, 'AWS key'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, '私钥'], [/xox[abpr]-[A-Za-z0-9-]{10,}/u, 'Slack token'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/u, 'API key (sk-)'], [/\bAIza[0-9A-Za-z_-]{35}\b/u, 'Google API key'],
  [/(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{20,}["']/iu, '疑似硬编码凭据'],
  [/\/Users\/[a-z0-9_-]+\//u, '本机绝对路径'],
  // 拼接构造，避免本文件自身命中
  [new RegExp(['DEVELOPMENT', 'TEAM'].join('_') + '|\\.' + 'mobileprovision|\\.' + 'p12\\b', 'u'), '签名信息']
];
export function scanSecrets(name, bytes) {
  if (/\.(png|jpe?g|webp|ico)$/iu.test(name) || bytes.includes(0)) return [];
  const text = bytes.toString('utf8');
  return secretPatterns.filter(([pattern]) => pattern.test(text)).map(([, label]) => `${name}: ${label}`);
}

function git(cwd, args, options = {}) { return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }); }

function changelogFor(version, sources) {
  for (const text of sources) {
    const literal = new RegExp(`\\{\\s*v\\s*:\\s*'${version.replace(/\./gu, '\\.')}'[^}]*?items\\s*:\\s*\\[([\\s\\S]*?)\\]\\s*\\}`, 'u').exec(text);
    if (literal) return [...literal[1].matchAll(/'((?:[^'\\]|\\.)*)'/gu)].map(match => match[1]);
    try {
      const stack = [JSON.parse(text)];
      while (stack.length) {
        const value = stack.pop();
        if (value && typeof value === 'object') {
          if ((value.v === version || value.version === version) && Array.isArray(value.items)) return value.items.map(String);
          stack.push(...Object.values(value));
        }
      }
    } catch { /* 不是 JSON */ }
  }
  return [];
}

async function commitMessage(webVersion) {
  const sources = [];
  for (const name of ['app.js', 'index.html']) if (await exists(path.join(web, name))) sources.push(await fs.readFile(path.join(web, name), 'utf8'));
  for (const name of await walk(path.join(web, 'content'))) if (name.endsWith('.json')) sources.push(await fs.readFile(path.join(web, 'content', name), 'utf8'));
  const items = changelogFor(webVersion, sources);
  const title = items.length ? '：' + items[0].split(/[，；。]/u)[0].slice(0, 40) : '';
  return `发布 Web ${webVersion}${title}\n\n${items.map(item => '- ' + item).join('\n') || '- 资料与站点更新'}\n\nCo-Authored-By: DeepSeek Harness <noreply@deepseek.com>\n`;
}

async function syncInto(target, files) {
  const present = git(target, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const preserved = new Set(['.gitignore']);
  let removed = 0; let written = 0;
  for (const name of present) if (!files.has(name) && !preserved.has(name)) { await fs.rm(path.join(target, name), { force: true }); removed++; }
  for (const [name, bytes] of files) {
    const destination = path.join(target, name);
    const current = await fs.readFile(destination).catch(() => null);
    if (current?.equals(bytes)) continue;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes); written++;
  }
  git(target, ['add', '-A']);
  return { removed, written };
}

async function verifyLive(expected) {
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const latest = await (await fetch(new URL('content-library/latest.json', siteURL), { cache: 'no-store' })).json();
      const index = await (await fetch(new URL('index.html', siteURL), { cache: 'no-store' })).text();
      const version = /\bvar\s+APP_VERSION\s*=\s*'([^']+)'/u.exec(index)?.[1];
      if (latest.releaseID === expected.releaseID && version === expected.webVersion) return `线上 Web ${version}，资料 ${latest.releaseID.slice(0, 12)}`;
      console.log(`第 ${attempt} 次读回：线上 Web ${version}，资料 ${latest.releaseID?.slice(0, 12)}，等待传播…`);
    } catch (error) { console.log(`第 ${attempt} 次读回失败：${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, 20000));
  }
  throw new Error('线上版本未在 4 分钟内更新，请稍后重跑读回或查看 Actions。');
}

async function publishWeb({ push, watch, skipCheck, clone }) {
  if (!skipCheck && !(await check({ ci: false }))) throw new Error('检查未通过，停止发布。');
  const cloneDirectory = path.resolve(root, clone || 'output/stage5-publication');
  if (!(await exists(path.join(cloneDirectory, '.git')))) throw new Error('公开仓库克隆不存在：' + cloneDirectory);
  if (git(cloneDirectory, ['status', '--porcelain']).trim()) throw new Error('公开仓库克隆有未提交改动，先处理：' + cloneDirectory);
  const versions = await readVersions();
  const latest = JSON.parse(await fs.readFile(path.join(web, 'content-library/latest.json'), 'utf8'));
  const files = await publicFiles();
  let target = cloneDirectory;
  let temporary = null;
  if (!push) {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yueqian-publish-dry-'));
    target = path.join(temporary, 'clone');
    git(root, ['clone', '--quiet', '--shared', cloneDirectory, target]);
  } else {
    git(cloneDirectory, ['fetch', '--quiet', 'origin']);
    const behind = Number(git(cloneDirectory, ['rev-list', '--count', 'HEAD..origin/main']).trim());
    if (behind) git(cloneDirectory, ['merge', '--ff-only', '--quiet', 'origin/main']);
  }
  try {
    const { removed, written } = await syncInto(target, files);
    const stat = git(target, ['diff', '--cached', '--stat=120']).trim();
    const short = git(target, ['diff', '--cached', '--shortstat']).trim();
    console.log(`\n公开仓库差异（写入 ${written}、删除 ${removed}）：\n${stat || '（无变化）'}`);
    const changed = git(target, ['diff', '--cached', '--name-only', '-z', '--diff-filter=AM']).split('\0').filter(Boolean);
    const findings = [];
    for (const name of changed) findings.push(...scanSecrets(name, await fs.readFile(path.join(target, name))));
    if (findings.length) throw new Error('发现疑似凭据或本机信息，拒绝发布：\n' + findings.join('\n'));
    const message = await commitMessage(versions.webVersion);
    console.log(`\n凭据扫描：${changed.length} 个新增或修改文件，未发现问题。\n提交说明：\n${message}`);
    if (!push) { console.log(`演练结束：公开仓库克隆未改动（${relative(cloneDirectory)}）。加 --push 提交并推送。`); return { short, stat }; }
    if (!short) { console.log('没有需要提交的变化。'); return { short, stat }; }
    const messageFile = path.join(os.tmpdir(), `yueqian-commit-${process.pid}.txt`);
    await fs.writeFile(messageFile, message);
    try { git(cloneDirectory, ['commit', '--quiet', '-F', messageFile]); } finally { await fs.rm(messageFile, { force: true }); }
    git(cloneDirectory, ['push', '--quiet', 'origin', 'HEAD:main'], { stdio: 'inherit' });
    console.log('已推送：' + git(cloneDirectory, ['log', '--oneline', '-1']).trim());
    if (watch) {
      await new Promise(resolve => setTimeout(resolve, 8000));
      const runID = JSON.parse(execFileSync('gh', ['run', 'list', '--repo', 'tsd619124/yueqian-training', '--workflow', 'publish.yml', '--limit', '1', '--json', 'databaseId'], { encoding: 'utf8' }))[0]?.databaseId;
      if (runID) execFileSync('gh', ['run', 'watch', String(runID), '--repo', 'tsd619124/yueqian-training', '--exit-status'], { stdio: 'inherit' });
      console.log(await verifyLive({ releaseID: latest.releaseID, webVersion: versions.webVersion }));
    }
    return { short, stat };
  } finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
}

// ---------- iOS：原生检查 + swift test + 同步到重签名源码目录 ----------
async function publishIOS({ install, skipSwiftTest }) {
  const native = path.join(root, 'native-app');
  const rows = [];
  for (const [id, file, args, cwd] of [
    ['两端资料库一致', node, ['native-app/scripts/export-content-release.mjs', '--check'], root],
    ['Xcode 工程静态检查', node, ['native-app/scripts/check-project.mjs'], root],
    ...(skipSwiftTest ? [] : [['swift test', 'swift', ['test'], native]])
  ]) {
    const result = await run(file, args, { cwd, timeout: file === 'swift' ? 1800000 : 240000 });
    // `swift test` 会同时打两行汇总：XCTest 侧（本项目没有 XCTest 用例，恒为
    // "Executed 0 tests"）与 swift-testing 侧（"Test run with N tests in M suites passed"）。
    // 必须先取 swift-testing 那一行，否则表格永远显示 0。
    const tests = /Test run with (\d+) tests? in (\d+) suites? (passed|failed)/u.exec(result.output)
      || /Executed (\d+) tests?, with (\d+) failures?/u.exec(result.output);
    rows.push({ id, status: result.code === 0 ? '通过' : '失败', ms: result.ms, detail: tests ? tests[0] : summarize(result.output), output: result.output });
    if (result.code !== 0) break;
  }
  printTable(rows);
  if (rows.some(row => row.status === '失败')) throw new Error('原生检查未通过，停止同步。');
  if (!(await exists(resignSource))) throw new Error('重签名源码目录不存在：' + resignSource);
  const rsync = ['-a', '--delete', '--exclude', '.build/', '--exclude', 'output/', '--exclude', '.DS_Store', '--exclude', 'xcuserdata/', '--exclude', '.swiftpm/', native + '/', resignSource + '/'];
  if (!install) {
    const preview = await run('rsync', ['-n', '-i', ...rsync]);
    const lines = preview.output.trim().split('\n').filter(Boolean);
    console.log(`\n演练：将同步 ${lines.length} 项到 ${resignSource}（rsync -n）：\n` + lines.slice(0, 60).join('\n') + (lines.length > 60 ? `\n… 另有 ${lines.length - 60} 项` : ''));
    console.log('\n加 --install 实际同步并运行 resign-install.sh --force。');
    return;
  }
  const synced = await run('rsync', rsync);
  if (synced.code !== 0) throw new Error('rsync 失败：' + synced.output);
  console.log('已同步原生源码到 ' + resignSource);
  const installer = await run('/bin/zsh', [path.join(path.dirname(resignSource), 'resign-install.sh'), '--force'], { quiet: false, timeout: 0 });
  if (installer.code !== 0) throw new Error('resign-install.sh 失败，退出码 ' + installer.code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (command === 'check') {
      const ci = flag('--ci'); const report = option('--report');
      const onlyValue = option('--only'); const skipValue = option('--skip');
      if (argumentsList.length) throw new Error('未知参数：' + argumentsList.join(' '));
      const { only, skip } = resolveCheckSelection(onlyValue, skipValue);
      process.exitCode = (await check({ ci, report, only, skip })) ? 0 : 1;
    } else if (command === 'web') {
      const push = flag('--push'); const watch = flag('--watch'); const skipCheck = flag('--skip-check'); const clone = option('--clone');
      if (argumentsList.length) throw new Error('未知参数：' + argumentsList.join(' '));
      await publishWeb({ push, watch, skipCheck, clone });
    } else if (command === 'ios') {
      const install = flag('--install'); const skipSwiftTest = flag('--skip-swift-test');
      if (argumentsList.length) throw new Error('未知参数：' + argumentsList.join(' '));
      await publishIOS({ install, skipSwiftTest });
    } else if (command === 'version') {
      const tags = flag('--tags');
      console.log(JSON.stringify(await readVersions(), null, 2));
      if (tags) { console.log('\n已有 tag：'); printTags(await currentTags()); }
    } else if (command === 'bump') {
      const webVersion = option('--web'); const nativeVersion = option('--native');
      if (argumentsList.length) throw new Error('未知参数：' + argumentsList.join(' '));
      await bump(webVersion, nativeVersion);
    } else if (command === 'tag') {
      const list = flag('--list'); const web = flag('--web'); const native = flag('--native');
      const force = flag('--force'); const push = flag('--push'); const allowDirty = flag('--allow-dirty');
      const webVersionOnly = flag('--web-version');
      if (argumentsList.length) throw new Error('未知参数：' + argumentsList.join(' '));
      await tag({ list, web, native, webVersionOnly, force, push, allowDirty });
    } else {
      console.log('用法：node content-pipeline/release.mjs <check [--ci] [--report 文件] [--only=项|分组] [--skip=项|分组] | web [--push] | ios [--install] [--skip-swift-test] | version [--tags] | bump --web x.y.z --native x.y.z | tag [--list] [--web] [--native] [--web-version] [--force] [--push] [--allow-dirty]>');
      process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    console.error('✗ ' + error.message);
    process.exitCode = 1;
  }
}
