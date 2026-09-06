import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeDependencies } from '../../src/background';
import { AiRequestCoordinator, type AiCacheLike, type AiRequestCostSnapshot } from '../../src/background/ai-coordinator';
import type { Provider } from '../../src/background/provider';
import type { TranslationRequest, TranslationResult } from '../../src/shared/messages';

interface FakeCall { request: TranslationRequest; signal: AbortSignal | undefined }

/** 条件驱动的确定性等待：轮询真实事件循环直到条件成立，避免盲等宏任务轮数的竞态 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 等待超时');
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

/** 等待全部未命中段完成入队（enqueue 与 cacheMisses 计数同步发生），随后才可手动驱动窗口 */
async function waitEnqueued(snapshot: () => AiRequestCostSnapshot, missCount: number): Promise<void> {
  await waitFor(() => snapshot().cacheMisses >= missCount);
}

/** 可手动驱动的合批窗口调度器，使测试不依赖真实 100ms 等待 */
function createManualScheduler() {
  const pending: Array<() => void> = [];
  return {
    flush: () => { while (pending.length > 0) pending.shift()!(); },
    schedule: (callback: () => void) => {
      pending.push(callback);
      return () => {
        const index = pending.indexOf(callback);
        if (index >= 0) pending.splice(index, 1);
      };
    },
  };
}

function createFakeProvider(engineId = 'custom-test', overrides: Partial<Provider> = {}) {
  const calls: FakeCall[] = [];
  const provider: Provider = {
    capabilities: { streaming: false },
    cacheIdentity: { engineId, engineFingerprint: `${engineId}-fp`, adapterVersion: 'test-v1' },
    translate: (request, signal) => {
      calls.push({ request, signal });
      return Promise.resolve(request.segments.map(({ id, text }) => ({ id, text: `译文:${text}` })));
    },
    testConnection: async () => undefined,
    ...overrides,
  };
  return { provider, calls };
}

function createManualProvider(engineId = 'custom-test') {
  const calls: FakeCall[] = [];
  let release: ((results: TranslationResult[]) => void) | undefined;
  const provider: Provider = {
    capabilities: { streaming: false },
    cacheIdentity: { engineId, engineFingerprint: `${engineId}-fp`, adapterVersion: 'test-v1' },
    translate: (request, signal) => new Promise<TranslationResult[]>((resolve) => {
      calls.push({ request, signal });
      release = resolve;
    }),
    testConnection: async () => undefined,
  };
  return {
    provider,
    calls,
    /** 返回 text 通过过滤的段（模拟 provider 部分成功） */
    completeWith: (keep: (text: string) => boolean) => {
      const request = calls[calls.length - 1]!.request;
      release?.(request.segments.filter(({ text }) => keep(text)).map(({ id, text }) => ({ id, text: `译文:${text}` })));
    },
    complete: () => {
      const request = calls[calls.length - 1]!.request;
      release?.(request.segments.map(({ id, text }) => ({ id, text: `译文:${text}` })));
    },
  };
}

function createMemoryCache() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string) => { store.set(key, value); },
  };
}

const request = (overrides: Partial<TranslationRequest> = {}): TranslationRequest => ({
  sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'p1', text: 'hello' }], ...overrides,
});

function createCoordinator(cache: AiCacheLike = createMemoryCache()) {
  const scheduler = createManualScheduler();
  const coordinator = new AiRequestCoordinator({ cache, windowMs: 100, schedule: scheduler.schedule });
  const queues = () => (coordinator as unknown as { queues: Map<string, unknown> }).queues;
  return { coordinator, flushWindow: scheduler.flush, queues };
}

