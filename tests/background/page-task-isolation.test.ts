import { describe, expect, it, vi } from 'vitest';

import { createBackgroundController, type BackgroundChrome, type BackgroundDependencies } from '../../src/background';
import { DEFAULT_CONFIG } from '../../src/shared/config';

function harness() {
  const signals: AbortSignal[] = [];
  const resolvers: Array<() => void> = [];
  const dependencies: BackgroundDependencies = {
    translate: vi.fn((_request, _config, signal) => new Promise<Array<{ id: string; text: string }>>((resolve) => {
      signals.push(signal);
      resolvers.push(() => resolve([{ id: 'p', text: '译文' }]));
    })),
    streamSelection: vi.fn(async function* () {}), testConnection: vi.fn(), clearCache: vi.fn(),
  };
  const api = {
    runtime: { id: 'ext', sendMessage: vi.fn(async () => undefined), onMessage: { addListener: vi.fn() }, onConnect: { addListener: vi.fn() } },
    commandsApi: { onCommand: { addListener: vi.fn() } },
    contextMenus: { create: vi.fn(), removeAll: vi.fn(), onClicked: { addListener: vi.fn() } },
    tabs: { query: vi.fn(), sendMessage: vi.fn() },
    storage: { local: { get: vi.fn(async () => ({ translatorConfig: { ...DEFAULT_CONFIG, apiKey: 'secret' } })), set: vi.fn() } },
    i18n: { getUILanguage: () => 'en' },
  } as unknown as BackgroundChrome;
  return { controller: createBackgroundController(api, dependencies), signals, resolvers, dependencies };
}

const sender = (tabId: number, documentId = 'doc'): chrome.runtime.MessageSender => ({
  id: 'ext', tab: { id: tabId } as chrome.tabs.Tab, frameId: 0, documentId,
});
const batch = { type: 'translate-batch', taskId: 'same', sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'p', text: 'hello' }] };

describe('页面任务身份与消息边界', () => {
  it('同一页面同 taskId 的并发 batch 全部被 cancel，其他 tab 不受影响', async () => {
    const { controller, signals, resolvers } = harness();
    const first = controller.handle(batch, sender(1));
    const second = controller.handle(batch, sender(1));
    const other = controller.handle(batch, sender(2));
    await vi.waitFor(() => expect(signals).toHaveLength(3));

    await controller.handle({ type: 'cancel-task', taskId: 'same' }, sender(1));
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
    resolvers.forEach((resolve) => resolve());
    await Promise.all([first, second, other]);
  });

  it('完成的请求只删除自身 controller，不影响同键并发请求', async () => {
    const { controller, signals, resolvers } = harness();
    const first = controller.handle(batch, sender(1));
    const second = controller.handle(batch, sender(1));
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[0]();
    await first;
    await controller.handle({ type: 'cancel-task', taskId: 'same' }, sender(1));
    expect(signals[1].aborted).toBe(true);
    resolvers[1]();
    await second;
  });

  it.each([
    { type: 'translate-batch', taskId: '', sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [] },
    { type: 'translate-batch', taskId: 'x', sourceLanguage: {}, targetLanguage: 'zh-Hans', segments: [{ id: 'p', text: 'x' }] },
    { type: 'translate-batch', taskId: 'x', sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: '__proto__', text: 'x' }] },
    { type: 'translate-batch', taskId: 'x', sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'p', text: 1 }] },
    { type: 'save-secret-config', config: { __proto__: { polluted: true }, model: 'x' } },
  ])('拒绝畸形消息 %#', async (message) => {
    const { controller, dependencies } = harness();
    await expect(controller.handle(message, sender(1))).resolves.toEqual({ ok: false, error: '消息格式无效' });
    expect(dependencies.translate).not.toHaveBeenCalled();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
