import { describe, expect, it, vi } from 'vitest';

import { createBackgroundController, type BackgroundChrome, type BackgroundDependencies } from '../../src/background/index';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/config';

// 站内跳转自动延续：旗标由 page-progress 附带的 siteCommand 维护，
// tabs.onUpdated(complete) 时同域名自动重发 translate-page 命令。

const contentSender = (url: string, tabId = 1): chrome.runtime.MessageSender => ({
  id: 'extension-id',
  url,
  tab: { id: tabId } as chrome.tabs.Tab,
  frameId: 0,
  documentId: `doc-${tabId}`,
});

interface Harness {
  api: BackgroundChrome;
  session: Record<string, unknown>;
  local: Record<string, unknown>;
  sent: Array<{ tabId: number; message: unknown }>;
  removed: Array<(tabId: number) => void>;
  updated: Array<(tabId: number, changeInfo: { status?: string; url?: string }) => void>;
  controller: ReturnType<typeof createBackgroundController>;
}

function createHarness(settings: Settings = structuredClone(DEFAULT_SETTINGS)): Harness {
  const session: Record<string, unknown> = {};
  const local: Record<string, unknown> = { translatorSettings: structuredClone(settings) };
  const sent: Array<{ tabId: number; message: unknown }> = [];
  const removed: Array<(tabId: number) => void> = [];
  const updated: Array<(tabId: number, changeInfo: { status?: string; url?: string }) => void> = [];
  const api: BackgroundChrome = {
    runtime: {
      id: 'extension-id',
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
    },
    commandsApi: { onCommand: { addListener: vi.fn() } },
    contextMenus: { create: vi.fn(), removeAll: vi.fn(async () => undefined), onClicked: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async (tabId: number, message: unknown) => { sent.push({ tabId, message }); return undefined; }),
      onRemoved: { addListener: (listener) => removed.push(listener) },
      onUpdated: { addListener: (listener) => updated.push(listener) },
    },
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
          const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(local);
          return Object.fromEntries(names.map((key) => [key, structuredClone(local[key])]));
        }),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(local, structuredClone(items)); }),
      } as unknown as BackgroundChrome['storage']['local'],
      session: {
        get: vi.fn(async (key: string): Promise<Record<string, unknown>> => ({ [key]: structuredClone(session[key]) })),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(session, structuredClone(items)); }),
        remove: vi.fn(async (key: string) => { delete session[key]; }),
      },
    },
    i18n: { getUILanguage: () => 'zh-CN' },
  };
  const dependencies: BackgroundDependencies = {
    createProvider: vi.fn(() => { throw new Error('site translation messages must not create providers'); }),
    clearCache: vi.fn(async () => undefined),
  };
  const controller = createBackgroundController(api, dependencies);
  controller.register();
  return { api, session, local, sent, removed, updated, controller };
}

async function reportProgress(harness: Harness, progress: Record<string, unknown>, url = 'https://example.com/page1'): Promise<void> {
  await harness.controller.handle({ type: 'page-progress', progress }, contentSender(url));
}

function siteFlag(harness: Harness, tabId = 1): unknown {
  return harness.session[`siteAutoTranslate:${tabId}`];
}

