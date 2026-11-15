/** 只接收当前助手轮的文本增量，不把用户转写或旧轮的迟到内容交给朗读器。 */
export function assistantTranscriptDelta(event: Record<string, unknown>, assistantId: string | undefined): string {
  return event.type === 'turn.delta' &&
    !!assistantId &&
    event.turn_id === assistantId &&
    typeof event.delta === 'string'
    ? event.delta.slice(0, 6000)
    : '';
}
