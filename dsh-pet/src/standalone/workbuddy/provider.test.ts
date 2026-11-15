import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStandaloneAi } from '../ai-provider/create.ts';
import { WorkBuddyFailure } from './executable.ts';

test('WorkBuddy 协议无需 API Key，模型和测试走 WorkBuddy；即时语音不把 GLM 当成 Codex 模型', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fish-wb-service-'));
  const called: string[] = [];
  const ai = createStandaloneAi(
    home,
    { info() {}, warn() {}, error() {}, debug() {} },
    {
      fetch: async () => {
        throw Error('API credential must never be used');
      },
      workbuddy: {
        async models() {
          called.push('models');
          return [{ id: 'glm-5.0-turbo', name: 'GLM' }];
        },
        async test(model) {
          called.push('test:' + model);
          return { reply: '连接成功', modelUsed: model };
        },
        async *stream(model, request) {
          called.push('stream:' + model);
          assert.equal(request.messages[0].content, '你好');
          yield { text: '大肥鱼来啦' };
        },
        dispose() {
          called.push('dispose');
        },
      },
    },
  );
  try {
    await ai.saveSettings({
      protocol: 'workbuddy',
      model: 'glm-5.0-turbo',
      baseUrl: 'https://example.test',
      apiKey: 'saved_other_provider_key',
    });
    assert.equal(ai.isReady(), true);
    assert.equal(ai.codexVoiceModel?.(), 'default');
    assert.deepEqual(ai.balanceAuth(), { provider: '', apiKey: '' });
    assert.equal((await ai.queryBalance()).ok, false);
    assert.equal((await ai.discoverModels({ protocol: 'workbuddy' })).ok, true);
    assert.equal((await ai.testConnection({ protocol: 'workbuddy', model: 'glm-5.0-turbo' })).reply, '连接成功');
    let reply = '';
    for await (const part of ai.stream({
      provider: 'standalone',
      model: 'glm-5.0-turbo',
      messages: [{ role: 'user', content: '你好' }],
    }))
      reply += part.text;
    assert.equal(reply, '大肥鱼来啦');
    assert.deepEqual(called, ['models', 'test:glm-5.0-turbo', 'stream:glm-5.0-turbo']);
    assert.equal(JSON.stringify(ai.getSettings()).includes('saved_other_provider_key'), false);
  } finally {
    ai.dispose();
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('WorkBuddy 登录失败保留可重试连接，不伪造成功或回显任意 CLI 错误', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fish-wb-login-'));
  const ai = createStandaloneAi(
    home,
    { info() {}, warn() {}, error() {}, debug() {} },
    {
      workbuddy: {
        models: async () => [],
        test: async () => {
          throw new WorkBuddyFailure('请先登录 WorkBuddy。');
        },
        stream: () => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw Error('secret_credential');
              },
            };
          },
        }),
        dispose() {},
      },
    },
  );
  try {
    await ai.saveSettings({ protocol: 'workbuddy', model: 'auto' });
    assert.deepEqual(await ai.testConnection({ protocol: 'workbuddy' }), {
      ok: false,
      message: '请先登录 WorkBuddy。',
    });
    await assert.rejects(
      async () => {
        for await (const event of ai.stream({
          provider: 'standalone',
          model: 'auto',
          messages: [{ role: 'user', content: '你好' }],
        }))
          void event;
      },
      (e) => e instanceof Error && /WorkBuddy/u.test(e.message) && !e.message.includes('secret_credential'),
    );
    assert.equal(ai.isReady(), true);
  } finally {
    ai.dispose();
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('连续语音保留服务端型号、短句流式回答和取消；设置变化或底层错误不切换模型', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fish-wb-live-service-'));
  let bad = false,
    calls = 0;
  const ai = createStandaloneAi(
    home,
    { info() {}, warn() {}, error() {}, debug() {} },
    {
      workbuddy: {
        models: async () => [],
        test: async () => ({ reply: 'ok' }),
        dispose() {},
        async *stream(model, request, signal, maxTokens) {
          calls++;
          assert.equal(model, 'deepseek-v4-flash');
          assert.equal(maxTokens, 256);
          assert.equal(request.messages[0].content, '你好');
          assert.equal(signal.aborted, false);
          if (bad) throw Error('secret-internal-error');
          yield { modelUsed: model };
          yield { text: '来啦。' };
        },
      },
    },
  );
  const collect = async (signal = new AbortController().signal) => {
    const events = [];
    for await (const event of ai.voiceStream!(
      'deepseek-v4-flash',
      { system: '大肥鱼', messages: [{ role: 'user', content: '你好' }] },
      signal,
    ))
      events.push(event);
    return events;
  };
  try {
    await ai.saveSettings({ protocol: 'workbuddy', model: 'deepseek-v4-flash' });
    assert.deepEqual(ai.voiceSelection?.(), { protocol: 'workbuddy', model: 'deepseek-v4-flash' });
    assert.deepEqual(await collect(), [{ modelUsed: 'deepseek-v4-flash' }, { text: '来啦。' }]);
    await assert.rejects(collect(AbortSignal.abort()), /已停止/u);
    assert.equal(calls, 1);
    bad = true;
    await assert.rejects(collect(), (error) => error instanceof Error && !error.message.includes('secret'));
    bad = false;
    assert.equal((await collect()).length, 2);
    await ai.saveSettings({ protocol: 'codex', model: 'gpt-6-luna' });
    await assert.rejects(collect(), /模型设置/u);
  } finally {
    ai.dispose();
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
