/** 源码与打包产物共享固定运行组件路径，网页不能指定其它脚本。 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkBuddyFailure } from './executable.ts';
export function nativeWorker(): string {
  const folder = dirname(fileURLToPath(import.meta.url));
  const worker = [
    resolve(folder, '../runtime/workbuddy-native.cjs'),
    resolve(folder, '../../../runtime/workbuddy-native.cjs'),
  ].find((file) => existsSync(file));
  if (!worker) throw new WorkBuddyFailure('WorkBuddy 接入组件缺失，请重新解压完整程序。');
  return worker;
}
