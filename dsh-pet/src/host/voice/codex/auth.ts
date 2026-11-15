/** 通过本机 Codex 取得本次听写所需的身份，只驻留内存，不读写或记录凭据文件。 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { CodexClient, codexRecord } from '../../../standalone/codex/client.ts';
import { SpeechUnavailableError } from '../speech-types.ts';

/** 仅发给固定的 Codex/OpenAI 听写端点。 */
export interface CodexSpeechIdentity {
  readonly token: string;
  readonly accountId?: string;
}

/** 身份读取需要的最小客户端，方便隔离验证取消与释放。 */
export type SpeechAuthClient = Pick<CodexClient, 'initialize' | 'request' | 'close'>;

/** 每次只启动自己持有的连接，完成或取消即关闭，不触碰正在运行的 Codex。 */
export async function readCodexSpeechIdentity(
  signal?: AbortSignal,
  refreshToken = false,
  createClient: () => SpeechAuthClient = () => {
    const home = process.env.DSH_HOME || join(homedir(), '.codex-bigfish');
    mkdirSync(home, { recursive: true });
    return new CodexClient(home);
  },
): Promise<CodexSpeechIdentity> {
  if (signal?.aborted) throw new Error('语音识别已停止。');
  const client = createClient();
  const abort = (): void => client.close(new Error('语音识别已停止。'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    await client.initialize();
    const auth = codexRecord(await client.request('getAuthStatus', { includeToken: true, refreshToken }, 10000));
    if (
      auth.authMethod !== 'chatgpt' ||
      typeof auth.authToken !== 'string' ||
      !auth.authToken ||
      /[\r\n]/u.test(auth.authToken)
    )
      throw new SpeechUnavailableError('请先用 ChatGPT 账号登录本机 Codex，再使用 Codex 听写。');
    const account = codexRecord(
      codexRecord(await client.request('account/read', { refreshToken: false }, 10000)).account,
    );
    const accountId = typeof account.id === 'string' && /^[\w-]{1,200}$/u.test(account.id) ? account.id : undefined;
    return { token: auth.authToken, ...(accountId ? { accountId } : {}) };
  } finally {
    signal?.removeEventListener('abort', abort);
    client.close();
  }
}
