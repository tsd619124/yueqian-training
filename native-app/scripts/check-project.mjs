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
for (const source of sources) {
  if (/\b(WKWebView|UIWebView|JavaScriptCore)\b/.test(fs.readFileSync(source, 'utf8'))) throw new Error('原生视图中不应嵌入网页运行时。');
}
console.log(`工程静态检查通过：${sources.length} 个 Swift 源文件，资源引用和原生图标完整。`);
