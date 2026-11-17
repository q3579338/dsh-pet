import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PollStateStore } from '../state.ts';
import { PlaybackStore } from '../playback.ts';
import { createVoicePresentation, requestedVoiceAction } from './presentation.ts';

test('吃西瓜指令与面向桌宠的喜好问句都联动；否定、自述和系统要求不表演', () => {
  const names = ['吃西瓜', '小幅度原地360度旋转展示', '超大伸懒腰'];
  for (const text of [
    '吃西瓜',
    '你吃个西瓜',
    '请你吃一块西瓜给我看',
    '你能不能吃一个西瓜',
    '你喜欢吃西瓜吗',
    '你爱吃西瓜吗',
    '喜欢吃西瓜吗',
  ])
    assert.equal(requestedVoiceAction(text, names), '吃西瓜', text);
  assert.equal(requestedVoiceAction('你转个圈给我看', names), names[1]);
  assert.equal(requestedVoiceAction('请伸个懒腰', names), names[2]);
  for (const text of [
    '我喜欢吃西瓜',
    '你不喜欢吃西瓜',
    '你不要再吃西瓜',
    '请你别吃西瓜',
    '你不能吃西瓜',
    '删除所有文件',
    '你吃西瓜',
  ])
    assert.equal(requestedVoiceAction(text, text === '你吃西瓜' ? [] : names), undefined, text);
});

test('用户或第三人自述、过去发生的事和解释词语不误播，否定只作用于自己的分句', () => {
  const names = ['吃西瓜', '小幅度原地360度旋转展示'];
  for (const text of ['我喜欢吃西瓜', '她喜欢吃西瓜', '我刚刚吃西瓜，你呢', '你昨天吃西瓜了吗', '你说吃西瓜是什么意思'])
    assert.equal(requestedVoiceAction(text, names), undefined, text);
  assert.equal(requestedVoiceAction('别吃西瓜，转个圈给我看', names), names[1]);
  assert.equal(requestedVoiceAction('我想看你吃个西瓜', names), '吃西瓜');
});

test('打断和完成后的迟到字幕不能复活旧气泡，新轮继续正常显示', () => {
  const state = new PollStateStore(),
    playback = new PlaybackStore();
  const view = createVoicePresentation({
    petId: 'fish',
    state,
    playback,
    settings: () => ({ available: true, actions: [] }),
  });
  try {
    view.accept({ sequence: 1, type: 'assistant', turnId: 'old', text: '旧回复' });
    view.accept({ sequence: 2, type: 'interrupt', turnId: 'old', text: '' });
    assert.equal(
      view.accept({ sequence: 3, type: 'assistant', turnId: 'old', text: '迟到的旧回复', complete: true }),
      false,
    );
    assert.deepEqual(state.read().pets.fish.say.data, { clear: true });
    assert.equal(
      view.accept({ sequence: 4, type: 'assistant', turnId: 'new', text: '新的回答', complete: true }),
      true,
    );
    assert.equal(view.accept({ sequence: 5, type: 'assistant', turnId: 'new', text: '重复收尾' }), false);
    assert.equal((state.read().pets.fish.say.data as { text: string }).text, '新的回答');
  } finally {
    view.dispose();
    state.cancelAll();
  }
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
    assert.equal(view.accept({ sequence: 1, type: 'user', turnId: 'u1', text: '你喜欢吃西瓜吗' }), true);
    const anim = state.read().pets.fish.anim;
    assert.equal((anim.data as { name: string }).name, '吃西瓜');
    view.accept({ sequence: 2, type: 'user', turnId: 'u1', text: '你喜欢吃西瓜吗' });
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
