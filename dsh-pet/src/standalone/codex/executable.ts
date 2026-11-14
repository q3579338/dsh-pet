/** 定位本机 Codex；只解析已有启动器，不经 shell 执行命令文本。 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** 将 Windows 官方启动器解析到实际 exe，避免 shell 转义及控制台闪现。 */
function executableAt(candidate: string): string | undefined {
  try {
    if (!statSync(candidate).isFile()) return undefined;
    if (!/\.(?:cmd|bat)$/i.test(candidate)) return candidate;
    const wrapper = readFileSync(candidate, 'utf8');
    const target = wrapper.match(/"([^"\r\n]+codex\.exe)"/i)?.[1];
    return target && isAbsolute(target) && existsSync(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

/** 优先使用显式路径，其次 PATH 与桌面应用随附的 CLI；不读取登录凭据。 */
export function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_PET_CODEX_PATH) {
    const explicit = executableAt(env.DSH_PET_CODEX_PATH);
    if (explicit) return explicit;
    throw new Error('找不到指定的 Codex 程序，请检查 DSH_PET_CODEX_PATH。');
  }
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const executable = executableAt(join(directory, name));
      if (executable) return executable;
    }
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const root = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = readdirSync(root).map((name) => join(root, name, 'codex.exe'));
      candidates.sort((left, right) => statTime(right) - statTime(left));
      for (const candidate of candidates) {
        const executable = executableAt(candidate);
        if (executable) return executable;
      }
    } catch {
      // 未安装桌面应用时仍允许上面的独立 CLI 路径。
    }
  }
  throw new Error('未找到本机 Codex。请先打开并登录 Codex，或设置 DSH_PET_CODEX_PATH。');
}

/** 缺失或正在更新的候选排到末尾。 */
function statTime(candidate: string): number {
  try {
    return statSync(candidate).mtimeMs;
  } catch {
    return 0;
  }
}
