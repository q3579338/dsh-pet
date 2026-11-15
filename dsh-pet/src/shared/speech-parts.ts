/** 流式预热与播放器共用的分句规则，避免预热的首句和实际请求使用不同缓存键。 */
const MAX_PART_CHARS = 100;

/** 取已经说完整的第一段；流未结束且没有句尾时，保留短尾巴继续等。 */
export function firstSpeechPart(text: string, complete = false): string | undefined {
  const clean = text.trimStart();
  if (!clean) return undefined;
  let end = 0;
  for (const char of clean) {
    if (end + char.length > MAX_PART_CHARS) break;
    end += char.length;
    if (end >= 8 && /[。！？!?；;\n]/u.test(char)) return clean.slice(0, end).trimEnd();
  }
  if (end >= MAX_PART_CHARS - 1 || (complete && end > 0)) return clean.slice(0, end).trimEnd();
  return undefined;
}

/** 将完整回复分成服务可接收的短段，保留每段正文和标点。 */
export function speechParts(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest) {
    const part = firstSpeechPart(rest, true);
    if (!part) break;
    parts.push(part);
    rest = rest.slice(part.length).trimStart();
  }
  return parts;
}
