import type { ParagraphRecord } from './paragraph-store';
import type { RenderTranslationOptions } from './dom-renderer';
import './content-inline.css';

// 独立内联渲染器：在段落内部的安全文本容器中渲染译文，不向父级 flex/grid 容器
// 新增子项，避免改变页面布局。复杂交互子树等不安全结构由调度方选择性回退 legacy。
// 本文件独立构建为 content-inline.js，仅当 Options 选择内联模式时被启用。

/** 无法安全承载内部包装节点的元素（受限内容/空元素/表单控件等）。 */
const RESTRICTED_TAGS = new Set([
  'SELECT', 'OPTION', 'OPTGROUP', 'TR', 'THEAD', 'TBODY', 'TFOOT', 'COLGROUP', 'COL',
  'TEXTAREA', 'IMG', 'INPUT', 'BR', 'HR', 'META', 'LINK', 'STYLE', 'SCRIPT', 'TEMPLATE',
  'IFRAME', 'OBJECT', 'EMBED', 'PARAM', 'SOURCE', 'TRACK', 'WBR', 'AREA', 'BASE',
  'CANVAS', 'SVG', 'MATH', 'AUDIO', 'VIDEO', 'DIALOG', 'FRAME', 'FRAMESET',
]);

/** 表单控件子树：字段集、输出、进度条及输入控件同样不适合内部包装。 */
const FORM_CONTROLS = 'form,fieldset,datalist,output,progress,meter,input,select,textarea,option,optgroup';

/** flex/grid 布局：多子项时新增包装节点会改变 flex/grid 子项数量与布局。 */
const FLEX_GRID_DISPLAYS = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);

/** 内容模型只接受 phrasing content 的块级宿主：内部只能放 span，放 div 属于 DOM 违法。 */
const PHRASING_HOSTS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DT', 'SUMMARY', 'FIGCAPTION', 'CAPTION', 'LEGEND', 'ADDRESS',
]);

/** 行内级宿主：译文容器保持行内显示，不新增独立文本块。 */
const INLINE_HOSTS = new Set([
  'SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'SMALL', 'CODE', 'KBD', 'SAMP', 'SUB', 'SUP',
  'MARK', 'Q', 'LABEL', 'INS', 'DEL', 'ABBR', 'CITE', 'TIME', 'A',
]);

/** 辅助/无障碍/图标等不作为正文的节点（通用规则，无站点专有排除） */
function isAuxiliaryOrHiddenNode(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return !node.textContent?.trim();
  }
  if (node instanceof HTMLElement || node instanceof SVGElement) {
    if ((node instanceof HTMLElement && node.hidden) || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden')) return true;
    if (node.matches('svg, img, canvas, mat-icon, [role="img"], [role="tooltip"], .sr-only, .visually-hidden')) return true;
    const style = (node as HTMLElement).style;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
    if (!node.textContent?.trim() && node.children.length === 0) return true;
  }
  return false;
}

/**
 * 递归向下寻找单链接或行内容器中最内的安全文本挂载容器。
 * 例如 a > span.title Releases 将下钻到 span.title。
 */
function resolveInnermostContainer(container: HTMLElement): HTMLElement {
  let current = container;
  while (true) {
    const substantiveChildren = Array.from(current.childNodes).filter((child) => {
      if (child.nodeType === Node.TEXT_NODE) return Boolean(child.textContent?.trim());
      if (child instanceof HTMLElement) {
        return !isAuxiliaryOrHiddenNode(child) && Boolean(child.textContent?.trim());
      }
      return false;
    });

    if (substantiveChildren.length === 1 && substantiveChildren[0] instanceof HTMLElement) {
      const onlyChild = substantiveChildren[0] as HTMLElement;
      if (
        (INLINE_HOSTS.has(onlyChild.tagName) || PHRASING_HOSTS.has(onlyChild.tagName))
        && !onlyChild.tagName.includes('-')
        && !onlyChild.matches(FORM_CONTROLS)
        && !onlyChild.isContentEditable
      ) {
        current = onlyChild;
        continue;
      }
    }
    break;
  }
  return current;
}

