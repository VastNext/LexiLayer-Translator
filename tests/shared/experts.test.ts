import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BUILTIN_EXPERTS, EXPERT_CATALOG_REVISION, canonicalExpertId } from '../../src/shared/experts';

describe('VastNext expert snapshot', () => {
  it('ships all experts from the dedicated repository snapshot', () => {
    expect(BUILTIN_EXPERTS).toHaveLength(29);
    expect(BUILTIN_EXPERTS.slice(0, 5).map((expert) => expert.id)).toEqual(['technology', 'medical', 'design', 'legal', 'financial']);
    expect(BUILTIN_EXPERTS.slice(-4).map((expert) => expert.id)).toEqual(['database', 'paragraph-summarizer', 'vocabulary-assistant', 'wyw']);
    expect(BUILTIN_EXPERTS).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'technology', name: '科技类翻译大师', description: '翻译代码、API 文档和技术教程，保留命令、路径、标识符与专业术语。' }),
      expect.objectContaining({ id: 'database' }),
      expect.objectContaining({ id: 'vocabulary-assistant' }),
    ]));
    expect(EXPERT_CATALOG_REVISION).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each([
    ['tech', 'technology'],
    ['wordByWord', 'word-by-word'],
    ['classicalToModern', 'classical-to-modern'],
    ['subliminal_lingo', 'subliminal-lingo'],
  ])('maps legacy expert id %s to %s', (legacy, current) => {
    expect(canonicalExpertId(legacy)).toBe(current);
  });

  it('keeps repository provenance and leaves JSON output protocol to the extension', () => {
    const snapshot = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../public/experts.json'), 'utf8')) as {
      source: string;
      revision: string;
      prompts: Record<string, string>;
    };
    expect(snapshot.source).toBe('https://github.com/VastNext/vast-expert-prompts');
    expect(snapshot.revision).toBe(EXPERT_CATALOG_REVISION);
    expect(Object.keys(snapshot.prompts)).toHaveLength(BUILTIN_EXPERTS.length);
    expect(snapshot.prompts.technology).toContain('For software terminology');
    expect(Object.values(snapshot.prompts).join('\n')).not.toContain('Return one JSON object');
  });

  it('uses explanatory display copy without repeating the repository brand', () => {
    expect(BUILTIN_EXPERTS.every((expert) => !expert.description.includes('VastNext'))).toBe(true);
    expect(BUILTIN_EXPERTS.every((expert) => expert.description.length >= 18)).toBe(true);
    expect(BUILTIN_EXPERTS).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'github', name: 'GitHub 专家' }),
      expect.objectContaining({ id: 'paragraph-summarizer', name: '段落摘要' }),
      expect.objectContaining({ id: 'ao3', name: '同人文学专家' }),
      expect.objectContaining({ id: 'classical-to-modern', name: '古文今译专家' }),
      expect.objectContaining({ id: 'wyw', name: '文言雅译专家' }),
    ]));
    expect(BUILTIN_EXPERTS.find((expert) => expert.id === 'classical-to-modern')?.description).toContain('现代汉语');
    expect(BUILTIN_EXPERTS.find((expert) => expert.id === 'wyw')?.description).toContain('古雅凝练');
  });
});
