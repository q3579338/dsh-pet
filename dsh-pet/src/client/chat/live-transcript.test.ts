import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assistantTranscriptDelta, createAssistantTranscript } from './live-transcript.ts';

test('当前助手轮的逐字增量可提前朗读；用户轮、旧轮和非文本事件不进入音频', () => {
  assert.equal(
    assistantTranscriptDelta({ type: 'turn.delta', turn_id: 'assistant', delta: '听到啦' }, 'assistant'),
    '听到啦',
  );
  for (const event of [
    { type: 'turn.delta', turn_id: 'user', delta: '用户的话' },
    { type: 'turn.delta', turn_id: 'old', delta: '旧的回复' },
    { type: 'turn.delta', turn_id: 'assistant', delta: { audio: 'opaque' } },
    { type: 'other', turn_id: 'assistant', delta: 'other' },
  ])
    assert.equal(assistantTranscriptDelta(event, 'assistant'), '');
  assert.equal(
    assistantTranscriptDelta({ type: 'turn.delta', turn_id: 'assistant', delta: '未知归属' }, undefined),
    '',
  );
});

for (const reversed of [false, true]) {
  test('两路相同字幕合并后日期和数字只出现一次，先到通道=' + (reversed ? 'output' : 'delta'), () => {
    const stream = createAssistantTranscript();
    assert.equal(stream.accept({ type: 'turn.created', turn: { id: 'a', role: 'assistant' } }).begin, true);
    let spoken = '';
    const words = ['今天是', '2026', '年', '11', '月', '16', '日，', '星期一。'];
    for (let i = 0; i < words.length; i++) {
      const delta = { type: 'turn.delta', turn_id: 'a', delta: words[i] };
      const output = { type: 'output_transcript.added', turn_id: 'a', item: { id: 'item' + i, text: words[i] } };
      for (const event of reversed ? [output, delta] : [delta, output]) spoken += stream.accept(event).delta ?? '';
    }
    assert.equal(spoken, words.join(''));
    assert.equal(
      stream.accept({ type: 'turn.done', turn: { id: 'a', role: 'assistant', transcript: words.join('') } }).full,
      spoken,
    );
  });
}
test('两通道分块边界不一致也不重复，合法的哈哈和再次相同回答保留', () => {
  const stream = createAssistantTranscript();
  for (const id of ['a', 'b']) {
    stream.accept({ type: 'turn.created', turn: { id, role: 'assistant' } });
    const rows = [
      { type: 'turn.delta', turn_id: id, delta: '哈哈，今天是' },
      { type: 'output_transcript.added', item: { id: 'one', text: '哈哈，' } },
      { type: 'output_transcript.added', item: { id: 'two', text: '今天是2026年。' } },
      { type: 'turn.delta', turn_id: id, delta: '2026年。' },
    ];
    assert.equal(rows.map((row) => stream.accept(row).delta ?? '').join(''), '哈哈，今天是2026年。');
    stream.accept({ type: 'turn.done', turn: { id, role: 'assistant', transcript: '哈哈，今天是2026年。' } });
    assert.deepEqual(stream.accept(rows[0]), {});
  }
});
test('重复事件、旧轮、用户轮和打断后的迟到字幕不再进入朗读', () => {
  const stream = createAssistantTranscript();
  stream.accept({ type: 'turn.created', turn: { id: 'new', role: 'assistant' } });
  const event = { type: 'turn.delta', turn_id: 'new', event_id: 'e', delta: '正确' };
  assert.equal(stream.accept(event).delta, '正确');
  assert.deepEqual(stream.accept(event), {});
  assert.deepEqual(stream.accept({ type: 'turn.delta', turn_id: 'old', delta: '旧' }), {});
  assert.deepEqual(stream.accept({ type: 'turn.delta', turn_id: 'user', delta: '用户' }), {});
  stream.interrupt();
  assert.deepEqual(stream.accept({ type: 'turn.delta', turn_id: 'new', delta: '迟到' }), {});
});
test('新轮尚未确认的无归属旧字幕不能抢先朗读，等待本轮增量或最终文本', () => {
  const stream = createAssistantTranscript();
  stream.accept({ type: 'turn.created', turn: { id: 'old', role: 'assistant' } });
  stream.interrupt();
  stream.accept({ type: 'turn.created', turn: { id: 'new', role: 'assistant' } });
  assert.deepEqual(
    stream.accept({ type: 'output_transcript.added', item: { id: 'late-old', text: '上一次的回复' } }),
    {},
  );
  assert.equal(stream.accept({ type: 'turn.delta', turn_id: 'new', delta: '新的回答' }).delta, '新的回答');
  assert.equal(
    stream.accept({ type: 'turn.done', turn: { id: 'new', role: 'assistant', transcript: '新的回答' } }).full,
    '新的回答',
  );
});
test('仅无归属字幕的旧协议在最终确认后仍能完成，带轮编号的片段仍即时返回', () => {
  const stream = createAssistantTranscript();
  stream.accept({ type: 'turn.created', turn: { id: 'one', role: 'assistant' } });
  assert.deepEqual(stream.accept({ type: 'output_transcript.added', item: { id: 'a', text: '你好' } }), {});
  assert.equal(
    stream.accept({ type: 'turn.done', turn: { id: 'one', role: 'assistant', transcript: '你好' } }).full,
    '你好',
  );
  stream.accept({ type: 'turn.created', turn: { id: 'two', role: 'assistant' } });
  assert.equal(
    stream.accept({ type: 'output_transcript.added', turn_id: 'two', item: { id: 'b', text: '即时文字' } }).delta,
    '即时文字',
  );
});
