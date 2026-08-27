import { describe, expect, it, vi } from 'vitest';

import { ElementVisibilityQueue, ParagraphVisibilityBatchQueue, VisibleFirstScheduler } from '../../src/content/scheduler';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('VisibleFirstScheduler', () => {
  it('whenIdle 返回每个失败任务而不吞异常', async () => {
    const scheduler = new VisibleFirstScheduler(async (item: string) => {
      if (item === 'bad') throw new Error('段落失败');
    }, { concurrency: 2, maxPending: 5 });
    scheduler.enqueue('ok', true);
    scheduler.enqueue('bad', true);

    await expect(scheduler.whenIdle()).resolves.toEqual([
      { item: 'bad', error: expect.objectContaining({ message: '段落失败' }) },
    ]);
  });
  it('当前任务结束后优先执行可见任务', async () => {
    const first = deferred();
    const calls: string[] = [];
    const scheduler = new VisibleFirstScheduler<string>(async (id) => {
      calls.push(id);
      if (id === 'first') await first.promise;
    }, { concurrency: 1, maxPending: 4 });

    scheduler.enqueue('first', false);
    scheduler.enqueue('background', false);
    scheduler.enqueue('visible', true);
    await Promise.resolve();
    expect(calls).toEqual(['first']);

    first.resolve();
    await scheduler.whenIdle();
    expect(calls).toEqual(['first', 'visible', 'background']);
  });

  it('对运行中和排队任务实施硬上限，并按 key 去重', async () => {
    const blocker = deferred();
    const scheduler = new VisibleFirstScheduler<{ id: string }>(
      async () => blocker.promise,
      { concurrency: 1, maxPending: 2, keyOf: (item) => item.id },
    );

    expect(scheduler.enqueue({ id: 'a' }, false)).toBe(true);
    expect(scheduler.enqueue({ id: 'a' }, true)).toBe(false);
    expect(scheduler.enqueue({ id: 'b' }, false)).toBe(true);
    expect(scheduler.enqueue({ id: 'c' }, true)).toBe(false);
    expect(scheduler.pendingCount).toBe(2);

    blocker.resolve();
    await scheduler.whenIdle();
    expect(scheduler.pendingCount).toBe(0);
  });

  it('IntersectionObserver 命中后把已排队任务提升为可见优先', async () => {
    const first = deferred();
    const calls: string[] = [];
    const scheduler = new VisibleFirstScheduler<string>(async (id) => {
      calls.push(id);
      if (id === 'first') await first.promise;
    }, { concurrency: 1, maxPending: 4 });
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    const observed: Element[] = [];
    const visibilityQueue = new ElementVisibilityQueue(scheduler, (callback) => {
      notify = callback;
      return {
        observe: (element) => observed.push(element),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    });
    const backgroundElement = document.createElement('p');
    const visibleElement = document.createElement('p');

    scheduler.enqueue('first', false);
    visibilityQueue.observe(backgroundElement, 'background');
    visibilityQueue.observe(visibleElement, 'visible');
    notify([{ target: visibleElement, isIntersecting: true }]);
    visibilityQueue.submitNonVisible(backgroundElement);
    expect(observed).toEqual([backgroundElement, visibleElement]);

    first.resolve();
    await scheduler.whenIdle();
    expect(calls).toEqual(['first', 'visible', 'background']);
    visibilityQueue.disconnect();
  });

  it('观察未知可见性的元素时，空闲调度器不会提前执行', async () => {
    const calls: string[] = [];
    const scheduler = new VisibleFirstScheduler<string>(async (id) => { calls.push(id); }, {
      concurrency: 1,
      maxPending: 2,
    });
    const visibilityQueue = new ElementVisibilityQueue(scheduler, () => ({
      observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn(),
    }));
    const element = document.createElement('p');

    expect(visibilityQueue.observe(element, 'unknown')).toBe(true);
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('允许显式提交尚不可见任务用于滚动附近懒加载', async () => {
    const calls: string[] = [];
    const scheduler = new VisibleFirstScheduler<string>(async (id) => { calls.push(id); }, {
      concurrency: 1,
      maxPending: 2,
    });
    const visibilityQueue = new ElementVisibilityQueue(scheduler, () => ({
      observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn(),
    }));
    const element = document.createElement('p');
    visibilityQueue.observe(element, 'nearby');

    expect(visibilityQueue.submitNonVisible(element)).toBe(true);
    await scheduler.whenIdle();
    expect(calls).toEqual(['nearby']);
  });

  it('离屏批在 IntersectionObserver 命中前不进入请求，命中后提交', async () => {
    const calls: string[][] = [];
    const scheduler = new VisibleFirstScheduler<string[]>(async (batch) => { calls.push(batch); }, { concurrency: 3, maxPending: 5 });
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    const queue = new ElementVisibilityQueue(scheduler, (callback) => { notify = callback; return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }; });
    const offscreen = document.createElement('p');
    queue.observe(offscreen, ['offscreen']); await Promise.resolve(); expect(calls).toEqual([]);
    notify([{ target: offscreen, isIntersecting: true }]);
    await scheduler.whenIdle(); expect(calls).toEqual([['offscreen']]);
  });

  it('whenIdle 等待首次 IO 判定与可见批完成，但不等待真正离屏项', async () => {
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    const calls: string[][] = [];
    const queue = new ParagraphVisibilityBatchQueue(async (items: Array<{ id: string; sourceText: string; element: HTMLElement }>) => { calls.push(items.map(({ id }) => id)); }, (callback) => { notify = callback; return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }; });
    const visible = { id: 'visible', sourceText: 'v', element: document.createElement('p') };
    const offscreen = { id: 'offscreen', sourceText: 'o', element: document.createElement('p') };
    queue.add([visible, offscreen]);
    let settled = false; const idle = queue.whenIdle().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    notify([{ target: visible.element, isIntersecting: true }, { target: offscreen.element, isIntersecting: false }]);
    await idle;
    expect(calls).toEqual([['visible']]);
    expect(queue.waitingCount).toBe(1);
  });

  it('浏览器不支持 IntersectionObserver 时保守提交任务', async () => {
    const original = globalThis.IntersectionObserver;
    Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: undefined });
    try {
      const calls: string[] = [];
      const scheduler = new VisibleFirstScheduler<string>(async (item) => { calls.push(item); }, { concurrency: 1, maxPending: 2 });
      const queue = new ElementVisibilityQueue(scheduler);
      expect(queue.observe(document.createElement('p'), 'fallback')).toBe(true);
      await scheduler.whenIdle();
      expect(calls).toEqual(['fallback']);
    } finally {
      Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: original });
    }
  });
});

