import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionInstruction, visibleChatText } from '../chat-action.ts';
import { createVoicePresentation, requestedVoiceAction } from './presentation.ts';
import { PollStateStore } from '../state.ts';
import { PlaybackStore } from '../playback.ts';

test('连续语音与文字对话共享动作指令和解析，仅模型完成时表演一次', () => {
  const state = new PollStateStore(),
    playback = new PlaybackStore();
  const presentation = createVoicePresentation({
    petId: 'fish',
    state,
    playback,
    mode: 'model',
    settings: () => ({ available: true, actions: ['吃西瓜'] }),
  });
  try {
    assert.equal(presentation.modelInstruction?.(), actionInstruction(['吃西瓜']));
    presentation.accept({ sequence: 1, type: 'user', turnId: 'u', text: '吃一块西瓜吃一块西瓜' });
    assert.equal(state.read().pets.fish, undefined);
    presentation.accept({
      sequence: 2,
      type: 'assistant',
      turnId: 'a',
      text: '啊呜，甜甜的～\n[动作:吃西瓜]',
      complete: true,
    });
    const animation = state.read().pets.fish.anim;
    assert.equal((animation.data as { name: string }).name, '吃西瓜');
    assert.ok(!JSON.stringify(state.read().pets.fish.say.data).includes('[动作:'));
    presentation.accept({
      sequence: 3,
      type: 'assistant',
      turnId: 'a',
      text: '啊呜，甜甜的～\n[动作:吃西瓜]',
      complete: true,
    });
    assert.equal(state.read().pets.fish.anim.counter, animation.counter);
    assert.equal(requestedVoiceAction('吃一块西瓜吃一块西瓜', ['吃西瓜']), '吃西瓜');
  } finally {
    presentation.dispose();
    state.cancelAll();
  }
});

test('动作标记在任意分块边界都不进入朗读，正文的合法叠词和日期保持完整', () => {
  const full = '哈哈，今天是2026年11月17日。\n[动作:吃西瓜]';
  for (let width = 1; width <= full.length; width++) {
    let raw = '',
      visible = '',
      spoken = '';
    for (let at = 0; at < full.length; at += width) {
      raw += full.slice(at, at + width);
      const clean = visibleChatText(raw);
      assert.ok(clean.startsWith(visible));
      spoken += clean.slice(visible.length);
      visible = clean;
    }
    assert.equal(spoken, '哈哈，今天是2026年11月17日。');
    assert.equal(visibleChatText(full, true), '哈哈，今天是2026年11月17日。');
  }
});
