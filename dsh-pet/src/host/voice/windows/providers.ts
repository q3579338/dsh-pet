/** Codex 独立版的本机语音：Windows 识别录音、Windows 朗读 Codex 回复，不需要 DSH 或 API 密钥。 */
import { registerVoiceProvider, resolveVoice } from '../registry.ts';
import { registerSpeechProvider, resolveSpeechProvider } from '../speech-registry.ts';
import type { VoiceProvider } from '../types.ts';
import type { SpeechProvider } from '../speech-types.ts';
import { runWindowsSpeech } from './run.ts';

/** 本机语音不冒充 Codex 的云端语音能力。 */
export const WINDOWS_VOICE_ID = 'windows/zh-CN';
/** 原桌宠与设置页共用的本机录音识别标识。 */
export const WINDOWS_SPEECH_ID = 'windows';

/** 保留 WAV 原始数据，录音格式错误不送入识别器。 */
export function validateWindowsWave(audio: Uint8Array): void {
  const bytes = Buffer.from(audio);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('录音不是有效的 WAV，请重新按住话筒录音。');
}

/** 中文和英文音色使用当前 Windows 安装的对应语言音色。 */
export const WINDOWS_VOICE_PROVIDER: VoiceProvider = {
  id: 'windows',
  name: 'Windows 本机朗读',
  voices: [
    { id: 'zh-CN', name: '中文 · 系统音色' },
    { id: 'en-US', name: '英文 · 系统音色' },
  ],
  format: 'wav',
  timeoutMs: 45_000,
  async synthesize({ text, voice, rate, signal }) {
    const result = await runWindowsSpeech({ operation: 'synthesize', text, voice, rate }, signal);
    if (typeof result.audio !== 'string') throw new Error('Windows 没有生成朗读音频。');
    const audio = Buffer.from(result.audio, 'base64');
    validateWindowsWave(audio);
    return audio;
  },
};

/** 仅识别客户端主动录制并提交的音频，不监听系统麦克风。 */
export const WINDOWS_SPEECH_PROVIDER: SpeechProvider = {
  id: WINDOWS_SPEECH_ID,
  name: 'Windows 本机识别（中文）',
  timeoutMs: 45_000,
  async transcribe({ audio, signal }) {
    validateWindowsWave(audio);
    const result = await runWindowsSpeech(
      { operation: 'transcribe', audio: Buffer.from(audio).toString('base64') },
      signal,
    );
    if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('没有识别到说话内容，请靠近话筒重试。');
    return result.text.trim();
  },
};

/** 只由 Windows Codex 入口装配，避免改变 DSH 插件版的候选目录。 */
export function ensureWindowsSpeech(): void {
  if (process.platform !== 'win32') return;
  if (!resolveVoice(WINDOWS_VOICE_ID)) registerVoiceProvider(WINDOWS_VOICE_PROVIDER);
  if (!resolveSpeechProvider(WINDOWS_SPEECH_ID)) registerSpeechProvider(WINDOWS_SPEECH_PROVIDER);
}
