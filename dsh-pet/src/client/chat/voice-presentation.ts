/** 合并高频字幕，仅把本通仍有效的画面送给宿主；不阻塞音频播放。 */
import type { VoicePresentationFrame } from '../../shared/voice-presentation.ts';

export function createVoicePresentationSender(
  send: (frame: VoicePresentationFrame) => Promise<unknown>,
  active: () => boolean,
) {
  type Frame = Omit<VoicePresentationFrame, 'sequence'>;
  let disposed = false,
    sequence = 0,
    pending: Frame | undefined,
    chain = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const value = pending;
    pending = undefined;
    if (!value || disposed || !active()) return;
    const frame = { ...value, sequence: ++sequence };
    chain = chain
      .then(async () => {
        if (!disposed && active()) await send(frame);
      })
      .catch(() => {});
  };
  return {
    emit(frame: Frame) {
      if (disposed) return;
      if (frame.type !== 'assistant') {
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
      clearTimeout(timer);
      pending = undefined;
    },
  };
}
