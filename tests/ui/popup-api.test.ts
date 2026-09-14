import { describe, expect, it, vi } from 'vitest';

import { createPopupApi } from '../../src/popup/api';

function createChromeApi(getAll: () => Promise<unknown[]> = async () => []) {
  return {
    runtime: {
      id: 'extension-id',
      sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(async () => ({ ok: true })),
      openOptionsPage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      query: vi.fn<(queryInfo?: chrome.tabs.QueryInfo) => Promise<Array<{ id?: number; url?: string; active?: boolean }>>>(async () => []),
      sendMessage: vi.fn<(tabId: number, message: unknown) => Promise<unknown>>(async () => ({ ok: true })),
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    commands: { getAll },
    i18n: { getMessage: vi.fn(() => '') },
  };
}

describe('Popup 快捷键 API', () => {
  it('与 Options 使用相同规则读取页面翻译快捷键', async () => {
    const api = createPopupApi(createChromeApi(vi.fn(async () => [
      { name: 'other', shortcut: 'Alt+A' },
      { name: 'translate_page', shortcut: '' },
    ])));

    await expect(api.getPageTranslationShortcut()).resolves.toEqual({ status: 'unassigned' });
  });

  it('commands.getAll reject 时返回不可用而不抛出', async () => {
    const api = createPopupApi(createChromeApi(vi.fn(async () => { throw new Error('commands unavailable'); })));

    await expect(api.getPageTranslationShortcut()).resolves.toEqual({ status: 'unavailable', reason: 'api-error' });
  });
});

describe('Popup 目标标签与进度订阅 API', () => {
  it('一次解析目标 tab 并在 subscribeProgress、sendToPage、setTranslationBadge 之间复用', async () => {
    const chromeApi = createChromeApi();
    chromeApi.tabs.query = vi.fn(async () => [{ id: 42, active: true, url: 'https://example.com' }]);
    const api = createPopupApi(chromeApi);

    await api.subscribeProgress(vi.fn());
    await api.sendToPage({ type: 'translate-page' });
    await api.setTranslationBadge(true);

    expect(chromeApi.tabs.query).toHaveBeenCalledTimes(1);
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'translate-page' });
    expect(chromeApi.action.setBadgeText).toHaveBeenCalledWith({ tabId: 42, text: '✓' });
  });

  it('subscribeProgress 先挂 onMessage 监听再读取一次快照', async () => {
    const chromeApi = createChromeApi();
    chromeApi.tabs.query = vi.fn(async () => [{ id: 42, active: true, url: 'https://example.com' }]);
    const callOrder: string[] = [];
    chromeApi.runtime.onMessage.addListener = vi.fn(() => {
      callOrder.push('addListener');
    });
    chromeApi.runtime.sendMessage = vi.fn(async (msg: unknown) => {
      if ((msg as { type?: string }).type === 'get-page-progress') {
        callOrder.push('getPageProgress');
        return { ok: true, data: { status: 'idle', completed: 0, failed: 0, total: 0 } };
      }
      return { ok: true };
    });
    const api = createPopupApi(chromeApi);

    await api.subscribeProgress(vi.fn());

    expect(callOrder).toEqual(['addListener', 'getPageProgress']);
  });

  it('实时事件先到达时，后返回的旧快照不会覆盖实时事件', async () => {
    const chromeApi = createChromeApi();
    chromeApi.tabs.query = vi.fn(async () => [{ id: 42, active: true, url: 'https://example.com' }]);
    let registeredListener!: (message: unknown) => void;
    chromeApi.runtime.onMessage.addListener = vi.fn((listener: (message: unknown) => void) => {
      registeredListener = listener;
    });

    let resolveSnapshot!: (val: unknown) => void;
    chromeApi.runtime.sendMessage = vi.fn(async (msg: unknown) => {
      if ((msg as { type?: string }).type === 'get-page-progress') {
        return new Promise((resolve) => { resolveSnapshot = resolve; });
      }
      return { ok: true };
    });

    const api = createPopupApi(chromeApi);
    const progressUpdates: Array<{ status: string; completed: number; failed: number; total: number }> = [];
    const subscribePromise = api.subscribeProgress((p) => {
      progressUpdates.push(p);
    });

    // 模拟快照请求尚未完成时，实时消息已到达
    expect(registeredListener).toBeDefined();
    registeredListener({
      type: 'page-progress',
      tabId: 42,
      frameId: 0,
      progress: { status: 'translating', completed: 1, failed: 0, total: 10 },
    });

    await vi.waitFor(() => expect(resolveSnapshot).toBeDefined());

    // 随后旧快照返回（如 idle 0/0）
    resolveSnapshot({
      ok: true,
      data: { status: 'idle', completed: 0, failed: 0, total: 0 },
    });
    await subscribePromise;

    // 实时 translating 先到，旧快照不应覆盖
    expect(progressUpdates).toEqual([
      { status: 'translating', completed: 1, failed: 0, total: 10 },
    ]);
  });

  it('目标 tab 尚未解析时忽略其他标签页的实时进度', async () => {
    const chromeApi = createChromeApi();
    let resolveTabs!: (tabs: Array<{ id?: number; active?: boolean; url?: string }>) => void;
    chromeApi.tabs.query = vi.fn(() => new Promise((resolve) => { resolveTabs = resolve; }));
    let registeredListener!: (message: unknown) => void;
    chromeApi.runtime.onMessage.addListener = vi.fn((listener: (message: unknown) => void) => { registeredListener = listener; });
    const api = createPopupApi(chromeApi);
    const progressUpdates: unknown[] = [];
    const pending = api.subscribeProgress((progress) => progressUpdates.push(progress));

    registeredListener({ type: 'page-progress', tabId: 99, frameId: 0, progress: { status: 'complete', completed: 9, failed: 0, total: 9 } });
    resolveTabs([{ id: 42, active: true, url: 'https://example.com' }]);
    await pending;

    expect(progressUpdates).toEqual([]);
  });

  it('没有实时事件到达时，快照正常通知 listener', async () => {
    const chromeApi = createChromeApi();
    chromeApi.tabs.query = vi.fn(async () => [{ id: 42, active: true, url: 'https://example.com' }]);
    chromeApi.runtime.sendMessage = vi.fn(async (msg: unknown) => {
      if ((msg as { type?: string }).type === 'get-page-progress') {
        return { ok: true, data: { status: 'complete', completed: 5, failed: 0, total: 5 } };
      }
      return { ok: true };
    });

    const api = createPopupApi(chromeApi);
    const progressUpdates: unknown[] = [];
    await api.subscribeProgress((p) => progressUpdates.push(p));

    expect(progressUpdates).toEqual([
      { status: 'complete', completed: 5, failed: 0, total: 5 },
    ]);
  });

  it('退订时正确移除 onMessage 监听', async () => {
    const chromeApi = createChromeApi();
    chromeApi.tabs.query = vi.fn(async () => [{ id: 42, active: true, url: 'https://example.com' }]);
    const api = createPopupApi(chromeApi);

    const cleanup = await api.subscribeProgress(vi.fn());
    cleanup();

    expect(chromeApi.runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);
  });
});
