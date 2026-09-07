import type { ParagraphRecord } from './paragraph-store';
import type { RenderTranslationOptions } from './dom-renderer';
import './content-inline.css';


const RESTRICTED = /^(SELECT|OPTION|OPTGROUP|TR|THEAD|TBODY|TFOOT|COLGROUP|COL|TEXTAREA|IMG|INPUT|BR|HR|META|LINK|STYLE|SCRIPT|TEMPLATE|IFRAME|OBJECT|EMBED|PARAM|SOURCE|TRACK|WBR|AREA|BASE|CANVAS|SVG|MATH|AUDIO|VIDEO|DIALOG|FRAME|FRAMESET)$/;
const FORM_CONTROLS = 'form,fieldset,datalist,output,progress,meter,input,select,textarea,option,optgroup';
const FLEX_GRID = /^(flex|inline-flex|grid|inline-grid)$/;

const isPhrasingHost = (tag: string) => /^(P|H[1-6]|DT|SUMMARY|FIGCAPTION|CAPTION|LEGEND|ADDRESS)$/.test(tag);
const isInlineHost = (tag: string) => /^(SPAN|EM|STRONG|B|I|U|SMALL|CODE|KBD|SAMP|SUB|SUP|MARK|Q|LABEL|INS|DEL|ABBR|CITE|TIME|A)$/.test(tag);