describe('ParagraphVisibilityBatchQueue', () => {
  function paragraph(id: string, length = 1) {
    const element = document.createElement('p');
    element.textContent = id;
    return { id, sourceText: id.repeat(length), element };
  }

  it('离屏段落不执行，intersection 后在一个短批中执行', async () => {
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    const calls: string[][] = [];
    const queue = new ParagraphVisibilityBatchQueue(async (items) => { calls.push(items.map((item) => item.id)); }, (callback) => {
      notify = callback;
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });
    const first = paragraph('first'); const second = paragraph('second');
    queue.add([first, second]); await Promise.resolve(); expect(calls).toEqual([]);
    notify([{ target: first.element, isIntersecting: true }, { target: second.element, isIntersecting: true }]);
    await queue.whenIdle();
    expect(calls).toEqual([['first', 'second']]);
  });

  it('10 个同时进入的短段组成 8+2 两批', async () => {
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    const calls: number[] = [];
    const queue = new ParagraphVisibilityBatchQueue(async (items) => { calls.push(items.length); }, (callback) => {
      notify = callback; return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });
    const items = Array.from({ length: 10 }, (_, index) => paragraph(String(index)));
    queue.add(items);
    notify(items.map((item) => ({ target: item.element, isIntersecting: true })));
    await queue.whenIdle();
    expect(calls).toEqual([8, 2]);
  });

  it('按 6000 字符边界分批且并发不超过 3', async () => {
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    let active = 0; let peak = 0;
    const blockers: Array<() => void> = [];
    const queue = new ParagraphVisibilityBatchQueue(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => blockers.push(resolve));
      active -= 1;
    }, (callback) => { notify = callback; return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }; });
    const items = Array.from({ length: 8 }, (_, index) => paragraph(String(index), 2000));
    queue.add(items); notify(items.map((item) => ({ target: item.element, isIntersecting: true })));
    await vi.waitFor(() => expect(blockers).toHaveLength(3));
    expect(peak).toBe(3);
    blockers.splice(0).forEach((resolve) => resolve());
    await queue.whenIdle();
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('离屏元素移除后解除观察且后续 intersection 不执行', async () => {
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    const unobserve = vi.fn(); const worker = vi.fn(async () => undefined);
    const queue = new ParagraphVisibilityBatchQueue(worker, (callback) => {
      notify = callback; return { observe: vi.fn(), unobserve, disconnect: vi.fn() };
    });
    const item = paragraph('removed'); queue.add([item]); queue.remove(item.element);
    notify([{ target: item.element, isIntersecting: true }]); await queue.whenIdle();
    expect(unobserve).toHaveBeenCalledWith(item.element);
    expect(worker).not.toHaveBeenCalled();
  });

  it('首次 IO 前移除最后一个元素会释放 initial waiter 并结束 whenIdle', async () => {
    const queue = new ParagraphVisibilityBatchQueue(async () => undefined, () => ({
      observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn(),
    }));
    const item = paragraph('removed-before-io');
    queue.add([item]);
    const idle = queue.whenIdle();

    queue.remove(item.element);

    await expect(Promise.race([
      idle.then(() => 'idle'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])).resolves.toBe('idle');
  });

  it('最后一个观察项处理完成后通知调用方释放队列', async () => {
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    const onDrained = vi.fn();
    const queue = new ParagraphVisibilityBatchQueue(async () => undefined, (callback) => {
      notify = callback; return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }, onDrained);
    const item = paragraph('visible'); queue.add([item]);
    notify([{ target: item.element, isIntersecting: true }]);
    await queue.whenIdle(); await vi.waitFor(() => expect(onDrained).toHaveBeenCalledOnce());
  });
});
