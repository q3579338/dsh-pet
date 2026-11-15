import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkStatusSpeaker } from './work-status-speech.ts';

test('状态变化播一次，回空闲后允许下一轮；进行中提示限频', () => {
  let clock = 0;
  const spoken: string[] = [];
  const speak = createWorkStatusSpeaker({
    enabled: () => true,
    busy: () => false,
    now: () => clock,
    speak: (text) => spoken.push(text),
  });
  speak('thinking', '正在认真想下一步呢');
  speak('thinking', '同状态不重复');
  speak('working', '短时间切状态也不重复');
  clock = 15000;
  speak('result', '清点成果啦');
  speak('success', '完成啦');
  speak(null, null);
  clock = 30000;
  speak('thinking', '新的一轮');
  assert.deepEqual(spoken, ['正在认真想下一步呢', '清点成果啦', '完成啦', '新的一轮']);
});

test('关闭和忙碌期间不抢话，也不补读已经过去的状态', () => {
  let enabled = false;
  let busy = false;
  const spoken: string[] = [];
  const speak = createWorkStatusSpeaker({
    enabled: () => enabled,
    busy: () => busy,
    now: () => 0,
    speak: (text) => spoken.push(text),
  });
  speak('thinking', '关闭时不读');
  enabled = true;
  speak('thinking', '不补读旧状态');
  busy = true;
  speak('success', '聊天中不抢话');
  busy = false;
  speak('success', '不补读完成');
  speak('error', '新错误可提醒');
  assert.deepEqual(spoken, ['新错误可提醒']);
});