function isAuxiliaryOrHiddenNode(node: Node): boolean {
  if (node instanceof HTMLElement && node.matches('[data-vast-translator]')) return true;
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
 */
function resolveInnermostContainer(container: HTMLElement): HTMLElement {
  let current = container;
  while (true) {
    const substantiveChildren = Array.from(current.childNodes).filter((child) => {
      if (child instanceof HTMLElement && child.matches('[data-vast-translator]')) return false;
      if (child.nodeType === Node.TEXT_NODE) return Boolean(child.textContent?.trim());
      if (child instanceof HTMLElement) {
        return !isAuxiliaryOrHiddenNode(child) && Boolean(child.textContent?.trim());
      }
      return false;
    });

    if (substantiveChildren.length === 1 && substantiveChildren[0] instanceof HTMLElement) {
      const onlyChild = substantiveChildren[0] as HTMLElement;
      if (onlyChild.matches('[data-vast-source]')) {
        break;
      }
      if (
        (isInlineHost(onlyChild.tagName) || isPhrasingHost(onlyChild.tagName))
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
 */
export function resolveInlineMountTarget(element: HTMLElement): HTMLElement | null {
  if (RESTRICTED.test(element.tagName)) return null;
  if (element.tagName.includes('-')) return null;
  if (element.matches(FORM_CONTROLS)) return null;
  if (element.matches('button, [role="button"]')) return null;
  if (element.isContentEditable) return null;

  for (const descendant of element.querySelectorAll('*')) {
    if (descendant.closest('[data-vast-translator]')) continue;
    if (descendant.tagName.includes('-')) return null;
    if (descendant.matches(FORM_CONTROLS)) return null;
    if (descendant.matches('button, [role="button"]')) return null;
    if (descendant instanceof HTMLElement && descendant.isContentEditable) return null;
  }

  const links = Array.from(element.querySelectorAll<HTMLElement>('a, [role="link"]')).filter(
    (link) => !link.closest('[data-vast-translator]'),
  );

  if (element.matches('a, [role="link"]')) {
    if (links.length > 0) return null;
    return resolveInnermostContainer(element);
  }

  if (links.length > 1) {
    return null;
  }

  if (links.length === 1) {
    const link = links[0];
    if (link.isContentEditable) return null;

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
        return null;
      }
    }

    if (!link.textContent?.trim()) return null;
    return resolveInnermostContainer(link);
  }

  if (FLEX_GRID.test(getComputedStyle(element).display)) {
    let businessChildCount = 0;
    for (const child of element.children) {
      if (child.matches('[data-vast-translator]')) continue;
      if (child.matches('[data-vast-source]')) {
        businessChildCount += Array.from(child.children).filter(
          (grandChild) => !grandChild.matches('[data-vast-translator]'),
        ).length;
      } else {
        businessChildCount += 1;
      }
    }
    if (businessChildCount >= 2) return null;
  }
  return element;
}

export function isUnsafeInlineElement(element: HTMLElement): boolean {
  return resolveInlineMountTarget(element) === null;
}

const hide = (element: HTMLElement) => element.hidden = true;

interface MountRecord { source?: HTMLElement; translator?: HTMLElement }

export class InlineRenderer {
  private nextTaskId = 1;
  /**
   * 挂载节点 → 归属段落 id。以节点为键的弱引用：段落或其挂载节点被 GC 后
   * 条目自动消失，不存在强引用泄漏；克隆产生的无主节点查不到归属即视为 stale。
   */
  private readonly ownedMounts = new WeakMap<HTMLElement, string>();

  isOwnedMount(node: HTMLElement): boolean {
    return this.ownedMounts.get(node) === node.dataset.vastOwner;
  }

  private register(paragraph: ParagraphRecord, patch: Partial<MountRecord>): void {
    if (patch.source !== undefined) this.ownedMounts.set(patch.source, paragraph.id);
    if (patch.translator !== undefined) this.ownedMounts.set(patch.translator, paragraph.id);
  }

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
    const wrapper = paragraph.wrapper;
    if (!wrapper) return;
    const button = wrapper.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.vastRetryAll = '';
    button.textContent = '↻';
    button.title = '重试全部失败段落';
    button.setAttribute('aria-label', '重试全部失败段落');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      wrapper.ownerDocument.dispatchEvent(new CustomEvent('vast-translator-retry-all'));
    });
    wrapper.append(' ', button);
  }

  renderTranslation(
    paragraph: ParagraphRecord,
    translation: string,
    options: RenderTranslationOptions,
  ): boolean {
    if (!paragraph.element.isConnected
      || options.expectedVersion !== paragraph.version
      || options.taskId !== paragraph.currentTaskId
      || this.isUnsafe(paragraph.element)) return false;

    const sourceWrapper = this.mountContext(paragraph, true);
    if (!sourceWrapper) return false;
    const target = paragraph.targetElement!;

    const wrapper = this.prepareWrapper(paragraph);
    if (!wrapper) return false;
    wrapper.dataset.vastState = 'translated';
    wrapper.textContent = translation;
    (options.placement === 'before' ? sourceWrapper.before(wrapper) : sourceWrapper.after(wrapper));
    if (!wrapper.isConnected || wrapper.parentElement !== target) return false;
    paragraph.wrapper = wrapper;
    this.register(paragraph, { translator: wrapper });
    this.setSourceHidden(paragraph, options.mode === 'translation-only');
    return true;
  }

  /** mangled kind: 节点包装的选择 lead 由宿主功能（source/translator）决定。 */
  restore(paragraph: ParagraphRecord): void {
    let target = paragraph.targetElement;
    if (!target?.isConnected || !paragraph.element.contains(target)) {
      target = this.resolveTarget(paragraph.element) ?? paragraph.element;
    }
    paragraph.wrapper?.remove();
    paragraph.wrapper = undefined;
    const source = paragraph.sourceWrapper;
    if (source) {
      source.hidden = false;
      source.replaceWith(...source.childNodes);
    }
    paragraph.sourceWrapper = undefined;
    this.cleanupUnownedPluginNodes(paragraph.element, paragraph.id);
    delete target.dataset.vastInline;
    delete paragraph.element.dataset.vastInline;
    paragraph.targetElement = undefined;
    paragraph.currentTaskId = undefined;
  }

  /**
   */
  private renderState(paragraph: ParagraphRecord, state: 'loading' | 'error', text: string): void {
    const sourceWrapper = this.mountContext(paragraph);
    if (!sourceWrapper) return;
    const wrapper = this.prepareWrapper(paragraph);
    if (!wrapper) return;
    wrapper.dataset.vastState = state;
    wrapper.textContent = text;
    sourceWrapper.after(wrapper);
    paragraph.wrapper = wrapper;
    this.register(paragraph, { translator: wrapper });
  }

  private mountContext(paragraph: ParagraphRecord, strict = false): HTMLElement | null {
    if (!paragraph.element.isConnected || this.isUnsafe(paragraph.element)) return null;
    let target = paragraph.targetElement;
    if (!target || !target.isConnected || !paragraph.element.contains(target)) {
      const resolved = this.resolveTarget(paragraph.element);
      if (!resolved) return null;
      target = resolved;
      paragraph.targetElement = target;
    }
    const source = paragraph.sourceWrapper;
    if (source && source.isConnected && source.parentElement === target) return source;
    if (strict && source !== undefined) return null;
    return this.createSourceWrapper(paragraph, target);
  }

  /** 源/译文包装共用：owner 标记 + inline 归属标记（target 钻入宿主内时也标记）。 */
  private mark(wrapper: HTMLElement, paragraph: ParagraphRecord): void {
    wrapper.dataset.vastOwner = paragraph.id;
    paragraph.element.dataset.vastInline = '';
    const target = paragraph.targetElement;
    if (target && target !== paragraph.element) target.dataset.vastInline = '';
  }
  private createSourceWrapper(paragraph: ParagraphRecord, target: HTMLElement): HTMLElement | null {
    const wrapper = this.createInnerContainer(target);
    delete wrapper.dataset.vastBlock;
    this.mark(wrapper, paragraph);
    wrapper.dataset.vastSource = '';
    const originals = [...target.childNodes].filter((node) => !(node instanceof HTMLElement && node.closest('[data-vast-translator], [data-vast-source]')));
    wrapper.append(...originals);
    target.append(wrapper);
    paragraph.sourceWrapper = wrapper;
    this.register(paragraph, { source: wrapper });
    return wrapper;
  }

  private prepareWrapper(paragraph: ParagraphRecord): HTMLElement | null {
    const target = paragraph.targetElement;
    if (!target) return null;
    if (paragraph.wrapper?.isConnected && paragraph.wrapper.parentElement === target) return paragraph.wrapper;
    const wrapper = this.createInnerContainer(target);
    this.mark(wrapper, paragraph);
    wrapper.dataset.vastTranslator = '';
    return wrapper;
  }

  private cleanupUnownedPluginNodes(host: HTMLElement, ownerId: string, currentSourceWrapper?: HTMLElement, currentWrapper?: HTMLElement): void {
    const stale = (node: HTMLElement) => !node.dataset.vastOwner || node.dataset.vastOwner === ownerId || !this.isOwnedMount(node);
    for (const source of host.querySelectorAll<HTMLElement>('[data-vast-source]')) {
      if (source !== currentSourceWrapper && stale(source)) { source.hidden = false; source.replaceWith(...source.childNodes); }
    }
    for (const translator of host.querySelectorAll<HTMLElement>('[data-vast-translator]')) {
      if (translator !== currentWrapper && stale(translator)) translator.remove();
    }
  }

  private createInnerContainer(element: HTMLElement): HTMLElement {
    if (isPhrasingHost(element.tagName)) {
      const span = element.ownerDocument.createElement('span');
      span.dataset.vastBlock = '';
      return span;
    }
    return element.ownerDocument.createElement(isInlineHost(element.tagName) ? 'span' : 'div');
  }

  /**
   * 隐藏/显示源包装：直接作用于已挂载的 sourceWrapper，不重复走 mountContext。
   */
  private setSourceHidden(paragraph: ParagraphRecord, hidden: boolean): void {
    const source = paragraph.sourceWrapper;
    if (!source) return;
    if (hidden) hide(source); else source.hidden = false;
  }
}

if (typeof globalThis !== 'undefined') {
  (globalThis as { __vastInlineRenderer?: unknown }).__vastInlineRenderer = new InlineRenderer();
}
