import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBalancePoll, type BalancePollInput } from './balance-poll.ts';

test('local account quotas reach the original balance state without reading API credentials', async () => {
  const writes: Array<{ section: string; data: unknown }> = [];
  const success = {
    ok: true,
    provider: 'codex',
    shape: 'custom',
    data: { percent: 80, rows: { tag: 'div', text: 'Codex 剩余 20%' } },
  };
  const poll = createBalancePoll({
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'standalone', model: 'default' }) },
      credentials: { resolve: () => assert.fail('不应解析 API 密钥') },
      get: () => assert.fail('不应调用 DSH 账号服务'),
    },
    standaloneAiBalance: () => ({ provider: 'codex', apiKey: '', query: async () => success }),
    state: {
      writeSection: (section: string, data: unknown) => {
        writes.push({ section, data });
      },
    },
    log: { info() {}, warn() {} },
  } as unknown as BalancePollInput);
  await poll.refreshBalance(true, 'main');
  assert.deepEqual(writes, [{ section: 'balance', data: { ...success, manual: true, petId: 'main' } }]);
});
