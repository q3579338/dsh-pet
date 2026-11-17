/** 合并高频字幕，仅把本通仍有效的画面送给宿主；不阻塞音频播放。 */
import type { VoicePresentationFrame } from '../../shared/voice-presentation.ts';

export function createVoicePresentationSender(
  send: (frame: VoicePresentationFrame, signal: AbortSignal) => Promise<unknown>,
  active: () => boolean,
) {
  type Frame = Omit<VoicePresentationFrame, 'sequence'>;
  let disposed = false,
    sequence = 0,
    pending: Frame | undefined,
    chain = Promise.resolve(),
    epoch = 0;
  let inFlight: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const value = pending;
    pending = undefined;
    if (!value || disposed || !active()) return;
    const frame = { ...value, sequence: ++sequence };
    const generation = epoch;
    chain = chain
      .then(async () => {
        if (disposed || !active() || generation !== epoch) return;
        const abort = new AbortController();
        inFlight = abort;
        const timeout = setTimeout(() => abort.abort(), 1800);
        try {
          await Promise.race([
            send(frame, abort.signal),
            new Promise<never>((_resolve, reject) =>
              abort.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
            ),
          ]);
        } finally {
          clearTimeout(timeout);
          if (inFlight === abort) inFlight = undefined;
        }
      })
      .catch(() => {});
  };
  return {
    emit(frame: Frame) {
      if (disposed) return;
      if (frame.type !== 'assistant') {
        epoch++;
        inFlight?.abort();
        clearTimeout(timer);
        timer = undefined;
        pending = undefined;
      }
      const first = !timer;
      pending = frame;
      if (frame.type !== 'assistant' || frame.complete) flush();
      else if (first) timer = setTimeout(flush, 120);
    },
    dispose() {
      disposed = true;
      inFlight?.abort();
      clearTimeout(timer);
      pending = undefined;
    },
  };
}
