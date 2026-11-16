/** 独立应用单进程持有；按宠物分文件，严格读、完整写后替换，删除不留下事实正文的日志。 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MEMORY_KINDS, type MemoryState } from './types.ts';

export const MAX_MEMORY_FACTS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const fact = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(MEMORY_KINDS),
    text: z.string().trim().min(1).max(360),
    tags: z.array(z.string().max(32)).max(12),
    salience: z.number().int().min(1).max(5),
    ts: z.number().int().nonnegative(),
    key: z.string().max(400),
    source: z.enum(['text', 'codex-voice', 'workbuddy-voice', 'manual']),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    revision: z.number().int().nonnegative(),
    facts: z.array(fact).max(MAX_MEMORY_FACTS),
  })
  .strict();

/** 每次读取磁盘真值；同步临界区不跨网络等待，避免多个模型的回调交错覆盖。 */
export function createLongTermMemoryStore(userRoot: string) {
  const directory = join(userRoot, 'long-term-memory');
  const file = (petId: string): string => join(directory, createHash('sha256').update(petId).digest('hex') + '.json');
  const checkDirectory = (): void => {
    if (!existsSync(directory)) return;
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('长期记忆目录不可用。');
  };
  const read = (petId: string): MemoryState => {
    let fd: number | undefined;
    try {
      checkDirectory();
      const path = file(petId);
      if (!existsSync(path)) return { version: 1, enabled: true, revision: 0, facts: [] };
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw Error('Unsafe memory file');
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_BYTES) throw Error('Unsafe memory size');
      return schema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    } catch {
      throw Error('长期记忆暂时无法读取，原文件已保留，请检查文件或恢复备份。');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const write = (petId: string, value: MemoryState): void => {
    const next = schema.parse(value);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    checkDirectory();
    // 写前再校验，损坏或不可读的旧文件不能当空库覆盖。
    read(petId);
    const path = file(petId),
      temporary = path + '.' + randomUUID() + '.tmp';
    let fd: number | undefined;
    let owned = false;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      owned = true;
      writeFileSync(fd, JSON.stringify(next), 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
    } catch {
      throw Error('长期记忆未能保存，原有信息已保留，请重试。');
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (owned && existsSync(temporary)) unlinkSync(temporary);
    }
  };
  return { directory, file, read, write };
}
