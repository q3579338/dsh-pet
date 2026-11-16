/** 本机长期记忆；模型来源不参与分桶，同一只宠物在切换模型后继续使用。 */
export const MEMORY_KINDS = ['profile', 'preference', 'promise', 'relationship', 'event', 'lesson'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemorySource = 'text' | 'codex-voice' | 'workbuddy-voice' | 'manual';
export interface MemoryFact {
  id: string;
  kind: MemoryKind;
  text: string;
  tags: string[];
  salience: number;
  ts: number;
  key: string;
  source: MemorySource;
}
export interface MemoryState {
  version: 1;
  enabled: boolean;
  revision: number;
  facts: MemoryFact[];
}
export type MemoryCandidate = Pick<MemoryFact, 'kind' | 'text' | 'tags' | 'salience' | 'key'>;
