/** 原生语音与 WorkBuddy 连续语音共享界面，不共享身份或上游连接。 */
import type { LiveVoiceStyleId } from '../../shared/live-voice-style.ts';

export interface LiveData {
  active: boolean;
  phase: 'idle' | 'connecting' | 'live';
  message: string;
  user: string;
  pet: string;
}
export interface LiveControlOptions {
  source?: string;
  petId: string;
  changed(state: LiveData): void;
  canStart(): boolean;
  style?(): LiveVoiceStyleId;
}
