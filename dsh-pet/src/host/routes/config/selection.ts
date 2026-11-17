/** 桌面单宠/多宠选择：一次核对所有条目，写入失败恢复已改的配置，不触碰聊天与记忆。 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readAllConfig, saveUserConfig, userConfigUnparsable } from '../../config.ts';
import type { PetRouteDeps, RouteInput } from '../types.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from '../result.ts';
import { resolveConfigLayer } from './layer.ts';

/** 暂存全部文件后再替换；跨文件写失败时恢复原始字节。提交函数可注入以验收中途失败。 */
export async function writeSelectionFiles(
  updates: Array<{ path: string; data: string }>,
  commit: typeof rename = rename,
): Promise<void> {
  const staged: Array<{ path: string; temp: string; before?: Buffer; committed: boolean }> = [];
  try {
    for (const update of updates) {
      let before: Buffer | undefined;
      try {
        before = await readFile(update.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await mkdir(dirname(update.path), { recursive: true });
      const temp = update.path + '.selection-' + randomUUID() + '.tmp';
      staged.push({ path: update.path, temp, before, committed: false });
      await writeFile(temp, update.data, { flag: 'wx', mode: 0o600 });
    }
    for (const file of staged) {
      await commit(file.temp, file.path);
      file.committed = true;
    }
  } catch (error) {
    for (const file of staged.filter((item) => item.committed).reverse()) {
      if (file.before) {
        await writeFile(file.temp, file.before, { mode: 0o600 });
        await rename(file.temp, file.path);
      } else await unlink(file.path);
    }
    throw error;
  } finally {
    await Promise.all(staged.map((file) => unlink(file.temp).catch(() => {})));
  }
}

/** 保存模式和选中的实例；隐藏仅移除桌面显示，保留原有浏览器显示。 */
export async function savePetSelection(deps: PetRouteDeps, input: RouteInput) {
  if (input.method !== 'POST') return methodNotAllowed();
  let body: unknown;
  try {
    body = JSON.parse(input.body ?? '');
  } catch {
    return invalidJson();
  }
  if (!body || typeof body !== 'object') return failResult('bad-request', '请选择单宠或多宠模式及宠物。');
  const { mode, ids } = body as { mode?: unknown; ids?: unknown };
  if (
    (mode !== 'single' && mode !== 'multiple') ||
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => typeof id !== 'string' || !id.trim() || id !== id.trim()) ||
    new Set(ids).size !== ids.length ||
    (mode === 'single' && ids.length !== 1)
  )
    return failResult('bad-request', '单宠请选择一只，多宠至少选择一只；宠物不能重复。');
  try {
    if (userConfigUnparsable(deps.configPaths))
      return failResult('user-config-unparsable', '用户配置无法解析，请先修复后再选择宠物。');
    const merged = readAllConfig(deps.configPaths);
    const allPets = Object.values(merged).flatMap((conf) =>
      Array.isArray(conf.pets) ? (conf.pets as Record<string, unknown>[]) : [],
    );
    if (ids.some((id) => !allPets.some((pet) => pet.id === id)))
      return failResult('unknown-pet', '所选宠物已不存在，请重新读取设置。');
    const selected = new Set(ids);
    const updates: Array<{ path: string; data: string }> = [];
    for (const [entry, conf] of Object.entries(merged)) {
      const lookup = resolveConfigLayer(deps, entry);
      if (!lookup.ok || (entry !== 'main' && !lookup.layer.existing))
        throw new Error('角色配置无法读取，请修复后重试。');
      const pets = (conf.pets as Record<string, unknown>[]).map((pet) => ({
        ...pet,
        display: selected.has(pet.id)
          ? pet.display === 'web' || pet.display === 'both'
            ? 'both'
            : 'desktop'
          : pet.display === 'both' || pet.display === 'web'
            ? 'web'
            : 'none',
      }));
      const clean = saveUserConfig(
        { pets, ...(entry === 'main' ? { desktopPetMode: mode } : {}) },
        lookup.layer.existing,
      );
      if (!clean) throw new Error('角色配置无效，未保存选择。');
      updates.push({ path: lookup.layer.path, data: JSON.stringify(clean, null, 2) });
    }
    await writeSelectionFiles(updates);
    for (const pet of allPets) if (!selected.has(pet.id)) deps.lock.release({ petId: String(pet.id), force: true });
    deps.state.writeSection('config', {});
    void deps.requestRestart();
    return okResult(readAllConfig(deps.configPaths));
  } catch {
    return failResult('generate-error', '宠物显示选择未能保存，请检查配置文件和目录权限后重试。');
  }
}
