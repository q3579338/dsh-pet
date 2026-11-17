/** 原生即时语音：显式点击才打开麦克风，结束、切页或卸载立即关闭全部媒体。 */
import { ROUTE_SEGMENT } from '../../shared/constants.ts';
import { setLiveVoiceActive } from '../../shared/voice.ts';
import { DEFAULT_LIVE_VOICE_STYLE, liveVoiceStyle, type LiveVoiceStyleId } from '../../shared/live-voice-style.ts';
import type { ChatPanelRuntime } from './runtime.ts';
import type { ChatPanelState } from './types.ts';
import { createCustomSpeechOutput, type CustomSpeechQueue } from './custom-speech.ts';
import { watchMicrophoneSpeech } from './microphone-activity.ts';
import { createAssistantTranscript, createUserTranscript } from './live-transcript.ts';
import { createWorkBuddyVoiceControl } from './workbuddy-voice.ts';
import type { LiveControlOptions } from './live-voice-types.ts';
import { createVoicePresentationSender } from './voice-presentation.ts';

/** 对话区只显示本次最近一轮字幕，不写入普通聊天存档。 */
export interface LiveVoiceView {
  readonly source?: string;
  readonly active: boolean;
  readonly phase: 'idle' | 'connecting' | 'live';
  readonly message: string;
  readonly user: string;
  readonly pet: string;
  readonly toggle: () => void;
  readonly styleId: LiveVoiceStyleId;
  readonly mode: 'natural' | 'custom';
  readonly chooseMode: (mode: string) => void;
  readonly chooseStyle: (id: string) => void;
  readonly interrupt: () => void;
}

/** 连接的可见状态。 */
type LiveData = Pick<LiveVoiceView, 'active' | 'phase' | 'message' | 'user' | 'pet'>;
const EMPTY: LiveData = { active: false, phase: 'idle', message: '', user: '', pet: '' };

