/** 管理页与自动提取使用同一主题键；兼容 .19 手动编辑留下的旧键，不修改原事实正文。 */
import { memoryCandidates } from './extract.ts';
import type { MemoryFact, MemoryKind } from './types.ts';

export function canonicalMemoryKey(text: string, kind: MemoryKind): string | undefined {
  const name = text.trim().match(/^用户希望被称为[「“"]([^」”"]{1,24})[」”"][。.]?$/u);
  if (name) return 'name';
  let statement = text.trim().replace(/^用户(?=不再喜欢|不喜欢|讨厌|喜欢|爱好|不吃|不能吃|吃不了|不喝|喝不了)/u, '我');
  if (kind === 'preference' && /^(?:不再喜欢|不喜欢|讨厌|喜欢|不吃|不能吃|吃不了|不喝|喝不了)/u.test(statement))
    statement = '我' + statement;
  const candidates = memoryCandidates(statement);
  if (candidates.length !== 1) return undefined;
  const key = candidates[0].key;
  return key === 'name' || key.startsWith('preference:') ? key : undefined;
}

export function factMemoryKey(fact: MemoryFact): string {
  return fact.source === 'manual' ? (canonicalMemoryKey(fact.text, fact.kind) ?? 'manual:' + fact.id) : fact.key;
}
