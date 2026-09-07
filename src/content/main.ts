import type { TranslationResult } from '../shared/messages';
import { DomRenderer } from './dom-renderer';
import type { InlineRenderer } from './inline-renderer';
import { scanParagraphElements, unwrapAllTextLeaves } from './dom-scanner';
import { DynamicPageObserver } from './dynamic-observer';
import type { ParagraphRecord } from './paragraph-store';
import { matchSiteRule } from './rule-matcher';
import { registerSelectionController } from './selection-controller';
import { ParagraphVisibilityBatchQueue } from './scheduler';
import type { RendererMode } from '../shared/config';
import type { ContentControllerDependencies, PublicConfig, ProgressState } from './index';

// 内容脚本装配层：独立构建为 content-main.js，在 manifest 中排在 content.js 之后。
// 控制器库 content.js 只暴露纯控制器；运行时依赖与启动路由集中在这里，
// 使 content.js 回到 38KiB 预算内，同时保持内联渲染器脚本的独立性。

export function createRuntimeDependencies(): ContentControllerDependencies {
  const legacyRenderer = new DomRenderer();
  let observer: DynamicPageObserver | undefined;
  const visibilityQueues = new Set<ParagraphVisibilityBatchQueue<ParagraphRecord>>();
  let sessionRendererMode: RendererMode = 'legacy';

  // 内联渲染器由独立 content-inline.js 注册到隔离世界；缺失时回退 legacy。
  const inlineRenderer = () => (globalThis as { __vastInlineRenderer?: InlineRenderer }).__vastInlineRenderer;
  function rendererFor(paragraph: ParagraphRecord): [DomRenderer | InlineRenderer, RendererMode] {
    // 首次选用即固定归属：错误提示里的重试按钮等插件自身节点不得触发重新判定，
    // 避免 loading→error→retry 链中发生归属翻转；归属在 restore 时清除后才会重新判定。
    if (paragraph.rendererKind === 'inline') {
      const inline = inlineRenderer();
      if (inline) return [inline, 'inline'];
      return [legacyRenderer, 'legacy'];
    }
    if (paragraph.rendererKind === 'legacy') return [legacyRenderer, 'legacy'];
    const inline = inlineRenderer();
    return sessionRendererMode === 'inline' && inline && !inline.isUnsafe(paragraph.element)
      ? [inline, 'inline']
      : [legacyRenderer, 'legacy'];
  }
  return {
    addMessageListener(listener) {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        void listener(message).then(sendResponse);
        return true;
      });
    },
    loadRule: () => matchSiteRule(new URL(location.href)),
    scan: (rule, scope) => scanParagraphElements(document, rule, scope),
    async translate(request) {
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          reject(new Error('翻译请求超时，请检查网络或配置后重试'));
        }, 30_000);
      });
      try {
        const responsePromise = chrome.runtime.sendMessage({ type: 'translate-batch', ...request }) as Promise<{ ok: boolean; data?: TranslationResult[]; error?: string }>;
        const response = await Promise.race([responsePromise, timeoutPromise]);
        if (!response.ok) throw new Error(response.error ?? '翻译失败');
        return response.data ?? [];
      } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      }
    },
    async cancel(taskId) { await chrome.runtime.sendMessage({ type: 'cancel-task', taskId }); },
    async getConfig() {
      const response = await chrome.runtime.sendMessage({ type: 'get-public-config' }) as { data?: PublicConfig };
      return response.data ?? { preferences: { targetLanguage: 'en', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content', rendererMode: 'legacy' }, activeEngineId: 'google', availableEngines: [] };
    },
    getPageLanguage: () => document.documentElement.lang || 'auto',
    showSelectionText: () => undefined,
    async schedule(items, worker, onFailure) {
      let visibility!: ParagraphVisibilityBatchQueue<ParagraphRecord>;
      visibility = new ParagraphVisibilityBatchQueue(worker, undefined, () => visibilityQueues.delete(visibility), onFailure);
      visibilityQueues.add(visibility);
      visibility.add(items.flat());
      return visibility.whenIdle();
    },
    hasWaiting: () => [...visibilityQueues].some((queue) => queue.waitingCount > 0),
    // 任务代际统一由 legacy 渲染器计数器管理，保证跨会话任务 ID 不重复。
    beginRender: (paragraph) => legacyRenderer.beginTask(paragraph),
    renderLoading: (paragraph) => {
      const [renderer, kind] = rendererFor(paragraph);
      renderer.renderLoading(paragraph);
      paragraph.rendererKind = kind;
    },
    renderTranslation: (paragraph, text, options) => {
      const [renderer, kind] = rendererFor(paragraph);
      const accepted = renderer.renderTranslation(paragraph, text, { ...options, placement: options.placement ?? 'after' });
      if (accepted) paragraph.rendererKind = kind;
    },
    renderError: (paragraph, error) => {
      const [renderer, kind] = rendererFor(paragraph);
      renderer.renderError(paragraph, error);
      paragraph.rendererKind = kind;
    },
    restore: (paragraph) => {
      const renderer = paragraph.rendererKind === 'inline' ? inlineRenderer() : legacyRenderer;
      renderer?.restore(paragraph);
      paragraph.rendererKind = undefined;
      // 兼容段落在内联装载后被页面改成不安全结构、译文改由 legacy 渲染的混合场景，
      // 这里统一移除内联标记；inline.restore 已删除时本操作幂等。
      delete paragraph.element.dataset.vastInline;
      if (paragraph.targetElement) {
        delete paragraph.targetElement.dataset.vastInline;
        paragraph.targetElement = undefined;
      }
    },
    setRendererMode: (mode) => { sessionRendererMode = mode; },
    cleanupPage() {
      for (const wrapper of document.querySelectorAll<HTMLElement>('[data-vast-translator]')) wrapper.remove();
      for (const source of document.querySelectorAll<HTMLElement>('[data-vast-source]')) {
        source.hidden = false;
        source.replaceWith(...source.childNodes);
      }
      for (const hidden of document.querySelectorAll<HTMLElement>('[data-vast-original-hidden]')) hidden.hidden = false;
      for (const inline of document.querySelectorAll<HTMLElement>('[data-vast-inline]')) delete inline.dataset.vastInline;
      unwrapAllTextLeaves(document);
    },
    startObserver(rule, store, scope, onChanges) {
      observer?.stop();
      observer = new DynamicPageObserver(document.body, {
        debounceMs: 150,
        scan(root) {
          return scanParagraphElements(root, rule, scope);
        },
        store,
        onChanges(changes) {
          for (const paragraph of [...changes.invalidated, ...changes.removed]) {
            for (const queue of visibilityQueues) queue.remove(paragraph.element);
          }
          Promise.resolve(onChanges(changes)).catch(() => {
            console.error('语层翻译: 动态页面变更处理失败');
          });
        },
      });
      observer.start();
    },
    stopObserver() {
      observer?.stop(); observer = undefined;
      for (const queue of visibilityQueues) queue.disconnect();
      visibilityQueues.clear();
    },
    report(progress: ProgressState) { void chrome.runtime.sendMessage({ type: 'page-progress', progress }).catch(() => undefined); },
  };
}

// 启动路由：content.js 通过 iife 全局暴露控制器工厂，这里接入并注册。
interface ContentLibrary {
  createContentController(dependencies: ContentControllerDependencies): {
    register(): void;
    onMessage(message: unknown): Promise<unknown>;
  };
}

const library = (globalThis as { LexiLayerContent?: ContentLibrary }).LexiLayerContent;
if (library && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  const selection = registerSelectionController();
  const dependencies = createRuntimeDependencies();
  dependencies.showSelectionText = (text) => selection.showText(text);
  const controller = library.createContentController(dependencies);
  controller.register();
  document.addEventListener('vast-translator-retry-all', () => { void controller.onMessage({ type: 'retry-page-translation' }); });
}
