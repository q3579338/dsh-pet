import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createCodexSpeechProvider, ensureCodexSpeech } from './provider.ts';
import { resolveSpeechProvider, resetSpeechProviders } from '../speech-registry.ts';
import { postCodexDictation, CODEX_DICTATION_ENDPOINT } from './http.ts';
afterEach(resetSpeechProviders);
const wave = Buffer.alloc(44);
wave.write('RIFF');
wave.write('WAVE', 8);
const identity = async () => ({ token: 'test-only-token', accountId: 'test-account' });

test('真实录音交给 Codex 转写；不调用 Windows 识别或改写文字', async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = createCodexSpeechProvider({
    identity,
    post: async (audio, auth, signal) => {
      calls++;
      assert.equal(audio, wave);
      assert.equal(auth.token, 'test-only-token');
      assert.equal(signal, controller.signal);
      return { status: 200, text: ' 大肥鱼，原来是一条鱼。 ' };
    },
  });
  assert.equal(await provider.transcribe({ audio: wave, signal: controller.signal }), '大肥鱼，原来是一条鱼。');
  assert.equal(calls, 1);
});

test('仅 401 刷新身份重试一次，其他拒绝不重放录音', async () => {
  const refreshes: boolean[] = [];
  let calls = 0;
  const provider = createCodexSpeechProvider({
    identity: async (_signal, refresh) => {
      refreshes.push(refresh === true);
      return { token: 'test-' + refresh };
    },
    post: async () => (++calls === 1 ? { status: 401 } : { status: 200, text: '已识别' }),
  });
  assert.equal(await provider.transcribe({ audio: wave }), '已识别');
  assert.deepEqual(refreshes, [false, true]);
  for (const status of [403, 429, 500]) {
    let attempts = 0;
    await assert.rejects(
      createCodexSpeechProvider({
        identity,
        post: async () => {
          attempts++;
          return { status };
        },
      }).transcribe({ audio: wave }),
    );
    assert.equal(attempts, 1);
  }
});

test('错误不回显凭据或任意上游正文，坏录音不取得登录', async () => {
  await assert.rejects(
    createCodexSpeechProvider({
      identity,
      post: async () => {
        throw Error('Bearer test-only-secret');
      },
    }).transcribe({ audio: wave }),
    (error) => error instanceof Error && !error.message.includes('secret'),
  );
  let read = false;
  await assert.rejects(
    createCodexSpeechProvider({
      identity: async () => {
        read = true;
        return identity();
      },
    }).transcribe({ audio: new Uint8Array([1]) }),
  );
  assert.equal(read, false);
});

test('听写上传固定官方入口，禁重定向，录音和登录凭据分别位于正文与请求头', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, CODEX_DICTATION_ENDPOINT);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-only-token');
    const form = init?.body as FormData;
    assert.equal(form.get('language'), 'zh');
    assert.deepEqual(new Uint8Array(await (form.get('file') as Blob).arrayBuffer()), new Uint8Array(wave));
    assert.equal(form.has('token'), false);
    return new Response(JSON.stringify({ text: '原来是一条鱼', asset_pointer: 'discard-this-reference' }));
  };
  assert.deepEqual(await postCodexDictation(wave, await identity(), undefined, fetcher), {
    status: 200,
    text: '原来是一条鱼',
  });
});

test('Codex 识别实现独立注册，重复装配不重复登记', () => {
  ensureCodexSpeech();
  ensureCodexSpeech();
  assert.equal(resolveSpeechProvider('codex')?.name, 'Codex 听写（云端中文识别）');
});