describe('站内跳转自动延续', () => {
  // 每个用例自建 harness，无需跨用例清理；不要在此使用 clearAllMocks——
  // 它会连 harness mock 的 implementation 一起清除，导致依赖实现的用例失效。
  it('translating 进度附带 siteCommand 时写入旗标，idle 时清除', async () => {
    const harness = createHarness();
    const command = { engineId: 'google', targetLanguage: 'zh-Hans', scope: 'whole-page', mode: 'bilingual' };
    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 3, siteCommand: command });
    expect(siteFlag(harness)).toEqual({ host: 'example.com', params: command });

    await reportProgress(harness, { status: 'idle', completed: 0, failed: 0, total: 0 });
    expect(siteFlag(harness)).toBeUndefined();
  });

  it('非 http(s) 页面与非法 siteCommand 不写旗标', async () => {
    const harness = createHarness();
    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 1, siteCommand: { engineId: 'google', targetLanguage: 'zh-Hans', scope: 'whole-page', mode: 'bilingual' } }, 'chrome-extension://extension-id/options.html');
    expect(siteFlag(harness)).toBeUndefined();

    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 1, siteCommand: { engineId: 'google', evil: 'x' } });
    expect(siteFlag(harness)).toBeUndefined();
  });

  it('siteCommand 缺少 engineId 或枚举非法时不写旗标', async () => {
    const harness = createHarness();
    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 1, siteCommand: {} });
    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 1, siteCommand: { engineId: 'google', scope: 'everything', mode: 'bilingual' } });
    expect(siteFlag(harness)).toBeUndefined();
  });

  it('complete 且同域名时重发 translate-page 命令并携带参数', async () => {
    const harness = createHarness();
    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 2, siteCommand: { engineId: 'google', targetLanguage: 'zh-Hans', scope: 'whole-page', mode: 'bilingual' } });
    harness.sent.length = 0;
    for (const listener of harness.updated) listener(1, { status: 'complete', url: 'https://example.com/page2' });
    await vi.waitFor(() => expect(harness.sent).toEqual([{ tabId: 1, message: { type: 'translate-page', source: 'site-continue', engineId: 'google', targetLanguage: 'zh-Hans', scope: 'whole-page', mode: 'bilingual' } }]));
  });

  it('域名不同或非 http(s) 时跳过且不清旗标', async () => {
    const harness = createHarness();
    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 2, siteCommand: { engineId: 'google', targetLanguage: 'zh-Hans', scope: 'whole-page', mode: 'bilingual' } });
    for (const listener of harness.updated) listener(1, { status: 'complete', url: 'https://other.example/page' });
    for (const listener of harness.updated) listener(1, { status: 'complete', url: 'chrome://newtab' });
    expect(harness.sent).toEqual([]);
    expect(siteFlag(harness)).toBeDefined();
  });

  it('偏好关闭时不自动延续', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.readingPreferences.autoSiteTranslation = false;
    const harness = createHarness(settings);
    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 2, siteCommand: { engineId: 'google', targetLanguage: 'zh-Hans', scope: 'whole-page', mode: 'bilingual' } });
    for (const listener of harness.updated) listener(1, { status: 'complete', url: 'https://example.com/page2' });
    expect(harness.sent).toEqual([]);
  });

  it('按真实事件序列触发：loading 携带 url，complete 不带 url', async () => {
    const harness = createHarness();
    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 2, siteCommand: { engineId: 'google', targetLanguage: 'zh-Hans', scope: 'whole-page', mode: 'bilingual' } });
    harness.sent.length = 0;
    for (const listener of harness.updated) {
      listener(1, { status: 'loading', url: 'https://example.com/page2' });
      listener(1, {});
      listener(1, { status: 'complete' });
    }
    await vi.waitFor(() => expect(harness.sent).toEqual([{ tabId: 1, message: { type: 'translate-page', source: 'site-continue', engineId: 'google', targetLanguage: 'zh-Hans', scope: 'whole-page', mode: 'bilingual' } }]));
  });

  it('内容脚本未就绪时短暂重试发送，恢复后成功', async () => {
    const harness = createHarness();
    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 2, siteCommand: { engineId: 'google', targetLanguage: 'zh-Hans', scope: 'whole-page', mode: 'bilingual' } });
    harness.sent.length = 0;
    vi.mocked(harness.api.tabs.sendMessage)
      .mockRejectedValueOnce(new Error('receiving end does not exist'))
      .mockRejectedValueOnce(new Error('receiving end does not exist'));
    for (const listener of harness.updated) {
      listener(1, { status: 'loading', url: 'https://example.com/page2' });
      listener(1, { status: 'complete' });
    }
    await vi.waitFor(() => expect(harness.sent.length).toBe(1), { timeout: 4_000 });
  });

  it('标签页关闭时清理旗标', async () => {
    const harness = createHarness();
    await reportProgress(harness, { status: 'translating', completed: 0, failed: 0, total: 2, siteCommand: { engineId: 'google', targetLanguage: 'zh-Hans', scope: 'whole-page', mode: 'bilingual' } });
    expect(siteFlag(harness)).toBeDefined();
    for (const listener of harness.removed) listener(1);
    await vi.waitFor(() => expect(siteFlag(harness)).toBeUndefined());
  });
});
