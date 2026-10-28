import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportClientContent } from '../../content-pipeline/client-content.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argumentsList = process.argv.slice(2);
if (argumentsList.some(argument => argument !== '--check')) throw new Error('只支持 --check 参数。');
console.log(JSON.stringify(await exportClientContent(path.join(root, 'output/content-pipeline'), {
  webDirectory: path.join(root, 'yueqian-training'),
  nativeSeedPath: path.join(root, 'native-app/Sources/YueqianCore/Resources/content-release.json'),
  check: argumentsList.includes('--check')
}), null, 2));
