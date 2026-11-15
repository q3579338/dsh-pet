import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIVE_VOICE_STYLE, LIVE_VOICE_STYLES, liveVoiceStyle } from './live-voice-style.ts';

test('原生风格只调整语气，自然原声不附加声音指令', () => {
  assert.ok(liveVoiceStyle(DEFAULT_LIVE_VOICE_STYLE)?.instructions.includes('轻盈'));
  assert.ok(liveVoiceStyle('moon')?.instructions.includes('柔和'));
  assert.equal(liveVoiceStyle('natural')?.instructions, '');
  assert.equal(liveVoiceStyle('unknown'), undefined);
  assert.equal(new Set(LIVE_VOICE_STYLES.map((style) => style.id)).size, LIVE_VOICE_STYLES.length);
  for (const style of LIVE_VOICE_STYLES) {
    assert.ok(!JSON.stringify(style).includes('edge/'));
    if (style.id !== 'natural') assert.ok(style.instructions.includes('普通话'));
  }
});
