/** 连续聊天的最小本地事件；音频、身份、任意上游错误都不出现在此契约中。 */
export type ConversationEvent =
  | { type: 'ready'; model: string; source?: string }
  | { type: 'partial' | 'user' | 'text'; text: string }
  | { type: 'model'; model: string }
  | { type: 'reply' | 'interrupted' | 'ping' }
  | { type: 'done'; text?: string }
  | { type: 'error'; message: string; fatal: boolean };
