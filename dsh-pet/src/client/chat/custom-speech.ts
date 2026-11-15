/** 连续聊天的实际音色播放器：首个短句尽早合成，最多预取两段，打断立即取消旧轮。 */
import { ROUTE_SEGMENT } from '../../shared/constants.ts';

/** 只有完成真实播放才进入 idle；调用方据此显示准备／朗读状态。 */
export type CustomSpeechPhase = 'preparing' | 'playing' | 'idle';
/** 合成与播放分离，队列测试不需要网络、扬声器或真实麦克风。 */
export interface CustomSpeechSink {
  synthesize(text: string, signal: AbortSignal): Promise<Blob>;
  play(audio: Blob, signal: AbortSignal): Promise<void>;
}
/** 每通只持有一个队列；旧轮的网络和播放不能写入新轮。 */
export interface CustomSpeechQueue {
  begin(): void;
  append(text: string): void;
  finish(fullText?: string): void;
  interrupt(): void;
  busy(): boolean;
  dispose(): void;
}

/** 分句保持 Unicode 字符完整；首句采用较短边界，后续段扩大以减少在线合成次数。 */
function boundary(text: string, first: boolean, final: boolean): number {
  let end = 0;
  const limit = first ? 24 : 96;
  for (const char of text) {
    if (end + char.length > limit) return end;
    end += char.length;
    if (end >= (first ? 6 : 24) && /[。！？!?；;\n]|[，,、]/u.test(char)) return end;
  }
  return final ? end : 0;
}

/** 字幕流抵达就准备首句，声音严格按顺序播放，完整句结束前不等待整轮生成。 */
export function createCustomSpeechQueue(options: {
  sink: CustomSpeechSink;
  phase?(phase: CustomSpeechPhase): void;
  failure(): void;
}): CustomSpeechQueue {
  type Ready = { ok: true; audio: Blob } | { ok: false };
  type Job = { text: string; ready?: Promise<Ready> };
  type Turn = {
    abort: AbortController;
    received: string;
    sent: number;
    buffer: string;
    first: boolean;
    final: boolean;
    jobs: Job[];
    pending: number;
    playing: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
  let current: Turn | undefined;
  let disposed = false;
  const valid = (turn: Turn): boolean => current === turn && !turn.abort.signal.aborted && !disposed;
  const interrupt = (): void => {
    const old = current;
    current = undefined;
    if (old) {
      clearTimeout(old.timer);
      old.abort.abort();
      old.jobs = [];
      old.buffer = '';
    }
  };
  const fail = (turn: Turn): void => {
    if (valid(turn)) {
      interrupt();
      options.failure();
    }
  };
  const prepare = (turn: Turn): void => {
    for (const job of turn.jobs.slice(0, 2)) {
      if (!valid(turn) || turn.pending >= 2) break;
      if (job.ready) continue;
      turn.pending++;
      job.ready = options.sink
        .synthesize(job.text, turn.abort.signal)
        .then(
          (audio) => ({ ok: true, audio }) as Ready,
          () => ({ ok: false }) as Ready,
        )
        .finally(() => {
          turn.pending--;
          if (valid(turn)) prepare(turn);
        });
    }
  };
  const play = async (turn: Turn): Promise<void> => {
    if (turn.playing || !valid(turn)) return;
    turn.playing = true;
    try {
      while (valid(turn) && turn.jobs.length) {
        prepare(turn);
        const job = turn.jobs[0];
        const result = await job.ready;
        if (!valid(turn)) return;
        if (!result?.ok) {
          fail(turn);
          return;
        }
        options.phase?.('playing');
        await options.sink.play(result.audio, turn.abort.signal);
        if (!valid(turn)) return;
        turn.jobs.shift();
        prepare(turn);
      }
      if (valid(turn) && turn.final && !turn.buffer) options.phase?.('idle');
    } catch {
      fail(turn);
    } finally {
      turn.playing = false;
    }
  };
  const flush = (turn: Turn, final = false): void => {
    if (!valid(turn)) return;
    for (;;) {
      const end = boundary(turn.buffer, turn.first, final);
      if (!end) break;
      const part = turn.buffer.slice(0, end);
      turn.buffer = turn.buffer.slice(end);
      turn.sent += end;
      if (!/[\p{L}\p{N}]/u.test(part)) continue;
      turn.first = false;
      turn.jobs.push({ text: part.trim() });
      options.phase?.('preparing');
    }
    prepare(turn);
    void play(turn);
  };
  return {
    begin() {
      interrupt();
      if (!disposed)
        current = {
          abort: new AbortController(),
          received: '',
          sent: 0,
          buffer: '',
          first: true,
          final: false,
          jobs: [],
          pending: 0,
          playing: false,
        };
    },
    append(text) {
      const turn = current;
      if (!turn || !valid(turn) || turn.final) return;
      const part = text.slice(0, 6000 - turn.received.length);
      turn.received += part;
      turn.buffer += part;
      clearTimeout(turn.timer);
      flush(turn);
      if (turn.buffer)
        turn.timer = setTimeout(
          () => {
            if (valid(turn) && turn.buffer.length >= (turn.first ? 8 : 40)) flush(turn, true);
          },
          turn.first ? 280 : 650,
        );
    },
    finish(fullText) {
      const turn = current;
      if (!turn || !valid(turn) || turn.final) return;
      clearTimeout(turn.timer);
      if (fullText && fullText.slice(0, turn.sent) === turn.received.slice(0, turn.sent)) {
        turn.received = fullText.slice(0, 6000);
        turn.buffer = turn.received.slice(turn.sent);
      }
      turn.final = true;
      flush(turn, true);
    },
    interrupt,
    busy() {
      return !!current && (current.jobs.length > 0 || current.buffer.length > 0);
    },
    dispose() {
      disposed = true;
      interrupt();
    },
  };
}

/** 只请求明确选中的音色，失败不改用 Codex 原声；所有音频 URL 和媒体在取消时释放。 */
export function createCustomSpeechOutput(options: {
  voice: string;
  volume: number;
  phase?(phase: CustomSpeechPhase): void;
  failure(): void;
}): CustomSpeechQueue {
  return createCustomSpeechQueue({
    ...options,
    sink: {
      async synthesize(text, signal) {
        const response = await fetch(ROUTE_SEGMENT + '/voice/speak', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voice: options.voice, text }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });
        if (!response.ok || !(response.headers.get('content-type') ?? '').includes('audio'))
          throw new Error('Selected voice unavailable');
        return response.blob();
      },
      play(blob, signal) {
        if (signal.aborted) return Promise.reject(new Error('Speech cancelled'));
        return new Promise<void>((resolve, reject) => {
          const url = URL.createObjectURL(blob);
          const audio = document.createElement('audio');
          audio.dataset.petCustomVoice = options.voice;
          audio.hidden = true;
          audio.volume = options.volume;
          audio.src = url;
          document.body.append(audio);
          let done = false;
          const settle = (ok: boolean): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            audio.onended = null;
            audio.onerror = null;
            audio.pause();
            audio.removeAttribute('src');
            audio.remove();
            URL.revokeObjectURL(url);
            if (ok) resolve();
            else reject(new Error('Speech playback cancelled'));
          };
          const abort = (): void => settle(false);
          const timer = setTimeout(abort, 60000);
          signal.addEventListener('abort', abort, { once: true });
          audio.onended = () => settle(true);
          audio.onerror = abort;
          void audio.play().catch(abort);
        });
      },
    },
  });
}
