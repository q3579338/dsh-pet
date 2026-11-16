interface RecallFact {
  id: string;
  text: string;
  kind: string;
  tags: string[];
  ts: number;
  salience: number;
}
export function recall<T extends RecallFact>(
  store: { facts(): T[] },
  query: string,
  options?: { limit?: number; minScore?: number },
): Array<T & { score: number }>;
export function neutralize(text: string): string;
