/** Codex 与原桌宠会话监听之间的最小事件契约。 */

/** 只携带状态，桌面会话的正文、工具参数和输出不进入桌宠。 */
export interface CodexSessionEvent {
  readonly sessionId: string;
  readonly event: { type: string; seq?: number; data?: Record<string, unknown> };
}

/** 本实例的事件出口；监听器随 AI 服务释放。 */
export type CodexEventSink = (event: CodexSessionEvent) => void;

/** 连接一次异步通知流；结束或异常后不再接受数据。 */
export class CodexQueue<T> {
  private readonly buffered: T[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private failure: Error | undefined;

  /** 消费较慢时限制积压，避免子进程无界占用内存。 */
  push(value: T): void {
    if (this.ended) return;
    if (this.buffered.length >= 4096) return this.fail(new Error('Codex 返回的事件过多，请重试。'));
    this.buffered.push(value);
    this.wake?.();
  }

  /** 已缓冲的数据仍会被消费。 */
  end(): void {
    this.ended = true;
    this.wake?.();
  }

  /** 异常优先于尚未消费的缓冲，避免取消后继续显示迟到输出。 */
  fail(error: Error): void {
    this.failure = error;
    this.end();
  }

  /** 等待下一个事件或终态。 */
  async *read(): AsyncGenerator<T> {
    while (true) {
      if (this.failure) throw this.failure;
      if (this.buffered.length) yield this.buffered.shift()!;
      else if (this.ended) return;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
