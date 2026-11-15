/** 连续聊天专用的单连接租用器：只复用已完整结束的一段，取消或出错立即丢弃连接。 */
export interface SpeechSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/** 每一租用的结束事件只交付一次，旧轮事件不得进入新轮。 */
type Lease = SpeechSocket & { requestId?: string; ended: boolean; complete: boolean };
type Slot = { raw: SpeechSocket; lease?: Lease; timer?: ReturnType<typeof setTimeout> };
interface SpeechConnectionPool {
  prepare(owner: string, active: boolean): Promise<boolean>;
  take(fallback: () => SpeechSocket): SpeechSocket;
}

/** 仅解析帧头来核对请求编号；正文与实际音频继续由原 SDK 处理。 */
function headers(data: unknown): string {
  if (typeof data === 'string') return data.split('\r\n\r\n', 1)[0];
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : undefined;
  if (!bytes || bytes.length < 2) return '';
  return new TextDecoder().decode(bytes.subarray(2, Math.min(bytes.length, 2 + ((bytes[0] << 8) | bytes[1]))));
}

/** 没有通话所有者时完全沿用一次性连接；空闲连接有界，到期后下一次开口再准备。 */
export function createSpeechConnectionPool(options: {
  connect(): Promise<SpeechSocket>;
  idleMs?: number;
}): SpeechConnectionPool {
  let owner: string | undefined;
  let slot: Slot | undefined;
  let opening: Promise<boolean> | undefined;
  let generation = 0;
  let warmRetryAt = 0;
  let replenish: ReturnType<typeof setTimeout> | undefined;
  const retired = new Set<string>();
  const drop = (entry: Slot, replace = false): void => {
    clearTimeout(entry.timer);
    if (slot === entry) slot = undefined;
    entry.raw.close();
    if (replace && owner && !slot) {
      clearTimeout(replenish);
      const attempt = generation;
      replenish = setTimeout(() => {
        replenish = undefined;
        if (owner && generation === attempt) void pool.prepare(owner, true);
      }, 80);
      replenish.unref?.();
    }
  };
  const idle = (entry: Slot): void => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!entry.lease) drop(entry);
    }, options.idleMs ?? 18000);
    entry.timer.unref?.();
  };
  const end = (lease: Lease | undefined, event: unknown): void => {
    if (!lease || lease.ended) return;
    lease.ended = true;
    lease.onclose?.(event);
  };
  const pool: SpeechConnectionPool = {
    /** 只建连接，不上传预设台词或生成垫话；迟到的已结束通话不能重新占用连接。 */
    async prepare(id: string, active: boolean): Promise<boolean> {
      if (!active) {
        retired.add(id);
        if (retired.size > 64) retired.delete(retired.values().next().value!);
        if (owner === id) {
          clearTimeout(replenish);
          owner = undefined;
          generation++;
          opening = undefined;
          if (slot) drop(slot);
        }
        return false;
      }
      if (retired.has(id)) return false;
      if (owner !== id) {
        clearTimeout(replenish);
        owner = id;
        generation++;
        opening = undefined;
        if (slot && !slot.lease) drop(slot);
      }
      if (slot && slot.raw.readyState <= 1) return true;
      if (opening) return opening;
      if (Date.now() < warmRetryAt) return false;
      const attempt = generation;
      const work = (async () => {
        try {
          const raw = await options.connect();
          if (attempt !== generation || owner !== id) {
            raw.onerror = () => {};
            raw.close();
            return false;
          }
          const entry: Slot = { raw };
          slot = entry;
          raw.binaryType = 'arraybuffer';
          raw.onopen = (event) => entry.lease?.onopen?.(event);
          raw.onmessage = (event) => {
            const lease = entry.lease;
            if (!lease || lease.ended) return;
            const head = headers(event.data);
            const requestId = /(?:^|\r\n)X-RequestId:([^\r\n]+)/iu.exec(head)?.[1]?.trim();
            if (requestId && lease.requestId && requestId !== lease.requestId) return;
            if (/(?:^|\r\n)Path:turn\.end(?:\r\n|$)/iu.test(head)) lease.complete = true;
            lease.onmessage?.(event);
          };
          raw.onerror = (event) => {
            warmRetryAt = Date.now() + 15000;
            if (slot === entry) slot = undefined;
            clearTimeout(entry.timer);
            entry.lease?.onerror?.(event);
            raw.close();
          };
          raw.onclose = (event) => {
            if (slot === entry) slot = undefined;
            clearTimeout(entry.timer);
            end(entry.lease, event);
          };
          idle(entry);
          return true;
        } catch {
          warmRetryAt = Date.now() + 15000;
          return false;
        } finally {
          if (attempt === generation) opening = undefined;
        }
      })();
      opening = work;
      return work;
    },
    /** SDK 仍负责 SSML、声音参数与协议；只把“本段结束”与“物理断连”分开。 */
    take(fallback: () => SpeechSocket): SpeechSocket {
      const entry = slot;
      if (!owner || !entry || entry.lease || entry.raw.readyState > 1) return fallback();
      clearTimeout(entry.timer);
      const lease: Lease = {
        binaryType: 'arraybuffer',
        ended: false,
        complete: false,
        get readyState() {
          return entry.raw.readyState;
        },
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(data) {
          if (/(?:^|\r\n)Path:ssml(?:\r\n|$)/iu.test(data))
            lease.requestId = /(?:^|\r\n)X-RequestId:([^\r\n]+)/iu.exec(data)?.[1]?.trim();
          try {
            entry.raw.send(data);
          } catch (error) {
            lease.onerror?.({ error });
            drop(entry);
          }
        },
        close() {
          if (lease.ended) return;
          if (lease.complete && owner && slot === entry && entry.raw.readyState === 1) {
            entry.lease = undefined;
            idle(entry);
            queueMicrotask(() => end(lease, { code: 1000 }));
          } else drop(entry, true);
        },
      };
      entry.lease = lease;
      if (entry.raw.readyState === 1)
        queueMicrotask(() => {
          if (lease.ended) return;
          if (entry.raw.readyState === 1) lease.onopen?.({});
          else end(lease, { code: 1006 });
        });
      return lease;
    },
  };
  return pool;
}
