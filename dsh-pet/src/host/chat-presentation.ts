/** 文字对话与连续语音共用同一动作播放入口，回执仍由实际渲染端上报。 */
import type { PollStateStore } from './state.ts';
import type { PlaybackStore } from './playback.ts';
export function playChatAction(state: PollStateStore, playback: PlaybackStore, petId: string, action: string): void {
  const record = playback.create(petId, action);
  state.writePet(petId, 'anim', { name: action, playbackId: record.playbackId, chatHold: true });
}