/**
 * 解析内联模式的实际挂载目标节点：
 * 1. 若宿主本身为普通安全段落，直接返回宿主；
 * 2. 若宿主内部包含普通非编辑单链接且所有可翻译正文均在其内（如 h2 > span > a > span Releases），
 *    则下钻到该链接内部的最内安全文本容器；
 * 3. 其余多链接、表单、自定义组件、按钮或混合复杂结构返回 null（由调度方保守回退 legacy）。
 */
export function resolveInlineMountTarget(element: HTMLElement): HTMLElement | null {
  if (RESTRICTED_TAGS.has(element.tagName)) return null;
  if (element.tagName.includes('-')) return null;
  if (element.matches(FORM_CONTROLS) || element.querySelector(FORM_CONTROLS) !== null) return null;
  if (element.matches('button, [role="button"]') || element.querySelector('button, [role="button"]') !== null) return null;
  if (element.isContentEditable) return null;

  for (const descendant of element.querySelectorAll('*')) {
    if (descendant.tagName.includes('-')) return null;
  }

  const links = Array.from(element.querySelectorAll<HTMLElement>('a, [role="link"]'));

  if (element.matches('a, [role="link"]')) {
    if (links.length > 0) return null;
    return resolveInnermostContainer(element);
  }

  if (links.length > 1) {
    // 多链接复合结构：保守回退 legacy
    return null;
  }

  if (links.length === 1) {
    const link = links[0];
    if (link.isContentEditable) return null;

    // 检查宿主在 link 外部是否存在实质性可见文本（排除辅助/隐藏节点）
    const doc = element.ownerDocument;
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      if (link.contains(node)) continue;

      let isAux = false;
      for (let curr: HTMLElement | null = node.parentElement; curr && curr !== element; curr = curr.parentElement) {
        if (isAuxiliaryOrHiddenNode(curr)) { isAux = true; break; }
      }
      if (!isAux) {
        // link 外部存在实质性可见正文（混合句子），回退 legacy
        return null;
      }
    }

    if (!link.textContent?.trim()) return null;
    return resolveInnermostContainer(link);
  }

  // links.length === 0
  if (FLEX_GRID_DISPLAYS.has(getComputedStyle(element).display) && element.children.length >= 2) return null;
  return element;
}

/** 判断段落是否适合内联渲染；不安全时调用方回退 legacy 并跟踪归属。 */
export function isUnsafeInlineElement(element: HTMLElement): boolean {
  return resolveInlineMountTarget(element) === null;
}

const hide = (element: HTMLElement) => element.hidden = true;

export class InlineRenderer {
  private nextTaskId = 1;

  /** 供 content-main.js 调度方调用：判断段落是否适合内联渲染。 */
  isUnsafe(element: HTMLElement): boolean {
    return isUnsafeInlineElement(element);
  }

  resolveTarget(element: HTMLElement): HTMLElement | null {
    return resolveInlineMountTarget(element);
  }

  beginTask(paragraph: ParagraphRecord): Pick<RenderTranslationOptions, 'taskId' | 'expectedVersion'> {
    const taskId = `${paragraph.id}:${this.nextTaskId++}`;
    paragraph.currentTaskId = taskId;
    return { taskId, expectedVersion: paragraph.version };
  }

  renderLoading(paragraph: ParagraphRecord): void {
    this.renderState(paragraph, 'loading', '翻译中…');
  }

  renderError(paragraph: ParagraphRecord, message: string): void {
    this.renderState(paragraph, 'error', message);
    const wrapper = paragraph.wrapper!;
    const button = wrapper.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.vastRetryAll = '';
    button.textContent = '↻';
    button.title = '重试全部失败段落';
    button.setAttribute('aria-label', '重试全部失败段落');
    button.addEventListener('click', () => wrapper.ownerDocument.dispatchEvent(new CustomEvent('vast-translator-retry-all')));
    wrapper.append(' ', button);
  }

  renderTranslation(
    paragraph: ParagraphRecord,
    translation: string,
    options: RenderTranslationOptions,
  ): boolean {
    if (!paragraph.element.isConnected
      || options.expectedVersion !== paragraph.version
      || options.taskId !== paragraph.currentTaskId) return false;

    const sourceWrapper = this.ensureSourceWrapper(paragraph);
    const wrapper = paragraph.wrapper ?? this.createTranslationWrapper(paragraph);
    wrapper.dataset.vastTranslator = '';
    wrapper.dataset.vastState = 'translated';
    wrapper.textContent = translation;
    if (options.placement === 'before') sourceWrapper.before(wrapper);
    else sourceWrapper.after(wrapper);
    paragraph.wrapper = wrapper;
    this.setSourceHidden(paragraph, options.mode === 'translation-only');
    return true;
  }

