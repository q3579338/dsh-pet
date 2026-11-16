/** 语音画面只同步字幕与当前用户的动画请求，不授予模型文件或系统操作能力。 */
export interface VoicePresentationFrame {
  sequence: number;
  turnId: string;
  type: 'user' | 'assistant' | 'interrupt';
  text: string;
  complete?: boolean;
}

export function readVoicePresentationFrame(value: unknown): VoicePresentationFrame | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(v.sequence) ||
    (v.sequence as number) < 1 ||
    typeof v.turnId !== 'string' ||
    !/^[\w-]{1,200}$/u.test(v.turnId) ||
    !['user', 'assistant', 'interrupt'].includes(v.type as string) ||
    typeof v.text !== 'string' ||
    v.text.length > 6000 ||
    (v.complete !== undefined && typeof v.complete !== 'boolean')
  )
    return;
  return {
    sequence: v.sequence as number,
    turnId: v.turnId,
    type: v.type as VoicePresentationFrame['type'],
    text: v.text,
    complete: v.complete as boolean | undefined,
  };
}
