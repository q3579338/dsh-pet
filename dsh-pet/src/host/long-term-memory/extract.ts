/** 在固定版本的上游规则外补中文称呼、否定纠正和引用过滤；只处理用户原话。 */
import { extractFacts, isPromptInjection, tagsFor } from '../../vendor/dsh-pet-memory/extract.mjs';
import type { MemoryCandidate, MemoryKind } from './types.ts';

const PRIVATE = /(?:密码|口令|密钥|私钥|身份证|银行卡|api[ _-]?key|access[ _-]?token|bearer\s|sk-[a-z0-9]{8})/i;
const DIRECTIVE = /ignore.{0,30}(?:instructions|rules)|system\s*prompt|https?:\/\/|<\/?[a-z][^>]*>|```|\{\{|\}\}/i;
/** 编辑器同样不允许把凭据、提示词指令和嵌入标记作为长期事实。 */
export function safeMemoryText(text: string): boolean {
  return (
    text.length > 0 && text.length <= 360 && !PRIVATE.test(text) && !DIRECTIVE.test(text) && !isPromptInjection(text)
  );
}
const trimTail = (s: string): string =>
  s
    .trim()
    .replace(/(?:就行|就好|就可以|吧|啊|呀|啦|哦|呗|了|呢|嘛)+$/u, '')
    .trim();
const objectKey = (s: string): string =>
  trimTail(s)
    .toLowerCase()
    .replace(/^(?:吃|喝|玩|看|听|使用|用)/u, '')
    .replace(/[\s「」“”"']/g, '');

/** 不猜代词指代、反讽或假设；识别不了的表达仍只留在普通聊天里。 */
export function memoryCandidates(input: string): MemoryCandidate[] {
  if (
    input.length > 5000 ||
    /(?:不要|不用|别|不许|无需)(?:再)?(?:记住|记|保存)|(?:举例|比如|假如|假设|台词|引用|角色扮演)/u.test(input)
  )
    return [];
  if (PRIVATE.test(input) || DIRECTIVE.test(input) || isPromptInjection(input)) return [];
  const out: MemoryCandidate[] = [];
  const put = (kind: MemoryKind, text: string, key: string, salience = 4): void => {
    if (safeMemoryText(text)) out.push({ kind, text, key, salience, tags: tagsFor(text) });
  };
  for (let clause of input.match(/[^。！？!?，,；;\n]+[。！？!?，,；;\n]?/gu) ?? []) {
    if (/[？?]\s*$/u.test(clause)) continue;
    clause = clause.replace(/[。！？!?，,；;\n]+$/u, '').trim();
    if (!clause || /(?:能不能|要不要|是不是|是否|以前|曾经)/u.test(clause)) continue;
    clause = clause
      .replace(
        /^(?:(?:请你?|麻烦你?)?记住[：:]?|以后|今后|从现在起|现在|其实|另外|还有|对了|顺便说下|请|嗯|啊|好的)+/u,
        '',
      )
      .trim();
    const name = clause.match(/^(?:叫我|我叫|我的名字(?:是|叫))([\p{L}\p{N}_· -]{1,24})$/u);
    if (name) {
      const value = trimTail(name[1]);
      if (
        value &&
        !/^(?:什么|谁|啥|名字|怎么)/u.test(value) &&
        !/(?:不要|别再|以后|今年|喜欢|但是|因为|所以)/u.test(value)
      )
        put('profile', `用户希望被称为「${value}」`, 'name', 5);
      continue;
    }
    const preference = clause.match(
      /^我(?:现在|以后|已经|很|超|最|特别|挺|蛮)?(不再喜欢|不喜欢|讨厌|喜欢|爱|不吃|不能吃|吃不了|不喝|喝不了)(.{1,40})$/u,
    );
    if (preference) {
      const object = trimTail(preference[2]);
      if (!object || /(?:但是|不过|可惜|不喜欢了)|^(?:什么|啥|谁|哪)|吗$/u.test(object)) continue;
      const verb =
        preference[1] === '不再喜欢' || preference[1] === '讨厌'
          ? '不喜欢'
          : preference[1] === '爱'
            ? '喜欢'
            : preference[1];
      const key = objectKey(object);
      const dimension = ['喜欢', '不喜欢'].includes(verb) ? 'like:' : 'consume:';
      if (key) put('preference', `用户${verb}${object}`, 'preference:' + dimension + key);
      continue;
    }
    if (!/^(?:我(?:最近|现在|今年)?|叫我|我们(?:说好|约定)|说好|答应你|约定[：:])/u.test(clause)) continue;
    for (const candidate of extractFacts(clause, { max: 8 })) {
      if (candidate.kind === 'event' || candidate.kind === 'preference') continue;
      if (candidate.kind === 'promise' && !/(?:答应|说好|约定)/u.test(clause)) continue;
      const kind = candidate.kind as MemoryKind;
      const key = /^我(?:最近|现在)?在(?:做|忙|搞)/u.test(clause) ? 'current-work' : kind + ':' + candidate.text;
      put(kind, candidate.text.replace(/^他/u, '用户').replace(/他说/u, '用户说'), key, candidate.salience);
    }
  }
  return [...new Map(out.map((item) => [item.key, item])).values()].slice(0, 8);
}
