/** 工作状态台词的低优先级播报；进行中提示限频，聊天和用户点播优先。 */
import { isVoiceBusy, isVoiceNotifyEnabled, speakNotice } from './voice.ts';
import type { WorkStatusState } from './work-status.ts';

/** 状态变化只消费一次，关闭或忙碌期间的旧提示不会补念。 */
export function createWorkStatusSpeaker(deps: {
  enabled(): boolean;
  busy(): boolean;
  speak(text: string): void;
  now(): number;
}): (state: WorkStatusState | null, text: string | null) => void {
  let previous: WorkStatusState | null = null;
  let spokenAt = -Infinity;
  return (state, text) => {
    if (state === previous) return;
    previous = state;
    if (!state || !text || !deps.enabled() || deps.busy()) return;
    const now = deps.now();
    const urgent = state === 'waiting' || state === 'success' || state === 'error';
    if (!urgent && now - spokenAt < 15000) return;
    spokenAt = now;
    deps.speak(text);
  };
}

/** 桌面端只传配置中的角色台词，不传任务详情、日志或路径。 */
export const speakDesktopWorkStatus = createWorkStatusSpeaker({
  enabled: isVoiceNotifyEnabled,
  busy: isVoiceBusy,
  speak: speakNotice,
  now: Date.now,
});
