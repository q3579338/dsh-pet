/** 沿用 Codex 桌面版的会话协商入口；凭据只发给固定官方地址，返回内容只保留 SDP 和通话编号。 */
import type { CodexSpeechIdentity } from '../codex/auth.ts';
import { withCodexProxy } from '../codex/http.ts';

/** 即时语音使用原生语音模型，普通文字对话的模型选择继续独立。 */
export const LIVE_VOICE_MODEL = 'gpt-live-1.1-codex';
/** 只由本模块构造的公开错误才可交给页面。 */
export class LiveVoiceError extends Error {}

/** 通话创建成功后的最小结果。 */
export interface CodexLiveCall {
  readonly answerSdp: string;
  readonly callId: string;
}

/** 固定官方端点，不允许通过请求体或配置替换为任意地址。 */
export async function createCodexLiveCall(
  input: {
    sdp: string;
    threadId: string;
    sessionId: string;
    prompt: string;
    model: string;
    effort: string;
    identity: CodexSpeechIdentity;
    signal: AbortSignal;
  },
  fetcher: typeof fetch = fetch,
): Promise<CodexLiveCall> {
  return withCodexProxy(async (network) => {
    const response = await fetcher(
      'https://chatgpt.com/backend-api/wham/realtime/calls?intent=quicksilver&architecture=avas',
      {
        method: 'POST',
        redirect: 'error',
        signal: input.signal,
        ...network,
        headers: {
          Authorization: 'Bearer ' + input.identity.token,
          ...(input.identity.accountId ? { 'ChatGPT-Account-Id': input.identity.accountId } : {}),
          originator: 'codex_bigfish',
          'Content-Type': 'application/json',
          'OpenAI-Alpha': 'quicksilver=v2',
          'Thread-Id': input.threadId,
          'Voice-Session-Id': input.sessionId,
          'x-codex-turn-metadata': JSON.stringify({
            backend_model_name: input.model,
            backend_thinking_effort: input.effort,
          }),
        },
        body: JSON.stringify({
          sdp: input.sdp,
          session: {
            delegation: { type: 'client' },
            model: LIVE_VOICE_MODEL,
            instructions: input.prompt,
            initial_items: [
              { type: 'message', role: 'developer', content: [{ type: 'input_text', text: input.prompt }] },
            ],
            voice_session_id: input.sessionId,
          },
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new LiveVoiceError('Codex 登录已失效，请在 Codex 中重新登录。');
      if (response.status === 403) throw new LiveVoiceError('当前账号或网络暂时无法使用 Codex 即时语音。');
      if (response.status === 429) throw new LiveVoiceError('即时语音额度或请求频率受限，请稍后重试。');
      throw new LiveVoiceError('Codex 即时语音服务暂时无法连接，请重试。');
    }
    const answerSdp = await response.text();
    const callId = response.headers.get('location')?.split('?')[0]?.split('/').pop();
    if (!answerSdp.startsWith('v=0') || answerSdp.length > 131072 || !callId || !/^[\w-]{1,200}$/u.test(callId))
      throw new LiveVoiceError('即时语音未返回有效连接，请重试。');
    return { answerSdp, callId };
  });
}
