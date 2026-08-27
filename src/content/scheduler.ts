export interface SchedulerOptions<T> {
  concurrency: number;
  maxPending: number;
  keyOf?: (item: T) => string;
}

interface QueueEntry<T> {
  item: T;
  key: string;
}

export interface SchedulerFailure<T> {
  item: T;
  error: unknown;
}

export class VisibleFirstScheduler<T> {
  private readonly visibleQueue: QueueEntry<T>[] = [];
  private readonly backgroundQueue: QueueEntry<T>[] = [];
  private readonly keys = new Set<string>();
  private readonly idleWaiters: Array<(failures: SchedulerFailure<T>[]) => void> = [];
  private readonly failures: SchedulerFailure<T>[] = [];
  private activeCount = 0;

  constructor(
    private readonly worker: (item: T) => Promise<void>,
    private readonly options: SchedulerOptions<T>,
  ) {
    if (options.concurrency < 1 || options.maxPending < 1) {
      throw new Error('并发数和队列上限必须大于 0');
    }
  }

  get pendingCount(): number {
    return this.activeCount + this.visibleQueue.length + this.backgroundQueue.length;
  }

  enqueue(item: T, visible: boolean): boolean {
    const key = this.options.keyOf?.(item) ?? String(item);
    if (this.keys.has(key)) {
      if (visible) this.promote(key);
      return false;
    }
    if (this.pendingCount >= this.options.maxPending) return false;

    const entry = { item, key };
    this.keys.add(key);
    (visible ? this.visibleQueue : this.backgroundQueue).push(entry);
    this.pump();
    return true;
  }

  whenIdle(): Promise<SchedulerFailure<T>[]> {
    if (this.pendingCount === 0) return Promise.resolve(this.takeFailures());
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private promote(key: string): void {
    const index = this.backgroundQueue.findIndex((entry) => entry.key === key);
    if (index < 0) return;
    const [entry] = this.backgroundQueue.splice(index, 1);
    this.visibleQueue.push(entry);
  }

  private pump(): void {
    while (this.activeCount < this.options.concurrency) {
      const entry = this.visibleQueue.shift() ?? this.backgroundQueue.shift();
      if (!entry) break;

      this.activeCount += 1;
      void Promise.resolve()
        .then(() => this.worker(entry.item))
        .catch((error: unknown) => this.failures.push({ item: entry.item, error }))
        .finally(() => {
          this.activeCount -= 1;
          this.keys.delete(entry.key);
          this.pump();
          this.resolveIdle();
        });
    }
  }

  private resolveIdle(): void {
    if (this.pendingCount !== 0) return;
    const failures = this.takeFailures();
    for (const resolve of this.idleWaiters.splice(0)) resolve(failures);
  }

  private takeFailures(): SchedulerFailure<T>[] {
    return this.failures.splice(0);
  }
}

interface VisibilityObserver {
  observe: (element: Element) => void;
  unobserve: (element: Element) => void;
  disconnect: () => void;
}

type VisibilityCallback = (
  entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[],
) => void;

type VisibilityObserverFactory = (callback: VisibilityCallback) => VisibilityObserver;

interface VisibleParagraph {
  id: string;
  sourceText: string;
  element: HTMLElement;
}

export class ElementVisibilityQueue<T> {
  private readonly items = new Map<Element, T>();
  private readonly observer?: VisibilityObserver;
  private readonly fallback: boolean;

  constructor(
    private readonly scheduler: VisibleFirstScheduler<T>,
    createObserver?: VisibilityObserverFactory,
  ) {
    const factory = createObserver ?? (typeof IntersectionObserver === 'function'
      ? (callback: VisibilityCallback) => new IntersectionObserver(
        (entries) => callback(entries),
        { rootMargin: '200px 0px' },
      )
      : undefined);
    this.fallback = factory === undefined;
    this.observer = factory?.((entries) => this.onIntersection(entries));
  }

  observe(element: Element, item: T): boolean {
    if (this.fallback) return this.scheduler.enqueue(item, false);
    if (this.items.has(element)) return false;
    this.items.set(element, item);
    this.observer!.observe(element);
    return true;
  }

  submitNonVisible(element: Element): boolean {
    const item = this.items.get(element);
    if (item === undefined || !this.scheduler.enqueue(item, false)) return false;
    this.remove(element);
    return true;
  }

