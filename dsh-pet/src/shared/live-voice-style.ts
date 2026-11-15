/** 即时通话的原生说话风格；不经过 Edge 朗读器或本地变声处理。 */
export const LIVE_VOICE_STYLES = [
  {
    id: 'starbell',
    name: '星铃 · 轻甜',
    instructions:
      '用标准普通话，使用明亮、轻盈、柔和的年轻女性声线，带自然笑意。音调稍高但不尖锐，轻快利落，不挤嗓、不耳语、不拖长尾音。像熟悉的朋友自然聊天，每次先回一两句短句，然后停下来听对方。',
  },
  {
    id: 'moon',
    name: '月棉 · 温柔',
    instructions:
      '用标准普通话，使用清澈、柔和、温暖的年轻女性声线，自然、有亲近感，语调有轻微起伏。保持自然聊天的速度，字头清楚，不刻意压低或拖慢声音，每次先回一两句短句。',
  },
  {
    id: 'sugarbud',
    name: '糖芽 · 软萌',
    instructions:
      '用标准普通话，使用轻盈、明亮、偏高但不尖的年轻女性声线，温柔、活泼，带一点俏皮和笑意。发音清楚，音量均匀，不挤嗓、不刻意装幼儿、不持续耳语。节奏轻快，短句回答，不拖长语尾。',
  },
  { id: 'natural', name: '自然原声', instructions: '' },
] as const;

/** 风格标识只控制声音指令，不表示独立训练或克隆的角色声库。 */
export type LiveVoiceStyleId = (typeof LIVE_VOICE_STYLES)[number]['id'];
/** 本次按用户偏好默认轻甜，保留直接语音的响应路径。 */
export const DEFAULT_LIVE_VOICE_STYLE: LiveVoiceStyleId = 'starbell';

/** 只接受目录内的风格，未知编号不偷偷变成另一个音色。 */
export function liveVoiceStyle(id: unknown): (typeof LIVE_VOICE_STYLES)[number] | undefined {
  return LIVE_VOICE_STYLES.find((style) => style.id === id);
}
