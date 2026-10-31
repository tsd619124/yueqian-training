import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 课程内容自 Web 1.15.0 起单独存放在 yueqian-training/content/course.json，结构与原生 catalog.json 相同。
// sourceVersion / sourceSHA256 记录课程内容最后一次变化时的 Web 版本与内容指纹，只在课程内容变化时更新，
// 与 Web 的 APP_VERSION 无关：只改 Web 外壳不会让原生教材变化。
const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(appDirectory, '../yueqian-training/content/course.json');
const destination = path.join(appDirectory, 'Sources/YueqianCore/Resources/catalog.json');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const fields = ['levels', 'stages', 'tracks', 'modules', 'dailyPrompts', 'phases', 'projects', 'interviewQuestions', 'quizzes', 'lessons', 'references', 'skillLessons', 'entries', 'taskLabels', 'relatedGoals'];
if (source.schemaVersion !== 1 || typeof source.sourceVersion !== 'string' || !/^[0-9a-f]{64}$/.test(source.sourceSHA256 ?? '')) {
  throw new Error('课程内容文件的版本信息缺失或格式不对，请检查 content/course.json。');
}
for (const field of fields) if (source[field] === undefined) throw new Error(`课程内容缺少字段：${field}`);
const payload = { schemaVersion: 1, sourceVersion: source.sourceVersion, sourceSHA256: source.sourceSHA256 };
for (const field of fields) payload[field] = source[field];
if (new Set(payload.entries.map(entry => entry.id)).size !== Object.keys(payload.lessons).length) {
  throw new Error('学习入口与教材数量不一致，迁移已停止。');
}
for (const entry of payload.entries) {
  if (!payload.lessons[entry.id]) throw new Error(`教材缺失：${entry.id}`);
}
const json = JSON.stringify(payload, null, 2) + '\n';
const images = ['training-receipt.png', 'training-receipt-obscured.png'];
for (const image of images) {
  const sourceImage = path.resolve(appDirectory, '../yueqian-training', image);
  const targetImage = path.join(path.dirname(destination), image);
  const data = fs.readFileSync(sourceImage);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(targetImage) || !data.equals(fs.readFileSync(targetImage))) {
      throw new Error(`原生练习图片与 Web 不一致：${image}`);
    }
  } else {
    fs.copyFileSync(sourceImage, targetImage);
  }
}
if (process.argv.includes('--check')) {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== json) {
    throw new Error('原生教材与 content/course.json 不一致，请重新运行迁移脚本。');
  }
} else {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, json);
}
console.log(JSON.stringify({
  sourceVersion: payload.sourceVersion,
  lessons: Object.keys(payload.lessons).length,
  materials: Object.values(payload.lessons).reduce((total, lesson) => total + lesson.mat.length, 0),
  questions: Object.values(payload.quizzes).reduce((total, questions) => total + questions.length, 0),
  status: process.argv.includes('--check') ? '一致' : '已迁移'
}, null, 2));
