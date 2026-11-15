/** Codex 听写传输：固定官方端点、单次上传、继承现有代理，不持久化录音或返回的资产引用。 */
import { ProxyAgent } from 'undici';
import { codexChildEnvironment } from '../../../standalone/codex/network.ts';
import type { CodexSpeechIdentity } from './auth.ts';

/** 与本机 Codex 听写一致的入口，不接受用户提供的任意上传地址。 */
export const CODEX_DICTATION_ENDPOINT = 'https://chatgpt.com/backend-api/transcribe';

/** 不将服务端的任意错误正文回显给页面。 */
export interface DictationResponse {
  readonly status: number;
  readonly text?: string;
}

/** 用于接线与隔离测试的上传契约。 */
export type DictationPost = (
  audio: Uint8Array,
  identity: CodexSpeechIdentity,
  signal?: AbortSignal,
) => Promise<DictationResponse>;

/** 网络设置只作用于当前 Codex 请求，不修改全局代理或其他本机接口。 */
export async function withCodexProxy<T>(run: (network: { dispatcher?: ProxyAgent }) => Promise<T>): Promise<T> {
  const env = codexChildEnvironment();
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  try {
    return await run(dispatcher ? { dispatcher } : {});
  } finally {
    await dispatcher?.close();
  }
}

/** 完整消费响应后再释放本次代理连接，任何凭据只出现在请求头。 */
export async function postCodexDictation(
  audio: Uint8Array,
  identity: CodexSpeechIdentity,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<DictationResponse> {
  return withCodexProxy(async (network) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'codex.wav');
    form.append('language', 'zh');
    const response = await fetcher(CODEX_DICTATION_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + identity.token,
        originator: 'codex_bigfish',
        ...(identity.accountId ? { 'ChatGPT-Account-Id': identity.accountId } : {}),
      },
      body: form,
      redirect: 'error',
      signal,
      ...network,
    });
    const body: unknown = await response.json().catch(() => null);
    const text = body && typeof body === 'object' ? (body as Record<string, unknown>).text : undefined;
    return { status: response.status, ...(typeof text === 'string' && text.length <= 20000 ? { text } : {}) };
  });
}
