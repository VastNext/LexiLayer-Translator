import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DynamicPageObserver } from '../../src/content/dynamic-observer';
import { ParagraphStore, type ParagraphRecord } from '../../src/content/paragraph-store';
import { InlineRenderer } from '../../src/content/inline-renderer';

/**
 * 仅译文模式防闪烁回归。
 *
 * 缺陷背景：内联渲染器在 translation-only 模式把原文包裹进 [data-vast-source]
 * 并设置 hidden。若 readSourceText 将该扩展隐藏的包装视为"网页隐藏文本"，
 * 段落后续任何 refresh（动态页面外部 mutation 触发）都会把源文本读成空串并
 * 自增 version，触发 restore → 重译 → 再次隐藏的无限循环，页面表现为待翻译
 * 文字反复闪烁。
 *
 * 本测试用真实 ParagraphStore + DynamicPageObserver + InlineRenderer 复刻
 * index.ts 的 observer 处理链（restore → refresh → renderLoading → 重译）。
 */
describe('仅译文模式防闪烁回归', () => {
  const activeObservers: DynamicPageObserver[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    // 真实用户报告的下钻结构：h2 > span > a > span
    document.body.innerHTML = `
      <main>
        <h2 id="drill">
          <span class="outer">
            <a id="drill-link" href="/repo/releases">
              <span id="drill-text">Releases</span>
            </a>
          </span>
        </h2>
        <p id="plain">Plain paragraph</p>
      </main>`;
  });

  afterEach(() => {
    for (const observer of activeObservers.splice(0)) observer.stop();
    vi.useRealTimers();
  });

  interface Harness {
    store: ParagraphStore;
    renderer: InlineRenderer;
    paragraph: ParagraphRecord;
    /** 每次 invalidation 视为一次重新翻译请求，记录请求时的源文本。 */
    retranslationRequests: string[];
    invalidationCount: () => number;
  }

  /** 复刻 index.ts createObserverHandler 对 invalidated 的真实处理链。 */
  function setup(paragraphElement: HTMLElement): Harness {
    const store = new ParagraphStore();
    const renderer = new InlineRenderer();
    const retranslationRequests: string[] = [];
    let invalidations = 0;
    const paragraph = store.getOrCreate(paragraphElement);
    const observer = new DynamicPageObserver(document.body, {
      scan: () => [],
      store,
      debounceMs: 20,
      onChanges(changes) {
        for (const record of changes.invalidated) {
          invalidations += 1;
          retranslationRequests.push(record.sourceText);
          renderer.restore(record);
          store.refresh(record.element);
          renderer.renderLoading(record);
        }
      },
    });
    observer.start();
    activeObservers.push(observer);
    return { store, renderer, paragraph, retranslationRequests, invalidationCount: () => invalidations };
  }

  /** 模拟调度方完整渲染一轮：loading → 翻译完成 → 仅译文。 */
  function renderTranslationOnly(harness: Harness, translation: string): void {
    const { paragraph, renderer } = harness;
    renderer.renderLoading(paragraph);
    renderer.renderTranslation(paragraph, translation, {
      mode: 'translation-only',
      placement: 'after',
      ...renderer.beginTask(paragraph),
    });
  }

  it('translation-only 渲染后多轮 debounce 内 version 与源文本保持不变，无重复失效与重复请求', async () => {
    const h2 = document.getElementById('drill') as HTMLElement;
    const harness = setup(h2);

    renderTranslationOnly(harness, '发布版本');

    // 等待远超一个 debounce 周期的多轮，让潜在的失效循环充分暴露。
    await vi.advanceTimersByTimeAsync(200);

    expect(harness.invalidationCount()).toBe(0);
    expect(harness.retranslationRequests).toEqual([]);
    expect(harness.paragraph.version).toBe(1);
    expect(harness.paragraph.sourceText).toBe('Releases');

    // 仅译文状态就位：译文可见，原文被扩展隐藏但仍在 DOM 中。
    const translator = document.querySelector('[data-vast-translator]') as HTMLElement;
    expect(translator?.textContent).toBe('发布版本');
    const sourceWrapper = harness.paragraph.sourceWrapper as HTMLElement;
    expect(sourceWrapper?.hidden).toBe(true);
    expect(sourceWrapper?.textContent).toContain('Releases');

    // 原文可完整恢复。
    harness.renderer.restore(harness.paragraph);
    expect((document.getElementById('drill-text') as HTMLElement).textContent).toBe('Releases');
  });

  it('真实用户 h2>span>a>span 结构：译文挂载在链接内部最内层 span', async () => {
    const h2 = document.getElementById('drill') as HTMLElement;
    const link = document.getElementById('drill-link') as HTMLElement;
    const harness = setup(h2);

    renderTranslationOnly(harness, '发布版本');
    await vi.advanceTimersByTimeAsync(200);

    expect(harness.invalidationCount()).toBe(0);
    expect(harness.paragraph.version).toBe(1);
    expect(harness.paragraph.sourceText).toBe('Releases');
    // 下钻挂载：译文与源包装都在链接内部最内层文本容器中。
    expect(harness.paragraph.targetElement).toBe(document.getElementById('drill-text'));
    expect(link.querySelector('[data-vast-translator]')?.textContent).toBe('发布版本');
    expect(h2.contains(document.querySelector('[data-vast-source]'))).toBe(true);
  });

  it('动态页面外部 mutation 触发段落 refresh 时，隐藏源包装内的原文仍被读取，不进入失效循环', async () => {
    const h2 = document.getElementById('drill') as HTMLElement;
    const harness = setup(h2);

    renderTranslationOnly(harness, '发布版本');
    await vi.advanceTimersByTimeAsync(40);
    expect(harness.invalidationCount()).toBe(0);

    // 模拟动态页面在段落内部的外部变化（如时间戳刷新、懒加载装饰节点）。
    const outer = h2.querySelector('.outer') as HTMLElement;
    outer.append(document.createElement('span'));
    // 连续多轮外部变化 + debounce，验证循环不会自我延续。
    for (let round = 0; round < 4; round += 1) {
      await vi.advanceTimersByTimeAsync(30);
      outer.append(document.createElement('span'));
    }
    await vi.advanceTimersByTimeAsync(40);

    expect(harness.invalidationCount()).toBe(0);
    expect(harness.retranslationRequests).toEqual([]);
    expect(harness.paragraph.version).toBe(1);
    expect(harness.paragraph.sourceText).toBe('Releases');
  });

  it('渲染稳定后网页修改源包装内文本仍触发失效并按新文本重译', async () => {
    const h2 = document.getElementById('drill') as HTMLElement;
    const harness = setup(h2);

    renderTranslationOnly(harness, '发布版本');
    await vi.advanceTimersByTimeAsync(60);
    expect(harness.invalidationCount()).toBe(0);

    // 网页自身修改源文本（位于 [data-vast-source] 包装内的原始文本节点）。
    const sourceWrapper = harness.paragraph.sourceWrapper as HTMLElement;
    (sourceWrapper.firstChild as Text).textContent = 'Releases updated';

    await vi.advanceTimersByTimeAsync(40);

    expect(harness.invalidationCount()).toBe(1);
    expect(harness.retranslationRequests).toEqual(['Releases updated']);
    expect(harness.paragraph.version).toBe(2);
    expect(harness.paragraph.sourceText).toBe('Releases updated');
  });

  it('网页固有隐藏辅助文本不进入源文本，译文文本也始终被排除', () => {
    document.body.innerHTML = `
      <main>
        <p id="mixed">Visible text <span hidden>hidden helper</span><span style="visibility:hidden">ghost</span></p>
      </main>`;
    const p = document.getElementById('mixed') as HTMLElement;
    const store = new ParagraphStore();
    const paragraph = store.getOrCreate(p);
    expect(paragraph.sourceText).toBe('Visible text');

    // 渲染后再 refresh：源包装（扩展隐藏）内的可见原文仍可读，
    // 网页固有隐藏文本与插件译文都不会混入。
    const renderer = new InlineRenderer();
    renderer.renderLoading(paragraph);
    renderer.renderTranslation(paragraph, '可见文本', {
      mode: 'translation-only',
      placement: 'after',
      ...renderer.beginTask(paragraph),
    });
    expect(store.refresh(p).sourceText).toBe('Visible text');
    renderer.restore(paragraph);
  });
});
