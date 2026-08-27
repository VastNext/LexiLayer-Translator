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

function isPluginNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return Boolean(element?.closest('[data-vast-translator]'));
}

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
    this.observer.observe(this.root, { childList: true, characterData: true, subtree: true });
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
    const rendererSources = new Set(records.flatMap((record) => {
      if (record.type !== 'childList' || !(record.target instanceof HTMLElement)) return [];
      const installsWrapper = [...record.addedNodes].some((node) => node instanceof HTMLElement && node.matches('[data-vast-source]'));
      return installsWrapper ? [record.target] : [];
    }));
    for (const record of records) {
      if (isPluginNode(record.target) || rendererSources.has(record.target as HTMLElement)) continue;

      this.collectInvalidatedSource(record.target);
      if (record.type !== 'childList') continue;

      for (const node of record.addedNodes) {
        if (node instanceof Element && !isPluginNode(node)) this.addRoot(node);
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        for (const element of [node, ...node.querySelectorAll<HTMLElement>('*')]) this.pendingRemoved.add(element);
      }
    }

    if (this.pendingRoots.size > 0 || this.pendingSources.size > 0 || this.pendingRemoved.size > 0) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), this.options.debounceMs);
    }
  }

  private collectInvalidatedSource(node: Node): void {
    if (!this.options.store) return;
    let element = node instanceof HTMLElement ? node : node.parentElement;
    while (element && this.root.contains(element)) {
      if (this.options.store.get(element)) {
        this.pendingSources.add(element);
        return;
      }
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
      const version = this.options.store!.get(source)?.version;
      const paragraph = this.options.store!.refresh(source);
      if (paragraph.version !== version) invalidated.push(paragraph);
    }
    const added = new Set<HTMLElement>();
    for (const root of this.pendingRoots) {
      for (const element of this.options.scan(root) ?? []) added.add(element);
    }
    const removed: ParagraphRecord[] = [];
    for (const element of this.pendingRemoved) {
      if (element.isConnected) continue;
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