  disconnect(): void {
    this.observer?.disconnect();
  }

  private onIntersection(
    entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[],
  ): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const item = this.items.get(entry.target);
      if (item === undefined) continue;

      if (this.scheduler.enqueue(item, true)) this.remove(entry.target);
    }
  }

  private remove(element: Element): void {
    this.items.delete(element);
    this.observer?.unobserve(element);
  }
}

export class ParagraphVisibilityBatchQueue<T extends VisibleParagraph> {
  private readonly waiting = new Map<Element, T>();
  private readonly ready: T[] = [];
  private readonly observer?: VisibilityObserver;
  private readonly scheduler: VisibleFirstScheduler<T[]>;
  private flushPending = false;
  private readonly initialPending = new Set<Element>();
  private readonly initialWaiters: Array<() => void> = [];

  constructor(
    worker: (items: T[]) => Promise<void>,
    createObserver?: VisibilityObserverFactory,
    private readonly onDrained?: () => void,
  ) {
    this.scheduler = new VisibleFirstScheduler(worker, {
      concurrency: 3,
      maxPending: Number.MAX_SAFE_INTEGER,
      keyOf: (items) => items.map((item) => `${item.id}:${item.sourceText}`).join(','),
    });
    const factory = createObserver ?? (typeof IntersectionObserver === 'function'
      ? (callback: VisibilityCallback) => new IntersectionObserver(
        (entries) => callback(entries),
        { rootMargin: '200px 0px' },
      )
      : undefined);
    this.observer = factory?.((entries) => this.onIntersection(entries));
  }

  add(items: T[]): void {
    for (const item of items) {
      if (this.waiting.has(item.element)) continue;
      if (!this.observer) this.ready.push(item);
      else {
        this.waiting.set(item.element, item);
        this.initialPending.add(item.element);
        this.observer.observe(item.element);
      }
    }
    if (!this.observer) this.requestFlush();
  }

  remove(element: Element): void {
    this.waiting.delete(element);
    this.initialPending.delete(element);
    this.observer?.unobserve(element);
    if (this.initialPending.size === 0) for (const resolve of this.initialWaiters.splice(0)) resolve();
    this.notifyWhenDrained();
  }

  async whenIdle(): Promise<SchedulerFailure<T[]>[]> {
    if (this.initialPending.size > 0) await new Promise<void>((resolve) => this.initialWaiters.push(resolve));
    if (this.flushPending) await new Promise<void>((resolve) => queueMicrotask(resolve));
    return this.scheduler.whenIdle();
  }

  disconnect(): void {
    this.waiting.clear();
    this.initialPending.clear();
    for (const resolve of this.initialWaiters.splice(0)) resolve();
    this.ready.length = 0;
    this.observer?.disconnect();
  }

  private onIntersection(entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]): void {
    for (const entry of entries) {
      this.initialPending.delete(entry.target);
      if (!entry.isIntersecting) continue;
      const item = this.waiting.get(entry.target);
      if (!item) continue;
      this.waiting.delete(entry.target);
      this.observer?.unobserve(entry.target);
      this.ready.push(item);
    }
    if (this.initialPending.size === 0) for (const resolve of this.initialWaiters.splice(0)) resolve();
    this.requestFlush();
  }

  private requestFlush(): void {
    if (this.flushPending || this.ready.length === 0) return;
    this.flushPending = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushPending = false;
    let batch: T[] = [];
    let characters = 0;
    for (const item of this.ready.splice(0)) {
      if (batch.length > 0 && (batch.length >= 8 || characters + item.sourceText.length > 6000)) {
        this.scheduler.enqueue(batch, true);
        batch = [];
        characters = 0;
      }
      batch.push(item);
      characters += item.sourceText.length;
    }
    if (batch.length > 0) this.scheduler.enqueue(batch, true);
    this.notifyWhenDrained();
  }

  private notifyWhenDrained(): void {
    if (this.waiting.size > 0 || this.ready.length > 0 || this.flushPending) return;
    void this.scheduler.whenIdle().then(() => {
      if (this.waiting.size === 0 && this.ready.length === 0 && !this.flushPending) this.onDrained?.();
    });
  }
}
