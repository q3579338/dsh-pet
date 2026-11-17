import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepChatAnimation } from './chat-animation.ts';
const hold = { name: '展示天圆地方', playbackId: 'pb-1', startedAt: 1000 };
test('2.3秒短片播完仍保持本体展示，气泡收起后到最短时间才恢复', () => {
  assert.equal(keepChatAnimation(hold, hold.name, 'pb-1', false, 3300), true);
  assert.equal(keepChatAnimation(hold, hold.name, 'pb-1', true, 12_000), true);
  assert.equal(keepChatAnimation(hold, hold.name, 'pb-1', false, 12_000), false);
});
test('到上限、换动作、换回执与显式取消都不再续播', () => {
  assert.equal(keepChatAnimation(hold, hold.name, 'pb-1', true, 31_000), false);
  assert.equal(keepChatAnimation(hold, '展示非洲之心', 'pb-1', true, 2000), false);
  assert.equal(keepChatAnimation(hold, hold.name, 'pb-2', true, 2000), false);
  assert.equal(keepChatAnimation(null, hold.name, 'pb-1', true, 2000), false);
});
