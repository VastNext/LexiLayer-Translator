import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DynamicPageObserver } from '../../src/content/dynamic-observer';
import { ParagraphStore, type ParagraphRecord } from '../../src/content/paragraph-store';
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

  it('段落内部结构变动且原文文本不变时，识别挂载失效并通知 onInvalidated', async () => {
    document.body.innerHTML = '<main><h2 id="heading"><span>Title</span></h2></main>';
    const heading = document.getElementById('heading') as HTMLElement;
    const store = new ParagraphStore();
    const paragraph = store.getOrCreate(heading);
    paragraph.sourceWrapper = document.createElement('span'); // 模拟已内联挂载
    const initialVersion = paragraph.version;

    const onInvalidated = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: vi.fn(),
      store,
      onInvalidated,
      debounceMs: 20,
    });
    observer.start();

    // 页面内部重构：替换 span 为 strong，文本 'Title' 保持完全一致！
    const strong = document.createElement('strong');
    strong.textContent = 'Title';
    heading.replaceChildren(strong);

    await vi.advanceTimersByTimeAsync(20);

    expect(onInvalidated).toHaveBeenCalledOnce();
    expect(paragraph.version).toBeGreaterThan(initialVersion);
    observer.stop();
  });

  it('深克隆产生无主 [data-vast-source] 和 [data-vast-translator] 时，安全还原原节点（保留事件与子节点）并识别失效', async () => {
    document.body.innerHTML = '<main><h2 id="heading"><span class="title">Title</span></h2></main>';
    const heading = document.getElementById('heading') as HTMLElement;
    const store = new ParagraphStore();
    const paragraph = store.getOrCreate(heading);

    // 模拟之前渲染过的插件结构被框架 deepclone 放回 DOM
    const fakeSource = document.createElement('span');
    fakeSource.dataset.vastSource = '';
    const strong = document.createElement('strong');
    strong.textContent = 'Title';
    let clicked = false;
    strong.addEventListener('click', () => { clicked = true; });
    fakeSource.append(strong);

    const fakeLoading = document.createElement('span');
    fakeLoading.dataset.vastTranslator = '';
    fakeLoading.dataset.vastState = 'loading';
    fakeLoading.textContent = '翻译中…';

    heading.replaceChildren(fakeSource, fakeLoading);

    const onInvalidated = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: vi.fn(),
      store,
      onInvalidated,
      debounceMs: 20,
    });
    observer.start();

    // 触发一次 micro-mutation 或者直接由 observer 响应当前 DOM 结构变更
    heading.append(document.createComment('trigger'));
    await vi.advanceTimersByTimeAsync(20);

    // 验证：无主的 [data-vast-source] 已经被安全解包还原，无主的 [data-vast-translator] 已经被移除
    expect(heading.querySelector('[data-vast-translator]')).toBeNull();
    expect(heading.querySelector('[data-vast-source]')).toBeNull();
    // 关键：保留了原节点和其事件监听器，而非 textContent 重写！
    expect(heading.querySelector('strong')).toBe(strong);
    strong.click();
    expect(clicked).toBe(true);

    expect(onInvalidated).toHaveBeenCalledWith(paragraph);
    observer.stop();
  });

  it('网站克隆已有包含 [data-vast-source] 的子树并替换回段落：观察器不因 addedNodes 含 data-vast-source 而忽略，精准识别失效并重译', async () => {
    document.body.innerHTML = '<main><h2 id="heading">Original Title</h2></main>';
    const heading = document.getElementById('heading') as HTMLElement;
    const store = new ParagraphStore();
    const paragraph = store.getOrCreate(heading);

    // 插件首先正常完成挂载
    const realSource = document.createElement('span');
    realSource.dataset.vastSource = '';
    realSource.textContent = 'Original Title';
    const realTranslator = document.createElement('span');
    realTranslator.dataset.vastTranslator = '';
    realTranslator.dataset.vastState = 'translated';
    realTranslator.textContent = '原始标题译文';
    heading.replaceChildren(realSource, realTranslator);
    paragraph.sourceWrapper = realSource;
    paragraph.wrapper = realTranslator;

    const onInvalidated = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: vi.fn(),
      store,
      onInvalidated,
      debounceMs: 20,
    });
    observer.start();

    // 模拟前端框架对整个 heading 内部进行 cloneNode(true) 重建替换（addedNodes 包含克隆的 data-vast-source）
    const clonedSource = realSource.cloneNode(true) as HTMLElement;
    const clonedTranslator = realTranslator.cloneNode(true) as HTMLElement;
    heading.replaceChildren(clonedSource, clonedTranslator);

    await vi.advanceTimersByTimeAsync(20);

    // 观察器绝不漏检：即便 addedNodes 含有 [data-vast-source]，也必须识别出克隆失效并通知失效
    expect(onInvalidated).toHaveBeenCalledOnce();
    expect(onInvalidated).toHaveBeenCalledWith(paragraph);
    // 克隆的无主标记已被安全还原
    expect(heading.querySelector('[data-vast-source]')).toBeNull();
    expect(heading.querySelector('[data-vast-translator]')).toBeNull();
    expect(heading.textContent).toBe('Original Title');

    observer.stop();
  });

  it('插件自身正常内联渲染不会触发失效通知，验证零自观察循环', async () => {
    document.body.innerHTML = '<main><p id="source">Hello world</p></main>';
    const source = document.getElementById('source') as HTMLElement;
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

    // 模拟 InlineRenderer 正常安装 sourceWrapper 和 translator
    const sourceWrapper = document.createElement('span');
    sourceWrapper.dataset.vastSource = '';
    sourceWrapper.append(...source.childNodes);
    source.append(sourceWrapper);
    paragraph.sourceWrapper = sourceWrapper;

    const translatorWrapper = document.createElement('span');
    translatorWrapper.dataset.vastTranslator = '';
    translatorWrapper.dataset.vastState = 'loading';
    translatorWrapper.textContent = '翻译中…';
    sourceWrapper.after(translatorWrapper);
    paragraph.wrapper = translatorWrapper;

    // 推进多轮定时器，验证不会触发任何失效回调
    await vi.advanceTimersByTimeAsync(100);

    expect(onInvalidated).not.toHaveBeenCalled();
    expect(paragraph.version).toBe(1);

    observer.stop();
  });

  it('同文且规范化空白相同但 DOM 发生结构替换时，挂载结构失效仍触发 onInvalidated', async () => {
    document.body.innerHTML = '<main><h2 id="heading">Hello\n   World</h2></main>';
    const heading = document.getElementById('heading') as HTMLElement;
    const store = new ParagraphStore();
    const paragraph = store.getOrCreate(heading);
    const initialVersion = paragraph.version;

    // 模拟已内联挂载
    const sourceWrapper = document.createElement('span');
    sourceWrapper.dataset.vastSource = '';
    sourceWrapper.textContent = 'Hello World';
    heading.replaceChildren(sourceWrapper);
    paragraph.sourceWrapper = sourceWrapper;

    const onInvalidated = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: vi.fn(),
      store,
      onInvalidated,
      debounceMs: 20,
    });
    observer.start();

    // 页面结构替换：内部替换为 strong + span，规范化文字依然为 'Hello World'
    const strong = document.createElement('strong');
    strong.textContent = 'Hello ';
    const span = document.createElement('span');
    span.textContent = 'World';
    heading.replaceChildren(strong, span);

    await vi.advanceTimersByTimeAsync(20);

    // 挂载脱离被捕获，必须触发失效通知并递增版本
    expect(onInvalidated).toHaveBeenCalledOnce();
    expect(paragraph.version).toBeGreaterThan(initialVersion);
    observer.stop();
  });

  it('仅译文模式正常切换 hidden 与正常 restore 过程零自观察循环', async () => {
    document.body.innerHTML = '<main><p id="source">Original text</p></main>';
    const source = document.getElementById('source') as HTMLElement;
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

    // 1. 模拟插件正常构建 sourceWrapper 并隐藏
    const sourceWrapper = document.createElement('span');
    sourceWrapper.dataset.vastSource = '';
    sourceWrapper.append(...source.childNodes);
    sourceWrapper.hidden = true;
    source.append(sourceWrapper);
    paragraph.sourceWrapper = sourceWrapper;

    await vi.advanceTimersByTimeAsync(40);
    expect(onInvalidated).not.toHaveBeenCalled();

    // 2. 模拟正常 restore 操作
    sourceWrapper.hidden = false;
    sourceWrapper.replaceWith(...sourceWrapper.childNodes);
    paragraph.sourceWrapper = undefined;

    await vi.advanceTimersByTimeAsync(40);
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(paragraph.version).toBe(1);

    observer.stop();
  });

  it('Legacy 模式外部相邻 wrapper 正常渲染后零自循环重译', async () => {
    document.body.innerHTML = '<main><p id="source">Legacy paragraph</p></main>';
    const source = document.getElementById('source') as HTMLElement;
    const store = new ParagraphStore();
    const paragraph = store.getOrCreate(source);
    paragraph.rendererKind = 'legacy';

    const onInvalidated = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: vi.fn(),
      store,
      onInvalidated,
      debounceMs: 20,
    });
    observer.start();

    // 模拟 Legacy 外部兄弟 wrapper 渲染
    const legacyWrapper = document.createElement('div');
    legacyWrapper.dataset.vastTranslator = '';
    legacyWrapper.dataset.vastState = 'translated';
    legacyWrapper.textContent = '译文';
    source.after(legacyWrapper);
    paragraph.wrapper = legacyWrapper;

    // 推进多轮定时器，验证 Legacy 兄弟节点绝不会因为不是 source 的子节点而被误判挂载失效
    await vi.advanceTimersByTimeAsync(100);

    expect(onInvalidated).not.toHaveBeenCalled();
    expect(paragraph.version).toBe(1);

    observer.stop();
  });

  it('flush 触发失效时保留段落 wrapper / sourceWrapper 引用，由 controller.restore 负责精准清理与解包', async () => {
    document.body.innerHTML = '<main><p id="source">Text</p></main>';
    const source = document.getElementById('source') as HTMLElement;
    const store = new ParagraphStore();
    const paragraph = store.getOrCreate(source);
    paragraph.rendererKind = 'legacy';

    // 模拟 Legacy 外部兄弟 wrapper
    const legacyWrapper = document.createElement('div');
    legacyWrapper.dataset.vastTranslator = '';
    source.after(legacyWrapper);
    paragraph.wrapper = legacyWrapper;

    let invalidatedParagraph: ParagraphRecord | undefined;
    const observer = new DynamicPageObserver(document.body, {
      scan: vi.fn(),
      store,
      onInvalidated: (p) => { invalidatedParagraph = p; },
      debounceMs: 20,
    });
    observer.start();

    // 文本变更触发失效
    source.firstChild!.textContent = 'New Text';
    await vi.advanceTimersByTimeAsync(20);

    expect(invalidatedParagraph).toBe(paragraph);
    // 关键断言：observer flush 不得提前清空 wrapper 引用，必须保留给 restore
    expect(invalidatedParagraph?.wrapper).toBe(legacyWrapper);

    // 验证由 restore 清除
    invalidatedParagraph?.wrapper?.remove();
    expect(document.querySelector('[data-vast-translator]')).toBeNull();

    observer.stop();
  });

  it('observer 处理无主子树仅限于当前 target 直接子级，嵌套的子段落合法插件标记不被误伤', async () => {
    document.body.innerHTML = `
      <main>
        <div id="parent-host">
          <p id="child-para">Child</p>
        </div>
      </main>`;
    const parent = document.getElementById('parent-host') as HTMLElement;
    const child = document.getElementById('child-para') as HTMLElement;
    const store = new ParagraphStore();

    // 建立子段落合法挂载
    const childRecord = store.getOrCreate(child);
    const childSource = document.createElement('span');
    childSource.dataset.vastSource = '';
    childSource.textContent = 'Child';
    const childTranslator = document.createElement('span');
    childTranslator.dataset.vastTranslator = '';
    childTranslator.textContent = '子译文';
    child.replaceChildren(childSource, childTranslator);
    childRecord.sourceWrapper = childSource;
    childRecord.wrapper = childTranslator;

    // 建立父段落记录
    store.getOrCreate(parent);

    const onInvalidated = vi.fn();
    const observer = new DynamicPageObserver(document.body, {
      scan: vi.fn(),
      store,
      onInvalidated,
      debounceMs: 20,
    });
    observer.start();

    // 触发父级变化
    parent.append(document.createComment('trigger'));
    await vi.advanceTimersByTimeAsync(20);

    // 关键断言：子段落合法的 [data-vast-source] 和 [data-vast-translator] 完好无损，未被误当作父级的无主标记解包或删除！
    expect(child.querySelector('[data-vast-translator]')?.textContent).toBe('子译文');
    expect(child.querySelector('[data-vast-source]')?.textContent).toBe('Child');

    observer.stop();
  });
});
