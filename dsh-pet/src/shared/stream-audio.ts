/** 所选音色的渐进播放；不支持 MP3 MediaSource 时仍播放同一音色的完整音频。 */
export type SpeechAudio = Blob | Response;

/** 只有确认支持 MP3 流式解码才请求流，旧宿主继续走完整音频。 */
export function canStreamSpeech(): boolean {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');
}

/** 第一批音频即可解码；完成、取消和错误都释放媒体、网络与对象 URL。 */
export function playSpeechAudio(
  payload: SpeechAudio,
  options: { signal: AbortSignal; volume: number; voice: string; started(): void },
): Promise<void> {
  const { signal } = options;
  if (signal.aborted) return Promise.reject(new Error('Speech cancelled'));
  return new Promise<void>((resolve, reject) => {
    const audio = document.createElement('audio');
    audio.dataset.petCustomVoice = options.voice;
    audio.hidden = true;
    audio.volume = options.volume;
    document.body.append(audio);
    let url: string | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let media: MediaSource | undefined;
    let buffer: SourceBuffer | undefined;
    let done = false;
    let began = false;
    let fullyReceived = false;
    let waitingForBuffer = false;
    let requestedPlay = false;
    const cancelled = new AbortController();
    const settle = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      cancelled.abort();
      void reader?.cancel().catch(() => {});
      audio.onended = null;
      audio.onerror = null;
      audio.onplaying = null;
      audio.onwaiting = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio.remove();
      if (url) URL.revokeObjectURL(url);
      if (ok) resolve();
      else reject(new Error('Speech playback cancelled'));
    };
    const abort = (): void => settle(false);
    const timer = setTimeout(abort, 60000);
    signal.addEventListener('abort', abort, { once: true });
    audio.onended = () => settle(true);
    audio.onerror = abort;
    audio.onplaying = () => {
      if (!done && !began) {
        began = true;
        options.started();
      }
    };
    audio.onwaiting = () => {
      if (done || !began || fullyReceived) return;
      waitingForBuffer = true;
      audio.pause();
      document.dispatchEvent(new CustomEvent('pet-voice-buffering', { detail: { voice: options.voice } }));
    };
    const wait = (target: EventTarget, event: string): Promise<void> =>
      new Promise((finish, fail) => {
        const clean = (): void => {
          target.removeEventListener(event, ready);
          target.removeEventListener('error', failed);
          cancelled.signal.removeEventListener('abort', failed);
        };
        const ready = (): void => {
          clean();
          finish();
        };
        const failed = (): void => {
          clean();
          fail(new Error('Speech stream stopped'));
        };
        target.addEventListener(event, ready, { once: true });
        target.addEventListener('error', failed, { once: true });
        cancelled.signal.addEventListener('abort', failed, { once: true });
        if (cancelled.signal.aborted) failed();
      });
    const begin = async (): Promise<void> => {
      if (done) return;
      if (payload instanceof Response && payload.body && canStreamSpeech()) {
        media = new MediaSource();
        const opened = wait(media, 'sourceopen');
        url = URL.createObjectURL(media);
        audio.src = url;
        await opened;
        if (done) return;
        buffer = media.addSourceBuffer('audio/mpeg');
        reader = payload.body.getReader();
        let received = false;
        const maybePlay = (complete = false): void => {
          if (done || (requestedPlay && !waitingForBuffer)) return;
          const ranges = buffer!.buffered;
          const available = ranges.length ? Math.max(0, ranges.end(ranges.length - 1) - audio.currentTime) : 0;
          if (!complete && available < (waitingForBuffer ? 0.55 : 0.32)) return;
          requestedPlay = true;
          waitingForBuffer = false;
          void audio.play().catch(abort);
        };
        for (;;) {
          const next = await reader.read();
          if (done) return;
          if (next.done) break;
          if (!next.value.length) continue;
          received = true;
          const appended = wait(buffer, 'updateend');
          try {
            buffer.appendBuffer(new Uint8Array(next.value));
          } catch (error) {
            void appended.catch(() => {});
            throw error;
          }
          await appended;
          if (done) return;
          maybePlay();
        }
        if (!received) throw new Error('Empty speech stream');
        fullyReceived = true;
        if (media.readyState === 'open') media.endOfStream();
        maybePlay(true);
      } else {
        const blob = payload instanceof Response ? await payload.blob() : payload;
        if (done) return;
        fullyReceived = true;
        url = URL.createObjectURL(blob);
        audio.src = url;
        void audio.play().catch(abort);
      }
    };
    if (signal.aborted) abort();
    void begin().catch(abort);
  });
}
