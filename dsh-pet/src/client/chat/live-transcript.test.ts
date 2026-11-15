import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assistantTranscriptDelta } from './live-transcript.ts';

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
