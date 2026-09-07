import type { ParagraphRecord, ParagraphStore } from './paragraph-store';

export interface DynamicObserverOptions {
  scan: (root: Element) => HTMLElement[] | void;
  debounceMs: number;
  store?: ParagraphStore;
  onAdded?: (elements: HTMLElement[]) => void;
  onInvalidated?: (paragraph: ParagraphRecord) => void;
  onRemoved?: (paragraph: ParagraphRecord) => void;
  onChanges?: (changes: { added: HTMLElement[]; invalidated: ParagraphRecord[]; removed: ParagraphRecord[] }) => void;
}

const inlineRenderer = () => (globalThis as { __vastInlineRenderer?: { isUnsafe(el: HTMLElement): boolean; isOwnedMount(node: HTMLElement): boolean } }).__vastInlineRenderer;
const isPluginNode = (node: Node): boolean => Boolean((node.nodeType === 1 ? node as Element : (node as Node).parentElement)?.closest?.('[data-vast-translator]'));
const checkIsUnsafe = (element: HTMLElement): boolean => inlineRenderer()?.isUnsafe(element) ?? false;
const isStalePluginNode = (node: HTMLElement, record: ParagraphRecord): boolean => {
  if (node === record.sourceWrapper || node === record.wrapper) return false;
  const owner = node.dataset.vastOwner;
  if (!owner || owner === record.id) return true;
  return !inlineRenderer()?.isOwnedMount(node);
};

export class DynamicPageObserver {
  private readonly pendingRoots = new Set<Element>();
  private readonly pendingSources = new Set<HTMLElement>();
  private readonly pendingRemoved = new Set<HTMLElement>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly observer: MutationObserver;

  constructor(
    private readonly root: Element,
    private readonly options: DynamicObserverOptions,
  ) {
    this.observer = new MutationObserver((records) => this.collect(records));
  }

  start(): void {
    this.observer.observe(this.root, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['inert', 'hidden', 'aria-hidden', 'aria-expanded'],
    });
  }

  stop(): void {
    this.observer.disconnect();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingRoots.clear();
    this.pendingSources.clear();
    this.pendingRemoved.clear();
  }

  private collect(records: MutationRecord[]): void {
    const ownTargets = new Set<Element>();
    for (const record of records) {
      if (record.type !== 'childList' || record.target.nodeType !== 1) continue;
      const target = record.target as HTMLElement;
      const mount = this.options.store?.get(target);
      if ([...record.addedNodes].some((node) => node === mount?.sourceWrapper || node === mount?.wrapper)) ownTargets.add(target);
    }
    for (const record of records) {
      if (isPluginNode(record.target) || ownTargets.has(record.target as Element)) continue;
      if (record.type === 'childList' || record.type === 'characterData') {
        this.collectInvalidatedSource(record.target);
      }
      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && !isPluginNode(node)) this.addRoot(node as HTMLElement);
        }
        for (const node of record.removedNodes) {
          if (node.nodeType !== 1) continue;
          for (const element of [node as HTMLElement, ...(node as HTMLElement).querySelectorAll<HTMLElement>('*')]) this.pendingRemoved.add(element);
        }
      } else if (record.type === 'attributes') {
        if (record.target.nodeType === 1) this.addRoot(record.target as HTMLElement);
      }
    }

    if (this.pendingRoots.size > 0 || this.pendingSources.size > 0 || this.pendingRemoved.size > 0) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), this.options.debounceMs);
    }
  }

  private collectInvalidatedSource(node: Node): void {
    let element = node.nodeType === 1 ? node as HTMLElement : node.parentElement;
    while (element && this.root.contains(element)) {
      if (this.options.store?.get(element)) { this.pendingSources.add(element); return; }
      element = element.parentElement;
    }
  }

  private addRoot(root: Element): void {
    for (const existing of this.pendingRoots) {
      if (existing.contains(root)) return;
      if (root.contains(existing)) this.pendingRoots.delete(existing);
    }
    this.pendingRoots.add(root);
  }

  private flush(): void {
    this.timer = undefined;

    const invalidated: ParagraphRecord[] = [];
    for (const source of this.pendingSources) {
      if (!source.isConnected) continue;
      const record = this.options.store?.get(source);
      if (!record) continue;

      const prevVersion = record.version;
      let mountInvalidated = false;

      for (const node of source.querySelectorAll<HTMLElement>('[data-vast-source], [data-vast-translator]')) {
        if (!isStalePluginNode(node, record)) continue;
        let nested = false;
        for (let parent = node.parentElement; parent && parent !== source; parent = parent.parentElement) {
          if (this.options.store?.get(parent) && this.options.store!.get(parent) !== record) { nested = true; break; }
        }
        if (nested) continue;
        mountInvalidated = true;
        if (node.dataset.vastSource !== undefined) { node.hidden = false; node.replaceWith(...node.childNodes); }
        else node.remove();
      }

      if (record.rendererKind === 'inline' || record.sourceWrapper !== undefined || record.targetElement !== undefined) {
        mountInvalidated = mountInvalidated
          || checkIsUnsafe(source)
          || [record.sourceWrapper, record.wrapper, record.targetElement].some((n) => !!n && (!n.isConnected || !source.contains(n)));
      } else if (record.rendererKind === 'legacy') {
        const wrapper = record.wrapper;
        mountInvalidated = mountInvalidated || (wrapper !== undefined && (!wrapper.isConnected || wrapper.parentElement !== source.parentElement));
      }

      const paragraph = this.options.store!.refresh(source);
      if (paragraph.version !== prevVersion || mountInvalidated) {
        if (paragraph.version === prevVersion) {
          paragraph.version += 1;
        }
        invalidated.push(paragraph);
      }
    }
    const added = new Set<HTMLElement>();
    for (const root of this.pendingRoots) {
      for (const element of this.options.scan(root) ?? []) {
        if (!this.options.store?.get(element)) {
          added.add(element);
        }
      }
    }
    const removed: ParagraphRecord[] = [];
    for (const element of this.pendingRemoved) {
      if (element.isConnected) continue;
      const record = this.options.store?.get(element);
      record?.wrapper?.remove();
      const paragraph = this.options.store?.delete(element);
      if (paragraph) removed.push(paragraph);
    }
    if (this.options.onChanges && (added.size > 0 || invalidated.length > 0 || removed.length > 0)) {
      this.options.onChanges({ added: [...added], invalidated, removed });
    } else {
      if (added.size > 0) this.options.onAdded?.([...added]);
      for (const paragraph of invalidated) this.options.onInvalidated?.(paragraph);
      for (const paragraph of removed) this.options.onRemoved?.(paragraph);
    }

    this.pendingSources.clear();
    this.pendingRoots.clear();
    this.pendingRemoved.clear();
  }
}
