/** 一次合成的有界字节缓冲：同一任务可同时供完整缓存和多个流式订阅者读取。 */
export class SpeechStreamHub {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private ended = false;
  private failed = false;
  private listeners = new Set<() => void>();

  /** 缓冲区只属于这次任务，防止异常实现无限返回数据。 */
  push(bytes: Uint8Array): void {
    if (this.ended || !bytes.length) return;
    this.size += bytes.length;
    if (this.size > 8 * 1024 * 1024) throw new Error('voice output too large');
    this.chunks.push(new Uint8Array(bytes));
    this.wake();
  }
  /** 只在完整合成成功后结束；失败通知所有等待者。 */
  end(ok: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.failed = !ok;
    this.wake();
  }
  /** 生成缓存使用同一份音频内容，不再次调用上游。 */
  bytes(): Uint8Array {
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  /** 先确认首字节，再决定 HTTP 音频响应，初始失败仍可回结构化错误。 */
  async first(signal?: AbortSignal): Promise<void> {
    const reader = this.read(signal);
    try {
      const value = await reader.next();
      if (value.done) throw new Error('empty speech stream');
    } finally {
      await reader.return(undefined);
    }
  }
  /** 每个读者有自己的游标和取消监听，不消费掉其他读者的数据。 */
  async *read(signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    let index = 0;
    for (;;) {
      if (signal?.aborted) throw new Error('speech stream cancelled');
      if (index < this.chunks.length) {
        yield this.chunks[index++];
        continue;
      }
      if (this.ended) {
        if (this.failed) throw new Error('speech stream failed');
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.listeners.delete(wake);
          signal?.removeEventListener('abort', abort);
        };
        const wake = (): void => {
          cleanup();
          resolve();
        };
        const abort = (): void => {
          cleanup();
          reject(new Error('speech stream cancelled'));
        };
        this.listeners.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  private wake(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