describe('自定义 AI 请求协调器', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('冷基准：窗口内不发送，超窗后一次 provider 调用并还原原 ID', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();

    const promise = coordinator.translate(provider, request({ segments: [{ id: 'p1', text: 'hello' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 1);
    expect(calls).toHaveLength(0);

    flushWindow();
    await expect(promise).resolves.toEqual([{ id: 'p1', text: '译文:hello' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.segments.map(({ text }) => text)).toEqual(['hello']);
    expect(calls[0]!.request.segments[0]!.id).toMatch(/^b\d+:\d+$/);
    expect(coordinator.snapshot()).toMatchObject({ cacheHits: 0, cacheMisses: 1, providerCalls: 1, providerSegments: 1, providerCharacters: 5 });
  });

  it('热基准：命中缓存后不再调用 provider', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();

    const cold = coordinator.translate(provider, request());
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    await cold;

    const hot = coordinator.translate(provider, request({ segments: [{ id: 'p2', text: 'hello' }] }));
    await expect(hot).resolves.toEqual([{ id: 'p2', text: '译文:hello' }]);
    expect(calls).toHaveLength(1);
    expect(coordinator.snapshot()).toMatchObject({ cacheHits: 1, cacheMisses: 1, providerCalls: 1 });
  });

  it('重复基准：并发同文本只发起一次 provider 调用，各方还原原 ID', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();

    const first = coordinator.translate(provider, request({ segments: [{ id: 'a', text: 'hello' }] }));
    const second = coordinator.translate(provider, request({ segments: [{ id: 'b', text: 'hello' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    const [resultA, resultB] = await Promise.all([first, second]);

    expect(resultA).toEqual([{ id: 'a', text: '译文:hello' }]);
    expect(resultB).toEqual([{ id: 'b', text: '译文:hello' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.segments.map(({ text }) => text)).toEqual(['hello']);
    expect(coordinator.snapshot()).toMatchObject({ cacheMisses: 2, deduplicatedSegments: 1, providerCalls: 1, providerSegments: 1 });
  });

  it('同 id 不同 text 合批：批内槽位 id 唯一，映射回各自调用者', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();

    const first = coordinator.translate(provider, request({ segments: [{ id: 'p1', text: 'alpha' }] }));
    const second = coordinator.translate(provider, request({ segments: [{ id: 'p1', text: 'beta' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    const [resultA, resultB] = await Promise.all([first, second]);

    expect(resultA).toEqual([{ id: 'p1', text: '译文:alpha' }]);
    expect(resultB).toEqual([{ id: 'p1', text: '译文:beta' }]);
    expect(calls).toHaveLength(1);
    const sentIds = calls[0]!.request.segments.map(({ id }) => id);
    expect(new Set(sentIds).size).toBe(2);
    expect(calls[0]!.request.segments.map(({ text }) => text).sort()).toEqual(['alpha', 'beta']);
  });

  it('100ms 窗口内不同文本合并为一次批次调用', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();

    const first = coordinator.translate(provider, request({ segments: [{ id: 'a', text: 'one' }] }));
    const second = coordinator.translate(provider, request({ segments: [{ id: 'b', text: 'two' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.segments.map(({ text }) => text)).toEqual(['one', 'two']);
    expect(new Set(calls[0]!.request.segments.map(({ id }) => id)).size).toBe(2);
    expect(coordinator.snapshot()).toMatchObject({ providerCalls: 1, providerSegments: 2, providerCharacters: 6 });
  });

  it('批次上限：超过 8 段拆分为 8+1 两次 provider 调用', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();
    const segments = Array.from({ length: 9 }, (_, index) => ({ id: `p${index}`, text: `文本${index}` }));

    const promise = coordinator.translate(provider, request({ segments }));
    await waitEnqueued(() => coordinator.snapshot(), 9);
    flushWindow();
    await promise;

    expect(calls).toHaveLength(2);
    expect(calls[0]!.request.segments).toHaveLength(8);
    expect(calls[1]!.request.segments).toHaveLength(1);
  });

  it('批次字符上限：累计超过 6000 字符拆批', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator } = createCoordinator();
    const segments = [
      { id: 'a', text: 'a'.repeat(3000) },
      { id: 'b', text: 'b'.repeat(2500) },
      { id: 'c', text: 'c'.repeat(1000) },
    ];

    const promise = coordinator.translate(provider, request({ segments }));
    await waitEnqueued(() => coordinator.snapshot(), 3);
    await promise;

    expect(calls).toHaveLength(2);
    expect(calls[0]!.request.segments.map(({ text }) => text)).toEqual(['a'.repeat(3000), 'b'.repeat(2500)]);
    expect(calls[1]!.request.segments.map(({ text }) => text)).toEqual(['c'.repeat(1000)]);
    expect(coordinator.snapshot()).toMatchObject({ providerCalls: 2, providerSegments: 3, providerCharacters: 6500 });
  });

  it('不同目标语言相互隔离，各自调用 provider', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();

    const zh = coordinator.translate(provider, request());
    const ja = coordinator.translate(provider, request({ targetLanguage: 'ja' }));
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    await Promise.all([zh, ja]);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.request.targetLanguage).sort()).toEqual(['ja', 'zh-Hans']);
  });

  it('不同指令相互隔离，provider 收到各自的 userInstruction', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();

    const first = coordinator.translate(provider, request({ userInstruction: '语气正式' }));
    const second = coordinator.translate(provider, request({ userInstruction: '语气轻松' }));
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    await Promise.all([first, second]);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.request.userInstruction).sort()).toEqual(['语气正式', '语气轻松']);
  });

  it('不同 provider cacheIdentity 相互隔离', async () => {
    const work = createFakeProvider('custom-work');
    const home = createFakeProvider('custom-home');
    const { coordinator, flushWindow } = createCoordinator();

    const first = coordinator.translate(work.provider, request());
    const second = coordinator.translate(home.provider, request());
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    await Promise.all([first, second]);

    expect(work.calls).toHaveLength(1);
    expect(home.calls).toHaveLength(1);
  });

  it('取消订阅隔离：单个调用者取消，同键其他调用者仍正常完成', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();
    const controllerA = new AbortController();

    const first = coordinator.translate(provider, request({ segments: [{ id: 'a', text: 'hello' }] }), controllerA.signal);
    const second = coordinator.translate(provider, request({ segments: [{ id: 'b', text: 'hello' }] }), new AbortController().signal);
    await waitEnqueued(() => coordinator.snapshot(), 2);
    controllerA.abort();
    flushWindow();

    await expect(first).rejects.toThrow('任务已取消');
    await expect(second).resolves.toEqual([{ id: 'b', text: '译文:hello' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal?.aborted).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({ deduplicatedSegments: 1, abortedBatches: 0 });
  });

  it('发出前全部取消则不调用 provider 并清理队列', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow, queues } = createCoordinator();
    const controller = new AbortController();

    const promise = coordinator.translate(provider, request(), controller.signal);
    await waitEnqueued(() => coordinator.snapshot(), 1);
    controller.abort();
    await expect(promise).rejects.toThrow('任务已取消');

    flushWindow();
    expect(calls).toHaveLength(0);
    expect(coordinator.snapshot().providerCalls).toBe(0);
    expect(queues().size).toBe(0);
  });

  it('取消后同键重试：不复用已弃在途项，按新请求发送', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();
    const controller = new AbortController();

    const first = coordinator.translate(provider, request({ segments: [{ id: 'x', text: 'hello' }] }), controller.signal);
    await waitEnqueued(() => coordinator.snapshot(), 1);
    controller.abort();
    await expect(first).rejects.toThrow('任务已取消');

    const retry = coordinator.translate(provider, request({ segments: [{ id: 'y', text: 'hello' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 2);
    expect(coordinator.snapshot().deduplicatedSegments).toBe(0);
    flushWindow();
    await expect(retry).resolves.toEqual([{ id: 'y', text: '译文:hello' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.segments.map(({ text }) => text)).toEqual(['hello']);
  });

  it('全部取消：已发出批次收到中止信号并计入 abortedBatches', async () => {
    const manual = createManualProvider();
    const { coordinator, flushWindow } = createCoordinator();
    const controller = new AbortController();

    const promise = coordinator.translate(manual.provider, request(), controller.signal);
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    expect(manual.calls).toHaveLength(1);

    controller.abort();
    await expect(promise).rejects.toThrow('任务已取消');
    expect(manual.calls[0]!.signal?.aborted).toBe(true);
    expect(coordinator.snapshot().abortedBatches).toBe(1);

    manual.complete();
    await waitFor(() => manual.calls.length === 0 || coordinator.snapshot().abortedBatches === 1);
  });

  it('批次部分取消：剩余订阅者保持，全取消才中止', async () => {
    const manual = createManualProvider();
    const { coordinator, flushWindow } = createCoordinator();
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const first = coordinator.translate(manual.provider, request({ segments: [{ id: 'a', text: 'hello' }] }), controllerA.signal);
    const second = coordinator.translate(manual.provider, request({ segments: [{ id: 'b', text: 'hello' }] }), controllerB.signal);
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    expect(manual.calls).toHaveLength(1);

    controllerA.abort();
    await expect(first).rejects.toThrow('任务已取消');
    expect(manual.calls[0]!.signal?.aborted).toBe(false);

    controllerB.abort();
    await expect(second).rejects.toThrow('任务已取消');
    expect(manual.calls[0]!.signal?.aborted).toBe(true);
    expect(coordinator.snapshot().abortedBatches).toBe(1);

    manual.complete();
  });

  it('部分成功：失败段不丢弃其余成功段，成功段写入缓存，重试只发缺项', async () => {
    const cache = createMemoryCache();
    const warm = createFakeProvider();
    const calls: FakeCall[] = [];
    let cursePending = true;
    const partial: Provider = {
      capabilities: { streaming: false },
      cacheIdentity: { ...warm.provider.cacheIdentity },
      translate: (request, signal) => {
        calls.push({ request, signal });
        const skipCurse = cursePending;
        cursePending = false;
        return Promise.resolve(request.segments
          .filter(({ text }) => !(skipCurse && text === 'curse'))
          .map(({ id, text }) => ({ id, text: `译文:${text}` })));
      },
      testConnection: async () => undefined,
    };
    const { coordinator, flushWindow } = createCoordinator(cache);

    const warmup = coordinator.translate(warm.provider, request({ segments: [{ id: 'w', text: 'prime' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    await warmup;

    const second = coordinator.translate(partial, request({ segments: [
      { id: 'h', text: 'prime' }, { id: 'b', text: 'bee' }, { id: 'c', text: 'curse' },
    ] }));
    await waitEnqueued(() => coordinator.snapshot(), 3);
    flushWindow();
    await expect(second).resolves.toEqual([
      { id: 'h', text: '译文:prime' }, { id: 'b', text: '译文:bee' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.segments.map(({ text }) => text)).toEqual(['bee', 'curse']);

    // 重试只发缺项：prime 与 bee 已入缓存
    const retry = coordinator.translate(partial, request({ segments: [
      { id: 'h2', text: 'prime' }, { id: 'b2', text: 'bee' }, { id: 'c2', text: 'curse' },
    ] }));
    await waitEnqueued(() => coordinator.snapshot(), 4);
    flushWindow();
    await expect(retry).resolves.toEqual([
      { id: 'h2', text: '译文:prime' }, { id: 'b2', text: '译文:bee' }, { id: 'c2', text: '译文:curse' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.request.segments.map(({ text }) => text)).toEqual(['curse']);
  });

  it('全批失败且有缓存命中段：仍返回命中 subset 而非整体拒绝', async () => {
    const cache = createMemoryCache();
    const warm = createFakeProvider();
    const failing: Provider = {
      capabilities: { streaming: false },
      cacheIdentity: { ...warm.provider.cacheIdentity },
      translate: async () => { throw new Error('上游 500'); },
      testConnection: async () => undefined,
    };
    const { coordinator, flushWindow } = createCoordinator(cache);

    const warmup = coordinator.translate(warm.provider, request({ segments: [{ id: 'w', text: 'prime' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    await warmup;

    const promise = coordinator.translate(failing, request({ segments: [{ id: 'h', text: 'prime' }, { id: 'x', text: 'boom' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    await expect(promise).resolves.toEqual([{ id: 'h', text: '译文:prime' }]);
  });

  it('全部失败且无任何成功段：按首个错误拒绝', async () => {
    const failing = createFakeProvider('custom-test', {
      translate: async () => { throw new Error('上游 500'); },
    });
    const { coordinator, flushWindow } = createCoordinator();

    const promise = coordinator.translate(failing.provider, request({ segments: [{ id: 'a', text: 'one' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    await expect(promise).rejects.toThrow('上游 500');
  });

  it('失败提前结束：仅自身 reject，同批其他调用者不受影响', async () => {
    const manual = createManualProvider();
    const { coordinator, flushWindow } = createCoordinator();

    const first = coordinator.translate(manual.provider, request({ segments: [{ id: 'a', text: 'bee' }] }), new AbortController().signal);
    const second = coordinator.translate(manual.provider, request({ segments: [{ id: 'b', text: 'jay' }] }), new AbortController().signal);
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    manual.completeWith((text) => text !== 'bee');

    await expect(first).rejects.toThrow('翻译响应 ID 不匹配');
    await expect(second).resolves.toEqual([{ id: 'b', text: '译文:jay' }]);
  });

  it('缓存写入挂起期间同键请求继续去重，写完成后再释放', async () => {
    let releaseSet: (() => void) | undefined;
    const deferredCache = {
      get: async () => undefined,
      set: () => new Promise<void>((resolve) => { releaseSet = resolve; }),
    };
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator(deferredCache);

    const first = coordinator.translate(provider, request({ segments: [{ id: 'a', text: 'hello' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    await waitFor(() => releaseSet !== undefined);
    expect(calls).toHaveLength(1);

    const second = coordinator.translate(provider, request({ segments: [{ id: 'b', text: 'hello' }] }));
    await waitFor(() => coordinator.snapshot().deduplicatedSegments === 1);
    expect(calls).toHaveLength(1);

    releaseSet?.();
    await waitFor(() => {
      try { return coordinator.snapshot().deduplicatedSegments === 1 && calls.length === 1; } catch { return false; }
    });
    await expect(first).resolves.toEqual([{ id: 'a', text: '译文:hello' }]);
    await expect(second).resolves.toEqual([{ id: 'b', text: '译文:hello' }]);
    expect(calls).toHaveLength(1);
  });

  it('队列完结即释放，不永久保留 provider 与指令', async () => {
    const { provider } = createFakeProvider();
    const { coordinator, flushWindow, queues } = createCoordinator();

    const first = coordinator.translate(provider, request());
    await waitEnqueued(() => coordinator.snapshot(), 1);
    expect(queues().size).toBe(1);
    flushWindow();
    await first;
    expect(queues().size).toBe(0);

    const second = coordinator.translate(provider, request({ targetLanguage: 'ja' }));
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    await second;
    expect(queues().size).toBe(0);
  });

  it('完成后移除 abort 监听，之后取消不产生副作用', async () => {
    const { provider } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const promise = coordinator.translate(provider, request(), controller.signal);
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    await expect(promise).resolves.toEqual([{ id: 'p1', text: '译文:hello' }]);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    const before = coordinator.snapshot();
    controller.abort();
    await waitFor(() => coordinator.snapshot().abortedBatches === before.abortedBatches);
    expect(coordinator.snapshot()).toEqual(before);
  });

  it('拒绝路径同样移除 abort 监听', async () => {
    const failing = createFakeProvider('custom-test', {
      translate: async () => { throw new Error('上游 500'); },
    });
    const { coordinator, flushWindow } = createCoordinator();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const promise = coordinator.translate(failing.provider, request(), controller.signal);
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    await expect(promise).rejects.toThrow('上游 500');
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('provider 同步抛出时安全清理，不影响后续请求', async () => {
    const failing = createFakeProvider('custom-test', {
      translate: () => { throw new Error('同步失败'); },
    });
    const ok = createFakeProvider();
    const { coordinator, flushWindow, queues } = createCoordinator();

    const promise = coordinator.translate(failing.provider, request({ segments: [{ id: 'a', text: 'one' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    await expect(promise).rejects.toThrow('同步失败');
    expect(queues().size).toBe(0);

    const next = coordinator.translate(ok.provider, request({ segments: [{ id: 'b', text: 'two' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    await expect(next).resolves.toEqual([{ id: 'b', text: '译文:two' }]);
  });

  it('计数快照可重置，且快照只含整数计数不含正文密钥 URL', async () => {
    const { provider } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();

    const promise = coordinator.translate(provider, request({ userInstruction: '正式语气' }));
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    await promise;

    const snapshot = coordinator.snapshot();
    expect(JSON.stringify(snapshot)).not.toMatch(/hello|译文|正式|api\.example|secret|Bearer/);
    expect(Object.values(snapshot).every((value) => Number.isInteger(value) && value >= 0)).toBe(true);

    coordinator.reset();
    expect(coordinator.snapshot()).toEqual({
      cacheHits: 0, cacheMisses: 0, deduplicatedSegments: 0,
      providerCalls: 0, providerSegments: 0, providerCharacters: 0, abortedBatches: 0,
    });
  });

  it('同一请求重复段 ID 直接拒绝，不发起 provider 调用', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();

    await expect(coordinator.translate(provider, request({ segments: [
      { id: 'dup', text: 'first' }, { id: 'dup', text: 'second' },
    ] }))).rejects.toThrow('翻译段 ID 重复');
    flushWindow();
    await waitFor(() => calls.length === 0);
    expect(calls).toHaveLength(0);
    expect(coordinator.snapshot().providerCalls).toBe(0);
  });

  it('跨调用者相同 id 不受重复校验影响（槽位机制保持）', async () => {
    const { provider } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();

    const first = coordinator.translate(provider, request({ segments: [{ id: 'p1', text: 'alpha' }] }));
    const second = coordinator.translate(provider, request({ segments: [{ id: 'p1', text: 'beta' }] }));
    await waitEnqueued(() => coordinator.snapshot(), 2);
    flushWindow();
    expect(await first).toEqual([{ id: 'p1', text: '译文:alpha' }]);
    expect(await second).toEqual([{ id: 'p1', text: '译文:beta' }]);
  });

  it('provider 返回后调用者才取消：不再空中止批次，abortedBatches 不虚增', async () => {
    const manual = createManualProvider();
    const { coordinator, flushWindow } = createCoordinator();
    const controller = new AbortController();

    const promise = coordinator.translate(manual.provider, request(), controller.signal);
    await waitEnqueued(() => coordinator.snapshot(), 1);
    flushWindow();
    manual.complete();
    await expect(promise).resolves.toEqual([{ id: 'p1', text: '译文:hello' }]);

    controller.abort();
    await waitFor(() => controller.signal.aborted);
    expect(coordinator.snapshot().abortedBatches).toBe(0);
  });

  it('入口 signal 已中止时直接拒绝且不发起请求', async () => {
    const { provider, calls } = createFakeProvider();
    const { coordinator, flushWindow } = createCoordinator();
    const controller = new AbortController();
    controller.abort();

    await expect(coordinator.translate(provider, request(), controller.signal)).rejects.toThrow('任务已取消');
    flushWindow();
    await waitFor(() => calls.length === 0);
    expect(calls).toHaveLength(0);
  });
});

describe('后台运行时依赖接入协调器', () => {
  const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

  it('custom-ai 经协调器缓存+去重+合批，aiMetrics 暴露快照与重置', async () => {
    const cache = createMemoryCache();
    const { provider, calls } = createFakeProvider('custom-work');
    const dependencies = createRuntimeDependencies({ cache, createProvider: () => provider });

    const first = dependencies.translate!(provider, request({ segments: [{ id: 'a', text: 'hello' }] }), new AbortController().signal);
    const second = dependencies.translate!(provider, request({ segments: [{ id: 'b', text: 'hello' }] }), new AbortController().signal);
    await sleep(150);
    const [resultA] = await Promise.all([first, second]);
    expect(resultA).toEqual([{ id: 'a', text: '译文:hello' }]);
    expect(calls).toHaveLength(1);
    expect(dependencies.aiMetrics!.snapshot()).toMatchObject({ deduplicatedSegments: 1, providerCalls: 1 });

    const hot = dependencies.translate!(provider, request({ segments: [{ id: 'c', text: 'hello' }] }), new AbortController().signal);
    await expect(hot).resolves.toEqual([{ id: 'c', text: '译文:hello' }]);
    expect(calls).toHaveLength(1);

    dependencies.aiMetrics!.reset();
    expect(dependencies.aiMetrics!.snapshot().providerCalls).toBe(0);
  });

  it('Google 路径保持原有同步批次行为，不经过 100ms 窗口', async () => {
    const cache = createMemoryCache();
    const googleCalls: FakeCall[] = [];
    const google: Provider = {
      capabilities: { streaming: false },
      cacheIdentity: { engineId: 'google', engineFingerprint: 'google', adapterVersion: 'google-v1' },
      translate: (request, signal) => {
        googleCalls.push({ request, signal });
        return Promise.resolve(request.segments.map(({ id, text }) => ({ id, text: `google:${text}` })));
      },
      testConnection: async () => undefined,
    };
    const dependencies = createRuntimeDependencies({ cache, createProvider: () => google });

    const promise = dependencies.translate!(google, request({ segments: [{ id: 'p1', text: 'hello' }] }), new AbortController().signal);
    await expect(promise).resolves.toEqual([{ id: 'p1', text: 'google:hello' }]);
    expect(googleCalls).toHaveLength(1);
    expect(dependencies.aiMetrics!.snapshot().providerCalls).toBe(0);
  });
});
