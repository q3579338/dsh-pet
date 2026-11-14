/** 为 Codex 适配版分离本机数据目录；不改写 Codex 与 DeepSeek 的配置。 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonc } from '../../host/config/jsonc.ts';
import type { ConfigPaths } from '../../host/config.ts';
import { writePrivateJson } from '../ai-storage.ts';

/** 仅在本适配版入口调用，显式 DSH_HOME 继续用于测试与便携部署。 */
export function useCodexProfile(): void {
  process.env.DSH_PET_CODEX ??= '1';
  process.env.DSH_HOME ??= join(homedir(), '.codex-bigfish');
}

/** 初次启动只写独立目录的偏好；自动调用模型的碎碎念由用户在设置页开启。 */
export function seedCodexProfile(paths: ConfigPaths): void {
  if (process.env.DSH_PET_CODEX !== '1' || (paths.legacyUserFile && existsSync(paths.legacyUserFile))) return;
  const defaults = readJsonc(paths.defaultFile);
  if (!defaults || !Array.isArray(defaults.pets)) throw new Error('大肥鱼内置配置不可用，请重新解压完整程序。');
  const pets = defaults.pets.map((pet: Record<string, unknown>) => ({
    id: pet.id,
    name: pet.name,
    whisperEnabled: false,
    balanceEnabled: true,
  }));
  const seed = {
    pets,
    eventsRefreshSec: { ...(defaults.eventsRefreshSec as Record<string, unknown> | undefined), balance: 120 },
  };
  if (existsSync(paths.userFile)) {
    const previousSeed = { pets: pets.map((pet) => ({ ...pet, balanceEnabled: false })) };
    // 只升级上版未编辑过的自动默认文件；自定义宠物和显式开关继续保留。
    if (JSON.stringify(readJsonc(paths.userFile)) === JSON.stringify(previousSeed))
      writePrivateJson(paths.userFile, seed);
    return;
  }
  mkdirSync(dirname(paths.userFile), { recursive: true });
  try {
    writeFileSync(paths.userFile, JSON.stringify(seed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
