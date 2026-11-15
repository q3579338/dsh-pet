import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCodexSpeechIdentity, type SpeechAuthClient } from './auth.ts';

test('听写身份只通过自己的 Codex 连接读取，完成即释放', async () => {
  const methods: string[] = [];
  let closed = 0;
  const client: SpeechAuthClient = {
    initialize: async () => {},
    close: () => {
      closed++;
    },
    request: async (method, params) => {
      methods.push(method);
      if (method === 'getAuthStatus') {
        assert.equal(params.includeToken, true);
        return { authMethod: 'chatgpt', authToken: 'test-only-token' };
      }
      return { account: { id: 'test-account' } };
    },
  };
  const identity = await readCodexSpeechIdentity(undefined, false, () => client);
  assert.deepEqual(identity, { token: 'test-only-token', accountId: 'test-account' });
  assert.deepEqual(methods, ['getAuthStatus', 'account/read']);
  assert.equal(closed, 1);
});

test('不将 API Key 当作 Codex 听写登录，身份失败也关闭自己的连接', async () => {
  let closed = 0;
  await assert.rejects(
    readCodexSpeechIdentity(undefined, false, () => ({
      initialize: async () => {},
      close: () => {
        closed++;
      },
      request: async () => ({ authMethod: 'apikey', authToken: 'test-only-key' }),
    })),
    /ChatGPT 账号/,
  );
  assert.equal(closed, 1);
});

test('取消后不启动连接；初始化失败会释放连接', async () => {
  let created = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readCodexSpeechIdentity(controller.signal, false, () => {
      created++;
      throw Error();
    }),
    /已停止/,
  );
  assert.equal(created, 0);
  let closed = 0;
  await assert.rejects(
    readCodexSpeechIdentity(undefined, false, () => ({
      initialize: async () => {
        throw Error('start failed');
      },
      close: () => {
        closed++;
      },
      request: async () => ({}),
    })),
    /start failed/,
  );
  assert.equal(closed, 1);
});
