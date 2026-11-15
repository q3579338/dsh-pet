/** 使用当前 WorkBuddy 内置模型的连续语音，音色失败只中断这一句，保留文字和麦克风。 */
import { ROUTE_SEGMENT } from '../../shared/constants.ts';
import { toBase64 } from '../../shared/hear.ts';
import { setLiveVoiceActive } from '../../shared/voice.ts';
import { liveVoiceStyle, DEFAULT_LIVE_VOICE_STYLE } from '../../shared/live-voice-style.ts';
import { createCustomSpeechOutput, type CustomSpeechQueue } from './custom-speech.ts';
import { captureContinuousSpeech } from './continuous-microphone.ts';
import type { ConversationEvent } from '../../shared/voice-conversation.ts';
import type { LiveControlOptions, LiveData } from './live-voice-types.ts';

/** 与原生控制器相同的生命周期，切换模型或重新开始时重新协商。 */
export function createWorkBuddyVoiceControl(options: LiveControlOptions): {
  toggle(): void;
  interrupt(): void;
  dispose(): void;
} {
  type Call = {
    abort: AbortController;
    sessionId?: string;
    stream?: MediaStream;
    stopCapture?: () => void;
    speech?: CustomSpeechQueue;
    heartbeat?: ReturnType<typeof setInterval>;
    utterance: number;
    sequence: number;
    send: Promise<void>;
    pending: number;
    chunks: Uint8Array[];
    firstTextAt?: number;
    speechEndAt?: number;
    reported: boolean;
    speechFailed: boolean;
    model: string;
  };
  let call: Call | undefined,
    disposed = false;
  let state: LiveData = { active: false, phase: 'idle', message: '', user: '', pet: '' };
  const paint = (patch: Partial<LiveData>): void => {
    state = { ...state, ...patch };
    if (!disposed) options.changed(state);
  };
  const post = async (
    action: string,
    body: unknown,
    signal?: AbortSignal,
    keepalive = false,
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(ROUTE_SEGMENT + '/voice/conversation/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      keepalive,
    });
    const value = await response.json();
    if (!response.ok || value?.ok === false)
      throw new Error(typeof value?.message === 'string' ? value.message : '语音连接未能完成。');
    return value;
  };
  const stop = (message = '即时语音已结束。'): void => {
    const old = call;
    call = undefined;
    if (old) {
      old.abort.abort();
      clearInterval(old.heartbeat);
      old.stopCapture?.();
      old.speech?.dispose();
      old.stream?.getTracks().forEach((track) => track.stop());
      if (old.sessionId) void post('stop', { sessionId: old.sessionId }, undefined, true).catch(() => {});
    }
    setLiveVoiceActive(false);
    paint({ active: false, phase: 'idle', message });
  };
  const start = async (): Promise<void> => {
    if (disposed || call) return;
    if (!options.canStart()) {
      paint({ message: '请先结束按住说话或等待当前回复。' });
      return;
    }
    const selection = liveVoiceStyle(options.style?.() ?? DEFAULT_LIVE_VOICE_STYLE);
    if (!selection?.synthesisVoice || !navigator.mediaDevices?.getUserMedia) {
      paint({ message: '请选择自定义音色并允许麦克风。' });
      return;
    }
    const current: Call = {
      abort: new AbortController(),
      utterance: 0,
      sequence: 0,
      send: Promise.resolve(),
      pending: 0,
      chunks: [],
      reported: false,
      speechFailed: false,
      model: '',
    };
    call = current;
    setLiveVoiceActive(true);
    paint({
      active: true,
      phase: 'connecting',
      user: '',
      pet: '',
      message: '正在连接 WorkBuddy 和语音识别，可随时取消…',
    });
    const relevant = (): boolean => call === current && !current.abort.signal.aborted;
    const listening = (): string => `WorkBuddy · ${current.model} · ${selection.name}，可以直接说话。`;
    const queue = (action: string, value: Record<string, unknown>, bytes = 0): void => {
      current.pending += bytes;
      if (current.pending > 160000) {
        stop('语音传输跟不上，请检查网络后重新开始。');
        return;
      }
      current.send = current.send
        .then(async () => {
          if (!relevant()) return;
          await post(action, { ...value, sessionId: current.sessionId }, current.abort.signal);
          current.pending -= bytes;
        })
        .catch(() => {
          if (relevant()) stop('语音片段未能送达，请点击即时语音重新连接。');
        });
    };
    const flush = (): void => {
      if (!current.chunks.length) return;
      const size = current.chunks.reduce((n, chunk) => n + chunk.length, 0),
        bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of current.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      current.chunks = [];
      queue('audio', { utterance: current.utterance, sequence: current.sequence++, audio: toBase64(bytes) }, size);
    };
    try {
      const config = fetch(ROUTE_SEGMENT + '/config', { signal: current.abort.signal })
        .then((r) => r.json())
        .catch(() => ({}));
      current.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (!relevant()) {
        current.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
        track.onended = () => {
          if (relevant()) stop('麦克风已断开，请连接后重试。');
        };
      });
      const main = (await config)?.main;
      const volume = typeof main?.voiceVolume === 'number' ? Math.min(1, Math.max(0, main.voiceVolume)) : 1;
      current.speech = createCustomSpeechOutput({
        voice: selection.synthesisVoice,
        volume,
        failure: () => {
          if (!relevant()) return;
          current.speechFailed = true;
          paint({ message: selection.name + '这一句未能播放，文字已保留；可以继续说话重试。' });
        },
        phase: (phase) => {
          if (!relevant() || current.speechFailed) return;
          paint({
            message:
              phase === 'preparing'
                ? selection.name + '正在准备声音…'
                : phase === 'playing'
                  ? selection.name + '正在说话，可以直接开口打断。'
                  : listening(),
          });
          if (phase === 'playing' && !current.reported) {
            current.reported = true;
            document.dispatchEvent(
              new CustomEvent('pet-custom-voice-play', {
                detail: {
                  voice: selection.synthesisVoice,
                  model: current.model,
                  fromTextMs: Date.now() - (current.firstTextAt ?? Date.now()),
                  fromSpeechEndMs: Date.now() - (current.speechEndAt ?? Date.now()),
                },
              }),
            );
          }
        },
      });
      const result = await post('start', { petId: options.petId, styleId: selection.id }, current.abort.signal);
      if (typeof result.sessionId === 'string') current.sessionId = result.sessionId;
      if (!relevant()) {
        if (current.sessionId) void post('stop', { sessionId: current.sessionId }, undefined, true).catch(() => {});
        return;
      }
      if (!current.sessionId || typeof result.model !== 'string') throw new Error('WorkBuddy 语音连接未能完成。');
      current.model = result.model;
      const response = await fetch(
        ROUTE_SEGMENT + '/voice/conversation/events?sessionId=' + encodeURIComponent(current.sessionId),
        { signal: current.abort.signal },
      );
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('ndjson'))
        throw new Error('语音事件连接未能完成。');
      const readEvents = async (): Promise<void> => {
        const reader = response.body!.getReader(),
          decoder = new TextDecoder();
        let pending = '';
        try {
          while (relevant()) {
            const part = await reader.read();
            if (part.done) break;
            pending += decoder.decode(part.value, { stream: true });
            if (pending.length > 65536) throw new Error('invalid stream');
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0 && relevant()) {
              const event = JSON.parse(pending.slice(0, end)) as ConversationEvent;
              pending = pending.slice(end + 1);
              if (event.type === 'partial' || event.type === 'user') {
                paint({ user: event.text });
                if (event.type === 'user')
                  document.dispatchEvent(
                    new CustomEvent('pet-voice-recognized', { detail: { text: event.text, at: Date.now() } }),
                  );
              }
              if (event.type === 'reply') {
                current.speechFailed = false;
                current.firstTextAt = undefined;
                current.reported = false;
                current.speech?.begin();
                paint({ pet: '', message: 'WorkBuddy 正在回答…' });
              }
              if (event.type === 'text') {
                current.firstTextAt ??= Date.now();
                paint({ pet: (state.pet + event.text).slice(0, 6000) });
                current.speech?.append(event.text);
              }
              if (event.type === 'done') current.speech?.finish(state.pet);
              if (event.type === 'interrupted') current.speech?.interrupt();
              if (event.type === 'model') {
                current.model = event.model;
                document.dispatchEvent(new CustomEvent('pet-voice-model', { detail: { model: event.model } }));
              }
              if (event.type === 'error') {
                current.speech?.interrupt();
                if (event.fatal) {
                  stop(event.message);
                  return;
                }
                paint({ message: event.message + ' 麦克风仍在接收。' });
              }
            }
          }
          if (relevant()) stop('语音连接已结束，点击即可重新开始。');
        } finally {
          await reader.cancel().catch(() => {});
        }
      };
      void readEvents().catch(() => {
        if (relevant()) stop('语音连接已断开，请点击重新连接。');
      });
      current.stopCapture = await captureContinuousSpeech(current.stream, {
        begin: () => {
          if (!relevant()) return;
          current.utterance++;
          current.sequence = 0;
          current.chunks = [];
          current.speech?.interrupt();
          current.speech?.prime?.();
          paint({ user: '', message: '正在听，停顿后自动接话…' });
        },
        chunk: (pcm) => {
          if (!relevant()) return;
          current.chunks.push(pcm);
          if (current.chunks.length >= 2) flush();
        },
        end: () => {
          if (!relevant()) return;
          current.speechEndAt = Date.now() - 320;
          document.dispatchEvent(new CustomEvent('pet-voice-speech-end', { detail: { at: current.speechEndAt } }));
          flush();
          queue('end', { utterance: current.utterance });
          paint({ message: '正在识别最后几个字…' });
        },
      });
      if (!relevant()) {
        current.stopCapture();
        return;
      }
      current.stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      current.heartbeat = setInterval(() => {
        void post('touch', { sessionId: current.sessionId }, current.abort.signal)
          .then((value) => {
            if (relevant() && value.ok !== true) stop('语音会话已结束，请重新开始。');
          })
          .catch(() => {
            if (relevant()) stop('语音连接已断开，请重试。');
          });
      }, 15000);
      paint({ phase: 'live', message: listening() });
    } catch (error) {
      if (!relevant()) return;
      const name = error instanceof Error ? error.name : '';
      stop(
        name === 'NotAllowedError'
          ? '请在系统设置中允许桌宠使用麦克风。'
          : name === 'NotFoundError'
            ? '没有找到麦克风，请连接后重试。'
            : error instanceof Error
              ? error.message
              : '即时语音连接失败，请重试。',
      );
    }
  };
  const pageStop = (): void => stop();
  const hidden = (): void => {
    if (document.hidden) stop();
  };
  window.addEventListener('pagehide', pageStop);
  document.addEventListener('visibilitychange', hidden);
  document.addEventListener('pet-stop-live-voice', pageStop);
  return {
    toggle() {
      if (call) stop();
      else void start();
    },
    interrupt() {
      const current = call;
      if (!current?.sessionId) return;
      current.speech?.interrupt();
      void post('interrupt', { sessionId: current.sessionId }, current.abort.signal).catch(() => {});
      paint({ message: '已停止这一句，麦克风仍在接收，可以继续说话。' });
    },
    dispose() {
      disposed = true;
      stop();
      window.removeEventListener('pagehide', pageStop);
      document.removeEventListener('visibilitychange', hidden);
      document.removeEventListener('pet-stop-live-voice', pageStop);
    },
  };
}
