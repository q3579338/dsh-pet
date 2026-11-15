/** WorkBuddy 自己的订阅与积分，只展示实际读到的数字。 */
import type { BalanceResult } from '../../host/balance/types.ts';
import type { WorkBuddyQuota } from './events.ts';
export function workBuddyAccountBalance(value: WorkBuddyQuota): BalanceResult {
  const credits = (number: number): string =>
    number > 0 && number < 0.01
      ? '不足0.01'
      : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(number);
  return {
    ok: true,
    provider: 'workbuddy',
    shape: 'custom',
    data: {
      ...(value.total > 0 ? { percent: Math.min(100, (value.used / value.total) * 100) } : {}),
      views: [
        {
          tag: 'div',
          children: [
            { tag: 'strong', text: 'WorkBuddy · ' + (value.plan || '当前套餐') },
            { tag: 'div', text: '剩余 ' + credits(value.left) + ' 积分' },
            { tag: 'div', text: '本期已用 ' + credits(value.used) + ' / ' + credits(value.total) + ' 积分' },
          ],
        },
      ],
    },
  };
}