  restore(paragraph: ParagraphRecord): void {
    paragraph.wrapper?.remove();
    paragraph.wrapper = undefined;
    const target = paragraph.targetElement ?? paragraph.element;
    if (paragraph.sourceWrapper) {
      // 原节点整体移回（不 clone），监听器、行内样式与 hidden 状态全部保留。
      paragraph.sourceWrapper.replaceWith(...paragraph.sourceWrapper.childNodes);
      paragraph.sourceWrapper = undefined;
    }
    target.hidden = paragraph.originalHidden;
    delete target.dataset.vastInline;
    delete paragraph.element.dataset.vastInline;
    paragraph.targetElement = undefined;
    paragraph.currentTaskId = undefined;
  }

  /**
   * 状态提示与译文一样只追加在段落内部原文之后；先安装 [data-vast-source] 再追加
   * 状态容器，让动态观察器把同一批变更识别为插件自身操作并跳过，避免观察自循环。
   */
  private renderState(
    paragraph: ParagraphRecord,
    state: 'loading' | 'error',
    text: string,
  ): void {
    const sourceWrapper = this.ensureSourceWrapper(paragraph);
    const wrapper = paragraph.wrapper ?? this.createTranslationWrapper(paragraph);
    wrapper.dataset.vastTranslator = '';
    wrapper.dataset.vastState = state;
    wrapper.textContent = text;
    sourceWrapper.after(wrapper);
    paragraph.wrapper = wrapper;
  }

  private createTranslationWrapper(paragraph: ParagraphRecord): HTMLElement {
    const target = paragraph.targetElement ?? this.resolveTarget(paragraph.element) ?? paragraph.element;
    paragraph.targetElement = target;
    paragraph.element.dataset.vastInline = '';
    if (target !== paragraph.element) {
      target.dataset.vastInline = '';
    }
    return this.createInnerContainer(target);
  }

  /**
   * 段落内部容器选择：phrasing 宿主只能用 span（并标记块级显示），行内宿主用 span
   * 保持行内，其余 flow 宿主用 div。保证注入后的 DOM 始终符合 content model。
   */
  private createInnerContainer(element: HTMLElement): HTMLElement {
    if (PHRASING_HOSTS.has(element.tagName)) {
      const span = element.ownerDocument.createElement('span');
      span.dataset.vastBlock = '';
      return span;
    }
    return element.ownerDocument.createElement(INLINE_HOSTS.has(element.tagName) ? 'span' : 'div');
  }

  /**
   * 用 [data-vast-source] 包裹原始子节点以保留节点与事件，只把译文文本写入
   * 独立的安全文本容器，绝不整体覆盖原节点 textContent。动态观察器已把
   * [data-vast-source] 安装视为插件自身变更并跳过，避免观察自循环。
   */
  private ensureSourceWrapper(paragraph: ParagraphRecord): HTMLElement {
    if (paragraph.sourceWrapper) return paragraph.sourceWrapper;
    const target = paragraph.targetElement ?? this.resolveTarget(paragraph.element) ?? paragraph.element;
    paragraph.targetElement = target;
    const wrapper = this.createInnerContainer(target);
    if (wrapper.dataset.vastBlock !== undefined) delete wrapper.dataset.vastBlock;
    wrapper.dataset.vastSource = '';
    const originals = [...target.childNodes].filter((node) => {
      if (!(node instanceof HTMLElement)) return true;
      return !node.closest('[data-vast-translator], [data-vast-source]');
    });
    wrapper.append(...originals);
    target.append(wrapper);
    paragraph.sourceWrapper = wrapper;
    return wrapper;
  }

  private setSourceHidden(paragraph: ParagraphRecord, hidden: boolean): void {
    const source = this.ensureSourceWrapper(paragraph);
    if (hidden) hide(source); else source.hidden = false;
  }
}

// 向内容脚本隔离世界注册单例；主 content-main.js 仅在需要时惰性取用。
if (typeof globalThis !== 'undefined') {
  (globalThis as { __vastInlineRenderer?: unknown }).__vastInlineRenderer = new InlineRenderer();
}
