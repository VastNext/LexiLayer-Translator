import { beforeEach, describe, expect, it } from 'vitest';

import { DomRenderer } from '../../src/content/dom-renderer';
import { ParagraphStore } from '../../src/content/paragraph-store';

describe('ParagraphStore 与 DomRenderer', () => {
  let source: HTMLParagraphElement;
  let store: ParagraphStore;
  let renderer: DomRenderer;

  beforeEach(() => {
    document.body.innerHTML = '<p id="source">Hello <strong>world</strong></p>';
    source = document.querySelector('#source')!;
    store = new ParagraphStore();
    renderer = new DomRenderer();
  });

  it('保存段落原文并在源文本变化时递增版本', () => {
    const paragraph = store.getOrCreate(source);
    expect(paragraph.sourceText).toBe('Hello world');
    expect(paragraph.version).toBe(1);

    source.textContent = 'Changed';
    expect(store.refresh(source)).toMatchObject({ sourceText: 'Changed', version: 2 });
  });

  it('使用 textContent 安全渲染双语译文，支持前后位置', () => {
    const paragraph = store.getOrCreate(source);
    const request = renderer.beginTask(paragraph);
    expect(renderer.renderTranslation(paragraph, '<img src=x onerror=alert(1)>', {
      mode: 'bilingual',
      placement: 'before',
      ...request,
    })).toBe(true);

    const wrapper = source.previousElementSibling as HTMLElement;
    expect(wrapper.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(wrapper.querySelector('img')).toBeNull();
    expect(source.hidden).toBe(false);

    renderer.renderTranslation(paragraph, '你好，世界', {
      mode: 'bilingual', placement: 'after', ...request,
    });
    expect(source.nextElementSibling?.textContent).toBe('你好，世界');
  });

  it('仅译文模式隐藏原文，恢复时移除插件节点并显示原文', () => {
    const paragraph = store.getOrCreate(source);
    const request = renderer.beginTask(paragraph);
    renderer.renderTranslation(paragraph, '你好，世界', {
      mode: 'translation-only', placement: 'after', ...request,
    });
    expect(source.hidden).toBe(true);

    renderer.restore(paragraph);
    expect(source.hidden).toBe(false);
    expect(document.querySelector('[data-vast-translator]')).toBeNull();
    expect(source.innerHTML).toBe('Hello <strong>world</strong>');
    expect(paragraph.wrapper).toBeUndefined();
    expect(paragraph.sourceWrapper).toBeUndefined();
    expect(paragraph.currentTaskId).toBeUndefined();
  });

  it('站点 CSS 覆盖 hidden 时仍强制隐藏普通源元素', () => {
    source.style.setProperty('display', 'block', 'important');
    const paragraph = store.getOrCreate(source);
    const request = renderer.beginTask(paragraph);

    renderer.renderTranslation(paragraph, '你好，世界', {
      mode: 'translation-only', placement: 'after', ...request,
    });

    expect(source).toHaveAttribute('hidden');
  });

  it('渲染 loading 和 error 状态并允许后续成功结果替换', () => {
    const paragraph = store.getOrCreate(source);
    const request = renderer.beginTask(paragraph);
    renderer.renderLoading(paragraph);
    expect(document.querySelector('[data-vast-state="loading"]')?.textContent).toBe('翻译中…');

    renderer.renderError(paragraph, '翻译失败');
    expect(document.querySelector('[data-vast-state="error"]')?.textContent).toContain('翻译失败');
    expect(document.querySelector('[data-vast-retry-all]')).not.toBeNull();

    renderer.renderTranslation(paragraph, '译文', {
      mode: 'bilingual', placement: 'after', ...request,
    });
    expect(document.querySelector('[data-vast-state="translated"]')?.textContent).toBe('译文');
  });

  it('源文本变化后丢弃旧版本结果且不改变当前 DOM', () => {
    const paragraph = store.getOrCreate(source);
    const request = renderer.beginTask(paragraph);
    renderer.renderTranslation(paragraph, '旧译文', {
      mode: 'bilingual', placement: 'after', ...request,
    });

    source.textContent = 'New source';
    store.refresh(source);

    expect(renderer.renderTranslation(paragraph, '迟到的译文', {
      mode: 'bilingual',
      placement: 'after',
      expectedVersion: 1,
      taskId: request.taskId,
    })).toBe(false);
    expect(document.querySelector('[data-vast-translator]')?.textContent).toBe('旧译文');
  });

  it('新任务译文先完成时，迟到的旧任务结果不得清除新译文', () => {
    const paragraph = store.getOrCreate(source);
    const oldRequest = renderer.beginTask(paragraph);
    const newRequest = renderer.beginTask(paragraph);

    expect(renderer.renderTranslation(paragraph, '新译文', {
      mode: 'bilingual', placement: 'after', ...newRequest,
    })).toBe(true);
    expect(renderer.renderTranslation(paragraph, '旧译文', {
      mode: 'bilingual', placement: 'after', ...oldRequest,
    })).toBe(false);
    expect(document.querySelector('[data-vast-state="translated"]')?.textContent).toBe('新译文');
  });

  it.each(['td', 'th', 'li'])('%s 在元素内部渲染，translation-only 保留结构边界并可完整恢复', (tag) => {
    document.body.innerHTML = tag === 'li'
      ? '<ul><li id="source">List <strong>item</strong></li></ul>'
      : `<table><tbody><tr><${tag} id="source">Cell <strong>value</strong></${tag}></tr></tbody></table>`;
    source = document.querySelector('#source')!;
    const originalHtml = source.innerHTML;
    const paragraph = store.getOrCreate(source);
    const request = renderer.beginTask(paragraph);

    renderer.renderTranslation(paragraph, '译文', {
      mode: 'translation-only', placement: 'after', ...request,
    });

    expect(source.hidden).toBe(false);
    expect(source.querySelector(':scope > [data-vast-translator]')?.textContent).toBe('译文');
    expect(source.parentElement?.querySelector(':scope > div[data-vast-translator]')).toBeNull();
    expect(source.querySelector('[data-vast-source]')).toHaveProperty('hidden', true);

    renderer.restore(paragraph);
    expect(source.innerHTML).toBe(originalHtml);
  });

  it('受限元素含块级原文时使用合法的 div source wrapper', () => {
    document.body.innerHTML = '<ul><li id="source"><p>Block content</p></li></ul>';
    source = document.querySelector('#source')!;
    const paragraph = store.getOrCreate(source);
    const request = renderer.beginTask(paragraph);

    renderer.renderTranslation(paragraph, '译文', {
      mode: 'bilingual', placement: 'after', ...request,
    });

    expect(source.querySelector(':scope > div[data-vast-source] > p')?.textContent).toBe('Block content');
    renderer.restore(paragraph);
    expect(source.innerHTML).toBe('<p>Block content</p>');
  });

  it('按钮内部文本叶使用 span 译文包装，保持按钮结构合法', () => {
    document.body.innerHTML = '<button id="button"><span id="label">Reports snapshot</span></button>';
    const label = document.querySelector('#label') as HTMLElement;
    const paragraph = new ParagraphStore().getOrCreate(label);
    const renderer = new DomRenderer();
    const token = renderer.beginTask(paragraph);
    renderer.renderTranslation(paragraph, '报告快照', { ...token, mode: 'bilingual', placement: 'after' });
    const wrapper = document.querySelector('#label + [data-vast-translator]');
    expect(wrapper?.tagName).toBe('SPAN');
    expect(document.querySelector('#button')?.contains(wrapper)).toBe(true);
  });

  it('直接文本链接在仅译文模式下保留链接本体、href 和点击能力', () => {
    document.body.innerHTML = '<ul><li><a id="source" href="/category">Category</a></li></ul>';
    source = document.querySelector('#source') as unknown as HTMLParagraphElement;
    const originalHtml = source.innerHTML;
    const paragraph = store.getOrCreate(source);
    const token = renderer.beginTask(paragraph);
    let clicked = 0;
    source.addEventListener('click', (event) => { event.preventDefault(); clicked += 1; });

    renderer.renderTranslation(paragraph, '分类', { ...token, mode: 'translation-only', placement: 'after' });

    expect(source.hidden).toBe(false);
    expect(source.getAttribute('href')).toBe('/category');
    expect(source.querySelector(':scope > [data-vast-source]')).toHaveProperty('hidden', true);
    expect(source.querySelector(':scope > [data-vast-translator]')?.textContent).toBe('分类');
    source.click();
    expect(clicked).toBe(1);

    renderer.restore(paragraph);
    expect(source.innerHTML).toBe(originalHtml);
    expect(source.getAttribute('href')).toBe('/category');
  });
});
