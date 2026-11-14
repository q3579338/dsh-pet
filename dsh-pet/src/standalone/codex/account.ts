/**
 * 只读本机 Codex 账户：复用已有登录，单飞查询并短时缓存额度和活动统计。
 * 仅调用三种读取方法，不调用登录变更、充值、重置兑换或邮件接口。
 * 连接和定时器归本实例所有，服务释放时立即结束查询，不把原始账户响应落盘。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodexClient, codexRecord } from './client.ts';
import { parseCodexAccount } from './account-parse.ts';
import { codexAccountBalance } from './account-view.ts';
import type { BalanceResult } from '../../host/balance/types.ts';

interface AccountDependencies {
  createClient?: (cwd: string) => Pick<CodexClient, 'initialize' | 'request' | 'close'>;
  now?: () => number;
}

/** 缺失数据给出固定原因，原始 RPC 错误和账号标识不进入界面与日志。 */
function failed(
  message: string,
  reason: 'fetch-error' | 'unsupported' | 'credential-missing' = 'fetch-error',
): BalanceResult {
  return { ok: false, provider: 'codex', reason, message };
}

/** 同一实例供设置页和原版余额轮询共用，连续点击只会产生一次读取。 */
export function createCodexAccountReader(home: string, dependencies: AccountDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const createClient = dependencies.createClient ?? ((cwd: string) => new CodexClient(cwd));
  let disposed = false;
  let active: ReturnType<typeof createClient> | undefined;
  let inFlight: Promise<BalanceResult> | undefined;
  let cached: { expiresAt: number; result: BalanceResult } | undefined;

  const fetchAccount = async (): Promise<BalanceResult> => {
    const workspace = join(home, 'codex-status');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      mkdirSync(workspace, { recursive: true });
      const client = createClient(workspace);
      active = client;
      timeout = setTimeout(() => client.close(new Error('Codex 账户查询超时。')), 15000);
      timeout.unref();
      await client.initialize();
      const results = await Promise.allSettled([
        client.request('account/read', { refreshToken: false }, 12000),
        client.request(
          'account/rateLimits/read',
          { excludeResetCreditDetails: true, supportsLunaReserve: false },
          12000,
        ),
        client.request('account/usage/read', {}, 12000),
      ]);
      const values = results.map((result) => (result.status === 'fulfilled' ? result.value : undefined));
      if (values.every((value) => value === undefined))
        return failed('暂时无法读取 Codex 账户，请检查本机 Codex 的登录和网络后重试。');
      const account = codexRecord(values[0]);
      const snapshot = parseCodexAccount(values[0], values[1], values[2], now());
      const hasUsage =
        snapshot.quotas.some((bucket) => bucket.primary || bucket.secondary || bucket.credits) ||
        Object.keys(snapshot.activity).length > 0 ||
        snapshot.ordinaryUsageAllowed !== undefined ||
        snapshot.resetCredits !== undefined;
      if (account.account === null && account.requiresOpenaiAuth === true)
        return failed('本机 Codex 尚未登录，请先在 Codex 登录后重试。', 'credential-missing');
      if (!hasUsage && snapshot.connection !== 'chatgpt')
        return failed(
          '当前 Codex 连接未提供订阅额度和用量；API Key 或第三方服务的余额请到对应服务商查看。',
          'unsupported',
        );
      if (!hasUsage && !snapshot.limitsRead && !snapshot.activityRead)
        return failed('已读取 Codex 账户，但额度和用量暂不可读，请稍后重试。');
      return codexAccountBalance(snapshot);
    } catch {
      return failed('暂时无法读取 Codex 账户，请检查本机 Codex 的登录和网络后重试。');
    } finally {
      if (timeout) clearTimeout(timeout);
      active?.close();
      active = undefined;
    }
  };

  return {
    /** 成功缓存三十秒、失败五秒；网络失败不会重新展示过期的成功数据。 */
    read(): Promise<BalanceResult> {
      if (disposed) return Promise.resolve(failed('账户查询服务已关闭。'));
      if (inFlight) return inFlight;
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.result);
      inFlight = fetchAccount()
        .then((result) => {
          if (!disposed) cached = { result, expiresAt: now() + (result.ok ? 30000 : 5000) };
          return result;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    /** 随大肥鱼退出而停止自己启动的连接，不退出用户的 Codex。 */
    dispose(): void {
      disposed = true;
      cached = undefined;
      active?.close();
    },
  };
}
