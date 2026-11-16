/** 长期记忆只经已鉴权的本机宠物路由管理，不接受网页提供存储路径或模型凭据。 */
import { z } from 'zod';
import { readAllConfig } from '../config.ts';
import { MEMORY_KINDS } from '../long-term-memory/types.ts';
import type { RouteHandler } from './types.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';

const edit = z
  .object({
    text: z.string().trim().min(1).max(360),
    kind: z.enum(MEMORY_KINDS).optional(),
    id: z.string().uuid().optional(),
  })
  .strict();
const enable = z.object({ enabled: z.boolean() }).strict();
export const handleLongTermMemoryRoutes: RouteHandler = async (deps, input) => {
  if (input.rest !== 'chat/long-term-memory') return undefined;
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(input.method)) return methodNotAllowed();
  if (!deps.longTermMemory) return failResult('unsupported', '当前宿主没有启用本机长期记忆。');
  const who = deps.requirePet(input.url.searchParams, () => readAllConfig(deps.configPaths));
  if (!who.ok) return who.res;
  const service = deps.longTermMemory,
    petId = who.petId;
  try {
    if (input.method === 'GET') return okResult({ ok: true, ...service.view(petId) });
    if (input.method === 'DELETE') {
      const id = input.url.searchParams.get('id'),
        all = input.url.searchParams.get('all');
      if ((!id && all !== '1') || (id && all !== null) || (id && !z.string().uuid().safeParse(id).success))
        return failResult('bad-request', '请明确选择要删除的记忆。');
      return okResult({ ok: true, ...(id ? service.remove(petId, id) : service.clear(petId)) });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(input.body ?? 'null');
    } catch {
      return invalidJson();
    }
    if (input.method === 'PUT') {
      const parsed = enable.safeParse(raw);
      if (!parsed.success) return failResult('bad-request', '长期记忆开关无效。');
      return okResult({ ok: true, ...service.setEnabled(petId, parsed.data.enabled) });
    }
    const parsed = edit.safeParse(raw);
    if (!parsed.success) return failResult('bad-request', '请输入360字内的记忆，并检查类型。');
    return okResult({ ok: true, ...service.save(petId, parsed.data.text, parsed.data.kind, parsed.data.id) });
  } catch (error) {
    return failResult('generate-error', error instanceof Error ? error.message : '长期记忆操作失败，请重试。');
  }
};
