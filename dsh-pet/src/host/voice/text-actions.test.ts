import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionInstruction, extractChatAction, visibleChatText } from '../chat-action.ts';
import { createVoicePresentation, requestedVoiceAction } from './presentation.ts';
import { PollStateStore } from '../state.ts';
import { PlaybackStore } from '../playback.ts';

test('原声沿用文件宠物的展示动作白名单，支持拿出与展示，不误触发物品介绍或否定', () => {
  const actions = ['展示非洲之心', '展示天圆地方', '放出闪光巡飞器'];
  for (const text of ['拿出一颗非洲之心给我看', '把非洲之心掏出来', '给我看看非洲之心'])
    assert.equal(requestedVoiceAction(text, actions), '展示非洲之心', text);
  assert.equal(requestedVoiceAction('展示一下天圆地方', actions), '展示天圆地方');
  assert.equal(requestedVoiceAction('放出一个闪光巡飞器', actions), '放出闪光巡飞器');
  for (const text of ['别拿出非洲之心', '非洲之心是什么', '我拿出非洲之心给你看', '你有非洲之心吗'])
    assert.equal(requestedVoiceAction(text, actions), undefined);
  assert.equal(requestedVoiceAction('拿出非洲之心给我看', ['吃西瓜']), undefined);
});

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

test('文字可解析的换行动作标记在语音中也被完整隐藏，各种分块均不漏词或重念', () => {
  const full = '  哈哈，西瓜甜甜的～\n[动作： \n吃西瓜\n ]';
  const expected = extractChatAction(full, ['吃西瓜']);
  assert.equal(expected.action, '吃西瓜');
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
    assert.equal(visibleChatText(full, true), expected.text);
    assert.equal(spoken, expected.text);
  }
});

test('头顶气泡与朗读共享正文过滤，不暴露半截动作标记或未提供的配图标记', () => {
  const state = new PollStateStore(),
    playback = new PlaybackStore();
  const view = createVoicePresentation({
    petId: 'fish',
    state,
    playback,
    mode: 'model',
    settings: () => ({ available: true, actions: ['吃西瓜'] }),
  });
  try {
    view.accept({ sequence: 1, type: 'assistant', turnId: 'a', text: '啊呜，甜甜的～[动' });
    assert.equal((state.read().pets.fish.say.data as { text: string }).text, '啊呜，甜甜的～');
    view.accept({
      sequence: 2,
      type: 'assistant',
      turnId: 'a',
      text: '啊呜，甜甜的～[动作:\n吃西瓜\n][图:吃瓜]',
      complete: true,
    });
    assert.equal((state.read().pets.fish.say.data as { text: string }).text, '啊呜，甜甜的～');
    assert.equal((state.read().pets.fish.anim.data as { name: string }).name, '吃西瓜');
  } finally {
    view.dispose();
    state.cancelAll();
  }
});
