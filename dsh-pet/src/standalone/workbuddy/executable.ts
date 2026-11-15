/** 国内版 WorkBuddy 本机运行组件；登录解码与云端请求都留在其独立进程内。 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
/** 只允许固定文案离开运行组件，不回显身份或底层异常。 */
export class WorkBuddyFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkBuddyFailure';
  }
}
/** 不经 shell；测试可替换为同协议的独立进程。 */
export interface WorkBuddyCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}
const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
let fuseCache: { file: string; size: number; mtime: number; allowed: boolean } | undefined;
/** 读取 Electron fuse v1 的 RunAsNode 开关，关闭时不能回退到打开桌面应用。 */
export function allowsWorkBuddyNode(file: string): boolean {
  const stat = statSync(file);
  if (fuseCache?.file === file && fuseCache.size === stat.size && fuseCache.mtime === stat.mtimeMs)
    return fuseCache.allowed;
  if (stat.size > 1024 * 1024 * 1024) return false;
  const fd = openSync(file, 'r'),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  let tail = Buffer.alloc(0),
    allowed = false;
  try {
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      const part = Buffer.concat([tail, buffer.subarray(0, size)]);
      const i = part.indexOf(sentinel);
      if (i >= 0 && part.length >= i + sentinel.length + 3) {
        const start = i + sentinel.length;
        allowed = part[start] === 1 && part[start + 1] > 0 && part[start + 2] === 49;
        break;
      }
      tail = part.subarray(Math.max(0, part.length - sentinel.length - 4));
    }
  } finally {
    closeSync(fd);
  }
  fuseCache = { file, size: stat.size, mtime: stat.mtimeMs, allowed };
  return allowed;
}
/** 只认国内版公开产品标识，不使用国际版或自定义服务替代。 */
export function resolveWorkBuddyCommand(env: NodeJS.ProcessEnv = process.env): WorkBuddyCommand {
  const file = env.DSH_PET_WORKBUDDY_PATH
    ? resolve(env.DSH_PET_WORKBUDDY_PATH)
    : env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'WorkBuddy', 'WorkBuddy.exe');
  if (!file || !existsSync(file))
    throw new WorkBuddyFailure('未找到国内版 WorkBuddy，请先安装，或用 DSH_PET_WORKBUDDY_PATH 指定程序。');
  try {
    const product = JSON.parse(
      readFileSync(join(dirname(file), 'resources/app.asar.unpacked/cli/product.json'), 'utf8'),
    ) as { endpoint?: string; authentication?: { id?: string } };
    if (
      new URL(product.endpoint ?? '').origin !== 'https://www.workbuddy.cn' ||
      product.authentication?.id !== 'workbuddy-desktop'
    )
      throw Error();
  } catch {
    throw new WorkBuddyFailure('所选程序不是受支持的国内版 WorkBuddy。');
  }
  if (!allowsWorkBuddyNode(file)) throw new WorkBuddyFailure('当前 WorkBuddy 版本不支持后台连接，未打开前台窗口。');
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env))
    if (
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|LANG|LC_ALL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(
        key,
      )
    )
      clean[key] = value;
  clean.ELECTRON_RUN_AS_NODE = '1';
  return { file, args: [], env: clean };
}
