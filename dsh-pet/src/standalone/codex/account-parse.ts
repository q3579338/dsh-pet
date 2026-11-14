/** 只读取 Codex 官方账户响应的展示字段；缺省和 null 不转换成零。 */
import { codexRecord } from './client.ts';
import type {
  CodexAccountSnapshot,
  CodexCredits,
  CodexQuotaBucket,
  CodexQuotaWindow,
  CodexTokenActivity,
} from './account-types.ts';

/** 超出 JS 精确整数范围的数据不参与额度展示。 */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 只用于界面标签，不承接 HTML、URL 或样式。 */
function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : undefined;
}

/** 真实的零用量有效，非法百分比保持未知。 */
function windowOf(value: unknown): CodexQuotaWindow | undefined {
  const raw = codexRecord(value);
  const usedPercent = count(raw.usedPercent);
  if (usedPercent === undefined) return undefined;
  const durationMins = count(raw.windowDurationMins);
  const resetsAt = count(raw.resetsAt);
  return {
    usedPercent,
    ...(durationMins ? { durationMins } : {}),
    ...(resetsAt && resetsAt < 253402300800 ? { resetsAt } : {}),
  };
}

/** 点数精度和正负号原样保留，空串和非数字不当余额。 */
function creditsOf(value: unknown): CodexCredits | undefined {
  const raw = codexRecord(value);
  const balance =
    typeof raw.balance === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw.balance) && raw.balance.length <= 64
      ? raw.balance
      : undefined;
  if (balance === undefined && typeof raw.hasCredits !== 'boolean' && typeof raw.unlimited !== 'boolean')
    return undefined;
  return {
    ...(balance !== undefined ? { balance } : {}),
    ...(typeof raw.hasCredits === 'boolean' ? { hasCredits: raw.hasCredits } : {}),
    ...(typeof raw.unlimited === 'boolean' ? { unlimited: raw.unlimited } : {}),
  };
}

/** 不采用任意嵌套字段，避免把账号标识和服务端文案带进状态叶子。 */
function bucketOf(id: string, value: unknown): CodexQuotaBucket {
  const raw = codexRecord(value);
  return {
    id: label(raw.limitId) ?? id.slice(0, 80),
    name: label(raw.limitName),
    primary: windowOf(raw.primary),
    secondary: windowOf(raw.secondary),
    credits: creditsOf(raw.credits),
    reached: label(raw.rateLimitReachedType),
    ...(typeof raw.spendControlReached === 'boolean' ? { spendControlReached: raw.spendControlReached } : {}),
  };
}

/** 活动指标逐项验证；日期沿用服务端日桶，不推测统计时区。 */
function activityOf(value: unknown): CodexTokenActivity {
  const raw = codexRecord(value);
  const summary = codexRecord(raw.summary);
  const activity: Record<string, number> = {};
  for (const key of [
    'lifetimeTokens',
    'peakDailyTokens',
    'longestRunningTurnSec',
    'currentStreakDays',
    'longestStreakDays',
  ]) {
    const valid = count(summary[key]);
    if (valid !== undefined) activity[key] = valid;
  }
  const days = (Array.isArray(raw.dailyUsageBuckets) ? raw.dailyUsageBuckets.slice(-400) : [])
    .flatMap((item) => {
      const day = codexRecord(item);
      const tokens = count(day.tokens);
      const date =
        typeof day.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.startDate) ? day.startDate : undefined;
      return date && tokens !== undefined ? [{ date, tokens }] : [];
    })
    .sort((left, right) => right.date.localeCompare(left.date));
  return { ...activity, ...(days[0] ? { recentDay: days[0] } : {}) };
}

/** 多桶优先、旧单桶回落；最多五个桶适配原版四页气泡。 */
export function parseCodexAccount(
  accountValue: unknown,
  limitsValue: unknown,
  activityValue: unknown,
  updatedAt: number,
): CodexAccountSnapshot {
  const account = codexRecord(codexRecord(accountValue).account);
  const limits = codexRecord(limitsValue);
  const entries = Object.entries(codexRecord(limits.rateLimitsByLimitId));
  if (!entries.length && limits.rateLimits) entries.push(['codex', limits.rateLimits]);
  entries.sort(([left], [right]) => Number(right === 'codex') - Number(left === 'codex'));
  const quotas = entries.slice(0, 5).map(([id, value]) => bucketOf(id, value));
  const plan = label(account.planType) ?? label(codexRecord(entries[0]?.[1]).planType);
  const resetCredits = count(codexRecord(limits.rateLimitResetCredits).availableCount);
  return {
    connection: label(account.type),
    plan,
    quotas,
    omittedQuotaCount: Math.max(0, entries.length - quotas.length),
    ...(typeof limits.ordinaryUsageAllowed === 'boolean' ? { ordinaryUsageAllowed: limits.ordinaryUsageAllowed } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {}),
    activity: activityOf(activityValue),
    limitsRead: limitsValue !== undefined,
    activityRead: activityValue !== undefined,
    updatedAt,
  };
}
