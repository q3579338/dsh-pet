/** 独立版沿用国内 WorkBuddy 登录识别，和 Codex 账号完全分开。 */
import { createWorkBuddyConnection } from '../../standalone/workbuddy/connection.ts';
import { registerSpeechProvider, resolveSpeechProvider } from './speech-registry.ts';
import { SpeechUnavailableError } from './speech-types.ts';
export function ensureWorkBuddySpeech(home: string): void {
  if (resolveSpeechProvider('workbuddy')) return;
  registerSpeechProvider({
    id: 'workbuddy',
    name: 'WorkBuddy 语音识别（沿用国内版登录）',
    timeoutMs: 35000,
    async transcribe({ audio, signal }) {
      const connection = createWorkBuddyConnection(home);
      try {
        if (!connection.hear) throw new SpeechUnavailableError('WorkBuddy 语音识别组件暂不可用。');
        return await connection.hear(audio, signal ?? AbortSignal.timeout(35000));
      } finally {
        connection.dispose();
      }
    },
  });
}
