const terms = [
  { action: '展示天圆地方', canonical: '天圆地方', heard: '天元地方' },
  { action: '展示非洲之心', canonical: '非洲之心', heard: '非洲之星' },
];

function isRequest(clause: string, at: number): boolean {
  if (!/(?:展示|拿出|掏出|取出|亮出|秀给我|给我看)/u.test(clause)) return false;
  if (/[“”「」『』"']/u.test(clause)) return false;
  if (/(?:是什么|什么意思|介绍|讲解|解释|历史|新闻|百科|区别|照片|图片|刚才|刚刚|昨天|已经)/u.test(clause))
    return false;
  if (/(?:别|不要|不许|不准|不能|取消|停止|不想)/u.test(clause.replace(/能不能/gu, ''))) return false;
  const before = clause.slice(0, at).replace(/(?:给|帮)我/gu, '');
  return !/(?:我|他|她|它|我们)[^你请]{0,12}$/u.test(before);
}

/** 文字与语音共用的明确藏品展示请求；其余语境继续由模型选择动作。 */
export function explicitShowcaseAction(text: string, actions: readonly string[]): string | undefined {
  for (const clause of text.split(/[，。！？；,!?;\n]/u)) {
    for (const term of terms) {
      const at = clause.indexOf(term.canonical);
      if (at >= 0 && actions.includes(term.action) && isRequest(clause, at)) return term.action;
    }
  }
  return undefined;
}

/** 只纠正当前角色的明确展示指令中的已知同音词，不改普通问答、引用或否定句。 */
export function correctActionTranscript(text: string, actions: readonly string[]): string {
  return text
    .split(/([，。！？；,!?;\n])/u)
    .map((clause) => {
      for (const term of terms) {
        if (!actions.includes(term.action)) continue;
        const at = clause.indexOf(term.heard);
        if (at < 0 || !isRequest(clause, at)) continue;
        clause = clause.split(term.heard).join(term.canonical);
      }
      return clause;
    })
    .join('');
}
