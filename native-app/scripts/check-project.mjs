import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(root, 'Yueqian.xcodeproj/project.pbxproj')], { encoding: 'utf8' }));
const objects = project.objects;
if (objects[project.rootObject]?.isa !== 'PBXProject') throw new Error('Xcode 项目根节点无效。');
function inspect(value) {
  if (typeof value === 'string' && /^A[0-9A-F]{23}$/.test(value) && !objects[value]) throw new Error(`Xcode 引用缺失：${value}`);
  if (Array.isArray(value)) value.forEach(inspect);
  else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
}
inspect(objects);
for (const file of ['iOS/YueqianApp.swift', 'iOS/Info.plist', 'iOS/PrivacyInfo.xcprivacy', 'Package.swift', 'Yueqian.xcodeproj/xcshareddata/xcschemes/Yueqian.xcscheme']) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`工程文件缺失：${file}`);
}
const iconFolder = path.join(root, 'iOS/Assets.xcassets/AppIcon.appiconset');
const icons = JSON.parse(fs.readFileSync(path.join(iconFolder, 'Contents.json'), 'utf8'));
const icon = fs.readFileSync(path.join(iconFolder, icons.images[0].filename));
if (icon.toString('hex', 0, 8) !== '89504e470d0a1a0a' || icon.readUInt32BE(16) !== 1024 || icon.readUInt32BE(20) !== 1024 || icon[25] !== 2) {
  throw new Error('App 图标必须是 1024×1024、不带透明通道的 PNG。');
}
execFileSync('swift', [path.join(root, 'scripts/make-icon.swift'), '--check'], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts/update-external-materials.mjs'), '--check'], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts/export-content-release.mjs'), '--check'], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts/export-content.mjs'), '--check'], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts/verify-content-kit.mjs')], { stdio: ['ignore', 'ignore', 'inherit'] });
const sources = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(fullPath);
    else if (entry.name.endsWith('.swift')) sources.push(fullPath);
  }
}
visit(path.join(root, 'Sources'));
// 值路由防复发（3.7.0 的「点了没反应」）：destination 只在标签栏根视图注册，
// 而从「目的地闭包」push 进来的二级页面里，值路由在当前 iOS 上不解析目的地——
// 点击行会高亮、事件被消费，但不 push 新页面。所以 Sources 内不允许再出现值路由。
const valueRoute = /NavigationLink\s*\(\s*(?:"(?:[^"\\]|\\.)*"\s*,\s*)?value\s*:/;
for (const source of sources) {
  const text = fs.readFileSync(source, 'utf8');
  if (/\b(WKWebView|UIWebView|JavaScriptCore)\b/.test(text)) throw new Error('原生视图中不应嵌入网页运行时。');
  // 整行注释里提到旧写法是允许的（本检查的文案就要讲清楚怎么改），行号保持不变。
  const scanned = text.split('\n').map((line) => (line.trimStart().startsWith('//') ? '' : line)).join('\n');
  const match = valueRoute.exec(scanned);
  if (match) {
    const line = scanned.slice(0, match.index).split('\n').length;
    throw new Error(
      `${path.relative(root, source)}:${line} 不允许用值路由 NavigationLink(value:)。` +
        '原因：二级页面是用「目的地闭包」从上一级 push 进来的，这种页面里的值路由在当前 iOS 上不解析目的地——' +
        '点击只高亮、不跳转，用户看到的就是「点了没反应」。' +
        '改法：写成 NavigationLink { RouteView(route: 路由值) } label: { … }（title 形式写成 label: { Text("标题") }）；' +
        'AppRoute → 目的地的映射只在 Sources/YueqianUI/Components.swift 的 RouteView 里维护一份。'
    );
  }
}
console.log(`工程静态检查通过：${sources.length} 个 Swift 源文件，资源引用和原生图标完整，无值路由 NavigationLink。`);
