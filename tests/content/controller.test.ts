import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createContentController, createRuntimeDependencies, type ContentControllerDependencies } from '../../src/content';
import type { TranslationRequest } from '../../src/shared/messages';

function createDependencies(): ContentControllerDependencies & {
  listeners: Array<(message: unknown) => Promise<unknown>>;
} {
  const listeners: Array<(message: unknown) => Promise<unknown>> = [];
  return {
    listeners,
    addMessageListener: (listener) => listeners.push(listener),
    loadRule: vi.fn(async () => ({ id: 'general', label: '通用' })),
    scan: vi.fn(() => [document.querySelector('p') as HTMLElement]),
    translate: vi.fn(async ({ segments }: TranslationRequest) => segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` }))),
    cancel: vi.fn(async () => undefined),
    getConfig: vi.fn(async () => ({ preferences: { targetLanguage: 'zh-Hant', displayMode: 'translation', translationPosition: 'before' as const, scanScope: 'whole-page' as const }, activeEngineId: 'google', availableEngines: [] })),
    getPageLanguage: vi.fn(() => document.documentElement.lang),
    showSelectionText: vi.fn(),
    schedule: vi.fn(async (items, worker) => {
      const failures = [];
      for (const item of items) try { await worker(item); } catch (error) { failures.push({ item, error }); }
      return failures;
    }),
    hasWaiting: vi.fn(() => false),
    renderLoading: vi.fn(),
    beginRender: vi.fn((paragraph) => ({ taskId: `render:${paragraph.id}`, expectedVersion: paragraph.version })),
    renderTranslation: vi.fn(),
    renderError: vi.fn(),
    restore: vi.fn(),
    cleanupPage: vi.fn(),
    startObserver: vi.fn(),
    stopObserver: vi.fn(),
    report: vi.fn(),
  };
}

describe('网页翻译控制器', () => {
  let dependencies: ReturnType<typeof createDependencies>;

  beforeEach(() => {
    document.body.innerHTML = '<main><p>Hello world</p></main>';
    dependencies = createDependencies();
    createContentController(dependencies).register();
  });

  it('10 个短段在 content 侧组成 8+2 两个 API 批请求', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 10 }, (_, index) => `<p>paragraph ${index}</p>`).join('')}</main>`;
    vi.mocked(dependencies.scan).mockReturnValue([...document.querySelectorAll('p')] as HTMLElement[]);
    vi.mocked(dependencies.translate).mockImplementation(async ({ segments }) => segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` })));
    await dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'de' });
    expect(dependencies.translate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dependencies.translate).mock.calls.map(([request]) => request.segments.length)).toEqual([8, 2]);
  });

  it('字符边界按 6000 字符切批且不拆段', async () => {
    document.body.innerHTML = `<main><p>${'a'.repeat(4000)}</p><p>${'b'.repeat(2000)}</p><p>c</p></main>`;
    vi.mocked(dependencies.scan).mockReturnValue([...document.querySelectorAll('p')] as HTMLElement[]);
    await dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'de' });
    expect(vi.mocked(dependencies.translate).mock.calls.map(([request]) => request.segments.map((segment) => segment.text.length))).toEqual([[4000, 2000], [1]]);
  });

  it('同一批部分结果缺失时按 ID 渲染成功项并标记缺失项', async () => {
    document.body.innerHTML = '<main><p>first</p><p>second</p></main>';
    vi.mocked(dependencies.scan).mockReturnValue([...document.querySelectorAll('p')] as HTMLElement[]);
    vi.mocked(dependencies.translate).mockImplementation(async ({ segments }) => [{ id: segments[1].id, text: '第二段' }]);
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.renderTranslation).toHaveBeenCalledOnce();
    expect(dependencies.renderTranslation).toHaveBeenCalledWith(expect.objectContaining({ sourceText: 'second' }), '第二段', expect.anything());
    expect(dependencies.renderError).toHaveBeenCalledWith(expect.objectContaining({ sourceText: 'first' }), '翻译失败，请重试');
  });

  it('调度器最多并发三个真实批次', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 32 }, (_, index) => `<p>p${index}</p>`).join('')}</main>`;
    vi.mocked(dependencies.scan).mockReturnValue([...document.querySelectorAll('p')] as HTMLElement[]);
    let active = 0; let peak = 0;
    vi.mocked(dependencies.schedule).mockImplementation(async (items, worker) => {
      const failures: Array<{ item: typeof items[number]; error: unknown }> = [];
      let cursor = 0;
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (cursor < items.length) {
          const item = items[cursor++]; active += 1; peak = Math.max(peak, active);
          try { await worker(item); } catch (error) { failures.push({ item, error }); } finally { active -= 1; }
        }
      }));
      return failures;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(dependencies.translate).mockImplementation(async ({ segments }) => {
      await gate; return segments.map((segment) => ({ id: segment.id, text: segment.text }));
    });
    const pending = dependencies.listeners[0]({ type: 'translate-page' });
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(3));
    expect(peak).toBe(3);
    release(); await pending;
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('初始仅注册轻量消息监听，不加载规则、不扫描或启动 observer', () => {
    expect(dependencies.listeners).toHaveLength(1);
    expect(dependencies.loadRule).not.toHaveBeenCalled();
    expect(dependencies.scan).not.toHaveBeenCalled();
    expect(dependencies.startObserver).not.toHaveBeenCalled();
  });

  it('translate 首次启动闭环并传递范围、语言和模式', async () => {
    await dependencies.listeners[0]({
      type: 'translate-page',
      scope: 'whole-page',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      mode: 'translation-only',
    });

    expect(dependencies.loadRule).toHaveBeenCalledOnce();
    expect(dependencies.scan).toHaveBeenCalledWith(expect.anything(), 'whole-page');
    expect(dependencies.startObserver).toHaveBeenCalledOnce();
    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      segments: [{ id: expect.any(String), text: 'Hello world' }],
    }));
    expect(dependencies.schedule).toHaveBeenCalledOnce();
    expect(dependencies.renderTranslation).toHaveBeenCalledWith(
      expect.anything(),
      '译:Hello world',
      expect.objectContaining({ mode: 'translation-only', taskId: 'render:paragraph-1', expectedVersion: 1 }),
    );
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'complete', completed: 1, total: 1 }));
  });

  it('toggle 在已翻译时恢复，在未翻译时启动', async () => {
    await dependencies.listeners[0]({ type: 'toggle-page-translation' });
    await dependencies.listeners[0]({ type: 'toggle-page-translation' });
    expect(dependencies.scan).toHaveBeenCalledOnce();
    expect(dependencies.restore).toHaveBeenCalledOnce();
    expect(dependencies.stopObserver).toHaveBeenCalledOnce();
  });

  it('新翻译会话先恢复旧 translation-only DOM 再扫描调度', async () => {
    await dependencies.listeners[0]({ type: 'translate-page', mode: 'translation-only' });
    vi.mocked(dependencies.restore).mockClear();
    vi.mocked(dependencies.scan).mockClear();
    await dependencies.listeners[0]({ type: 'translate-page', mode: 'bilingual' });
    expect(dependencies.restore).toHaveBeenCalledWith(expect.objectContaining({ id: 'paragraph-1' }));
    expect(dependencies.restore).toHaveBeenCalledBefore(vi.mocked(dependencies.scan));
  });

  it('无参数快捷入口读取保存配置', async () => {
    document.documentElement.lang = 'zh-TW';
    await dependencies.listeners[0]({ type: 'toggle-page-translation' });
    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({ sourceLanguage: 'zh-Hant', targetLanguage: 'en' }));
    expect(dependencies.scan).toHaveBeenCalledWith(expect.anything(), 'whole-page');
    expect(dependencies.renderTranslation).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ mode: 'translation-only', placement: 'before' }));
  });

  it('auto 目标先按 Chrome 配置解析，再避开页面语言冲突', async () => {
    document.documentElement.lang = 'en-US';
    vi.mocked(dependencies.getConfig).mockResolvedValue({ preferences: { targetLanguage: 'auto', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content' }, activeEngineId: 'google', availableEngines: [] });
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({ sourceLanguage: 'en', targetLanguage: 'zh-Hans' }));
  });

  it('运行时规范化 documentElement.lang 后再选择非同语种目标', async () => {
    document.documentElement.lang = '  EN-us  ';
    vi.mocked(dependencies.getConfig).mockResolvedValue({ preferences: { targetLanguage: 'en', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content' }, activeEngineId: 'google', availableEngines: [] });

    await dependencies.listeners[0]({ type: 'translate-page' });

    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({ sourceLanguage: 'en', targetLanguage: 'zh-Hans' }));
  });

  it('请求发出前捕获 render token，源文本变化后旧结果不可渲染', async () => {
    let resolve!: (value: Array<{ id: string; text: string }>) => void;
    vi.mocked(dependencies.translate).mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'de' });
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledOnce());
    expect(dependencies.beginRender).toHaveBeenCalledOnce();
    const paragraph = vi.mocked(dependencies.beginRender).mock.calls[0][0];
    paragraph.version += 1;
    resolve([{ id: paragraph.id, text: 'late' }]);
    await pending;
    expect(dependencies.renderTranslation).toHaveBeenCalledWith(paragraph, 'late', expect.objectContaining({ expectedVersion: 1 }));
  });

  it('动态新增和原文失效按当前会话配置重新翻译且受代际保护', async () => {
    await dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'ja' });
    const observer = vi.mocked(dependencies.startObserver).mock.calls[0][3];
    const added = document.createElement('p'); added.textContent = 'dynamic'; document.body.append(added);
    await observer({ added: [added], invalidated: [] });
    expect(dependencies.renderLoading).toHaveBeenCalledWith(expect.objectContaining({ sourceText: 'dynamic' }));
    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: 'ja', segments: [expect.objectContaining({ text: 'dynamic' })] }));

    added.textContent = 'changed';
    const record = vi.mocked(dependencies.renderLoading).mock.calls.at(-1)![0];
    await observer({ added: [], invalidated: [record] });
    expect(dependencies.restore).toHaveBeenCalledWith(record);
    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({ segments: [expect.objectContaining({ text: 'changed' })] }));
  });

  it('任务启动时固定 engineId，动态段落和 retry 沿用原引擎', async () => {
    await dependencies.listeners[0]({ type: 'translate-page', engineId: 'bing', targetLanguage: 'ja' });
    const observer = vi.mocked(dependencies.startObserver).mock.calls[0][3];
    const added = document.createElement('p'); added.textContent = 'dynamic'; document.body.append(added);
    await observer({ added: [added], invalidated: [] });
    await dependencies.listeners[0]({ type: 'retry-page-translation' });

    expect(vi.mocked(dependencies.translate).mock.calls.map(([request]) => request.engineId)).toEqual(['bing', 'bing', 'bing']);
    expect(dependencies.report).toHaveBeenCalledWith(expect.objectContaining({ engineId: 'bing' }));
  });

  it('observer 空变更批次不覆盖已完成进度', async () => {
    await dependencies.listeners[0]({ type: 'translate-page' });
    const reportsBefore = vi.mocked(dependencies.report).mock.calls.length;
    const observer = vi.mocked(dependencies.startObserver).mock.calls[0][3];
    await observer({ added: [], invalidated: [], removed: [] });
    expect(dependencies.report).toHaveBeenCalledTimes(reportsBefore);
  });

  it('初始离屏段落后来进入视口并完成时更新 complete 进度', async () => {
    let deferredWorker!: () => Promise<void>;
    let waiting = true;
    vi.mocked(dependencies.hasWaiting).mockImplementation(() => waiting);
    vi.mocked(dependencies.schedule).mockImplementation(async (items, worker) => {
      deferredWorker = async () => { waiting = false; await worker(items.flat()); };
      return [];
    });

    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.report).toHaveBeenLastCalledWith({ status: 'translating', completed: 0, failed: 0, total: 1, engineId: 'google' });

    await deferredWorker();

    expect(dependencies.report).toHaveBeenLastCalledWith({ status: 'complete', completed: 1, failed: 0, total: 1, engineId: 'google' });
    const finalReports = vi.mocked(dependencies.report).mock.calls.filter(([progress]) => progress.completed === 1);
    expect(finalReports).toHaveLength(1);
  });

  it('仅消费明确标记的可信菜单选区消息', async () => {
    await dependencies.listeners[0]({ type: 'translate-selection', source: 'context-menu', text: 'menu text' });
    await dependencies.listeners[0]({ type: 'translate-selection', text: 'forged' });
    expect(dependencies.showSelectionText).toHaveBeenCalledOnce();
    expect(dependencies.showSelectionText).toHaveBeenCalledWith('menu text');
  });

  it('失败显示中文错误并允许 retry', async () => {
    vi.mocked(dependencies.translate)
      .mockRejectedValueOnce(new Error('网络异常'))
      .mockResolvedValueOnce([{ id: 'paragraph-1', text: '重试成功' }]);
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.renderError).toHaveBeenCalledWith(expect.anything(), '网络异常');
    expect(dependencies.report).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', failed: 1 }));

    await dependencies.listeners[0]({ type: 'retry-page-translation' });
    expect(dependencies.translate).toHaveBeenCalledTimes(2);
  });

  it('混合成功失败时逐段收口并报告 partial', async () => {
    document.body.innerHTML = '<p>good</p><p>bad</p>';
    vi.mocked(dependencies.scan).mockReturnValue([...document.querySelectorAll('p')] as HTMLElement[]);
    vi.mocked(dependencies.translate).mockImplementation(async ({ segments }) => {
      if (segments[0].text === 'bad') throw new Error('网络异常');
      return [{ id: segments[0].id, text: '成功' }];
    });
    await dependencies.listeners[0]({ type: 'translate-page' });

    expect(dependencies.renderTranslation).toHaveBeenCalledTimes(1);
    expect(dependencies.renderError).toHaveBeenCalledTimes(1);
    expect(dependencies.report).toHaveBeenLastCalledWith({ status: 'partial', completed: 1, failed: 1, total: 2, engineId: 'google' });
  });

  it('restore 恢复所有段落并停止 observer', async () => {
    await dependencies.listeners[0]({ type: 'translate-page' });
    await dependencies.listeners[0]({ type: 'restore-page' });
    expect(dependencies.restore).toHaveBeenCalledOnce();
    expect(dependencies.stopObserver).toHaveBeenCalledOnce();
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'idle' }));
  });

  it('新翻译和 restore 在等待取消旧 task 前先销毁旧可见性队列', async () => {
    await dependencies.listeners[0]({ type: 'translate-page' });
    vi.mocked(dependencies.stopObserver).mockClear();
    vi.mocked(dependencies.cancel).mockClear();
    const order: string[] = [];
    vi.mocked(dependencies.stopObserver).mockImplementation(() => { order.push('disconnect'); });
    vi.mocked(dependencies.cancel).mockImplementation(async () => { order.push('cancel'); });

    await dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'de' });
    expect(order.slice(0, 2)).toEqual(['disconnect', 'cancel']);

    order.length = 0;
    await dependencies.listeners[0]({ type: 'restore-page' });
    expect(order.slice(0, 2)).toEqual(['disconnect', 'cancel']);
  });

  it('新命令配置仍在读取时已断开旧队列并发出旧 task 取消', async () => {
    await dependencies.listeners[0]({ type: 'translate-page' });
    vi.mocked(dependencies.stopObserver).mockClear();
    vi.mocked(dependencies.cancel).mockClear();
    vi.mocked(dependencies.getConfig).mockReturnValueOnce(new Promise(() => undefined));

    void dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'de' });
    await Promise.resolve();

    expect(dependencies.stopObserver).toHaveBeenCalledOnce();
    expect(dependencies.cancel).toHaveBeenCalledWith('page-1');
    expect(dependencies.stopObserver).toHaveBeenCalledBefore(vi.mocked(dependencies.cancel));
  });

  it('旧可见性 worker 在代际失效后才运行时不得发送 API', async () => {
    let oldWorker!: () => Promise<void>;
    vi.mocked(dependencies.schedule)
      .mockImplementationOnce(async (items, worker) => { oldWorker = () => worker(items.flat()); return []; })
      .mockImplementationOnce(async (items, worker) => {
        for (const item of items) await worker(item);
        return [];
      });
    await dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'ja' });
    await dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'de' });
    vi.mocked(dependencies.translate).mockClear();

    await oldWorker();

    expect(dependencies.translate).not.toHaveBeenCalled();
  });

  it('dispose 失效当前代际、销毁旧队列并取消旧 task', async () => {
    const controller = createContentController(dependencies);
    await controller.onMessage({ type: 'translate-page' });
    vi.mocked(dependencies.stopObserver).mockClear();
    vi.mocked(dependencies.cancel).mockClear();

    await controller.dispose();

    expect(dependencies.stopObserver).toHaveBeenCalledOnce();
    expect(dependencies.cancel).toHaveBeenCalledWith(expect.stringMatching(/^page-/));
  });

  it('动态移除已跟踪段落后从进度总量删除且无限滚动不累积', async () => {
    await dependencies.listeners[0]({ type: 'translate-page' });
    const observer = vi.mocked(dependencies.startObserver).mock.calls[0][3];
    for (let index = 0; index < 20; index += 1) {
      const element = document.createElement('p'); element.textContent = `dynamic ${index}`; document.body.append(element);
      await observer({ added: [element], invalidated: [] });
      const paragraph = vi.mocked(dependencies.renderLoading).mock.calls.at(-1)![0];
      element.remove();
      await observer({ added: [], invalidated: [], removed: [paragraph] });
    }
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1 }));
  });

  it('新任务代际取消旧任务并丢弃旧结果', async () => {
    let resolveOld!: (value: Array<{ id: string; text: string }>) => void;
    vi.mocked(dependencies.translate)
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce([{ id: 'paragraph-1', text: '新结果' }]);

    const oldTask = dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'ja' });
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledOnce());
    await dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'zh-Hans' });
    resolveOld([{ id: 'paragraph-1', text: '旧结果' }]);
    await oldTask;

    expect(dependencies.cancel).toHaveBeenCalled();
    expect(dependencies.renderTranslation).toHaveBeenCalledWith(expect.anything(), '新结果', expect.anything());
    expect(dependencies.renderTranslation).not.toHaveBeenCalledWith(expect.anything(), '旧结果', expect.anything());
  });

  it('命令到达时立即分配代际，较慢的旧配置读取不能反超新命令', async () => {
    let resolveOldConfig!: (value: Awaited<ReturnType<ContentControllerDependencies['getConfig']>>) => void;
    vi.mocked(dependencies.getConfig)
      .mockReturnValueOnce(new Promise((resolve) => { resolveOldConfig = resolve; }))
      .mockResolvedValueOnce({ preferences: { targetLanguage: 'de', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content' }, activeEngineId: 'google', availableEngines: [] });

    const oldCommand = dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'ja' });
    const newCommand = dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'de' });
    await newCommand;
    resolveOldConfig({ preferences: { targetLanguage: 'ja', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content' }, activeEngineId: 'google', availableEngines: [] });
    await oldCommand;

    expect(dependencies.translate).toHaveBeenCalledOnce();
    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: 'de', taskId: 'page-2' }));
  });
});

