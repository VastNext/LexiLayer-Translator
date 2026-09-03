import { BUILTIN_EXPERT_CATALOG, EXPERT_CATALOG_REVISION } from './builtin-experts.generated';

export type ExpertKind = 'builtin' | 'custom';

export interface Expert {
  id: string;
  kind: ExpertKind;
  name: string;
  description: string;
  prompt?: string;
  enabled: boolean;
  order: number;
}

export const BUILTIN_EXPERTS: Expert[] = BUILTIN_EXPERT_CATALOG.map(({ id, name, description }, order) => ({
  id, kind: 'builtin', name, description, prompt: '', enabled: false, order,
}));

export { EXPERT_CATALOG_REVISION };

export const LEGACY_EXPERT_ID_ALIASES: Record<string, string> = {
  tech: 'technology',
  wordByWord: 'word-by-word',
  classicalToModern: 'classical-to-modern',
  subliminal_lingo: 'subliminal-lingo',
};

export function canonicalExpertId(id: string): string {
  return LEGACY_EXPERT_ID_ALIASES[id] ?? id;
}

export const MAX_EXPERTS = 100;
export const MAX_EXPERT_PROMPT_LENGTH = 20_000;

export function defaultExperts(): Expert[] {
  return structuredClone(BUILTIN_EXPERTS);
}

export function expertById(experts: Expert[], id: string | undefined): Expert | undefined {
  return experts.find((expert) => expert.id === id && expert.enabled);
}

export function isAiEngine(engineId: string, kind?: string): boolean {
  return kind === 'custom-ai' || engineId.startsWith('custom-');
}
