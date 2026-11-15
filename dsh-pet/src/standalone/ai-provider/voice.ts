/** 连续语音只调用当前选择的 WorkBuddy 内置模型，沿用普通聊天的互斥与取消。 */
import type { AiRuntime } from './types.ts';
import type { AiRequest } from '../ai-transport.ts';
import type { WorkBuddyEvent } from '../workbuddy/connection.ts';
import { WorkBuddyFailure } from '../workbuddy/executable.ts';

/** 不带任务包装或工具，较短的回复尽早交给所选音色。 */
export async function* workBuddyVoiceStream(
  runtime: AiRuntime,
  model: string,
  request: AiRequest,
  signal: AbortSignal,
): AsyncIterable<WorkBuddyEvent> {
  const settings = runtime.store.current();
  if (!runtime.ready() || settings.protocol !== 'workbuddy' || settings.model !== model)
    throw new WorkBuddyFailure('语音模型设置已变化，请结束后重新开始。');
  if (runtime.active) throw new WorkBuddyFailure('模型正在回复，请稍后继续说话。');
  const abort = new AbortController();
  runtime.active = abort;
  const combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(30000)]);
  try {
    combined.throwIfAborted();
    for await (const event of runtime.workbuddy!.stream(model, request, combined, 256)) {
      combined.throwIfAborted();
      if (
        !runtime.ready() ||
        runtime.store.current().model !== model ||
        runtime.store.current().protocol !== 'workbuddy'
      )
        throw new WorkBuddyFailure('语音模型设置已变化，请重新开始。');
      yield event;
    }
  } catch (error) {
    if (combined.aborted) throw new WorkBuddyFailure('WorkBuddy 回复已停止或超时，请继续说话重试。');
    throw error instanceof WorkBuddyFailure ? error : new WorkBuddyFailure('WorkBuddy 暂未能回复，请检查登录和网络。');
  } finally {
    abort.abort();
    if (runtime.active === abort) runtime.active = undefined;
  }
}
