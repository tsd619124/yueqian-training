// 从 output/content-pipeline 的已校验版本生成两端随包资料库：
//   Web：yueqian-training/content-library/（随站点发布）
//   iOS：native-app/Sources/YueqianCore/Resources/ContentLibrary/（与 Web 逐字节相同，不含 .generated.json 与 search/）
// --check 只核对，不写文件。原图以独立文件按哈希寻址，不再生成 base64 种子。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportClientContent } from '../../content-pipeline/client-content.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argumentsList = process.argv.slice(2);
if (argumentsList.some(argument => argument !== '--check')) throw new Error('只支持 --check 参数。');
console.log(JSON.stringify(await exportClientContent(path.join(root, 'output/content-pipeline'), {
  webDirectory: path.join(root, 'yueqian-training'),
  nativeLibraryDirectory: path.join(root, 'native-app/Sources/YueqianCore/Resources/ContentLibrary'),
  check: argumentsList.includes('--check')
}), null, 2));
