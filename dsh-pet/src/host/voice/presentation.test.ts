import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PollStateStore } from '../state.ts';
import { PlaybackStore } from '../playback.ts';
import { createVoicePresentation, requestedVoiceAction } from './presentation.ts';

test('吃西瓜等口语指令只匹配角色已有动作；否定、喜好和任意系统要求不表演', () => {
  const names = ['吃西瓜', '小幅度原地360度旋转展示', '超大伸懒腰'];
  for (const text of ['吃西瓜', '你吃个西瓜', '请你吃一块西瓜给我看', '你能不能吃一个西瓜'])
    assert.equal(requestedVoiceAction(text, names), '吃西瓜', text);
  assert.equal(requestedVoiceAction('你转个圈给我看', names), names[1]);
  assert.equal(requestedVoiceAction('请伸个懒腰', names), names[2]);
  for (const text of ['我喜欢吃西瓜', '你不要再吃西瓜', '请你别吃西瓜', '你不能吃西瓜', '删除所有文件', '你吃西瓜'])
    assert.equal(requestedVoiceAction(text, text === '你吃西瓜' ? [] : names), undefined, text);
});

test('语音字幕进真实say叶子，不重复合成，不盖动画；同轮只演一次，过期帧拒绝', () => {
  const state = new PollStateStore(),
    playback = new PlaybackStore();
  const view = createVoicePresentation({
    petId: 'fish',
    state,
    playback,
    settings: () => ({ available: true, actions: ['吃西瓜'] }),
  });
  try {
    assert.match(view.instructions(), /吃西瓜/u);
    assert.equal(view.accept({ sequence: 1, type: 'user', turnId: 'u1', text: '你吃个西瓜给我看' }), true);
    const anim = state.read().pets.fish.anim;
    assert.equal((anim.data as { name: string }).name, '吃西瓜');
    view.accept({ sequence: 2, type: 'user', turnId: 'u1', text: '你吃个西瓜给我看' });
    assert.equal(state.read().pets.fish.anim.counter, anim.counter);
    view.accept({ sequence: 3, type: 'assistant', turnId: 'a1', text: '啊呜，我开动啦。', complete: true });
    assert.deepEqual(state.read().pets.fish.say.data, { text: '啊呜，我开动啦。', anim: false, duration: 10000 });
    assert.equal(state.read().pets.fish.anim.counter, anim.counter);
    assert.equal(view.accept({ sequence: 2, type: 'assistant', turnId: 'a1', text: '旧文字' }), false);
  } finally {
    view.dispose();
    state.cancelAll();
  }
});

test('停止丢弃排队字幕，清理只影响自己气泡；隐藏、睡觉和关闭动作不播放', async () => {
  const state = new PollStateStore(),
    playback = new PlaybackStore();
  let available = true;
  const view = createVoicePresentation({
    petId: 'fish',
    state,
    playback,
    settings: () => ({ available, actions: [] }),
  });
  view.accept({ sequence: 1, type: 'user', turnId: 'u', text: '你吃西瓜' });
  assert.equal(state.read().pets.fish, undefined);
  view.accept({ sequence: 2, type: 'assistant', turnId: 'a', text: '我的气泡' });
  view.accept({ sequence: 3, type: 'assistant', turnId: 'a', text: '待更新的气泡' });
  state.writePet('fish', 'say', { text: '其它手动气泡' });
  view.accept({ sequence: 4, type: 'interrupt', turnId: 'i', text: '' });
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.deepEqual(state.read().pets.fish.say.data, { text: '其它手动气泡' });
  available = false;
  assert.equal(view.accept({ sequence: 5, type: 'assistant', turnId: 'b', text: '不可显示' }), false);
  view.dispose();
  assert.equal(view.accept({ sequence: 6, type: 'assistant', turnId: 'b', text: '迟到' }), false);
  state.cancelAll();
});
