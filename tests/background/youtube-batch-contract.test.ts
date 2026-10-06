import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackgroundController, type BackgroundChrome, type BackgroundDependencies } from '../../src/background/index';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/config';

// YouTube 字幕 current-engine 路径的后台契约：内容脚本发送的 translate-batch 消息
// 形状（taskId/engineId 由字幕模块生成）必须通过后台校验并返回译文。

const contentSender = (url: string, tabId = 1): chrome.runtime.MessageSender => ({
  id: 'extension-id',
  url,
  tab: { id: tabId } as chrome.tabs.Tab,
  frameId: 0,
  documentId: `doc-${tabId}`,
});

describe('YouTube 字幕 translate-batch 契约', () => {
  let local: Record<string, unknown>;

  function createHarness(): { controller: ReturnType<typeof createBackgroundController> } {
    local = { translatorSettings: structuredClone(DEFAULT_SETTINGS) };
    const api: BackgroundChrome = {
      runtime: {
        id: 'extension-id',
        sendMessage: vi.fn(async () => undefined),
        onMessage: { addListener: vi.fn() },
        onConnect: { addListener: vi.fn() },
      },
      commandsApi: { onCommand: { addListener: vi.fn() } },
      contextMenus: { create: vi.fn(), removeAll: vi.fn(async () => undefined), onClicked: { addListener: vi.fn() } },
      tabs: { query: vi.fn(async () => []), sendMessage: vi.fn(async () => undefined) },
      storage: {
        local: {
          get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
            const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(local);
            return Object.fromEntries(names.map((key) => [key, structuredClone(local[key])]));
          }),
          set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(local, structuredClone(items)); }),
        } as unknown as BackgroundChrome['storage']['local'],
      },
      i18n: { getUILanguage: () => 'zh-CN' },
    };
    const dependencies: BackgroundDependencies = {
      createProvider: vi.fn(() => ({
        capabilities: { streaming: false },
        cacheIdentity: { engineId: 'google', kind: 'google' },
        translate: vi.fn(async ({ segments }: { segments: Array<{ id: string; text: string }> }) =>
          segments.map((segment) => ({ id: segment.id, text: `译:${segment.text}` }))),
      })) as unknown as BackgroundDependencies['createProvider'],
      clearCache: vi.fn(async () => undefined),
    };
    return { controller: createBackgroundController(api, dependencies) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('字幕模块的 translate-batch 消息形状（taskId/engineId）通过校验并返回译文', async () => {
    const { controller } = createHarness();
    const response = await controller.handle({
      type: 'translate-batch',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      segments: [{ id: 'yt-0', text: 'Hello' }, { id: 'yt-1', text: 'World' }],
      engineId: 'google',
      taskId: 'yts-1-0',
    }, contentSender('https://www.youtube.com/watch?v=test'));

    expect(response).toEqual({
      ok: true,
      data: [{ id: 'yt-0', text: '译:Hello' }, { id: 'yt-1', text: '译:World' }],
    });
  });

  it('缺少 taskId 或 engineId 的消息被拒绝（防止字幕模块契约回退）', async () => {
    const { controller } = createHarness();
    const base = { type: 'translate-batch', sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'yt-0', text: 'Hello' }] };
    await expect(controller.handle({ ...base, engineId: 'google' }, contentSender('https://www.youtube.com/watch?v=test'))).resolves.toEqual({ ok: false, error: '消息格式无效' });
    await expect(controller.handle({ ...base, taskId: 'yts-1-0' }, contentSender('https://www.youtube.com/watch?v=test'))).resolves.toEqual({ ok: false, error: '消息格式无效' });
  });
});
