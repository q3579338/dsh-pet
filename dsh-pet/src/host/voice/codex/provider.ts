/** Codex 云端听写：沿用已有登录，401 时仅刷新身份重试一次，不降级成 Windows 听写。 */
import { registerSpeechProvider, resolveSpeechProvider } from '../speech-registry.ts';
import { SpeechUnavailableError, type SpeechProvider } from '../speech-types.ts';
import { validateWindowsWave } from '../windows/providers.ts';
import { readCodexSpeechIdentity, type CodexSpeechIdentity } from './auth.ts';
import { postCodexDictation, type DictationPost } from './http.ts';

/** 原版设置页与 /voice/hear 共用的识别标识。 */
export const CODEX_SPEECH_ID = 'codex';

class DictationServiceError extends Error {}

/** 身份与上传可分别注入，默认调用本机 Codex 和固定的官方听写端点。 */
export function createCodexSpeechProvider(
  deps: {
    identity?: (signal?: AbortSignal, refresh?: boolean) => Promise<CodexSpeechIdentity>;
    post?: DictationPost;
  } = {},
): SpeechProvider {
  const identity = deps.identity ?? readCodexSpeechIdentity;
  const post = deps.post ?? postCodexDictation;
  return {
    id: CODEX_SPEECH_ID,
    name: 'Codex 听写（云端中文识别）',
    timeoutMs: 35000,
    async transcribe({ audio, signal }) {
      validateWindowsWave(audio);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (signal?.aborted) throw new Error('语音识别已停止。');
          const auth = await identity(signal, attempt === 1);
          if (signal?.aborted) throw new Error('语音识别已停止。');
          const response = await post(audio, auth, signal);
          if (response.status === 401 && attempt === 0) continue;
          if (response.status === 401) throw new SpeechUnavailableError('Codex 登录已失效，请在 Codex 中重新登录。');
          if (response.status === 403)
            throw new SpeechUnavailableError('当前 Codex 听写请求被拒绝，请检查登录、账号权限或网络。');
          if (response.status === 429)
            throw new DictationServiceError('Codex 听写请求过于频繁或额度受限，请稍后重试。');
          if (response.status < 200 || response.status >= 300)
            throw new DictationServiceError('Codex 听写服务暂时不可用，请稍后重试。');
          if (typeof response.text !== 'string')
            throw new DictationServiceError('Codex 听写没有返回有效文字，请重试。');
          return response.text.trim();
        }
        throw new DictationServiceError('Codex 听写未完成。');
      } catch (error) {
        /* eslint-disable preserve-caught-error -- 不把可能含登录信息的上游异常附到面向页面的错误上。 */
        if (error instanceof SpeechUnavailableError) throw error;
        if (signal?.aborted) throw new Error('语音识别已停止。');
        if (error instanceof DictationServiceError) throw error;
        throw new Error('Codex 听写连接失败，请检查网络后重试。');
        /* eslint-enable preserve-caught-error */
      }
    },
  };
}

/** Codex 模式显式登记；其他宿主维持原有识别目录。 */
export function ensureCodexSpeech(): void {
  if (!resolveSpeechProvider(CODEX_SPEECH_ID)) registerSpeechProvider(createCodexSpeechProvider());
}
