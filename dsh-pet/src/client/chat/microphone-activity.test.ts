import assert from 'node:assert/strict';
import { test } from 'node:test';
import { microphoneSpeechGate } from './microphone-activity.ts';

test('持续开口才触发，噪声和单帧点击不触发；静音后可再次打断', () => {
  let calls = 0;
  const feed = microphoneSpeechGate(() => {
    calls++;
  });
  for (let i = 0; i < 20; i++) feed(0.005, 22);
  feed(0.1, 22);
  for (let i = 0; i < 12; i++) feed(0, 22);
  assert.equal(calls, 0);
  for (let i = 0; i < 8; i++) feed(0.025, 22);
  assert.equal(calls, 1);
  for (let i = 0; i < 12; i++) feed(0, 22);
  for (let i = 0; i < 4; i++) feed(0.025, 22);
  assert.equal(calls, 2);
});
