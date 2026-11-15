import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWindowsWave, WINDOWS_SPEECH_PROVIDER, WINDOWS_VOICE_PROVIDER } from './providers.ts';

test('local speech rejects non-wave input and already cancelled synthesis', async () => {
  assert.throws(() => validateWindowsWave(Buffer.from('invalid')), /WAV/);
  await assert.rejects(WINDOWS_SPEECH_PROVIDER.transcribe({ audio: Buffer.alloc(100) }), /WAV/);
  await assert.rejects(
    WINDOWS_VOICE_PROVIDER.synthesize({ text: '测试', voice: 'zh-CN', rate: 0, signal: AbortSignal.abort() }),
    /停止|Windows/,
  );
});

test(
  'installed Windows voice creates WAV and the installed Chinese recognizer recovers speech without playback',
  {
    skip: process.platform !== 'win32' || process.env.DSH_PET_TEST_LOCAL_SPEECH !== '1',
  },
  async () => {
    const audio = await WINDOWS_VOICE_PROVIDER.synthesize({ text: '你好，今天的天气很好。', voice: 'zh-CN', rate: 0 });
    validateWindowsWave(audio);
    const text = await WINDOWS_SPEECH_PROVIDER.transcribe({ audio });
    assert.match(text, /天气很好/);
  },
);