describe('运行时可见性接线', () => {
  it('IO 命中前不调用 worker，命中后把多个小 root 合成短批', async () => {
    const original = globalThis.IntersectionObserver;
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    class FakeIntersectionObserver {
      constructor(callback: typeof notify) { notify = callback; }
      observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: FakeIntersectionObserver });
    try {
      const dependencies = createRuntimeDependencies();
      const first = document.createElement('p'); first.textContent = 'first'; document.body.append(first);
      const second = document.createElement('p'); second.textContent = 'second'; document.body.append(second);
      const store = new (await import('../../src/content/paragraph-store')).ParagraphStore();
      const records = [store.getOrCreate(first), store.getOrCreate(second)];
      const worker = vi.fn(async () => undefined);
      const scheduled = dependencies.schedule(records.map((record) => [record]), worker);
      expect(worker).not.toHaveBeenCalled();
      notify(records.map((record) => ({ target: record.element, isIntersecting: true })));
      await scheduled;
      await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
      expect(worker).toHaveBeenCalledWith(records);
      dependencies.stopObserver();
    } finally {
      Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: original });
    }
  });

  it('队列销毁后旧 IO 回调不能再调用 worker', async () => {
    const original = globalThis.IntersectionObserver;
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    class FakeIntersectionObserver {
      constructor(callback: typeof notify) { notify = callback; }
      observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: FakeIntersectionObserver });
    try {
      const dependencies = createRuntimeDependencies();
      const element = document.createElement('p'); element.textContent = 'stale'; document.body.append(element);
      const store = new (await import('../../src/content/paragraph-store')).ParagraphStore();
      const record = store.getOrCreate(element);
      const worker = vi.fn(async () => undefined);
      const scheduled = dependencies.schedule([[record]], worker);

      dependencies.stopObserver();
      notify([{ target: element, isIntersecting: true }]);
      await scheduled;

      expect(worker).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: original });
    }
  });
});
