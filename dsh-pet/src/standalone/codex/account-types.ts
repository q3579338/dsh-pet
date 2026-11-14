/** Codex 账户的最小展示数据：只保留套餐、额度和活动统计。 */

/** 服务端窗口的已用比例；重置时间为 Unix 秒。 */
export interface CodexQuotaWindow {
  readonly usedPercent: number;
  readonly durationMins?: number;
  readonly resetsAt?: number;
}

/** Credits 保留接口单位，不折算成现金。 */
export interface CodexCredits {
  readonly balance?: string;
  readonly hasCredits?: boolean;
  readonly unlimited?: boolean;
}

/** 每个额度桶的窗口和点数互相独立。 */
export interface CodexQuotaBucket {
  readonly id: string;
  readonly name?: string;
  readonly primary?: CodexQuotaWindow;
  readonly secondary?: CodexQuotaWindow;
  readonly credits?: CodexCredits;
  readonly reached?: string;
  readonly spendControlReached?: boolean;
}

/** Token 活动不是账单金额；未提供的指标保持缺省。 */
export interface CodexTokenActivity {
  readonly lifetimeTokens?: number;
  readonly peakDailyTokens?: number;
  readonly longestRunningTurnSec?: number;
  readonly currentStreakDays?: number;
  readonly longestStreakDays?: number;
  readonly recentDay?: { readonly date: string; readonly tokens: number };
}

/** 经过白名单解析的账户快照，不含邮箱、账号 ID 或任何凭据。 */
export interface CodexAccountSnapshot {
  readonly connection?: string;
  readonly plan?: string;
  readonly quotas: readonly CodexQuotaBucket[];
  readonly omittedQuotaCount: number;
  readonly ordinaryUsageAllowed?: boolean;
  readonly resetCredits?: number;
  readonly activity: CodexTokenActivity;
  readonly limitsRead: boolean;
  readonly activityRead: boolean;
  readonly updatedAt: number;
}
