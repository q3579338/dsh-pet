/** 只接收当前助手轮的文本增量，不把用户转写或旧轮的迟到内容交给朗读器。 */
export function assistantTranscriptDelta(event: Record<string, unknown>, assistantId: string | undefined): string {
  return event.type === 'turn.delta' &&
    !!assistantId &&
    event.turn_id === assistantId &&
    typeof event.delta === 'string'
    ? event.delta.slice(0, 6000)
    : '';
}

type TranscriptUpdate = { begin?: boolean; delta?: string; full?: string; done?: boolean };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
function transcriptText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 6000);
  if (Array.isArray(value))
    return value
      .map((item) => transcriptText(record(item).text))
      .join('')
      .slice(0, 6000);
  return '';
}

/** 同一回答可能同时走 delta 和 output_transcript；分别累积，仅提交尚未出现的公共前缀尾部。 */
export function createAssistantTranscript() {
  let id: string | undefined,
    emitted = '',
    deltas = '',
    outputs = '',
    unscoped = '',
    done = true;
  const items = new Set<string>(),
    events = new Set<string>(),
    turns = new Set<string>();
  return {
    interrupt() {
      done = true;
    },
    accept(event: Record<string, unknown>): TranscriptUpdate {
      const turn = record(event.turn),
        item = record(event.item);
      if (event.type === 'turn.created' && turn.role === 'assistant' && typeof turn.id === 'string') {
        if (turns.has(turn.id)) return {};
        turns.add(turn.id);
        if (turns.size > 32) turns.delete(turns.values().next().value!);
        id = turn.id;
        emitted = '';
        deltas = '';
        outputs = '';
        unscoped = '';
        done = false;
        items.clear();
        events.clear();
        return { begin: true };
      }
      if (!id || done) return {};
      if (typeof event.event_id === 'string') {
        if (events.has(event.event_id)) return {};
        if (events.size >= 2048) return {};
        events.add(event.event_id);
      }
      if (event.type === 'turn.done' && turn.role === 'assistant' && turn.id === id) {
        done = true;
        return { done: true, full: transcriptText(turn.transcript) || emitted || unscoped };
      }
      let candidate = '';
      if (event.type === 'turn.delta') {
        const delta = assistantTranscriptDelta(event, id);
        if (!delta) return {};
        deltas = (deltas + delta).slice(0, 6000);
        candidate = deltas;
      } else if (event.type === 'output_transcript.added') {
        const owner = event.turn_id ?? item.turn_id;
        if ((owner !== undefined && owner !== id) || (item.role !== undefined && item.role !== 'assistant')) return {};
        if (typeof item.id === 'string') {
          if (items.has(item.id)) return {};
          if (items.size >= 1024) return {};
          items.add(item.id);
        }
        // 缺少轮编号的片段可能来自被打断的上一轮，不得抢在当前增量前进入字幕或朗读。
        if (owner === undefined) {
          unscoped = (unscoped + transcriptText(item.text)).slice(0, 6000);
          return {};
        }
        outputs = (outputs + transcriptText(item.text)).slice(0, 6000);
        candidate = outputs;
      }
      // 另一通道落后时忽略；两者有改写差异时等最终字幕，不把差异再念一遍。
      if (!candidate || !candidate.startsWith(emitted)) return {};
      const delta = candidate.slice(emitted.length);
      emitted = candidate;
      return delta ? { delta, full: emitted } : {};
    },
  };
}
