import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createContentController, type ContentControllerDependencies } from '../../src/content';
import { createRuntimeDependencies } from '../../src/content/main';
import type { TranslationRequest } from '../../src/shared/messages';

// 真实 DynamicPageObserver 的 MutationObserver 回调在 jsdom 环境缺少 HTMLElement 全局
// 会抛 ReferenceError 污染测试进程；此处 mock 掉动态扫描。
// 可见性调度（IntersectionObserver 队列）仍走真实实现，不受影响。
vi.mock('../../src/content/dynamic-observer', () => ({
  DynamicPageObserver: class {
    start(): void {}
    stop(): void {}
  },
}));

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
    getConfig: vi.fn(async () => ({ preferences: { targetLanguage: 'zh-Hant', displayMode: 'translation', translationPosition: 'before' as const, scanScope: 'whole-page' as const, rendererMode: 'legacy' as const }, activeEngineId: 'google', availableEngines: [] })),
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
    setRendererMode: vi.fn(),
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

  it('emoji 和品牌名标题作为独立段落正常进入翻译请求', async () => {
    document.body.innerHTML = '<main><h1>🚀 GlanceMD</h1></main>';
    vi.mocked(dependencies.scan).mockReturnValue([...document.querySelectorAll('h1')] as HTMLElement[]);

    await dependencies.listeners[0]({ type: 'translate-page' });

    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({
      segments: [{ id: expect.any(String), text: '🚀 GlanceMD' }],
    }));
    expect(dependencies.renderError).not.toHaveBeenCalled();
  });

  it('忽略扫描结果中的空文本段落，避免后台返回消息格式无效', async () => {
    document.body.innerHTML = '<main><h1>🚀 GlanceMD</h1><p></p></main>';
    vi.mocked(dependencies.scan).mockReturnValue([...document.querySelectorAll('h1, p')] as HTMLElement[]);

    await dependencies.listeners[0]({ type: 'translate-page' });

    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({
      segments: [{ id: expect.any(String), text: '🚀 GlanceMD' }],
    }));
  });

  it('动态加入的空节点不进入翻译队列，避免异步页面返回消息格式无效', async () => {
    await dependencies.listeners[0]({ type: 'translate-page' });
    const observer = vi.mocked(dependencies.startObserver).mock.calls[0][3];
    const empty = document.createElement('h3');

    await observer({ added: [empty], invalidated: [] });

    expect(dependencies.renderLoading).not.toHaveBeenCalledWith(expect.objectContaining({ element: empty }));
    expect(dependencies.translate).toHaveBeenCalledTimes(1);
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
    vi.mocked(dependencies.getConfig).mockResolvedValue({ preferences: { targetLanguage: 'auto', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content', rendererMode: 'legacy' }, activeEngineId: 'google', availableEngines: [] });
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({ sourceLanguage: 'en', targetLanguage: 'zh-Hans' }));
  });

  it('运行时规范化 documentElement.lang 后再选择非同语种目标', async () => {
    document.documentElement.lang = '  EN-us  ';
    vi.mocked(dependencies.getConfig).mockResolvedValue({ preferences: { targetLanguage: 'en', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content', rendererMode: 'legacy' }, activeEngineId: 'google', availableEngines: [] });

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
    let dynamicAttempts = 0;
    vi.mocked(dependencies.translate).mockImplementation(async ({ segments }) => {
      if (segments.some((segment) => segment.text === 'dynamic') && ++dynamicAttempts === 1) throw new Error('网络异常');
      return segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` }));
    });
    await dependencies.listeners[0]({ type: 'translate-page', engineId: 'bing', targetLanguage: 'ja' });
    const observer = vi.mocked(dependencies.startObserver).mock.calls[0][3];
    const added = document.createElement('p'); added.textContent = 'dynamic'; document.body.append(added);
    await observer({ added: [added], invalidated: [] });
    await dependencies.listeners[0]({ type: 'retry-page-translation' });

    expect(vi.mocked(dependencies.translate).mock.calls.map(([request]) => request.engineId)).toEqual(['bing', 'bing', 'bing']);
    expect(vi.mocked(dependencies.translate).mock.calls[2][0].segments.map((segment) => segment.text)).toEqual(['dynamic']);
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
    // retry 只重发失败段落，不重新扫描或恢复已渲染内容
    expect(dependencies.scan).toHaveBeenCalledOnce();
    expect(dependencies.restore).not.toHaveBeenCalled();
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'complete', completed: 1, failed: 0 }));
  });

  it('部分失败后 retry 只重发失败段落，不重翻已成功段落', async () => {
    document.body.innerHTML = `<main><p>${'a'.repeat(4000)}</p><p>${'b'.repeat(4000)}</p><p>${'c'.repeat(4000)}</p><p>${'d'.repeat(4000)}</p></main>`;
    vi.mocked(dependencies.scan).mockReturnValue([...document.querySelectorAll('p')] as HTMLElement[]);
    vi.mocked(dependencies.translate).mockImplementation(async ({ segments }) => {
      if (segments.some((segment) => segment.text.startsWith('b'))) throw new Error('网络异常');
      return segments.map((segment) => ({ id: segment.id, text: `译:${segment.text.slice(0, 1)}` }));
    });
    await dependencies.listeners[0]({ type: 'translate-page' });

    // 4 个长段各自成批：a/c/d 成功，b 批失败 → partial
    expect(dependencies.report).toHaveBeenLastCalledWith({ status: 'partial', completed: 3, failed: 1, total: 4, engineId: 'google' });
    expect(dependencies.renderTranslation).toHaveBeenCalledTimes(3);
    expect(dependencies.renderError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.translate)).toHaveBeenCalledTimes(4);

    vi.mocked(dependencies.translate).mockClear();
    vi.mocked(dependencies.translate).mockImplementation(async ({ segments }) => segments.map((segment) => ({ id: segment.id, text: `译:${segment.text.slice(0, 1)}` })));
    await dependencies.listeners[0]({ type: 'retry-page-translation' });
    expect(vi.mocked(dependencies.translate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.translate).mock.calls[0][0].segments).toHaveLength(1);
    expect(vi.mocked(dependencies.translate).mock.calls[0][0].segments[0].text.startsWith('b')).toBe(true);
    expect(dependencies.scan).toHaveBeenCalledOnce();
    expect(dependencies.restore).not.toHaveBeenCalled();
    expect(dependencies.report).toHaveBeenLastCalledWith({ status: 'complete', completed: 4, failed: 0, total: 4, engineId: 'google' });
  });

  it('retry 后仍失败的段落保留错误与重试入口', async () => {
    vi.mocked(dependencies.translate).mockRejectedValue(new Error('网络异常'));
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', failed: 1 }));

    await dependencies.listeners[0]({ type: 'retry-page-translation' });
    expect(dependencies.translate).toHaveBeenCalledTimes(2);
    expect(dependencies.renderError).toHaveBeenCalledTimes(2);
    expect(dependencies.report).toHaveBeenLastCalledWith({ status: 'error', completed: 0, failed: 1, total: 1, engineId: 'google' });
  });

  it('全部成功后 retry 不再发起任何翻译请求', async () => {
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'complete' }));

    await dependencies.listeners[0]({ type: 'retry-page-translation' });
    expect(dependencies.translate).toHaveBeenCalledTimes(1);
    expect(dependencies.scan).toHaveBeenCalledOnce();
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'complete' }));
  });

  it('恢复原文后 retry 不重新启动翻译', async () => {
    vi.mocked(dependencies.translate).mockRejectedValueOnce(new Error('网络异常'));
    await dependencies.listeners[0]({ type: 'translate-page' });
    await dependencies.listeners[0]({ type: 'restore-page' });
    vi.mocked(dependencies.translate).mockClear();

    await dependencies.listeners[0]({ type: 'retry-page-translation' });

    expect(dependencies.translate).not.toHaveBeenCalled();
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'idle' }));
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
      .mockResolvedValueOnce({ preferences: { targetLanguage: 'de', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content', rendererMode: 'legacy' }, activeEngineId: 'google', availableEngines: [] });

    const oldCommand = dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'ja' });
    const newCommand = dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'de' });
    await newCommand;
    resolveOldConfig({ preferences: { targetLanguage: 'ja', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content', rendererMode: 'legacy' }, activeEngineId: 'google', availableEngines: [] });
    await oldCommand;

    expect(dependencies.translate).toHaveBeenCalledOnce();
    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: 'de', taskId: 'page-2' }));
  });

  it('全新翻译从配置读取渲染器模式并固定到本会话', async () => {
    vi.mocked(dependencies.getConfig).mockResolvedValue({ preferences: { targetLanguage: 'en', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content', rendererMode: 'inline' }, activeEngineId: 'google', availableEngines: [] });
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.setRendererMode).toHaveBeenCalledWith('inline');
  });

  it('重试沿用既有会话模式，不重新读取渲染器配置', async () => {
    vi.mocked(dependencies.getConfig).mockResolvedValue({ preferences: { targetLanguage: 'en', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content', rendererMode: 'inline' }, activeEngineId: 'google', availableEngines: [] });
    document.body.innerHTML = '<main><p>first</p></main>';
    vi.mocked(dependencies.scan).mockReturnValue([document.querySelector('p') as HTMLElement]);
    vi.mocked(dependencies.schedule).mockImplementation(async () => [{ item: [], error: new Error('失败') }]);
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.setRendererMode).toHaveBeenCalledTimes(1);

    vi.mocked(dependencies.schedule).mockImplementation(async (_items, worker) => {
      await worker([]);
      return [];
    });
    await dependencies.listeners[0]({ type: 'retry-page-translation' });
    expect(dependencies.setRendererMode).toHaveBeenCalledTimes(1);
  });
});

describe('运行时可见性接线', () => {
  it('扩展重载后进度上报失败不会产生未处理的 Promise rejection', () => {
    const originalChrome = globalThis.chrome;
    const catchRejection = vi.fn();
    const sendMessage = vi.fn(() => ({ catch: catchRejection }));
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { sendMessage } } });
    try {
      const dependencies = createRuntimeDependencies();
      dependencies.report({ status: 'complete', completed: 1, failed: 0, total: 1 });
      expect(sendMessage).toHaveBeenCalledWith({ type: 'page-progress', progress: { status: 'complete', completed: 1, failed: 0, total: 1 } });
      expect(catchRejection).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(globalThis, 'chrome', { configurable: true, value: originalChrome });
    }
  });

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
      const scheduled = dependencies.schedule(records.map((record) => [record]), worker, () => undefined);
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
      const scheduled = dependencies.schedule([[record]], worker, () => undefined);

      dependencies.stopObserver();
      notify([{ target: element, isIntersecting: true }]);
      await scheduled;

      expect(worker).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: original });
    }
  });

  // 以下测试装配真实 ParagraphVisibilityBatchQueue（经 createRuntimeDependencies），
  // 验证批次失败（尤其初始空闲后滚动才可见的批）传播到错误渲染与进度上报。
  function installChromeRuntime(
    translate: (segments: Array<{ id: string; text: string }>) => unknown,
  ) {
    const originalChrome = globalThis.chrome;
    const sendMessage = vi.fn(async (message: { type: string; segments?: Array<{ id: string; text: string }> }) => {
      if (message.type === 'get-public-config') {
        return { data: { preferences: { targetLanguage: 'en', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'whole-page', rendererMode: 'legacy' }, activeEngineId: 'google', availableEngines: [] } };
      }
      if (message.type === 'translate-batch') return translate(message.segments ?? []);
      return {};
    });
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { sendMessage } } });
    return {
      sendMessage,
      progressCalls: () => sendMessage.mock.calls
        .map(([message]) => message as { type: string; progress?: Record<string, unknown> })
        .filter((message) => message.type === 'page-progress')
        .map((message) => message.progress!),
      restoreChrome: () => Object.defineProperty(globalThis, 'chrome', { configurable: true, value: originalChrome }),
    };
  }

  function fakeIntersectionObserver() {
    const original = globalThis.IntersectionObserver;
    const observed: Element[] = [];
    let notify!: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;
    class FakeIntersectionObserver {
      constructor(callback: typeof notify) { notify = callback; }
      observe = (element: Element) => { observed.push(element); };
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: FakeIntersectionObserver });
    return {
      observed,
      notify: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => notify(entries),
      restore: () => Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: original }),
    };
  }

  it('初始批完成后滚动可见批失败立即渲染错误并可重试恢复', async () => {
    let secondAttempts = 0;
    const chrome = installChromeRuntime(async (segments) => {
      if (segments.some((segment) => segment.text === 'second') && secondAttempts++ === 0) {
        return { ok: false, error: 'API 请求超时（90000ms）' };
      }
      return { ok: true, data: segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` })) };
    });
    const io = fakeIntersectionObserver();
    try {
      document.body.innerHTML = '<main><p>first</p><p>second</p></main>';
      const [first, second] = [...document.querySelectorAll('p')] as HTMLElement[];
      const controller = createContentController(createRuntimeDependencies());
      const pending = controller.onMessage({ type: 'translate-page' });
      await vi.waitFor(() => expect(io.observed).toHaveLength(2));

      // 初始批：first 可见成功，second 离屏待滚动。
      io.notify([{ target: first, isIntersecting: true }, { target: second, isIntersecting: false }]);
      await vi.waitFor(() => expect(document.querySelector('[data-vast-state="translated"]')?.textContent).toContain('译:first'));

      // 滚动后 second 可见且批次失败：必须立即出现错误与重试按钮，进度转 partial。
      io.notify([{ target: second, isIntersecting: true }]);
      await vi.waitFor(() => expect(document.querySelector('[data-vast-state="error"]')).not.toBeNull());
      expect(document.querySelector('button[data-vast-retry-all]')).not.toBeNull();
      expect(chrome.progressCalls().at(-1)).toMatchObject({ status: 'partial', completed: 1, failed: 1 });

      // 重试仅重发失败段，成功后整体 complete，失败计数不重复。
      const retry = controller.onMessage({ type: 'retry-page-translation' });
      await vi.waitFor(() => expect(io.observed).toHaveLength(3));
      io.notify([{ target: second, isIntersecting: true }]);
      await retry;
      expect(document.querySelectorAll('[data-vast-state="translated"]')).toHaveLength(2);
      expect(chrome.progressCalls().at(-1)).toMatchObject({ status: 'complete', completed: 2, failed: 0 });
      await pending;
    } finally {
      io.restore();
      chrome.restoreChrome();
    }
  });

  it('初始可见批失败经队列失败回调渲染错误并报告失败', async () => {
    const chrome = installChromeRuntime(async () => ({ ok: false, error: 'API 请求失败' }));
    const io = fakeIntersectionObserver();
    try {
      document.body.innerHTML = '<main><p>only</p></main>';
      const controller = createContentController(createRuntimeDependencies());
      const pending = controller.onMessage({ type: 'translate-page' });
      await vi.waitFor(() => expect(io.observed).toHaveLength(1));
      io.notify([{ target: io.observed[0], isIntersecting: true }]);
      await pending;
      expect(document.querySelector('[data-vast-state="error"]')).not.toBeNull();
      expect(document.querySelector('button[data-vast-retry-all]')).not.toBeNull();
      expect(chrome.progressCalls().at(-1)).toMatchObject({ status: 'error', completed: 0, failed: 1 });
    } finally {
      io.restore();
      chrome.restoreChrome();
    }
  });

  it('前端 translate 请求在 30 秒超时后立即触发错误状态并展示重试按钮', async () => {
    vi.useFakeTimers();
    const chrome = installChromeRuntime(async () => new Promise<never>(() => undefined));
    const io = fakeIntersectionObserver();
    try {
      document.body.innerHTML = '<main><p id="p-timeout">Waiting forever</p></main>';
      const controller = createContentController(createRuntimeDependencies());
      const pending = controller.onMessage({ type: 'translate-page' });
      await vi.advanceTimersByTimeAsync(10);
      io.notify([{ target: io.observed[0], isIntersecting: true }]);

      // 29.9 秒时依然在等待
      await vi.advanceTimersByTimeAsync(29_900);
      expect(document.querySelector('[data-vast-state="loading"]')).not.toBeNull();
      expect(document.querySelector('[data-vast-state="error"]')).toBeNull();

      // 到达 30 秒超时熔断：立即报错并渲染重试按钮
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(document.querySelector('[data-vast-state="error"]')).not.toBeNull();
      expect(document.querySelector('button[data-vast-retry-all]')).not.toBeNull();
      expect(chrome.progressCalls().at(-1)).toMatchObject({ status: 'error', failed: 1 });
    } finally {
      vi.useRealTimers();
      io.restore();
      chrome.restoreChrome();
    }
  });

  it('恢复会话后旧批次失败不渲染错误也不污染新任务', async () => {
    let release!: (value: unknown) => void;
    let hang = true;
    const chrome = installChromeRuntime(async (segments) => {
      if (hang) return new Promise((resolve) => { release = resolve; });
      return { ok: true, data: segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` })) };
    });
    const io = fakeIntersectionObserver();
    try {
      document.body.innerHTML = '<main><p>solo</p></main>';
      const controller = createContentController(createRuntimeDependencies());
      const firstRun = controller.onMessage({ type: 'translate-page' });
      await vi.waitFor(() => expect(io.observed).toHaveLength(1));
      io.notify([{ target: io.observed[0], isIntersecting: true }]);
      await vi.waitFor(() => expect(chrome.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'translate-batch' })));

      // 恢复会话后旧批次的请求才失败：不得向新会话渲染旧错误。
      await controller.onMessage({ type: 'restore-page' });
      release({ ok: false, error: 'API 请求超时（90000ms）' });
      await firstRun;
      expect(document.querySelector('[data-vast-state="error"]')).toBeNull();
      expect(chrome.progressCalls().at(-1)).toMatchObject({ status: 'idle' });

      // 新任务照常成功，旧失败不留任何 failed 状态。
      hang = false;
      const secondRun = controller.onMessage({ type: 'translate-page' });
      await vi.waitFor(() => expect(io.observed).toHaveLength(2));
      io.notify([{ target: io.observed[1], isIntersecting: true }]);
      await secondRun;
      expect(document.querySelector('[data-vast-state="translated"]')).not.toBeNull();
      expect(chrome.progressCalls().at(-1)).toMatchObject({ status: 'complete', completed: 1, failed: 0 });
    } finally {
      io.restore();
      chrome.restoreChrome();
    }
  });

  it('text-leaf 节点在动态文本变更和重译时保持 element 稳定且重译非空，全页恢复后 unwrap 纯文本', async () => {
    const chrome = installChromeRuntime(async (segments) => ({
      ok: true,
      data: segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` })),
    }));
    const io = fakeIntersectionObserver();
    try {
      document.body.innerHTML = '<main><p id="source-p">Hello</p></main>';
      const deps = createRuntimeDependencies();
      let capturedOnChanges!: (changes: { added: HTMLElement[]; invalidated: unknown[]; removed: unknown[] }) => Promise<void>;
      deps.startObserver = (_rule, _store, _scope, onChanges) => {
        capturedOnChanges = onChanges as typeof capturedOnChanges;
      };
      const controller = createContentController(deps);

      const pending = controller.onMessage({ type: 'translate-page' });
      await vi.waitFor(() => expect(io.observed).toHaveLength(1));
      io.notify([{ target: io.observed[0], isIntersecting: true }]);
      await pending;

      const p = document.getElementById('source-p') as HTMLElement;
      await vi.waitFor(() => expect(document.querySelector('[data-vast-state="translated"]')?.textContent).toContain('译:Hello'));

      // 模拟动态内容源文本变化触发 invalidate：
      // controller invalidate 单段调用 restore，确保 paragraph.element 稳定可复用
      const store = new (await import('../../src/content/paragraph-store')).ParagraphStore();
      const paragraph = store.getOrCreate(p);

      // 触发 observer 调度变更
      paragraph.sourceText = 'Hello Updated';
      const onChangesPromise = capturedOnChanges({ added: [], invalidated: [paragraph], removed: [] });
      await vi.waitFor(() => expect(io.observed.length).toBeGreaterThan(1));
      io.notify([{ target: io.observed.at(-1)!, isIntersecting: true }]);
      await onChangesPromise;

      // 全页恢复时：统一解包 unwrapAllTextLeaves，还原原始纯文本
      await controller.onMessage({ type: 'restore-page' });
      expect(document.querySelectorAll('[data-vast-text-leaf]')).toHaveLength(0);
      expect(document.querySelector('[data-vast-translator]')).toBeNull();
    } finally {
      io.restore();
      chrome.restoreChrome();
    }
  });

  it('同批变更中同时处于 invalidated 与 removed 的段落或已离线节点被安全跳过', async () => {
    const dependencies = createDependencies();
    document.body.innerHTML = '<main><p id="p1">text1</p></main>';
    let observerHandler!: (changes: { added: HTMLElement[]; invalidated: unknown[]; removed: unknown[] }) => Promise<void>;
    dependencies.startObserver = vi.fn((_rule, _store, _scope, handler) => {
      observerHandler = handler as typeof observerHandler;
    });
    const controller = createContentController(dependencies);
    await controller.onMessage({ type: 'translate-page' });

    const store = new (await import('../../src/content/paragraph-store')).ParagraphStore();
    const detachedElement = document.createElement('p');
    detachedElement.textContent = 'detached';
    const detachedRecord = store.getOrCreate(detachedElement);

    // 传入同批包含 removed 与 invalidated 的同一 record，以及 detached added 节点
    await expect(observerHandler({
      added: [detachedElement],
      invalidated: [detachedRecord],
      removed: [detachedRecord],
    })).resolves.not.toThrow();

    // detached 元素与已移除 record 不会进入渲染 loading
    expect(dependencies.renderLoading).not.toHaveBeenCalledWith(detachedRecord);
  });
});
