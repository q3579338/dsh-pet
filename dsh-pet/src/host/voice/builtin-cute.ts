/** 大肥鱼的原创调音预设：基于 Edge 女声调整语速与音高，沿用统一的合成、缓存及取消链路。 */
import { synthesize, type EdgeSynthInput } from './edge.ts';
import { registerVoiceProvider, resolveVoice } from './registry.ts';
import { limitedVoiceId, type VoiceProvider } from './types.ts';
import { EDGE_PROVIDER } from './builtin-edge.ts';

/** 原创调音分组；预设参数改变时递增音色 id 的版本，避免复用旧音频缓存。 */
export const CUTE_PROVIDER_ID = 'bigfish-cute';

/** 展示信息与合成参数共用同一份预设。 */
export const CUTE_VOICES = [
  { id: 'starbell-v1', name: '星铃', tag: '少女 · 元气', baseVoice: 'zh-CN-XiaoyiNeural', pitch: 18, rate: 6 },
  { id: 'moon-soft-v1', name: '月棉', tag: '少女 · 温柔', baseVoice: 'zh-CN-XiaoxiaoNeural', pitch: 8, rate: -8 },
  { id: 'sugarbud-v1', name: '糖芽', tag: '萝莉 · 软萌', baseVoice: 'zh-CN-XiaoyiNeural', pitch: 38, rate: -7 },
  { id: 'dango-v1', name: '团子', tag: '萝莉 · 俏皮', baseVoice: 'zh-CN-XiaoxiaoNeural', pitch: 48, rate: 5 },
] as const;

/** 创建预设实现；可注入合成器验证最终交给语音引擎的参数。 */
export function createCuteVoiceProvider(
  render: (input: EdgeSynthInput) => Promise<Uint8Array> = synthesize,
): VoiceProvider {
  return {
    id: CUTE_PROVIDER_ID,
    name: '大肥鱼 · 原创调音',
    voices: CUTE_VOICES.map(({ id, name, tag }) => ({ id, name, tag })),
    format: 'mp3',
    timeoutMs: EDGE_PROVIDER.timeoutMs,
    async synthesize({ text, voice, rate, signal }) {
      const preset = CUTE_VOICES.find((item) => item.id === voice);
      if (!preset) throw new Error('没有找到所选的调音预设');
      return render({
        text,
        voice: preset.baseVoice,
        pitch: preset.pitch,
        rate: Math.max(-50, Math.min(100, rate + preset.rate)),
        signal,
      });
    },
  };
}

/** 只由 Codex 入口装配，原版 Edge 分组与用户已经选中的音色继续保留。 */
export function ensureCuteVoices(): void {
  if (resolveVoice(limitedVoiceId(CUTE_PROVIDER_ID, CUTE_VOICES[0].id))) return;
  registerVoiceProvider(createCuteVoiceProvider());
}
