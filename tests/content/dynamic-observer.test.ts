import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DynamicPageObserver } from '../../src/content/dynamic-observer';
import { ParagraphStore } from '../../src/content/paragraph-store';
import { DomRenderer } from '../../src/content/dom-renderer';

describe('DynamicPageObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p id="existing">Original</p></main>';
  });

  it('debounce 后只扫描新增子树，批次内按包含关系去重', async () => {
    const scan = vi.fn();
    const observer = new DynamicPageObserver(document.body, { scan, debounceMs: 20 });
    observer.start();

    const section = document.createElement('section');
    const paragraph = document.createElement('p');
    section.append(paragraph);
    document.querySelector('main')!.append(section);
    section.append(document.createElement('span'));

    await vi.advanceTimersByTimeAsync(20);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(section);
    expect(scan).not.toHaveBeenCalledWith(document.body);
    observer.stop();
  });

  it('一个 debounce 批次把多个局部根结果合并通知一次', async () => {
    const first = document.createElement('p'); first.textContent = 'first';
    const second = document.createElement('p'); second.textContent = 'second';
    const onAdded = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: (root) => [...root.querySelectorAll<HTMLElement>('p'), ...(root.matches('p') ? [root as HTMLElement] : [])],
      onAdded,
      debounceMs: 20,
    });
    observer.start();
    document.querySelector('main')!.append(first, second);
    await vi.advanceTimersByTimeAsync(20);
    expect(onAdded).toHaveBeenCalledOnce();
    expect(onAdded).toHaveBeenCalledWith([first, second]);
    observer.stop();
  });

  it('同一 debounce 将新增、失效和移除合并为一个变更通知', async () => {
    const existing = document.querySelector('#existing') as HTMLElement;
    const removed = document.createElement('p'); removed.textContent = 'removed'; document.querySelector('main')!.append(removed);
    const store = new ParagraphStore(); store.getOrCreate(existing); const removedRecord = store.getOrCreate(removed);
    const onChanges = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: (root) => root.matches('p') ? [root as HTMLElement] : [], store, onChanges, debounceMs: 20,
    });
    observer.start();
    existing.firstChild!.textContent = 'changed';
    const added = document.createElement('p'); added.textContent = 'added'; document.querySelector('main')!.append(added);
    removed.remove();
    await vi.advanceTimersByTimeAsync(20);
    expect(onChanges).toHaveBeenCalledOnce();
    expect(onChanges).toHaveBeenCalledWith({
      added: [added], invalidated: [expect.objectContaining({ element: existing })], removed: [removedRecord],
    });
    observer.stop();
  });

  it('忽略插件自身节点及其后代变化', async () => {
    const scan = vi.fn();
    const observer = new DynamicPageObserver(document.body, { scan, debounceMs: 20 });
    observer.start();

    const pluginNode = document.createElement('span');
    pluginNode.dataset.vastTranslator = '';
    document.querySelector('main')!.append(pluginNode);
    pluginNode.textContent = '译文';

    await vi.advanceTimersByTimeAsync(20);
    expect(scan).not.toHaveBeenCalled();
    observer.stop();
  });

  it('源文本变化使段落版本失效并回调更新后的记录', async () => {
    const source = document.querySelector('#existing') as HTMLElement;
    const store = new ParagraphStore();
    const paragraph = store.getOrCreate(source);
    const onInvalidated = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: vi.fn(),
      store,
      onInvalidated,
      debounceMs: 20,
    });
    observer.start();

    source.firstChild!.textContent = 'Changed';
    await vi.advanceTimersByTimeAsync(20);

    expect(paragraph.version).toBe(2);
    expect(paragraph.sourceText).toBe('Changed');
    expect(onInvalidated).toHaveBeenCalledOnce();
    expect(onInvalidated).toHaveBeenCalledWith(paragraph);
    observer.stop();
  });

  it('每次有效 mutation 都重置 debounce 计时', async () => {
    const scan = vi.fn();
    const observer = new DynamicPageObserver(document.body, { scan, debounceMs: 20 });
    observer.start();

    document.querySelector('main')!.append(document.createElement('section'));
    await vi.advanceTimersByTimeAsync(15);
    document.querySelector('main')!.append(document.createElement('article'));
    await vi.advanceTimersByTimeAsync(5);
    expect(scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15);
    expect(scan).toHaveBeenCalledTimes(2);
    observer.stop();
  });

  it.each(['li', 'td', 'th'])('忽略 renderer 对 %s 的内部包装且不产生失效循环', async (tag) => {
    document.body.innerHTML = tag === 'li' ? '<ul><li id="source">item</li></ul>' : `<table><tr><${tag} id="source">cell</${tag}></tr></table>`;
    const source = document.querySelector('#source') as HTMLElement;
    const store = new ParagraphStore();
    const paragraph = store.getOrCreate(source);
    const onInvalidated = vi.fn();
    const observer = new DynamicPageObserver(document.body, { scan: vi.fn(), store, onInvalidated, debounceMs: 20 });
    observer.start();
    const renderer = new DomRenderer();
    renderer.renderTranslation(paragraph, 'translated', { mode: 'bilingual', placement: 'after', ...renderer.beginTask(paragraph) });
    await vi.advanceTimersByTimeAsync(40);
    expect(paragraph.version).toBe(1);
    expect(onInvalidated).not.toHaveBeenCalled();
    observer.stop();
  });

  it('renderer 内部 mutation 不进入 ParagraphStore.refresh', async () => {
    document.body.innerHTML = '<ul><li id="source">item</li></ul>';
    const source = document.querySelector('#source') as HTMLElement;
    const store = new ParagraphStore();
    const paragraph = store.getOrCreate(source);
    const refresh = vi.spyOn(store, 'refresh');
    const observer = new DynamicPageObserver(document.body, { scan: vi.fn(), store, onInvalidated: vi.fn(), debounceMs: 20 });
    observer.start();

    const renderer = new DomRenderer();
    renderer.renderTranslation(paragraph, 'translated', { mode: 'bilingual', placement: 'after', ...renderer.beginTask(paragraph) });
    await vi.advanceTimersByTimeAsync(20);

    expect(refresh).not.toHaveBeenCalled();
    observer.stop();
  });

  it('文本未实际变化时不触发 onInvalidated', async () => {
    const source = document.querySelector('#existing') as HTMLElement;
    const store = new ParagraphStore(); store.getOrCreate(source);
    const onInvalidated = vi.fn();
    const observer = new DynamicPageObserver(document.body, { scan: vi.fn(), store, onInvalidated, debounceMs: 20 });
    observer.start();
    source.firstChild!.textContent = 'Original';
    await vi.advanceTimersByTimeAsync(20);
    expect(onInvalidated).not.toHaveBeenCalled();
    observer.stop();
  });

  it('removedNodes 通知已跟踪段落并从 store 删除', async () => {
    const source = document.querySelector('#existing') as HTMLElement;
    const store = new ParagraphStore(); const paragraph = store.getOrCreate(source);
    const onRemoved = vi.fn();
    const observer = new DynamicPageObserver(document.body, { scan: vi.fn(), store, onRemoved, debounceMs: 20 });
    observer.start(); source.remove(); await vi.advanceTimersByTimeAsync(20);
    expect(onRemoved).toHaveBeenCalledWith(paragraph);
    expect(store.get(source)).toBeUndefined();
    observer.stop();
  });

  it('同一 debounce 批次内移动并重新连接的段落不当作删除', async () => {
    const source = document.querySelector('#existing') as HTMLElement;
    const store = new ParagraphStore(); store.getOrCreate(source);
    const onRemoved = vi.fn();
    const observer = new DynamicPageObserver(document.body, { scan: vi.fn(), store, onRemoved, debounceMs: 20 });
    observer.start(); document.body.append(source); await vi.advanceTimersByTimeAsync(20);
    expect(onRemoved).not.toHaveBeenCalled();
    expect(store.get(source)).toBeDefined();
    observer.stop();
  });

  it('折叠区移除 inert 属性时触发重新扫描并通知新增段落', async () => {
    document.body.innerHTML = `
      <main>
        <div id="region" inert>
          <p id="city">Paris</p>
        </div>
      </main>`;
    const region = document.getElementById('region')!;
    const city = document.getElementById('city')!;
    const onAdded = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: (root) => {
        if (root.closest('[inert]') || (root as HTMLElement).inert) return [];
        return [...root.querySelectorAll<HTMLElement>('p')];
      },
      onAdded,
      debounceMs: 20,
    });
    observer.start();

    // 初始状态带 inert，移除 inert 模拟展开手风琴
    region.removeAttribute('inert');
    await vi.advanceTimersByTimeAsync(20);

    expect(onAdded).toHaveBeenCalledOnce();
    expect(onAdded).toHaveBeenCalledWith([city]);
    observer.stop();
  });

  it('legacy loading 相邻 wrapper 在 source 被 replaceWith 后摘除且新节点独立跟踪', async () => {
    document.body.innerHTML = '<main><p id="source">Hello</p></main>';
    const source = document.querySelector('#source') as HTMLElement;
    const store = new ParagraphStore();
    const renderer = new DomRenderer();
    const paragraph = store.getOrCreate(source);
    renderer.renderLoading(paragraph);
    // legacy 外部渲染：loading wrapper 是 source 的相邻兄弟节点。
    expect(paragraph.wrapper!.dataset.vastState).toBe('loading');
    expect(paragraph.wrapper!.parentElement).toBe(source.parentElement);

    const onChanges = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: (root) => root.matches('p') ? [root as HTMLElement] : [],
      store,
      onChanges,
      debounceMs: 20,
    });
    observer.start();

    const clone = source.cloneNode(true) as HTMLElement;
    source.replaceWith(clone);
    await vi.advanceTimersByTimeAsync(20);

    // 旧 loading wrapper 不得残留为永久孤儿节点。
    expect(document.querySelector('[data-vast-translator]')).toBeNull();
    // 原记录已删除；observer 只上报新节点，不为其建记录。
    expect(store.get(source)).toBeUndefined();
    expect(store.get(clone)).toBeUndefined();
    expect(onChanges).toHaveBeenCalledOnce();
    expect(onChanges).toHaveBeenCalledWith({
      added: [clone],
      invalidated: [],
      removed: [paragraph],
    });

    // 控制器侧为新节点独立建立记录并渲染 loading，不继承旧状态。
    const cloneRecord = store.getOrCreate(clone);
    expect(cloneRecord.id).not.toBe(paragraph.id);
    expect(cloneRecord.wrapper).toBeUndefined();
    renderer.renderLoading(cloneRecord);
    expect(clone.hasAttribute('data-vast-translator')).toBe(false);
    expect(document.querySelectorAll('[data-vast-translator]')).toHaveLength(1);
    expect(cloneRecord.wrapper!.dataset.vastState).toBe('loading');
    expect(cloneRecord.wrapper!.parentElement).toBe(clone.parentElement);
    observer.stop();
  });

  it('source 直接移除时其相邻 loading wrapper 一并从 DOM 摘除', async () => {
    document.body.innerHTML = '<main><p id="source">Hello</p></main>';
    const source = document.querySelector('#source') as HTMLElement;
    const store = new ParagraphStore();
    const renderer = new DomRenderer();
    const paragraph = store.getOrCreate(source);
    renderer.renderLoading(paragraph);
    expect(document.querySelector('[data-vast-translator]')).not.toBeNull();

    const onRemoved = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: vi.fn(),
      store,
      onRemoved,
      debounceMs: 20,
    });
    observer.start();
    source.remove();
    await vi.advanceTimersByTimeAsync(20);

    expect(onRemoved).toHaveBeenCalledWith(paragraph);
    expect(store.get(source)).toBeUndefined();
    expect(document.querySelector('[data-vast-translator]')).toBeNull();
    observer.stop();
  });

  it('source 被替换后晚到的原请求成功不渲染到新节点', async () => {
    document.body.innerHTML = '<main><p id="source">Hello</p></main>';
    const source = document.querySelector('#source') as HTMLElement;
    const store = new ParagraphStore();
    const renderer = new DomRenderer();
    const paragraph = store.getOrCreate(source);
    renderer.renderLoading(paragraph);
    const staleToken = renderer.beginTask(paragraph);

    const observer = new DynamicPageObserver(document.body, {
      scan: (root) => root.matches('p') ? [root as HTMLElement] : [],
      store,
      onChanges: vi.fn(),
      debounceMs: 20,
    });
    observer.start();
    const clone = source.cloneNode(true) as HTMLElement;
    source.replaceWith(clone);
    await vi.advanceTimersByTimeAsync(20);

    // 晚到的原请求结果：旧元素已断开，渲染器拒绝且不落到新节点。
    expect(renderer.renderTranslation(paragraph, '迟到的译文', { mode: 'bilingual', placement: 'after', ...staleToken })).toBe(false);
    expect(document.querySelector('[data-vast-state="translated"]')).toBeNull();
    expect(clone.textContent).toBe('Hello');

    // 新节点正常翻译不受旧请求污染。
    const cloneRecord = store.getOrCreate(clone);
    renderer.renderLoading(cloneRecord);
    const freshToken = renderer.beginTask(cloneRecord);
    expect(renderer.renderTranslation(cloneRecord, '新译文', { mode: 'bilingual', placement: 'after', ...freshToken })).toBe(true);
    expect(document.querySelectorAll('[data-vast-state="translated"]')).toHaveLength(1);
    expect(clone.nextElementSibling?.textContent).toBe('新译文');
    expect(clone.textContent).toBe('Hello');
    observer.stop();
  });

  it('source 被替换后晚到的原请求失败不渲染错误到新节点', async () => {
    document.body.innerHTML = '<main><p id="source">Hello</p></main>';
    const source = document.querySelector('#source') as HTMLElement;
    const store = new ParagraphStore();
    const renderer = new DomRenderer();
    const paragraph = store.getOrCreate(source);
    renderer.renderLoading(paragraph);

    const observer = new DynamicPageObserver(document.body, {
      scan: (root) => root.matches('p') ? [root as HTMLElement] : [],
      store,
      onChanges: vi.fn(),
      debounceMs: 20,
    });
    observer.start();
    const clone = source.cloneNode(true) as HTMLElement;
    source.replaceWith(clone);
    await vi.advanceTimersByTimeAsync(20);

    // 晚到的原请求失败：旧元素断开后 renderError 只产生脱离文档的 wrapper。
    renderer.renderError(paragraph, '翻译失败');
    expect(document.querySelector('[data-vast-state="error"]')).toBeNull();
    expect(document.querySelector('[data-vast-translator]')).toBeNull();
    expect(clone.textContent).toBe('Hello');

    // 新节点的失败独立渲染，不受旧请求影响。
    const cloneRecord = store.getOrCreate(clone);
    renderer.renderLoading(cloneRecord);
    renderer.renderError(cloneRecord, '翻译失败');
    expect(document.querySelectorAll('[data-vast-state="error"]')).toHaveLength(1);
    expect(clone.nextElementSibling?.textContent).toContain('翻译失败');
    expect(clone.textContent).toBe('Hello');
    observer.stop();
  });
});
