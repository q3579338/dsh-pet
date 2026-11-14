/**
 * `@deepseek-ai/dsh-llm` 的独立模式替身：消息工厂、文本块拼装与 reasoning 标识。
 *
 * 独立模式由本机连接层提供模型，这里只兼容宿主的消息与流形状。
 * 形状必须与 DSH 契约一致：配置里显式写了模型时，生成侧会真的走到这里。
 * 只在独立模式构建里生效，由 alias 指向本文件。
 * @module dsh-pet/src/standalone/shims/dsh-llm
 */

/** 消息的最小形状：只有角色、内容与来源。 */
export interface StandaloneLlmMessage {
  role: 'user' | 'assistant';
  content: unknown;
  source: unknown;
}

/** 创建用户消息。 */
export function createUserMessage(input: { content: unknown; source: unknown }): StandaloneLlmMessage {
  return { role: 'user', content: input.content, source: input.source };
}

/** 创建助手消息。 */
export function createAssistantMessage(input: { content: unknown; source: unknown }): StandaloneLlmMessage {
  return { role: 'assistant', content: input.content, source: input.source };
}

/** 文本块形状。 */
export interface StandaloneTextBlock {
  type: 'text';
  text: string;
}

/** 兼容本机文本块与宿主 text-delta，并保留明确的流终止原因。 */
export class BlockAssembler {
  /** 宿主 finish.reason；本机连接层直接抛错时为空。 */
  finish: unknown;
  /** 已收集的文本片段。 */
  private readonly chunks: string[] = [];

  /** 收集一个文本块；其他类型忽略。 */
  push(chunk: unknown): void {
    if (chunk !== null && typeof chunk === 'object') {
      const block = chunk as { type?: unknown; text?: unknown; reason?: unknown };
      if (block.type === 'finish') this.finish = block.reason;
      if (block.type !== 'text' && block.type !== 'text-delta') return;
      const text = block.text;
      if (typeof text === 'string') this.chunks.push(text);
    }
  }

  /** 返回当前拼装结果。 */
  blocks(): StandaloneTextBlock[] {
    const text = this.chunks.join('');
    return text === '' ? [] : [{ type: 'text', text }];
  }
}

/** reasoning effort 标识工厂：原样返回传入值。 */
export function ReasoningEffortId(id: string): string {
  return id;
}
