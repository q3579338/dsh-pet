/** 短片展示至少持续一会儿；气泡仍在时延长，上限避免任何异常让角色永久循环。 */
export interface ChatAnimationHold {
  readonly name: string;
  readonly playbackId: string;
  readonly startedAt: number;
}

/** 只为同一段聊天动作续播，换动作、取消或到上限立即放行。 */
export function keepChatAnimation(
  hold: ChatAnimationHold | null | undefined,
  name: string,
  playbackId: string | null | undefined,
  bubbleVisible: boolean,
  now = Date.now(),
): boolean {
  if (!hold || hold.name !== name || hold.playbackId !== playbackId) return false;
  const elapsed = now - hold.startedAt;
  return elapsed >= 0 && elapsed < 30_000 && (elapsed < 8_000 || bubbleVisible);
}
