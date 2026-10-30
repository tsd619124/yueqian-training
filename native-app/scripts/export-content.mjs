import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(appDirectory, '../yueqian-training/index.html');
const destination = path.join(appDirectory, 'Sources/YueqianCore/Resources/catalog.json');
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('var LVW=');
const end = source.indexOf('function md(s)', start);
if (start < 0 || end <= start) throw new Error('原有课程数据的边界发生变化，请检查后再迁移。');
const context = vm.createContext(Object.create(null));
vm.runInContext(source.slice(start, end), context, { timeout: 1000 });
const payload = {
  schemaVersion: 1,
  sourceVersion: source.match(/var APP_VERSION='([^']+)'/)[1],
  sourceSHA256: crypto.createHash('sha256').update(source.slice(start, end)).digest('hex'),
  levels: context.LVW,
  stages: context.STAGES,
  tracks: context.TRACKS,
  modules: context.MODS,
  dailyPrompts: context.DAILY,
  phases: context.PHASES,
  projects: context.PROJECTS,
  interviewQuestions: context.QA,
  quizzes: context.QUIZ,
  lessons: context.LESSONS,
  references: context.REFS,
  skillLessons: context.SKILL_LESSON,
  entries: context.LEARN_ENTRIES,
  taskLabels: context.TASK_LABELS,
  relatedGoals: context.RELATED_GOALS
};
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
    throw new Error('原生教材与当前 HTML 内容不一致，请重新运行迁移脚本。');
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
