import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWordTooltip } from '../../../src/content/subtitles/word-tooltip';

// 字幕点词悬浮层：打开即查词 → 显示释义 → 加入生词本状态反馈；外部点击/Escape 关闭。

describe('createWordTooltip', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  function createDeps(overrides: Partial<Parameters<typeof createWordTooltip>[1]> = {}) {
    return {
      getTargetLanguage: vi.fn(async () => 'zh-Hans'),
      translateWord: vi.fn(async (word: string) => `释义:${word}`),
      saveToVocabulary: vi.fn(async () => 'created' as const),
      ...overrides,
    };
  }

  it('open 后渲染词、渐进释义与收词按钮', async () => {
    const deps = createDeps();
    createWordTooltip(document, deps).open('serene', 'The lake was serene.', new DOMRect(100, 100, 60, 20));
    const tip = document.querySelector('[data-lexiytds-wordtip]')!;
    expect(tip.querySelector('[data-lexiytds-wordtip-word]')?.textContent).toBe('serene');
    await vi.waitFor(() => expect(tip.querySelector('[data-lexiytds-wordtip-meaning]')?.textContent).toBe('释义:serene'));
    expect(deps.translateWord).toHaveBeenCalledWith('serene', 'The lake was serene.', 'zh-Hans');
  });

  it('加入生词本显示 created/duplicate/失败状态', async () => {
    const deps = createDeps({ saveToVocabulary: vi.fn(async () => 'duplicate' as const) });
    createWordTooltip(document, deps).open('word', 'sentence.', new DOMRect(0, 0, 10, 10));
    await vi.waitFor(() => expect(deps.saveToVocabulary).toBeDefined());
    const saveButton = document.querySelector('[data-lexiytds-wordtip] button') as HTMLButtonElement;
    await vi.waitFor(() => expect(saveButton).toBeEnabled());
    saveButton.click();
    await vi.waitFor(() => expect(saveButton.textContent).toBe('已在生词本'));
  });

  it('收词失败后按钮恢复可点，重试成功显示已加入', async () => {
    let attempts = 0;
    const deps = createDeps({
      saveToVocabulary: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return 'created' as const;
      }),
    });
    createWordTooltip(document, deps).open('word', 'sentence.', new DOMRect(0, 0, 10, 10));
    const saveButton = document.querySelector('[data-lexiytds-wordtip] button') as HTMLButtonElement;
    await vi.waitFor(() => expect(saveButton).toBeEnabled());
    saveButton.click();
    await vi.waitFor(() => expect(saveButton.textContent).toBe('加入失败'));
    expect(saveButton.disabled).toBe(false);
    saveButton.click();
    await vi.waitFor(() => expect(saveButton.textContent).toBe('已加入生词本'));
    expect(saveButton.disabled).toBe(true);
  });

  it('查词失败显示失败提示，收词按钮不出现异常', async () => {
    const deps = createDeps({ translateWord: vi.fn(async () => { throw new Error('down'); }) });
    createWordTooltip(document, deps).open('word', 'sentence.', new DOMRect(0, 0, 10, 10));
    await vi.waitFor(() => expect(document.querySelector('[data-lexiytds-wordtip-meaning]')?.textContent).toBe('查词失败'));
  });

  it('再次 open 关闭旧悬浮层（sequence 隔离），Escape 关闭当前', async () => {
    const deps = createDeps();
    const tooltip = createWordTooltip(document, deps);
    tooltip.open('a', 'a.', new DOMRect(0, 0, 10, 10));
    tooltip.open('b', 'b.', new DOMRect(0, 0, 10, 10));
    expect(document.querySelectorAll('[data-lexiytds-wordtip]')).toHaveLength(1);
    expect(document.querySelector('[data-lexiytds-wordtip-word]')?.textContent).toBe('b');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[data-lexiytds-wordtip]')).toBeNull();
  });

  it('destroy 后清理全部', () => {
    const deps = createDeps();
    const tooltip = createWordTooltip(document, deps);
    tooltip.open('a', 'a.', new DOMRect(0, 0, 10, 10));
    tooltip.destroy();
    expect(document.querySelector('[data-lexiytds-wordtip]')).toBeNull();
  });
});
