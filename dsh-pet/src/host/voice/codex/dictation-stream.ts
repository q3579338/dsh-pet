/** 沿用已登录 Codex 的流式听写；音频和身份只发给固定官方地址，不写入本机。 */
import { randomUUID } from 'node:crypto';
import { ProxyAgent, WebSocket } from 'undici';
import { codexChildEnvironment } from '../../../standalone/codex/network.ts';
import { readCodexSpeechIdentity, type CodexSpeechIdentity } from './auth.ts';

/** 每句话独立结束听写，避免等待整段 WAV 上传后再开始识别。 */
export interface StreamingDictation {
  available?(): boolean;
  append(pcm: Uint8Array): void;
  finish(): Promise<string>;
  dispose(): void;
}

/** 只显示固定错误，WebSocket 错误可能含身份信息，不能原样透出。 */
export class DictationStreamError extends Error {}

/** 与本机 Codex 桌面听写协议一致；测试可替换身份及连接。 */
export async function createStreamingDictation(
  partial: (text: string) => void,
  signal: AbortSignal,
  deps: {
    identity?: (signal: AbortSignal) => Promise<CodexSpeechIdentity>;
    connect?: (identity: CodexSpeechIdentity) => WebSocket;
  } = {},
): Promise<StreamingDictation> {
  const identity = await (deps.identity ?? readCodexSpeechIdentity)(signal);
  signal.throwIfAborted();
  const env = deps.connect ? {} : codexChildEnvironment();
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const socket =
    deps.connect?.(identity) ??
    new WebSocket('wss://chatgpt.com/backend-api/dictation/stream?dictation_surface=codex&client_type=desktop', {
      protocols: ['chatgpt-dictation', 'codex-desktop'],
      dispatcher,
      headers: {
        Authorization: 'Bearer ' + identity.token,
        ...(identity.accountId ? { 'ChatGPT-Account-Id': identity.accountId } : {}),
        originator: 'codex_bigfish',
      },
    });
  let closed = false,
    finishing = false,
    bytes = 0;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  let resolveFinal!: (text: string) => void, rejectFinal!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const final = new Promise<string>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  // 在识别开始前对方也可能断开；提前观察拒绝，finish 时仍交回原来的失败。
  void final.catch(() => {});
  const dispose = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    socket.close();
    void dispatcher?.destroy().catch(() => {});
    const error = new DictationStreamError('语音识别已停止，请继续说话重试。');
    rejectReady(error);
    rejectFinal(error);
  };
  const fail = (): void => dispose();
  const abort = (): void => dispose();
  let deadline = setTimeout(fail, 12000);
  signal.addEventListener('abort', abort, { once: true });
  socket.addEventListener('open', () => {
    if (closed) return;
    socket.send(
      JSON.stringify({
        type: 'session.start',
        dictation_session_id: randomUUID(),
        attempt_id: randomUUID(),
        config: {
          language: 'zh',
          input_audio_format: 'pcm16',
          sample_rate_hz: 16000,
          num_channels: 1,
          max_buffer_size_bytes: 4194304,
          max_utterance_duration_ms: 30000,
          session_ttl_ms: 300000,
          provider_mode: 'streaming_sse',
          transcript_delivery_mode: 'segment',
          vad: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 300 },
        },
      }),
    );
  });
  socket.addEventListener('message', (event) => {
    if (closed || typeof event.data !== 'string' || event.data.length > 65536) return;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(event.data);
    } catch {
      fail();
      return;
    }
    if (!e || typeof e !== 'object') {
      fail();
      return;
    }
    if (e.type === 'session.started') {
      clearTimeout(deadline);
      deadline = setTimeout(fail, 270000);
      resolveReady();
    }
    if ((e.type === 'transcript.delta' || e.type === 'transcript.segment') && typeof e.text === 'string')
      partial(e.text.slice(0, 4000));
    if (e.type === 'transcript.final' && finishing && typeof e.text === 'string') {
      resolveFinal(e.text.trim().slice(0, 4000));
      dispose();
    }
    if (e.type === 'transcript.failed' || (e.type === 'session.error' && e.fatal === true)) fail();
  });
  socket.addEventListener('error', fail);
  socket.addEventListener('close', fail);
  if (signal.aborted) dispose();
  try {
    await ready;
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    available: () => !closed && !finishing,
    append(pcm) {
      if (closed || finishing || pcm.length % 2 || pcm.length > 32768 || (bytes += pcm.length) > 960000)
        throw new DictationStreamError('这一段语音过长或连接已断开，请分句重试。');
      if (socket.bufferedAmount > 128000) {
        dispose();
        throw new DictationStreamError('语音网络跟不上，请稍后重试。');
      }
      socket.send(JSON.stringify({ type: 'audio.append', audio: Buffer.from(pcm).toString('base64') }));
    },
    finish() {
      if (!finishing && !closed) {
        finishing = true;
        clearTimeout(deadline);
        deadline = setTimeout(fail, 8000);
        socket.send(JSON.stringify({ type: 'session.close' }));
      }
      return final;
    },
    dispose,
  };
}
