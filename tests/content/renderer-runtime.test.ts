import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeDependencies } from '../../src/content/main';
import { InlineRenderer } from '../../src/content/inline-renderer';
import { ParagraphStore } from '../../src/content/paragraph-store';

type RuntimeDependencies = ReturnType<typeof createRuntimeDependencies>;

describe('双渲染器调度层', () => {
  let originalChrome: unknown;
  let sendMessage: ReturnType<typeof vi.fn>;
  let inline: InlineRenderer;
  let store: ParagraphStore;
  let dependencies: RuntimeDependencies;

  beforeEach(() => {
    originalChrome = globalThis.chrome;
    sendMessage = vi.fn(async () => ({ ok: true, data: [] }));
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { runtime: { id: 'test-extension', sendMessage, onMessage: { addListener: vi.fn() } } },
    });
    document.body.innerHTML = '<main><p id="safe">Safe paragraph</p><p id="interactive">Text <a href="/x">with link</a></p></main>';
    inline = new InlineRenderer();
    (globalThis as { __vastInlineRenderer?: InlineRenderer }).__vastInlineRenderer = inline;
    store = new ParagraphStore();
    dependencies = createRuntimeDependencies();
  });

  afterEach(() => {
    delete (globalThis as { __vastInlineRenderer?: InlineRenderer }).__vastInlineRenderer;
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: originalChrome });
  });

  const safeParagraph = () => store.getOrCreate(document.querySelector('#safe') as HTMLElement);
  const interactiveParagraph = () => store.getOrCreate(document.querySelector('#interactive') as HTMLElement);

  it.each(['button', 'role', 'editable'])('内联请求期间变为 %s 时错误回退可见且重试有效', (change) => {
    dependencies.setRendererMode?.('inline');
    const paragraph = safeParagraph();
    dependencies.renderLoading(paragraph);
    const oldLoading = paragraph.wrapper!;
    const button = document.createElement('button');
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    if (change === 'button') paragraph.sourceWrapper!.append(button);
    else if (change === 'role') paragraph.element.setAttribute('role', 'button');
    else Object.defineProperty(paragraph.element, 'isContentEditable', { configurable: true, value: true });
    const retry = vi.fn();
    document.addEventListener('vast-translator-retry-all', retry);
    try {
      dependencies.renderError(paragraph, '翻译失败，请重试');
      expect(oldLoading.isConnected).toBe(false);
      expect(paragraph.rendererKind).toBe('legacy');
      expect(paragraph.wrapper).toHaveAttribute('data-vast-state', 'error');
      expect(paragraph.wrapper!.isConnected).toBe(true);
      expect(paragraph.element.textContent).toBe('Safe paragraph');
      expect(document.querySelector('[data-vast-state="loading"]')).toBeNull();
      paragraph.wrapper!.querySelector<HTMLButtonElement>('[data-vast-retry-all]')!.click();
      expect(retry).toHaveBeenCalledOnce();
      if (change === 'button') {
        expect(paragraph.element.contains(button)).toBe(true);
        button.click();
        expect(clicked).toHaveBeenCalledOnce();
      }
    } finally {
      document.removeEventListener('vast-translator-retry-all', retry);
    }
  });

  it('默认（未声明模式）走 legacy 渲染器', () => {
    const paragraph = safeParagraph();
    dependencies.renderLoading(paragraph);
    expect(paragraph.rendererKind).toBe('legacy');
    // legacy 外部渲染：wrapper 是段落元素的兄弟节点。
    expect(paragraph.wrapper!.parentElement).not.toBe(paragraph.element);
  });

  it('inline 模式下安全段落由内联渲染器处理并在段落内部渲染', () => {
    dependencies.setRendererMode?.('inline');
    const paragraph = safeParagraph();
    dependencies.renderLoading(paragraph);
    expect(paragraph.rendererKind).toBe('inline');
    expect(paragraph.wrapper!.parentElement).toBe(paragraph.element);
    expect(paragraph.element).toHaveAttribute('data-vast-inline');
  });

  it('inline 模式下交互子树段落保守回退 legacy', () => {
    dependencies.setRendererMode?.('inline');
    const paragraph = interactiveParagraph();
    dependencies.renderLoading(paragraph);
    expect(paragraph.rendererKind).toBe('legacy');
    expect(paragraph.element.hasAttribute('data-vast-inline')).toBe(false);
  });

  it('content-inline.js 缺失（全局未注册）时整体回退 legacy', () => {
    delete (globalThis as { __vastInlineRenderer?: InlineRenderer }).__vastInlineRenderer;
    dependencies.setRendererMode?.('inline');
    const paragraph = safeParagraph();
    dependencies.renderLoading(paragraph);
    expect(paragraph.rendererKind).toBe('legacy');
  });

  it('恢复由实际渲染该段落的渲染器处理', () => {
    dependencies.setRendererMode?.('inline');
    const inlineParagraph = safeParagraph();
    const legacyParagraph = interactiveParagraph();
    dependencies.renderLoading(inlineParagraph);
    dependencies.renderLoading(legacyParagraph);

    dependencies.restore(inlineParagraph);
    expect(inlineParagraph.wrapper).toBeUndefined();
    expect(inlineParagraph.sourceWrapper).toBeUndefined();
    expect(inlineParagraph.element.hasAttribute('data-vast-inline')).toBe(false);
    expect(inlineParagraph.rendererKind).toBeUndefined();

    dependencies.restore(legacyParagraph);
    expect(legacyParagraph.wrapper).toBeUndefined();
  });

  it('首次选用归属固定：内联装载后页面插入交互节点不翻转渲染器，恢复时清理干净', () => {
    dependencies.setRendererMode?.('inline');
    const paragraph = safeParagraph();
    dependencies.renderLoading(paragraph);
    expect(paragraph.rendererKind).toBe('inline');

    // 页面动态插入链接后段落不再满足安全判定，但会话内归属固定为 inline 直至 restore。
    const token = dependencies.beginRender(paragraph);
    paragraph.element.append(Object.assign(document.createElement('a'), { href: '/late' }));
    dependencies.renderTranslation(paragraph, '译文', { mode: 'bilingual', placement: 'after', ...token });
    expect(paragraph.rendererKind).toBe('inline');
    expect(paragraph.wrapper!.parentElement).toBe(paragraph.element);

    dependencies.restore(paragraph);
    expect(document.querySelector('[data-vast-translator]')).toBeNull();
    expect(paragraph.element.hasAttribute('data-vast-inline')).toBe(false);
    expect(paragraph.element.textContent).toContain('Safe paragraph');
  });

  it('inline 错误提示中的重试按钮不触发归属翻转，重试仍由内联渲染器处理', () => {
    dependencies.setRendererMode?.('inline');
    const paragraph = safeParagraph();
    dependencies.renderLoading(paragraph);
    expect(paragraph.rendererKind).toBe('inline');

    dependencies.renderError(paragraph, '翻译失败');
    expect(paragraph.rendererKind).toBe('inline');
    // 错误提示里的重试 button 属于插件自身节点，不得被判定为交互子树而翻转归属。
    const retryButton = paragraph.wrapper?.querySelector('[data-vast-retry-all]');
    expect(retryButton).not.toBeNull();

    const token = dependencies.beginRender(paragraph);
    dependencies.renderTranslation(paragraph, '译文', { mode: 'bilingual', placement: 'after', ...token });
    expect(paragraph.rendererKind).toBe('inline');
    expect(paragraph.wrapper!.parentElement).toBe(paragraph.element);
    expect(paragraph.wrapper!.textContent).toBe('译文');

    dependencies.restore(paragraph);
    expect(paragraph.rendererKind).toBeUndefined();
    expect(paragraph.element.hasAttribute('data-vast-inline')).toBe(false);
  });

  it('迟到结果被拒绝时不改写渲染器归属', () => {
    dependencies.setRendererMode?.('inline');
    const paragraph = safeParagraph();
    dependencies.renderLoading(paragraph);
    const staleToken = dependencies.beginRender(paragraph);
    // 新任务使旧 taskId 失效。
    const freshToken = dependencies.beginRender(paragraph);
    dependencies.renderTranslation(paragraph, '新译文', { mode: 'bilingual', placement: 'after', ...freshToken });
    dependencies.renderTranslation(paragraph, '迟到的译文', { mode: 'bilingual', placement: 'after', ...staleToken });
    expect(paragraph.rendererKind).toBe('inline');
    expect(paragraph.wrapper!.textContent).toBe('新译文');
  });

  it('cleanupPage 移除全部插件节点并清理内联标记', () => {
    dependencies.setRendererMode?.('inline');
    const paragraph = safeParagraph();
    dependencies.renderTranslation(paragraph, '译文', { ...dependencies.beginRender(paragraph), mode: 'bilingual', placement: 'after' });
    // 模拟孤立残留（段落记录丢失但 DOM 标记仍在）。
    document.body.innerHTML += '<div data-vast-inline=""><span data-vast-translator="">孤儿</span></div>';

    dependencies.cleanupPage();

    expect(document.querySelectorAll('[data-vast-translator]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-vast-inline]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-vast-source]')).toHaveLength(0);
  });

  it('setRendererMode 每次全新翻译读取一次，会话内固定段落归属', () => {
    dependencies.setRendererMode?.('inline');
    const paragraph = safeParagraph();
    dependencies.renderLoading(paragraph);
    expect(paragraph.rendererKind).toBe('inline');

    // 会话固定：即使模式改回 legacy，已选用段落的归属保持 inline 直至 restore。
    dependencies.setRendererMode?.('legacy');
    dependencies.renderLoading(paragraph);
    expect(paragraph.rendererKind).toBe('inline');

    // 全新会话（restore 清除归属后重新选用）按新模式走 legacy。
    dependencies.restore(paragraph);
    const fresh = safeParagraph();
    dependencies.renderLoading(fresh);
    expect(fresh.rendererKind).toBe('legacy');
  });

  it('真实扫描场景：main-content 与 whole-page 扫描到 h2>span>a>span，经 runtime 选用 inline 并在 a 内部挂载', () => {
    document.body.innerHTML = `
      <main id="main-area">
        <h2 id="scanned-h2" class="title-heading">
          <span class="outer-span">
            <a id="scanned-link" href="/tt-a1i/hive/releases" class="repo-link">
              <span id="scanned-text">Releases</span>
            </a>
          </span>
        </h2>
      </main>`;
    const h2 = document.getElementById('scanned-h2') as HTMLElement;
    const link = document.getElementById('scanned-link') as HTMLAnchorElement;
    const rule = { id: 'generic', host: 'example.com', mainContentSelectors: ['#main-area'] };

    // 1. main-content 扫描
    const mainScanned = dependencies.scan(rule, 'main-content');
    expect(mainScanned).toContain(h2);

    // 2. whole-page 扫描
    const wholeScanned = dependencies.scan(rule, 'whole-page');
    expect(wholeScanned).toContain(h2);

    // 3. runtime 调度翻译流程
    dependencies.setRendererMode?.('inline');
    const paragraph = store.getOrCreate(h2);

    dependencies.renderLoading(paragraph);
    expect(paragraph.rendererKind).toBe('inline');
    expect(h2.hidden).toBe(false);
    expect(link.querySelector('[data-vast-state="loading"]')).not.toBeNull();

    const token = dependencies.beginRender(paragraph);
    dependencies.renderTranslation(paragraph, '发布版本', { mode: 'bilingual', placement: 'after', ...token });

    // 验证：h2 不被 hidden，h2 外无相邻兄弟译文，译文在 a 内部
    expect(h2.hidden).toBe(false);
    expect(h2.parentElement?.querySelector(':scope > [data-vast-translator]')).toBeNull();
    expect(link.querySelector('[data-vast-translator]')?.textContent).toBe('发布版本');
    expect(h2.classList.contains('title-heading')).toBe(true);
    expect(link.getAttribute('href')).toBe('/tt-a1i/hive/releases');

    // 恢复
    dependencies.restore(paragraph);
    expect(h2.querySelector('[data-vast-translator]')).toBeNull();
    expect(h2.textContent?.trim()).toBe('Releases');
    expect(paragraph.rendererKind).toBeUndefined();
  });

  it('用户真实时序：先 beginRender 后发生内部替换，旧 token 迟到被拒绝，经 restore 与新任务重新渲染成功完成', () => {
    dependencies.setRendererMode?.('inline');
    const paragraph = safeParagraph();
    dependencies.renderLoading(paragraph);
    expect(paragraph.rendererKind).toBe('inline');
    expect(paragraph.element.querySelector('[data-vast-state="loading"]')).not.toBeNull();

    // 1. 真实时序：在替换发生前已生成首轮请求的 token
    const staleToken = dependencies.beginRender(paragraph);

    // 2. 模拟前端框架在请求飞行期间进行深克隆重置，原 loading 和 source 节点被克隆放入 DOM，旧引用脱离
    const clonedChildren = Array.from(paragraph.element.childNodes).map((node) => node.cloneNode(true));
    paragraph.element.replaceChildren(...clonedChildren);

    // 3. 旧请求迟到返回：因挂载脱离，renderTranslation 必须严格拒绝旧结果（返回 false）
    const staleAccepted = dependencies.renderTranslation(paragraph, '旧译文', { mode: 'bilingual', placement: 'after', ...staleToken });
    expect(staleAccepted).toBe(false);

    // 4. 模拟 observer/controller 的失效处理链：restore 解包清理后刷新 store 发起新任务
    dependencies.restore(paragraph);
    const freshParagraph = store.refresh(paragraph.element);

    // 5. 新任务发起：重新 renderLoading 并生成 freshToken
    dependencies.renderLoading(freshParagraph);
    const freshToken = dependencies.beginRender(freshParagraph);

    // 6. 新任务成功返回：renderTranslation 正确挂载并返回 true，完成收口
    const freshAccepted = dependencies.renderTranslation(freshParagraph, '新译文安全到达', { mode: 'bilingual', placement: 'after', ...freshToken });
    expect(freshAccepted).toBe(true);

    // 7. 断言 DOM 状态最终完全收敛：无残留 loading，最新译文正确显示且连通
    expect(paragraph.element.querySelector('[data-vast-state="loading"]')).toBeNull();
    const liveTranslator = paragraph.element.querySelector('[data-vast-state="translated"]') as HTMLElement;
    expect(liveTranslator).not.toBeNull();
    expect(liveTranslator.textContent).toBe('新译文安全到达');
    expect(liveTranslator.isConnected).toBe(true);

    // 8. 最终 restore：干净还原原节点
    dependencies.restore(freshParagraph);
    expect(paragraph.element.querySelector('[data-vast-translator]')).toBeNull();
    expect(paragraph.element.querySelector('[data-vast-source]')).toBeNull();
    expect(paragraph.element.textContent).toBe('Safe paragraph');
  });
});
