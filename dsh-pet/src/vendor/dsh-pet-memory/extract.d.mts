export interface ExtractedFact {
  kind: string;
  text: string;
  tags: string[];
  salience: number;
}
export function extractFacts(text: string, options?: { max?: number }): ExtractedFact[];
export function isPromptInjection(text: string): boolean;
export function tagsFor(text: string): string[];
export function isNearDuplicate(text: string, existing?: string[], threshold?: number): boolean;
