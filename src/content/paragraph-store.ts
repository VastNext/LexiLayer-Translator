export interface ParagraphRecord {
  id: string;
  element: HTMLElement;
  /** 内联模式下下钻挂载的目标元素（如单链接内部的安全文本容器） */
  targetElement?: HTMLElement;
  sourceText: string;
  version: number;
  currentTaskId?: string;
  wrapper?: HTMLElement;
  sourceWrapper?: HTMLElement;
  originalHidden: HTMLElement['hidden'];
  /** 实际渲染该段落的渲染器，恢复时必须由它处理。 */
  rendererKind?: 'legacy' | 'inline';
}

const EXCLUDED_TEXT_SELECTORS = [
  '[aria-hidden="true"]',
  '[hidden]',
  '.sr-only',
  '.visually-hidden',
  'svg',
  'canvas',
  'mat-icon',
  '[role="img"]',
  '[role="tooltip"]',
  'script',
  'style',
  'noscript',
  'template',
  '[data-vast-translator]',
  '[data-vast-inline-selection-translation]',
].join(',');

function isTextNodeExcluded(node: Node, root: HTMLElement): boolean {
  for (let current = node.parentElement; current && current !== root.parentElement; current = current.parentElement) {
    if (current.matches('[data-vast-source]')) continue;
    if (current.matches(EXCLUDED_TEXT_SELECTORS)) return true;
    const style = current.style;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
  }
  return false;
}

function readSourceText(element: HTMLElement): string {
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      if (isTextNodeExcluded(node, element)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.textContent ?? '');
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export class ParagraphStore {
  private readonly records = new WeakMap<HTMLElement, ParagraphRecord>();
  private nextId = 1;

  get(element: HTMLElement): ParagraphRecord | undefined {
    return this.records.get(element);
  }

  getOrCreate(element: HTMLElement): ParagraphRecord {
    const existing = this.records.get(element);
    if (existing) return existing;

    const record: ParagraphRecord = {
      id: `paragraph-${this.nextId++}`,
      element,
      sourceText: readSourceText(element),
      version: 1,
      originalHidden: element.hidden,
    };
    this.records.set(element, record);
    return record;
  }

  refresh(element: HTMLElement): ParagraphRecord {
    const record = this.getOrCreate(element);
    const sourceText = readSourceText(element);
    if (sourceText !== record.sourceText) {
      record.sourceText = sourceText;
      record.version += 1;
    }
    return record;
  }

  delete(element: HTMLElement): ParagraphRecord | undefined {
    const record = this.records.get(element);
    this.records.delete(element);
    if (record) {
      record.wrapper = undefined;
      record.sourceWrapper = undefined;
      record.targetElement = undefined;
      record.currentTaskId = undefined;
      record.rendererKind = undefined;
    }
    return record;
  }

  clear(): void {
    this.nextId = 1;
  }
}
