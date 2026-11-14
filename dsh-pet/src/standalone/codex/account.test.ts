import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAccountReader } from './account.ts';
import { parseCodexAccount } from './account-parse.ts';
import { codexAccountBalance } from './account-view.ts';
import { toBalanceState } from '../../shared/balance/parse.ts';

const updatedAt = Date.parse('2026-11-15T01:00:00Z');
const account = { account: { type: 'chatgpt', planType: 'pro', email: 'PRIVATE_EMAIL' }, userId: 'PRIVATE_ID' };
const bucket = {
  limitId: 'codex',
  planType: 'pro',
  primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: updatedAt / 1000 + 3600 },
  secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: updatedAt / 1000 + 86400 },
  credits: { balance: '12.3400', hasCredits: true, unlimited: false },
};
const limits = {
  rateLimits: bucket,
  ordinaryUsageAllowed: false,
  rateLimitResetCredits: { availableCount: 0, credits: [{ id: 'PRIVATE_RESET_ID' }] },
  accountId: 'PRIVATE_ID',
};
const usage = {
  summary: { lifetimeTokens: 123456, peakDailyTokens: 12345, currentStreakDays: 0 },
  dailyUsageBuckets: [{ startDate: '2026-11-15', tokens: 0 }],
};

test('Codex quota keeps real units, nulls and server-blocked state without exposing account identity', () => {
  const snapshot = parseCodexAccount(account, limits, usage, updatedAt);
  const result = codexAccountBalance(snapshot);
  const text = JSON.stringify(result);
  assert.equal(text.includes('PRIVATE_'), false);
  assert.match(text, /5小时额度：剩余 75%/);
  assert.match(text, /7天额度：剩余 15%/);
  assert.match(text, /12\.3400 Credits/);
  assert.match(text, /服务端暂不允许使用/);
  assert.match(text, /可用重置次数：0/);
  assert.match(text, /2026-11-15 Token：0/);
  assert.equal(result.shape === 'custom' && result.data.percent, 85);
  assert.equal(toBalanceState(result)?.ok, true, '原版共享解析器必须接受新账户气泡');
  assert.equal(snapshot.connection, 'chatgpt');
  assert.equal(snapshot.plan, 'pro');
  const unknown = codexAccountBalance(
    parseCodexAccount(
      account,
      { rateLimits: { primary: { usedPercent: null }, credits: { balance: null } } },
      { summary: { lifetimeTokens: null } },
      updatedAt,
    ),
  );
  assert.doesNotMatch(JSON.stringify(unknown), /剩余 100%|累计 Token：0|0 Credits/);
  assert.equal(unknown.shape === 'custom' && unknown.data.percent, undefined);
});

test('multiple Codex buckets stay within the original four-page contract and expired reset times do not claim recovery', () => {
  const byId = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => ['model-' + index, { ...bucket, limitId: 'model-' + index }]),
  );
  byId.codex = { ...bucket, primary: { ...bucket.primary, resetsAt: 1 } };
  const snapshot = parseCodexAccount(account, { rateLimitsByLimitId: byId }, usage, updatedAt);
  const result = codexAccountBalance(snapshot);
  assert.equal(snapshot.quotas[0].id, 'codex');
  assert.equal(snapshot.omittedQuotaCount, 6);
  assert.equal(result.shape === 'custom' && result.data.views?.length, 4);
  assert.equal(toBalanceState(result)?.ok, true);
  assert.match(JSON.stringify(result), /等待刷新/);
  assert.doesNotMatch(JSON.stringify(result), /已恢复|已重置/);
  const unlimited = codexAccountBalance(
    parseCodexAccount(
      account,
      { rateLimits: { credits: { unlimited: true, hasCredits: false, balance: null } } },
      undefined,
      updatedAt,
    ),
  );
  assert.match(JSON.stringify(unlimited), /额外点数：不限额/);
  assert.equal(unlimited.shape === 'custom' && unlimited.data.percent, undefined);
});

test('account reads are single-flight, cached and limited to read methods; an expired success is never reused after failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-account-'));
  let clock = updatedAt;
  let fail = false;
  let starts = 0;
  let closes = 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const reader = createCodexAccountReader(root, {
    now: () => clock,
    createClient: () => {
      starts++;
      return {
        initialize: async () => {},
        close: () => {
          closes++;
        },
        request: async (method, params) => {
          calls.push({ method, params });
          if (fail) throw new Error('PRIVATE_ERROR');
          return method === 'account/read' ? account : method === 'account/rateLimits/read' ? limits : usage;
        },
      };
    },
  });
  try {
    const [first, second] = await Promise.all([reader.read(), reader.read()]);
    assert.equal(first, second);
    assert.equal(first.ok, true);
    await reader.read();
    assert.equal(starts, 1);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['account/read', 'account/rateLimits/read', 'account/usage/read'],
    );
    assert.deepEqual(calls[1].params, { excludeResetCreditDetails: true, supportsLunaReserve: false });
    clock += 30001;
    fail = true;
    const failed = await reader.read();
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify(failed).includes('PRIVATE_ERROR'), false);
    assert.equal(closes, 2);
    reader.dispose();
    assert.equal((await reader.read()).ok, false);
    assert.equal(starts, 2);
  } finally {
    reader.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('API-key-only and signed-out accounts give actionable failures; a failed activity read keeps real quotas visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-account-modes-'));
  try {
    for (const kind of ['apiKey', 'signedOut', 'partial']) {
      const reader = createCodexAccountReader(root, {
        createClient: () => ({
          initialize: async () => {},
          close() {},
          request: async (method) => {
            if (method === 'account/read')
              return kind === 'signedOut'
                ? { account: null, requiresOpenaiAuth: true }
                : kind === 'apiKey'
                  ? { account: { type: 'apiKey' } }
                  : account;
            if (kind === 'partial' && method === 'account/rateLimits/read') return limits;
            throw new Error('PRIVATE_ERROR');
          },
        }),
      });
      const result = await reader.read();
      assert.equal(result.ok, kind === 'partial');
      if (!result.ok) assert.equal(result.reason, kind === 'apiKey' ? 'unsupported' : 'credential-missing');
      else assert.match(JSON.stringify(result), /统计暂不可读/);
      reader.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
