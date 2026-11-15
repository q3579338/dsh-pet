import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registerSpeechProvider, resetSpeechProviders } from './speech-registry.ts';
import { createHearService } from './hear.ts';
afterEach(resetSpeechProviders);

test('识别跟随连接来源，显式请求另一家也不能混用；切换后目录立即更新', async () => {
  const calls: string[] = [];
  for (const id of ['codex', 'workbuddy'])
    registerSpeechProvider({
      id,
      name: id,
      transcribe: async () => {
        calls.push(id);
        return id + '识别';
      },
    });
  let source = 'workbuddy';
  const speech = createHearService({ configuredProvider: () => 'codex', source: () => source });
  assert.deepEqual(
    speech.list().providers.map((p) => p.id),
    ['workbuddy'],
  );
  const audio = Buffer.from([1, 2, 3]).toString('base64');
  const blocked = await speech.hear({ audio, provider: 'codex' });
  assert.equal(blocked.ok, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(await speech.hear({ audio }), { ok: true, text: 'workbuddy识别' });
  source = 'codex';
  assert.deepEqual(
    speech.list().providers.map((p) => p.id),
    ['codex'],
  );
  assert.deepEqual(await speech.hear({ audio }), { ok: true, text: 'codex识别' });
  source = 'other';
  assert.equal((await speech.hear({ audio })).ok, false);
  assert.deepEqual(speech.list().providers, []);
  assert.deepEqual(calls, ['workbuddy', 'codex']);
});
test('识别进行中切换来源，旧来源的结果不填进新来源聊天', async () => {
  let source = 'codex',
    release!: (text: string) => void;
  registerSpeechProvider({
    id: 'codex',
    name: 'Codex',
    transcribe: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const speech = createHearService({ source: () => source });
  const pending = speech.hear({ audio: 'AAECAw==' });
  source = 'workbuddy';
  release('旧来源文字');
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message ?? '', /来源已切换/u);
});
