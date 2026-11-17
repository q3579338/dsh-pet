import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoicePresentationSender } from './voice-presentation.ts';
import type { VoicePresentationFrame } from '../../shared/voice-presentation.ts';

test('连续字幕合并、完整文本立即提交；取消后不发送排队帧', async () => {
  const sent: VoicePresentationFrame[] = [];
  let active = true;
  const sender = createVoicePresentationSender(
    async (frame) => {
      sent.push(frame);
    },
    () => active,
  );
  sender.emit({ type: 'assistant', turnId: 'a', text: '今' });
  sender.emit({ type: 'assistant', turnId: 'a', text: '今天' });
  sender.emit({ type: 'assistant', turnId: 'a', text: '今天开心。', complete: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    sent.map((frame) => frame.text),
    ['今天开心。'],
  );
  sender.emit({ type: 'assistant', turnId: 'a', text: '旧的后半句' });
  sender.emit({ type: 'interrupt', turnId: 'i', text: '' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(
    sent.map((frame) => frame.type),
    ['assistant', 'interrupt'],
  );
  assert.deepEqual(
    sent.map((frame) => frame.sequence),
    [1, 2],
  );
  active = false;
  sender.emit({ type: 'user', turnId: 'u', text: '你吃西瓜' });
  sender.dispose();
  assert.equal(sent.length, 2);
});

test('旧气泡请求卡住时打断能取消它，排队旧字幕丢弃，后续用户动作仍送达', async () => {
  const sent: VoicePresentationFrame[] = [];
  const sender = createVoicePresentationSender(
    async (frame) => {
      sent.push(frame);
      if (frame.text === '卡住的旧字幕') await new Promise(() => {});
    },
    () => true,
  );
  try {
    sender.emit({ type: 'assistant', turnId: 'a', text: '卡住的旧字幕', complete: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    sender.emit({ type: 'assistant', turnId: 'a', text: '排队的旧字幕', complete: true });
    sender.emit({ type: 'interrupt', turnId: 'a', text: '' });
    sender.emit({ type: 'user', turnId: 'u', text: '你吃西瓜' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      sent.some((frame) => frame.text === '排队的旧字幕'),
      false,
    );
    assert.ok(sent.some((frame) => frame.type === 'user'));
  } finally {
    sender.dispose();
  }
});
