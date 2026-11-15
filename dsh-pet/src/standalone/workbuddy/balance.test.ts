import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStandaloneAi } from '../ai-provider/create.ts';
import { workBuddyEvents } from './events.ts';

test('余额查询按本次明确选择的来源，未保存的界面切换也不误查另一家', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fish-balance-source-'));
  const calls: string[] = [];
  const ai = createStandaloneAi(
    home,
    { info() {}, warn() {}, error() {}, debug() {} },
    {
      codexAccount: {
        read: async () => {
          calls.push('codex');
          return { ok: true, provider: 'codex', shape: 'points', data: { unit: 'Credits', total: '12' } };
        },
        dispose() {},
      },
      workbuddy: {
        models: async () => [],
        test: async () => ({ reply: '' }),
        dispose() {},
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield { text: 'unused' };
          },
        }),
        balance: async () => {
          calls.push('workbuddy');
        return { plan: '测试套餐', total: 10000, left: 8765.43, used: 1234.57 };
        },
      },
    },
  );
  try {
    await ai.saveSettings({ protocol: 'workbuddy', model: 'deepseek-v4-flash' });
    assert.equal((await ai.queryBalance({ protocol: 'codex' })).provider, 'codex');
    assert.equal(ai.getSettings().protocol, 'workbuddy');
    const wb = await ai.queryBalance({ protocol: 'workbuddy' });
    assert.equal(wb.ok, true);
    assert.equal(wb.provider, 'workbuddy');
    assert.match(JSON.stringify(wb), /测试套餐/u);
    assert.match(JSON.stringify(wb), /8,765.43/u);
    assert.deepEqual(calls, ['codex', 'workbuddy']);
    await ai.saveSettings({ protocol: 'codex', model: 'default' });
    assert.equal((await ai.queryBalance({ protocol: 'workbuddy' })).provider, 'workbuddy');
    assert.equal((await ai.queryBalance()).provider, 'codex');
    assert.equal(ai.getSettings().protocol, 'codex');
  } finally {
    ai.dispose();
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
test('WorkBuddy 额度只解析数字与套餐名，非法数字拒绝，额外身份字段被丢弃', () => {
  const events = workBuddyEvents();
  const value = events.accept(
    JSON.stringify({ type: 'balance', balance: { plan: '体验版', total: 1, left: 0, used: 1, token: 'discard' } }),
  );
  assert.deepEqual(value.balance, { plan: '体验版', total: 1, left: 0, used: 1 });
  assert.throws(() => workBuddyEvents().accept('{"type":"balance","balance":{"plan":"","left":null}}'));
});
