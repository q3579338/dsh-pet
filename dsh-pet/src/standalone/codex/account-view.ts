/** 将账户快照画进原版多页余额气泡，百分比继续驱动原有额度动画。 */
import type { BalanceSuccess, CustomNode } from '../../host/balance/types.ts';
import type { CodexAccountSnapshot, CodexQuotaBucket, CodexQuotaWindow } from './account-types.ts';

/** 显示原窗口长度，不把所有主窗口都写死成五小时。 */
function windowLabel(window: CodexQuotaWindow, fallback: string): string {
  const minutes = window.durationMins;
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}天额度`;
  if (minutes % 60 === 0) return `${minutes / 60}小时额度`;
  return `${minutes}分钟额度`;
}

/** 重置时间仅展示时间；经过该时刻不代表后台已恢复额度。 */
function resetLabel(window: CodexQuotaWindow, updatedAt: number): string {
  if (!window.resetsAt) return '重置时间未提供';
  if (window.resetsAt * 1000 <= updatedAt) return '重置时间已到，等待刷新';
  return (
    new Date(window.resetsAt * 1000).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' 重置'
  );
}

/** 每行独立节点，桌面窄气泡可自然换行。 */
function page(title: string, lines: readonly string[]): CustomNode {
  return {
    tag: 'div',
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      maxWidth: '240px',
      fontSize: '12px',
      lineHeight: '1.4',
      whiteSpace: 'normal',
    },
    children: [{ tag: 'b', text: title }, ...lines.map((text): CustomNode => ({ tag: 'div', text }))],
  };
}

/** Credits 单独显示原始点数，未声明上限时不计算余额百分比。 */
function creditLines(bucket: CodexQuotaBucket): string[] {
  const credits = bucket.credits;
  if (!credits) return [];
  if (credits.unlimited === true) return ['额外点数：不限额'];
  if (credits.balance !== undefined) return [`额外点数：${credits.balance} Credits`];
  if (credits.hasCredits === false) return ['额外点数：无可用点数'];
  return ['额外点数：可用，数量未提供'];
}

/** 一个桶的两种窗口互相独立，不能拿缺失窗口替代零额度。 */
function quotaLines(bucket: CodexQuotaBucket, updatedAt: number): string[] {
  const lines: string[] = [];
  for (const [key, fallback] of [
    ['primary', '主窗口'],
    ['secondary', '次窗口'],
  ] as const) {
    const window = bucket[key];
    if (window)
      lines.push(
        `${windowLabel(window, fallback)}：剩余 ${Math.max(0, 100 - window.usedPercent)}%（已用 ${window.usedPercent}%）`,
        resetLabel(window, updatedAt),
      );
  }
  if (!lines.length) lines.push('窗口额度：未提供');
  lines.push(...creditLines(bucket));
  if (bucket.spendControlReached === true) lines.push('用量支出控制已触发');
  if (bucket.reached && bucket.reached !== 'none') lines.push('服务端报告额度限制');
  return lines;
}

/** 最多四页沿用原 custom 协议；不产生金额、额度分母或计费估算。 */
export function codexAccountBalance(snapshot: CodexAccountSnapshot): BalanceSuccess {
  const primary = snapshot.quotas[0];
  const heading = `Codex${snapshot.plan ? ' · ' + snapshot.plan : ''}`;
  const overview = primary ? quotaLines(primary, snapshot.updatedAt) : ['窗口额度：暂不可读'];
  if (snapshot.ordinaryUsageAllowed !== undefined)
    overview.push(snapshot.ordinaryUsageAllowed ? '常规额度：服务端允许使用' : '常规额度：服务端暂不允许使用');
  if (snapshot.resetCredits !== undefined) overview.push(`可用重置次数：${snapshot.resetCredits}`);
  overview.push('更新于 ' + new Date(snapshot.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }));
  const views = [page(heading, overview)];
  const activity = snapshot.activity;
  const stats: string[] = [];
  if (activity.lifetimeTokens !== undefined)
    stats.push(`累计 Token：${activity.lifetimeTokens.toLocaleString('zh-CN')}`);
  if (activity.recentDay)
    stats.push(`${activity.recentDay.date} Token：${activity.recentDay.tokens.toLocaleString('zh-CN')}`);
  if (activity.peakDailyTokens !== undefined)
    stats.push(`单日峰值 Token：${activity.peakDailyTokens.toLocaleString('zh-CN')}`);
  if (activity.currentStreakDays !== undefined) stats.push(`连续使用：${activity.currentStreakDays}天`);
  if (activity.longestStreakDays !== undefined) stats.push(`最长连续：${activity.longestStreakDays}天`);
  if (activity.longestRunningTurnSec !== undefined) stats.push(`最长回合：${activity.longestRunningTurnSec}秒`);
  views.push(
    page(
      'Token 活动',
      stats.length
        ? [...stats, '活动统计不代表账单金额']
        : [snapshot.activityRead ? '服务端暂未提供统计指标' : '统计暂不可读，请稍后刷新'],
    ),
  );
  for (const group of [snapshot.quotas.slice(1, 3), snapshot.quotas.slice(3, 5)]) {
    if (group.length)
      views.push(
        page(
          '其余额度',
          group.flatMap((bucket) => [bucket.name ?? bucket.id, ...quotaLines(bucket, snapshot.updatedAt)]),
        ),
      );
  }
  const percents = primary
    ? [primary.primary?.usedPercent, primary.secondary?.usedPercent].filter(
        (percent): percent is number => percent !== undefined,
      )
    : [];
  if (snapshot.omittedQuotaCount)
    views[views.length - 1].children?.push({
      tag: 'div',
      text: `另有 ${snapshot.omittedQuotaCount} 个额度桶，请在 Codex 查看`,
    });
  return {
    ok: true,
    provider: 'codex',
    shape: 'custom',
    data: { views, ...(percents.length ? { percent: Math.min(100, Math.max(...percents)) } : {}) },
  };
}
