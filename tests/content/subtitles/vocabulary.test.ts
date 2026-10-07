import { describe, expect, it, vi } from 'vitest';

import { saveWordToVocabulary } from '../../../src/content/subtitles/vocabulary';

// 字幕点词 → 生词本：字段截断与后台消息契约。

describe('saveWordToVocabulary', () => {
  it('发送 save-vocabulary-entry 且按上限截断字段', async () => {
    const send = vi.fn(async (_message: unknown) => ({ ok: true, data: { status: 'created' } }));
    const status = await saveWordToVocabulary(send, {
      word: ` ${'w'.repeat(150)} `,
      sentence: ` ${'s'.repeat(700)} `,
      translation: ` ${'t'.repeat(700)} `,
      targetLanguage: 'zh-Hans',
    }, { sourceUrl: 'https://www.youtube.com/watch?v=1', pageTitle: ` ${'p'.repeat(400)} ` });

    expect(status).toBe('created');
    const message = vi.mocked(send).mock.calls[0][0] as { type: string; draft: Record<string, string> };
    expect(message.type).toBe('save-vocabulary-entry');
    expect(message.draft.word).toHaveLength(120);
    expect(message.draft.sentence).toHaveLength(600);
    expect(message.draft.translation).toHaveLength(600);
    expect(message.draft.pageTitle).toHaveLength(300);
    expect(message.draft.targetLanguage).toBe('zh-Hans');
    expect(message.draft.sourceUrl).toBe('https://www.youtube.com/watch?v=1');
  });

  it('空译文与空标题省略字段；后台拒绝时抛错', async () => {
    const send = vi.fn(async () => ({ ok: false, error: '消息格式无效' }));
    await expect(saveWordToVocabulary(send, {
      word: 'hello', sentence: 'Hello world.', targetLanguage: 'zh-Hans',
    }, { sourceUrl: 'https://x.example/' })).rejects.toThrow('消息格式无效');

    const okSend = vi.fn(async (_message: unknown) => ({ ok: true, data: { status: 'duplicate' } }));
    const status = await saveWordToVocabulary(okSend, {
      word: 'hello', sentence: 'Hello world.', translation: '  ', targetLanguage: 'zh-Hans',
    }, { sourceUrl: 'https://x.example/' });
    expect(status).toBe('duplicate');
    const message = vi.mocked(okSend).mock.calls[0][0] as { draft: Record<string, string> };
    expect(message.draft.translation).toBeUndefined();
    expect(message.draft.pageTitle).toBeUndefined();
  });
});
