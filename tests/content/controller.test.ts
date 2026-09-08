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
  let renderTaskSeq = 0;
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
    // mock 与真实渲染器一致：beginRender 真实落写 currentTaskId，且每次调用 taskId 唯一，
    // 供控制器按 taskId+version 双重校验迟到结果；不得为适配 mock 而弱化校验。
    beginRender: vi.fn((paragraph) => {
      const taskId = `render:${paragraph.id}:${++renderTaskSeq}`;
      paragraph.currentTaskId = taskId;
      return { taskId, expectedVersion: paragraph.version };
    }),
    // 模拟真实渲染器：只接受与当前任务 token 完全匹配的结果（taskId + version 双重校验）。
    renderTranslation: vi.fn((paragraph, _text, options) => options.taskId === paragraph.currentTaskId && options.expectedVersion === paragraph.version),
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
      expect.objectContaining({ mode: 'translation-only', taskId: 'render:paragraph-1:1', expectedVersion: 1 }),
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

  it('渲染器拒绝当前 token（挂载失效）时明确错误收口，不永久停留在 translating', async () => {
    vi.mocked(dependencies.renderTranslation).mockReturnValue(false);
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.renderTranslation).toHaveBeenCalledOnce();
    // 当前 token 被拒绝说明挂载已失效：必须明确渲染错误并计入失败，
    // 段落不得永久停留在 loading/translating。
    expect(dependencies.renderError).toHaveBeenCalledOnce();
    expect(dependencies.report).toHaveBeenLastCalledWith({ status: 'error', completed: 0, failed: 1, total: 1, engineId: 'google' });
  });

  it('源节点被 observer 替换后晚到的旧批失败不污染 failedIds 且新节点成功完成', async () => {
    let rejectFirstTranslate!: (error: Error) => void;
    let translateCall = 0;

    vi.mocked(dependencies.translate).mockImplementation(async (request) => {
      translateCall += 1;
      if (translateCall === 1) {
        return new Promise((_, reject) => {
          rejectFirstTranslate = reject;
        });
      }
      return request.segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` }));
    });

    const pendingTranslate = dependencies.listeners[0]({ type: 'translate-page' });
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(1));

    const initialRecord = vi.mocked(dependencies.renderLoading).mock.calls[0][0];
    const initialElement = initialRecord.element;
    const observer = vi.mocked(dependencies.startObserver).mock.calls[0][3];

    // 模拟 DOM 替换：旧节点断开，新克隆节点挂载
    const clone = document.createElement('p');
    clone.textContent = 'hello cloned';
    initialElement.remove();
    document.body.append(clone);

    await observer({
      removed: [initialRecord],
      added: [clone],
      invalidated: [],
    });

    // 旧请求在后台失败（例如网络异常或服务端报错）
    rejectFirstTranslate(new Error('旧请求失败'));
    await pendingTranslate.catch(() => undefined);

    // 等待新节点的翻译完成
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(2));

    // 旧节点不应被调用 renderError，也不应污染 failedIds
    expect(dependencies.renderError).not.toHaveBeenCalledWith(initialRecord, expect.any(String));
    // 最终进度应由新节点成功收口：1 成功，0 失败，总计 1
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'complete',
      completed: 1,
      failed: 0,
      total: 1,
    }));
  });

  it('源节点被 observer 替换后晚到的旧批成功不计入完成且不污染新节点', async () => {
    let resolveFirstTranslate!: (value: Array<{ id: string; text: string }>) => void;
    let translateCall = 0;

    vi.mocked(dependencies.translate).mockImplementation(async (request) => {
      translateCall += 1;
      if (translateCall === 1) {
        return new Promise((resolve) => {
          resolveFirstTranslate = resolve;
        });
      }
      return request.segments.map((segment) => ({ id: segment.id, text: `新译:${segment.text}` }));
    });

    const pendingTranslate = dependencies.listeners[0]({ type: 'translate-page' });
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(1));

    const initialRecord = vi.mocked(dependencies.renderLoading).mock.calls[0][0];
    const initialElement = initialRecord.element;
    const observer = vi.mocked(dependencies.startObserver).mock.calls[0][3];

    // 模拟 DOM 替换
    const clone = document.createElement('p');
    clone.textContent = 'hello cloned 2';
    initialElement.remove();
    document.body.append(clone);

    await observer({
      removed: [initialRecord],
      added: [clone],
      invalidated: [],
    });

    // 旧请求迟到返回
    resolveFirstTranslate([{ id: initialRecord.id, text: '旧译文' }]);
    await pendingTranslate;

    // 等待新节点翻译完成
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(2));

    // 最终进度严格为新节点的 1 个完成
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'complete',
      completed: 1,
      failed: 0,
      total: 1,
    }));
  });

  it('observer 发现动态新增节点在异步请求挂起期间立即上报 translating', async () => {
    let resolveSecondTranslate!: (value: Array<{ id: string; text: string }>) => void;
    let translateCount = 0;

    vi.mocked(dependencies.translate).mockImplementation(async (request) => {
      translateCount += 1;
      if (translateCount === 1) {
        return request.segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` }));
      }
      return new Promise((resolve) => {
        resolveSecondTranslate = resolve;
      });
    });

    // 初始页面翻译完成
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'complete',
      completed: 1,
      total: 1,
    }));

    // observer 发现新增节点
    const observer = vi.mocked(dependencies.startObserver).mock.calls[0][3];
    const dynamicElement = document.createElement('p');
    dynamicElement.textContent = 'deferred dynamic';
    document.body.append(dynamicElement);

    const pendingObserver = observer({
      added: [dynamicElement],
      invalidated: [],
    });

    // 在 translate 挂起未完成阶段，因新增节点进入 paragraphs，应立即上报 translating (1, 0, total: 2)
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(2));
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'translating',
      completed: 1,
      failed: 0,
      total: 2,
    }));

    // 释放第二批 translate 结果
    const dynamicRecord = vi.mocked(dependencies.renderLoading).mock.calls.at(-1)![0];
    resolveSecondTranslate([{ id: dynamicRecord.id, text: '译:deferred dynamic' }]);
    await pendingObserver;

    // 最终收敛为 complete (2, 0, total: 2)
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'complete',
      completed: 2,
      failed: 0,
      total: 2,
    }));
  });

  it('批次在调度等待期间元素若全部断开连接则不发送空 translate 请求', async () => {
    let queuedWorker!: (items: unknown[]) => Promise<void>;
    vi.mocked(dependencies.schedule).mockImplementation(async (_batches, worker) => {
      queuedWorker = worker as (items: unknown[]) => Promise<void>;
      return [];
    });

    await dependencies.listeners[0]({ type: 'translate-page' });
    const initialRecord = vi.mocked(dependencies.renderLoading).mock.calls[0][0];

    // 在 worker 真正执行前，该元素断开连接
    initialRecord.element.remove();

    // 执行排队的 worker
    await queuedWorker([initialRecord]);

    // 此时 activeBatch 为空，不应调用 dependencies.translate
    expect(dependencies.translate).not.toHaveBeenCalled();
  });

  it('retry 准备期间失败节点被 DOM 移除时，彻底清理且不发起空重试与幽灵进度', async () => {
    // 第一次翻译失败
    vi.mocked(dependencies.translate).mockRejectedValueOnce(new Error('首次失败'));
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'error',
      failed: 1,
      total: 1,
    }));

    const failedRecord = vi.mocked(dependencies.renderLoading).mock.calls[0][0];

    // 局部重试在收集失败清单后检查连接性：节点已被 DOM 移除则彻底清理，不发起空重试。
    failedRecord.element.remove();

    await dependencies.listeners[0]({ type: 'retry-page-translation' });

    // 因失败节点已被移除，不应发起二次 translate
    expect(dependencies.translate).toHaveBeenCalledTimes(1);
    // 进度应正确收口（已无活跃段落，status: complete, 0/0）
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'complete',
      completed: 0,
      failed: 0,
      total: 0,
    }));

    // 确认此时 observer 依然注册生效，后续新增节点仍可正常处理翻译
    const latestObserver = vi.mocked(dependencies.startObserver).mock.calls.at(-1)![3];
    const postRetryAdded = document.createElement('p');
    postRetryAdded.textContent = 'post retry dynamic';
    document.body.append(postRetryAdded);

    vi.mocked(dependencies.translate).mockImplementationOnce(async (request) => {
      return request.segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` }));
    });

    await latestObserver({
      added: [postRetryAdded],
      invalidated: [],
    });

    expect(dependencies.renderLoading).toHaveBeenCalledWith(expect.objectContaining({ sourceText: 'post retry dynamic' }));
    expect(dependencies.translate).toHaveBeenCalledTimes(2);
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'complete',
      completed: 1,
      failed: 0,
      total: 1,
    }));
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

  it('retry 只重发失败段：不取消任务、不断开队列，在途与离屏段落继续收口', async () => {
    // 四类段落并存：A(alpha) 已完成、B(beta) 失败、C(gamma) 在途、D(delta) 离屏等待。
    document.body.innerHTML = `<main>${['alpha', 'beta', 'gamma', 'delta'].map((text) => `<p>${text}${'x'.repeat(4000)}</p>`).join('')}</main>`;
    vi.mocked(dependencies.scan).mockReturnValue([...document.querySelectorAll('p')] as HTMLElement[]);

    let resolveGamma!: (value: Array<{ id: string; text: string }>) => void;
    let releaseDelta!: () => void;
    const deltaGate = new Promise<void>((resolve) => { releaseDelta = resolve; });
    let deltaWaiting = true;
    vi.mocked(dependencies.hasWaiting).mockImplementation(() => deltaWaiting);
    vi.mocked(dependencies.schedule).mockImplementation(async (items, worker) => {
      const failures: Array<{ item: typeof items[number]; error: unknown }> = [];
      await Promise.all(items.map(async (batch) => {
        // delta 批模拟离屏等待：可见性释放前不进入 worker。
        if (batch.some((paragraph) => paragraph.sourceText.startsWith('delta'))) {
          await deltaGate;
          deltaWaiting = false;
        }
        try { await worker(batch); } catch (error) { failures.push({ item: batch, error }); }
      }));
      return failures;
    });
    let betaAttempts = 0;
    vi.mocked(dependencies.translate).mockImplementation(async ({ segments }) => {
      const beta = segments.find((segment) => segment.text.startsWith('beta'));
      if (beta) {
        if (++betaAttempts === 1) throw new Error('网络异常');
        return [{ id: beta.id, text: '译:beta' }];
      }
      if (segments.some((segment) => segment.text.startsWith('gamma'))) {
        return new Promise((resolve) => { resolveGamma = resolve; });
      }
      return segments.map((segment) => ({ id: segment.id, text: `译:${segment.text.slice(0, 5)}` }));
    });

    const pending = dependencies.listeners[0]({ type: 'translate-page' });
    await vi.waitFor(() => expect(dependencies.renderError).toHaveBeenCalledWith(expect.objectContaining({ sourceText: expect.stringContaining('beta') }), '网络异常'));
    expect(dependencies.renderTranslation).toHaveBeenCalledTimes(1);
    expect(dependencies.cancel).not.toHaveBeenCalled();
    expect(dependencies.stopObserver).not.toHaveBeenCalled();

    // 局部重试：不进入新会话，不取消当前任务，不断开可见性队列。
    const retry = dependencies.listeners[0]({ type: 'retry-page-translation' });
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(4));
    expect(dependencies.cancel).not.toHaveBeenCalled();
    expect(dependencies.stopObserver).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.translate).mock.calls[3][0].segments).toHaveLength(1);
    expect(vi.mocked(dependencies.translate).mock.calls[3][0].segments[0].text.startsWith('beta')).toBe(true);
    await retry;
    expect(dependencies.renderTranslation).toHaveBeenCalledTimes(2);

    // B 恢复后，C 在途结果与 D 离屏队列照常收口，不因 retry 被打断。
    const gammaRecord = vi.mocked(dependencies.renderLoading).mock.calls.map(([paragraph]) => paragraph).find((paragraph) => paragraph.sourceText.startsWith('gamma'))!;
    resolveGamma([{ id: gammaRecord.id, text: '译:gamma' }]);
    releaseDelta();
    await pending;

    expect(dependencies.translate).toHaveBeenCalledTimes(5);
    expect(dependencies.renderTranslation).toHaveBeenCalledTimes(4);
    expect(dependencies.report).toHaveBeenLastCalledWith({ status: 'complete', completed: 4, failed: 0, total: 4, engineId: 'google' });
  });

  it('retry 进行中重复触发不重复提交，失败后仍可再次重试', async () => {
    let attempts = 0;
    let release!: (value: Array<{ id: string; text: string }>) => void;
    vi.mocked(dependencies.translate).mockImplementation(async ({ segments }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('网络异常');
      if (attempts === 2) return new Promise((resolve) => { release = resolve; });
      return segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` }));
    });
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', failed: 1 }));

    // 重试进行中的第二次触发立即返回，不追加翻译请求。
    const first = dependencies.listeners[0]({ type: 'retry-page-translation' });
    const second = dependencies.listeners[0]({ type: 'retry-page-translation' });
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(2));
    await second;
    expect(dependencies.translate).toHaveBeenCalledTimes(2);

    // retry 再次失败后仍可重试。
    release([]);
    await first;
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', failed: 1 }));
    vi.mocked(dependencies.translate).mockResolvedValueOnce([{ id: 'paragraph-1', text: '译:ok' }]);
    await dependencies.listeners[0]({ type: 'retry-page-translation' });
    expect(dependencies.translate).toHaveBeenCalledTimes(3);
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'complete', completed: 1 }));
  });

  it('retry 进行中 restore：本地清理不被挂起的 cancel 阻塞，迟到结果不渲染', async () => {
    let release!: (value: Array<{ id: string; text: string }>) => void;
    vi.mocked(dependencies.translate)
      .mockRejectedValueOnce(new Error('网络异常'))
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    vi.mocked(dependencies.cancel).mockImplementation(() => new Promise<void>(() => undefined));
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', failed: 1 }));

    const retry = dependencies.listeners[0]({ type: 'retry-page-translation' });
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(2));

    // cancel 永不返回：restore 的本地清理不得被阻塞；旧 retry 继续挂起。
    await dependencies.listeners[0]({ type: 'restore-page' });
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'idle' }));

    // 旧 retry 仍挂起时开启新会话并失败：retry 不得被旧会话锁拒绝。
    vi.mocked(dependencies.translate).mockRejectedValueOnce(new Error('新会话失败'));
    await dependencies.listeners[0]({ type: 'translate-page' });
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', failed: 1 }));
    vi.mocked(dependencies.translate).mockResolvedValueOnce([{ id: 'paragraph-1', text: '译:ok' }]);
    await dependencies.listeners[0]({ type: 'retry-page-translation' });
    expect(dependencies.translate).toHaveBeenCalledTimes(4);
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'complete', completed: 1 }));

    // 旧 retry 的迟到结果被代际隔离，不渲染到已恢复/重译的页面。
    release([{ id: 'paragraph-1', text: '迟到译文' }]);
    await expect(retry).resolves.toBeUndefined();
    expect(vi.mocked(dependencies.renderTranslation).mock.calls.some(([, text]) => text === '迟到译文')).toBe(false);
  });

  it('新会话 cancel 旧任务被拒绝时新翻译照常完成', async () => {
    vi.mocked(dependencies.cancel).mockRejectedValueOnce(new Error('cancel 失败'));
    await dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'ja' });
    await dependencies.listeners[0]({ type: 'translate-page', targetLanguage: 'de' });
    expect(dependencies.translate).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: 'de' }));
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
      // 局部重试为失败段走独立临时队列（与动态变更同路径），已可见元素由 IO 立即回调。
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

  it('离屏失败段 retry 挂起期间重复点击不重复入队，滚入后仅补发一次', async () => {
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

      // first 可见成功；second 离屏等待。
      io.notify([{ target: first, isIntersecting: true }, { target: second, isIntersecting: false }]);
      await vi.waitFor(() => expect(document.querySelector('[data-vast-state="translated"]')?.textContent).toContain('译:first'));

      // second 滚入失败：错误与重试入口出现。
      io.notify([{ target: second, isIntersecting: true }]);
      await vi.waitFor(() => expect(document.querySelector('[data-vast-state="error"]')).not.toBeNull());

      // retry 建立补发队列后保持挂起（不 notify）：候选已同步摘出 failedIds，
      // 重复点击不得再建第二个补发队列（否则滚入后存在重复请求风险）。
      const retry = controller.onMessage({ type: 'retry-page-translation' });
      await vi.waitFor(() => expect(io.observed).toHaveLength(3));
      await controller.onMessage({ type: 'retry-page-translation' });
      expect(io.observed).toHaveLength(3);

      // 滚入后仅一次补发请求，成功后整体收口。
      io.notify([{ target: second, isIntersecting: true }]);
      await retry;
      expect(document.querySelectorAll('[data-vast-state="translated"]')).toHaveLength(2);
      const batchCalls = chrome.sendMessage.mock.calls.filter(([message]) => (message as { type: string }).type === 'translate-batch');
      expect(batchCalls).toHaveLength(3);
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

  it('前端 translate 请求在 15 秒超时后立即触发错误状态并展示重试按钮', async () => {
    vi.useFakeTimers();
    const chrome = installChromeRuntime(async () => new Promise<never>(() => undefined));
    const io = fakeIntersectionObserver();
    try {
      document.body.innerHTML = '<main><p id="p-timeout">Waiting forever</p></main>';
      const controller = createContentController(createRuntimeDependencies());
      const pending = controller.onMessage({ type: 'translate-page' });
      await vi.advanceTimersByTimeAsync(10);
      io.notify([{ target: io.observed[0], isIntersecting: true }]);

      // 14.9 秒时依然在等待
      await vi.advanceTimersByTimeAsync(14_900);
      expect(document.querySelector('[data-vast-state="loading"]')).not.toBeNull();
      expect(document.querySelector('[data-vast-state="error"]')).toBeNull();

      // 到达 15 秒超时熔断：立即报错并渲染重试按钮
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

  it('renderTranslation 拒绝（如挂载失效或脱离 DOM）时不增加完成计数，避免进度虚假 39/39 完成', async () => {
    const dependencies = createDependencies();
    document.body.innerHTML = '<main><p id="p1">text1</p><p id="p2">text2</p></main>';
    vi.mocked(dependencies.scan).mockReturnValue([...document.querySelectorAll('p')] as HTMLElement[]);
    vi.mocked(dependencies.translate).mockImplementation(async ({ segments }) =>
      segments.map((s) => ({ id: s.id, text: `译:${s.text}` })),
    );
    // 模拟第一个成功，第二个因脱离 DOM 或挂载失效被渲染器拒绝
    vi.mocked(dependencies.renderTranslation).mockImplementation((paragraph) => {
      return paragraph.element.id === 'p1';
    });

    const controller = createContentController(dependencies);
    await controller.onMessage({ type: 'translate-page' });

    // p2 被渲染器拒绝，不计入完成，总计 2 个，只有 1 个完成
    expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({
      completed: 1,
      total: 2,
    }));
  });

  it('内联段落请求飞行期间发生内部替换：新请求先收敛，旧请求迟到被 token 校验拒绝，最终 1/1 真实完成', async () => {
    const dependencies = createDependencies();
    document.body.innerHTML = '<main><h2 id="heading">Original Title</h2></main>';
    const heading = document.getElementById('heading') as HTMLElement;
    vi.mocked(dependencies.scan).mockReturnValue([heading]);

    // 两个 deferred 明确 token：首轮（旧）与失效后的新任务（新）都挂起，
    // 时序为「新请求先 resolve、旧请求后 resolve」，与真实网络乱序一致。
    let resolveFirstTranslate!: (value: Array<{ id: string; text: string }>) => void;
    let resolveSecondTranslate!: (value: Array<{ id: string; text: string }>) => void;
    let translateCount = 0;

    vi.mocked(dependencies.translate).mockImplementation(async () => {
      translateCount += 1;
      if (translateCount === 1) {
        return new Promise((resolve) => {
          resolveFirstTranslate = resolve;
        });
      }
      return new Promise((resolve) => {
        resolveSecondTranslate = resolve;
      });
    });

    let observerHandler!: (changes: { added: HTMLElement[]; invalidated: unknown[]; removed: unknown[] }) => Promise<void>;
    dependencies.startObserver = vi.fn((_rule, _store, _scope, handler) => {
      observerHandler = handler as typeof observerHandler;
    });

    const controller = createContentController(dependencies);
    const pendingTranslate = controller.onMessage({ type: 'translate-page' });

    // 等待首轮翻译开始
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(1));
    const initialRecord = vi.mocked(dependencies.renderLoading).mock.calls[0][0];

    // 模拟内部替换：observer 捕获失效并通知控制器 → 新任务调度（第二次 translate 挂起）
    const observerPromise = observerHandler({
      added: [],
      invalidated: [initialRecord],
      removed: [],
    });
    await vi.waitFor(() => expect(dependencies.translate).toHaveBeenCalledTimes(2));

    // 新请求先返回（新 token 被当前任务接受）
    resolveSecondTranslate([{ id: initialRecord.id, text: '新译文' }]);
    await observerPromise;

    // 旧请求迟到返回（旧 token 与当前任务不匹配，被 renderTranslation mock 拒绝，不污染）
    resolveFirstTranslate([{ id: initialRecord.id, text: '旧译文' }]);
    await pendingTranslate;

    // 最终进度真实收敛为 1/1 完成，绝不永久停留在 translating 或虚报完成
    await vi.waitFor(() => expect(dependencies.report).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'complete',
      completed: 1,
      failed: 0,
      total: 1,
    })));
    // 旧译文确实迟到到达渲染器，但被 token 校验拒绝（返回 false），不得被采纳渲染
    const staleCall = vi.mocked(dependencies.renderTranslation).mock.calls.find(([, text]) => text === '旧译文');
    expect(staleCall).toBeDefined();
    const staleIndex = vi.mocked(dependencies.renderTranslation).mock.calls.indexOf(staleCall!);
    expect(vi.mocked(dependencies.renderTranslation).mock.results[staleIndex].value).toBe(false);
  });
});