/** 外部消息收窄为记录，避免解析异常中断媒体清理。 */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 连接控制器的最小宿主，不依赖 React，方便验证真实媒体和取消路径。 */
function createCodexLiveVoiceControl(options: {
  petId: string;
  changed(state: LiveData): void;
  canStart(): boolean;
  style?(): LiveVoiceStyleId;
}): {
  toggle(): void;
  dispose(): void;
  interrupt(): void;
} {
  type Call = {
    abort: AbortController;
    peer: RTCPeerConnection;
    audio: HTMLAudioElement;
    stream?: MediaStream;
    sessionId?: string;
    heartbeat?: ReturnType<typeof setInterval>;
    timeout?: ReturnType<typeof setTimeout>;
    disconnect?: ReturnType<typeof setTimeout>;
    speech?: CustomSpeechQueue;
    stopMicWatch?: () => void;
    firstOutputAt?: number;
    reportedPlayback?: boolean;
    speechFailed?: boolean;
    transcript: ReturnType<typeof createAssistantTranscript>;
    userTranscript: ReturnType<typeof createUserTranscript>;
    presentation?: ReturnType<typeof createVoicePresentationSender>;
    assistantId?: string;
  };
  let call: Call | undefined;
  let state: LiveData = { ...EMPTY };
  let disposed = false;
  const paint = (patch: Partial<LiveData>): void => {
    state = { ...state, ...patch };
    if (!disposed) options.changed(state);
  };
  const post = (path: string, body: unknown, signal?: AbortSignal, keepalive = false): Promise<Response> =>
    fetch(ROUTE_SEGMENT + '/voice/live/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      keepalive,
    });
  const stop = (message = '即时语音已结束。'): void => {
    const old = call;
    call = undefined;
    if (old) {
      clearInterval(old.heartbeat);
      clearTimeout(old.timeout);
      clearTimeout(old.disconnect);
      old.abort.abort();
      old.speech?.dispose();
      old.presentation?.dispose();
      old.stopMicWatch?.();
      old.stream?.getTracks().forEach((track) => track.stop());
      old.peer.close();
      old.audio.pause();
      old.audio.srcObject = null;
      old.audio.remove();
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
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      paint({ message: '当前窗口不支持即时语音，请使用桌宠原生聊天窗口。' });
      return;
    }
    const current: Call = {
      abort: new AbortController(),
      peer: new RTCPeerConnection(),
      audio: document.createElement('audio'),
      transcript: createAssistantTranscript(),
      userTranscript: createUserTranscript(),
    };
    call = current;
    setLiveVoiceActive(true);
    paint({ ...EMPTY, active: true, phase: 'connecting', message: '正在连接 Codex，语音聊天可随时取消…' });
    current.timeout = setTimeout(() => {
      if (call === current) stop('即时语音连接超时，请重试。');
    }, 35000);
    const relevant = (): boolean => call === current && !current.abort.signal.aborted;
    current.presentation = createVoicePresentationSender(
      (frame, signal) =>
        post('present', { sessionId: current.sessionId, frame }, AbortSignal.any([current.abort.signal, signal])).then(
          (r) => r.json(),
        ),
      () => relevant() && !!current.sessionId,
    );
    try {
      const config = fetch(ROUTE_SEGMENT + '/config', { signal: current.abort.signal })
        .then((response) => response.json())
        .catch(() => null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (!relevant()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      for (const track of stream.getAudioTracks()) {
        track.enabled = false;
        track.onended = () => {
          if (relevant()) stop('麦克风已断开，即时语音已结束。');
        };
        current.peer.addTrack(track, stream);
      }
      const main = record(record(await config).main);
      const volume = typeof main.voiceVolume === 'number' ? main.voiceVolume : 1;
      const selection = liveVoiceStyle(options.style?.() ?? DEFAULT_LIVE_VOICE_STYLE)!;
      const playbackVolume = Math.min(1, Math.max(0, volume));
      current.audio.volume = selection.synthesisVoice ? 0 : playbackVolume;
      current.audio.dataset.petNativeVoice = 'true';
      const connectedMessage = selection.synthesisVoice
        ? `自定义音色：${selection.name}，边生成边朗读，可直接开口打断。`
        : '低延迟原声：正在直接播放 Codex 语音，可以直接说话。';
      if (selection.synthesisVoice) {
        current.speech = createCustomSpeechOutput({
          voice: selection.synthesisVoice,
          volume: playbackVolume,
          failure: () => {
            if (relevant()) {
              current.speechFailed = true;
              paint({ message: selection.name + '这一句未能播放，文字已保留；可以继续说话重试。' });
            }
          },
          phase: (phase) => {
            if (!relevant() || current.speechFailed) return;
            paint({
              message:
                phase === 'preparing'
                  ? selection.name + '正在准备声音…'
                  : phase === 'playing'
                    ? selection.name + '正在说话，可以直接开口打断。'
                    : connectedMessage,
            });
            if (phase === 'playing' && !current.reportedPlayback) {
              current.reportedPlayback = true;
              document.dispatchEvent(
                new CustomEvent('pet-custom-voice-play', {
                  detail: {
                    voice: selection.synthesisVoice,
                    fromTextMs: Date.now() - (current.firstOutputAt ?? Date.now()),
                  },
                }),
              );
            }
          },
        });
        current.speech.begin();
        current.stopMicWatch = watchMicrophoneSpeech(stream, () => {
          if (!relevant()) return;
          current.userTranscript.begin();
          current.presentation?.emit({ type: 'interrupt', turnId: current.assistantId ?? 'microphone', text: '' });
          current.transcript.interrupt();
          if (current.speech?.busy()) current.speech.interrupt();
          current.speech?.prime?.();
        });
      }
      current.audio.hidden = true;
      document.body.append(current.audio);
      const channel = current.peer.createDataChannel('oai-events');
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (!relevant() || typeof event.data !== 'string' || event.data.length > 1000000) return;
        try {
          const value = record(JSON.parse(event.data));
          const item = record(value.item);
          const turn = record(value.turn);
          if (value.type === 'input_audio_buffer.speech_started') current.userTranscript.begin();
          if (value.type === 'input_transcript.added') paint({ user: current.userTranscript.append(item) });
          if (value.type === 'turn.done' && turn.role === 'user') {
            const user = current.userTranscript.complete(turn.transcript);
            paint({ user });
            if (typeof turn.id === 'string') current.presentation?.emit({ type: 'user', turnId: turn.id, text: user });
          }
          const transcript = current.transcript.accept(value);
          if (transcript.begin) {
            current.assistantId = typeof turn.id === 'string' ? turn.id : undefined;
            current.speechFailed = false;
            paint({ pet: '' });
            current.firstOutputAt = undefined;
            current.reportedPlayback = false;
            current.speech?.begin();
          }
          const delta = transcript.delta;
          if (delta) {
            if (!current.firstOutputAt) current.firstOutputAt = Date.now();
            paint({ pet: transcript.full ?? (state.pet + delta).slice(-6000) });
            current.speech?.append(delta);
            if (current.assistantId)
              current.presentation?.emit({
                type: 'assistant',
                turnId: current.assistantId,
                text: transcript.full ?? state.pet,
              });
          }
          if (transcript.done) {
            const full = transcript.full;
            if (full) paint({ pet: full });
            current.speech?.finish(full);
            if (full && current.assistantId)
              current.presentation?.emit({
                type: 'assistant',
                turnId: current.assistantId,
                text: full,
                complete: true,
              });
          }
          // 自动打断由本机持续开口检测决定，服务端单帧噪声事件不直接截断朗读。
          if (value.type === 'input_audio_buffer.speech_started') current.speech?.prime?.();
          if (value.type === 'error') stop('Codex 即时语音已中断，请重试。');
        } catch {
          /* 忽略无法识别的控制事件，不显示内部报错或音频载荷。 */
        }
      };
      current.peer.ontrack = (event) => {
        if (!relevant()) return;
        current.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void current.audio.play().catch(() => {
          if (relevant()) stop('回复声音无法播放，请结束后重新开启即时语音。');
        });
      };
      current.peer.onconnectionstatechange = () => {
        if (!relevant()) return;
        const connection = current.peer.connectionState;
        if (connection === 'connected') {
          clearTimeout(current.disconnect);
          if (current.sessionId) {
            clearTimeout(current.timeout);
            paint({ phase: 'live', message: connectedMessage });
          }
        } else if (connection === 'failed' || connection === 'closed') stop('语音连接已断开，请重试。');
        else if (connection === 'disconnected')
          current.disconnect = setTimeout(() => {
            if (relevant()) stop('语音网络已断开，请重试。');
          }, 5000);
      };
      await current.peer.setLocalDescription(await current.peer.createOffer());
      const response = await post(
        'start',
        {
          petId: options.petId,
          sdp: current.peer.localDescription?.sdp,
          styleId: options.style?.() ?? DEFAULT_LIVE_VOICE_STYLE,
        },
        current.abort.signal,
      );
      const result = record(await response.json());
      // 即使取消晚于服务端建连成功，也必须交回本次编号并结束，不能留下后台麦克风或连接。
      if (typeof result.sessionId === 'string') current.sessionId = result.sessionId;
      if (!relevant()) {
        if (current.sessionId) void post('stop', { sessionId: current.sessionId }, undefined, true).catch(() => {});
        return;
      }
      if (result.ok !== true || typeof result.answerSdp !== 'string' || !current.sessionId) {
        stop(typeof result.message === 'string' ? result.message : 'Codex 未能连接即时语音，请重试。');
        return;
      }
      await current.peer.setRemoteDescription({ type: 'answer', sdp: result.answerSdp });
      if (!relevant()) return;
      current.stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      current.heartbeat = setInterval(() => {
        void post('touch', { sessionId: current.sessionId }, current.abort.signal)
          .then((response) => response.json())
          .then((value) => {
            if (relevant() && record(value).ok !== true) stop('即时语音已结束，点击按钮可重新开始。');
          })
          .catch(() => {
            if (relevant()) stop('语音网络暂时不可用，请重试。');
          });
      }, 15000);
      if (current.peer.connectionState === 'connected') {
        clearTimeout(current.timeout);
        paint({ phase: 'live', message: connectedMessage });
      }
    } catch (error) {
      if (!relevant()) return;
      const name = error instanceof Error ? error.name : '';
      stop(
        name === 'NotAllowedError'
          ? '麦克风权限未允许，请在系统设置中允许桌宠使用麦克风。'
          : name === 'NotFoundError'
            ? '没有找到麦克风，请连接后重试。'
            : name === 'NotReadableError'
              ? '麦克风正被占用或无法打开，请检查后重试。'
              : '即时语音连接失败，请检查网络后重试。',
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
      call?.presentation?.emit({ type: 'interrupt', turnId: call.assistantId ?? 'manual', text: '' });
      call?.transcript.interrupt();
      call?.speech?.interrupt();
      if (call) paint({ message: '已停止这一句，麦克风仍在接收，可以继续说话。' });
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

/** 自定义音色跟随当前文字模型；低延迟原声保持明确的 Codex 原生路线。 */
export function createLiveVoiceControl(options: LiveControlOptions): {
  toggle(): void;
  dispose(): void;
  interrupt(): void;
} {
  let inner: ReturnType<typeof createCodexLiveVoiceControl> | undefined;
  let selecting: AbortController | undefined;
  let disposed = false;
  return {
    toggle() {
      if (selecting) {
        selecting.abort();
        selecting = undefined;
        options.changed({ ...EMPTY, message: '即时语音已取消。' });
        return;
      }
      if (inner) {
        inner.toggle();
        return;
      }
      if (disposed || !options.canStart()) return;
      const abort = new AbortController();
      selecting = abort;
      options.changed({ ...EMPTY, active: true, phase: 'connecting', message: '正在检查当前语音连接…' });
      void (async () => {
        const natural = options.style?.() === 'natural';
        const value = await fetch(ROUTE_SEGMENT + '/voice/conversation/options', { signal: abort.signal }).then((r) =>
          r.json(),
        );
        if (disposed || abort.signal.aborted) return;
        if (value.workbuddy === true && natural) {
          selecting = undefined;
          options.changed({
            ...EMPTY,
            message: '当前连接是 WorkBuddy，请选择自定义音色。Codex 原声仅用于 Codex 连接。',
          });
          return;
        }
        if (value.workbuddy !== true && value.source !== 'codex') throw new Error('Voice source unavailable');
        const create = value.workbuddy === true ? createWorkBuddyVoiceControl : createCodexLiveVoiceControl;
        inner = create({
          ...options,
          canStart: () => true,
          changed: (state) => {
            options.changed(state);
            if (!state.active) {
              const old = inner;
              inner = undefined;
              // 回调结束后再释放，避免在构造或停止过程中重入。
              queueMicrotask(() => old?.dispose());
            }
          },
        });
        selecting = undefined;
        inner.toggle();
      })().catch(() => {
        if (selecting === abort) selecting = undefined;
        if (!disposed && !abort.signal.aborted) options.changed({ ...EMPTY, message: '未能读取模型连接，请重试。' });
      });
    },
    interrupt() {
      inner?.interrupt();
    },
    dispose() {
      disposed = true;
      selecting?.abort();
      inner?.dispose();
      inner = undefined;
    },
  };
}

/** 换宠物和卸载时结束通话，输入框草稿独立保留。 */
export function usePanelLiveVoice(rt: ChatPanelRuntime, state: ChatPanelState): LiveVoiceView | undefined {
  const [data, setData] = rt.useState<LiveData>({ ...EMPTY });
  const [customStyle, setStyle] = rt.useState<LiveVoiceStyleId>(DEFAULT_LIVE_VOICE_STYLE);
  const [mode, setMode] = rt.useState<'natural' | 'custom'>('custom');
  const [source, setSource] = rt.useState('codex');
  rt.useEffect(() => {
    let live = true;
    const update = (): void => {
      void fetch(ROUTE_SEGMENT + '/voice/conversation/options')
        .then((r) => r.json())
        .then((value) => {
          if (!live) return;
          setSource(value.source || '');
          if (value.workbuddy === true) setMode('custom');
        })
        .catch(() => {});
    };
    const changed = (): void => {
      document.dispatchEvent(new Event('pet-stop-live-voice'));
      update();
    };
    update();
    window.addEventListener('pet-ai-source-changed', changed);
    return () => {
      live = false;
      window.removeEventListener('pet-ai-source-changed', changed);
    };
  }, []);
  const styleId = mode === 'natural' ? 'natural' : customStyle;
  const styleRef = rt.useRef(styleId);
  styleRef.current = styleId;
  const control = rt.useRef<ReturnType<typeof createLiveVoiceControl> | undefined>(undefined);
  const latest = rt.useRef(state);
  latest.current = state;
  rt.useEffect(() => {
    if (!rt.speechInput) return;
    setData({ ...EMPTY });
    const next = createLiveVoiceControl({
      petId: state.petId,
      changed: setData,
      style: () => styleRef.current,
      canStart: () => {
        const mic = latest.current.draftRef.current
          ?.closest('.pet-chat-composer')
          ?.querySelector<HTMLButtonElement>('.pet-chat-mic');
        return !latest.current.busy && !!latest.current.petId && !mic?.disabled && !mic?.dataset.hear;
      },
    });
    control.current = next;
    return () => {
      next.dispose();
      if (control.current === next) control.current = undefined;
    };
  }, [state.petId]);
  return rt.speechInput
    ? {
        ...data,
        source,
        styleId,
        mode,
        chooseMode: (next) => {
          if (!data.active && (next === 'custom' || (next === 'natural' && source === 'codex')))
            setMode(next as 'natural' | 'custom');
        },
        chooseStyle: (id) => {
          if (!data.active && liveVoiceStyle(id)?.synthesisVoice) setStyle(id as LiveVoiceStyleId);
        },
        toggle: () => control.current?.toggle(),
        interrupt: () => control.current?.interrupt(),
      }
    : undefined;
}
