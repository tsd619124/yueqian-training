// 更新已核准图文（新增一篇也用它）：按 yueqian-training/external-catalog.js 从来源仓库 main 的最新提交
// 下载全部原文、原图与许可，完整校验后构建新版本，写入 output/content-pipeline，
// 再导出到 Web content-library/ 与 iOS ContentLibrary/。任一步失败都保留现有资料。
//   node native-app/scripts/update-external-materials.mjs          下载并导出
//   node native-app/scripts/update-external-materials.mjs --check  只校验现有资料库与原文目录一致（不联网）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRelease, readLibrarySnapshot, validateRegistry, writeRelease } from '../../content-pipeline/lib.mjs';
import { exportClientContent } from '../../content-pipeline/client-content.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'yueqian-training');
const argumentsList = process.argv.slice(2);
if (argumentsList.some(argument => argument !== '--check')) throw new Error('只支持 --check 参数。');
await import(pathToFileURL(path.join(web, 'external-catalog.js')));
await import(pathToFileURL(path.join(web, 'external-materials.js')));
const catalog = globalThis.YUEQIAN_EXTERNAL_CATALOG;
const materials = globalThis.YueqianMaterials;
const imageCount = snapshot => snapshot.articles.reduce((total, article) => total + article.images.length, 0);

if (argumentsList.includes('--check')) {
  const snapshot = await materials.validateSnapshot(await readLibrarySnapshot(), catalog);
  console.log(JSON.stringify({ status: '资料库原文、原图哈希与原文目录一致', articles: snapshot.articles.length, images: imageCount(snapshot), revision: snapshot.revision }, null, 2));
} else {
  const current = await readLibrarySnapshot().catch(() => null);
  const sameCatalog = current && current.articles.length === catalog.articles.length && current.articles.every((article, index) => article.id === catalog.articles[index].id && article.path === catalog.articles[index].path && article.title === catalog.articles[index].title && JSON.stringify(article.lessonIDs) === JSON.stringify(catalog.articles[index].lessonIDs));
  // 原文目录有变化（新增、改标题或课程关联）时必须重新下载；否则来源未更新则直接返回。
  const snapshot = await materials.downloadSnapshot(catalog, sameCatalog ? current : null, fetch, message => process.stdout.write(message + '\n'));
  if (snapshot === current) { console.log(JSON.stringify({ status: '来源仓库没有新提交，资料保持不变', revision: current.revision }, null, 2)); process.exit(0); }
  const registry = validateRegistry(JSON.parse(fs.readFileSync(path.join(root, 'content-pipeline/sources.json'), 'utf8')));
  const topics = JSON.parse(fs.readFileSync(path.join(root, 'content-pipeline/topics.json'), 'utf8'));
  const output = path.join(root, 'output/content-pipeline');
  const bundle = buildRelease(snapshot, registry, topics);
  await writeRelease(output, bundle);
  const exported = await exportClientContent(output, { webDirectory: web, nativeLibraryDirectory: path.join(root, 'native-app/Sources/YueqianCore/Resources/ContentLibrary') });
  const notices = 'Microsoft Generative AI for Beginners\nhttps://github.com/' + snapshot.repository + '\nRevision: ' + snapshot.revision + '\nRetrieved: ' + snapshot.fetchedAt + '\n\nThe included Chinese translation and original images are downloaded from the source repository. The original Markdown is retained in the content library.\n\n' + snapshot.licenseText + '\n';
  fs.writeFileSync(path.join(web, 'THIRD_PARTY_NOTICES.txt'), notices);
  console.log(JSON.stringify({ status: '已下载并导出新资料版本，未部署', articles: snapshot.articles.length, images: imageCount(snapshot), revision: snapshot.revision, releaseID: exported.releaseID, bytes: exported.bytes }, null, 2));
}
