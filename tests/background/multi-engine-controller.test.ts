import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackgroundController, createRuntimeDependencies, readSettings, type BackgroundChrome } from '../../src/background';
import { TranslationCache, type CacheStorage } from '../../src/background/cache';
import { DEFAULT_SETTINGS, type CustomAiEngine, type Engine, type Settings } from '../../src/shared/config';
import type { Provider } from '../../src/background/provider';

const custom: CustomAiEngine = {
  id: 'custom-work', kind: 'custom-ai', name: '工作接口', enabled: true, order: 2,
  baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiKey: 'secret-value',
};

function provider(engineId: string, streaming = false): Provider {
  return {
    capabilities: { streaming },
    cacheIdentity: { engineId, engineFingerprint: `${engineId}-fingerprint`, adapterVersion: `${engineId}-v1` },
    translate: vi.fn(async (request: import('../../src/shared/messages').TranslationRequest) => request.segments.map(({ id, text }) => ({ id, text: `${engineId}:${text}` }))),
    streamSelection: streaming ? vi.fn(async function* () { yield `${engineId}-a`; yield `${engineId}-b`; }) : undefined,
    testConnection: vi.fn(async () => undefined),
  };
}

function createChrome(stored: Record<string, unknown> = { translatorSettings: { ...DEFAULT_SETTINGS, engines: [...DEFAULT_SETTINGS.engines, custom] } }) {
  const listeners: Array<(message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => boolean | void> = [];
  const ports: Array<(port: chrome.runtime.Port) => void> = [];
  let local = { ...stored };
  const api: BackgroundChrome & { listeners: typeof listeners; ports: typeof ports; local: () => Record<string, unknown> } = {
    listeners, ports, local: () => local,
    runtime: { id: 'extension-id', sendMessage: vi.fn(async () => undefined), onMessage: { addListener: (listener) => listeners.push(listener) }, onConnect: { addListener: (listener) => ports.push(listener) } },
    commandsApi: { onCommand: { addListener: vi.fn() } },
    contextMenus: { create: vi.fn(), removeAll: vi.fn(), onClicked: { addListener: vi.fn() } },
    tabs: { query: vi.fn(async () => []), sendMessage: vi.fn(async () => undefined) },
    storage: {
      local: {
        get: vi.fn(async () => local),
        set: vi.fn(async (items: Record<string, unknown>) => { local = { ...local, ...items }; }),
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
    i18n: { getUILanguage: () => 'en-US' },
  };
  return api;
}

const sender = { id: 'extension-id', tab: { id: 4 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc-1' };

describe('后台 v2 多引擎编排', () => {
  it('translatorSettings 优先于旧配置，且仅旧配置时迁移并一次性写入 v2', async () => {
    const legacyConfig = {
      baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini',
      ...DEFAULT_SETTINGS.readingPreferences,
    };
    const preferred = createChrome({ translatorSettings: { ...DEFAULT_SETTINGS, activeEngineId: 'bing' }, translatorConfig: { ...legacyConfig, targetLanguage: 'ja' } });
    await expect(readSettings(preferred)).resolves.toMatchObject({ activeEngineId: 'bing' });
    expect(preferred.storage.local.set).not.toHaveBeenCalled();

    const legacy = createChrome({ translatorConfig: { ...legacyConfig, apiKey: 'legacy-key', targetLanguage: 'ja' } });
    await expect(readSettings(legacy)).resolves.toMatchObject({ activeEngineId: 'google', readingPreferences: { targetLanguage: 'ja' } });
    expect(legacy.storage.local.set).toHaveBeenCalledOnce();
    expect(legacy.local()).toHaveProperty('translatorSettings.schemaVersion', 2);
  });

  it('公开配置仅返回偏好、activeEngineId 与就绪能力摘要，不泄露 secret/endpoint/model', async () => {
    const api = createChrome();
    const providers = new Map([['google', provider('google')], ['bing', provider('bing')], ['custom-work', provider('custom-work', true)]]);
    const controller = createBackgroundController(api, { createProvider: (engine) => providers.get(engine.id)!, clearCache: vi.fn() });
    const response = await controller.handle({ type: 'get-public-config' }, sender);
    expect(response).toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        preferences: { ...DEFAULT_SETTINGS.readingPreferences, targetLanguage: 'en' },
        theme: 'pearl-reader',
        activeEngineId: 'google',
        availableEngines: [
          { id: 'google', kind: 'google', name: 'Google', ready: true, capabilities: { streaming: false } },
          { id: 'bing', kind: 'bing', name: 'Bing', ready: true, capabilities: { streaming: false } },
          { id: 'custom-work', kind: 'custom-ai', name: '工作接口', ready: true, capabilities: { streaming: true } },
        ],
        experts: [],
        activeExpertByEngine: {},
      }),
    }));
    expect(JSON.stringify(response)).not.toMatch(/secret-value|api\.example|gpt-test|apiKey|baseUrl|model/);
  });

  it('中文 Chrome 将 auto 目标语言公开为简体中文', async () => {
    const api = createChrome();
    api.i18n.getUILanguage = () => 'zh-CN';
    const controller = createBackgroundController(api, { createProvider: () => provider('google'), clearCache: vi.fn() });
    await expect(controller.handle({ type: 'get-popup-config' }, sender)).resolves.toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ preferences: expect.objectContaining({ targetLanguage: 'zh-Hans', scanScope: 'whole-page' }) }),
    }));
  });

  it('旧设置只迁移一次为浏览器语言和整页，之后保留用户明确选择', async () => {
    const api = createChrome();
    await api.storage.local.set({ translatorSettings: {
      ...structuredClone(DEFAULT_SETTINGS), mvpDefaultsVersion: undefined,
      readingPreferences: { ...DEFAULT_SETTINGS.readingPreferences, targetLanguage: 'en', scanScope: 'main-content' },
    } });
    await expect(readSettings(api)).resolves.toMatchObject({ mvpDefaultsVersion: 1, readingPreferences: { targetLanguage: 'auto', scanScope: 'whole-page' } });
    const stored = await readSettings(api);
    stored.readingPreferences.targetLanguage = 'ja';
    await api.storage.local.set({ translatorSettings: stored });
    await expect(readSettings(api)).resolves.toMatchObject({ readingPreferences: { targetLanguage: 'ja', scanScope: 'whole-page' } });
  });

  it('专家目录升级后持久化 VastNext ID 和目录版本', async () => {
    const legacy = structuredClone(DEFAULT_SETTINGS);
    legacy.expertDefaultsVersion = 2 as never;
    legacy.experts = [{ id: 'tech', kind: 'builtin', name: '科技类翻译大师', description: '旧技术专家', prompt: '', enabled: true, order: 0 }];
    legacy.activeExpertByEngine = { 'custom-work': 'tech' };
    legacy.engines = [...legacy.engines, custom];
    const api = createChrome({ translatorSettings: legacy });

    const migrated = await readSettings(api);

    expect(migrated.expertDefaultsVersion).toBe(6);
    expect(migrated.activeExpertByEngine).toEqual({ 'custom-work': 'technology' });
    expect(api.local()).toHaveProperty('translatorSettings.expertDefaultsVersion', 6);
    expect(api.local()).toHaveProperty('translatorSettings.activeExpertByEngine.custom-work', 'technology');
  });

  it.each(['google', 'bing', 'custom-work'])('translate-batch 按 engineId 路由 %s', async (engineId) => {
    const api = createChrome();
    const providers = new Map([['google', provider('google')], ['bing', provider('bing')], ['custom-work', provider('custom-work', true)]]);
    const controller = createBackgroundController(api, { createProvider: (engine) => providers.get(engine.id)!, clearCache: vi.fn() });
    await expect(controller.handle({ type: 'translate-batch', taskId: `task-${engineId}`, engineId, sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'p1', text: 'hello' }] }, sender))
      .resolves.toEqual({ ok: true, data: [{ id: 'p1', text: `${engineId}:hello` }] });
    expect(providers.get(engineId)!.translate).toHaveBeenCalledOnce();
  });

  it('translate-batch 必须指定存在、启用且就绪的 engineId', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, engines: [{ ...DEFAULT_SETTINGS.engines[0], enabled: false }, DEFAULT_SETTINGS.engines[1], { ...custom, apiKey: '' }] };
    const api = createChrome({ translatorSettings: settings });
    const controller = createBackgroundController(api, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });
    const base = { type: 'translate-batch', taskId: 'task', sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'p1', text: 'hello' }] };
    await expect(controller.handle(base, sender)).resolves.toEqual({ ok: false, error: '消息格式无效' });
    await expect(controller.handle({ ...base, engineId: 'missing' }, sender)).resolves.toEqual({ ok: false, error: '翻译引擎不存在' });
    await expect(controller.handle({ ...base, engineId: 'google' }, sender)).resolves.toEqual({ ok: false, error: '翻译引擎已停用' });
    await expect(controller.handle({ ...base, engineId: 'custom-work' }, sender)).resolves.toEqual({ ok: false, error: '翻译引擎尚未配置' });
  });

  it('更新 custom 时空 key 保留旧密钥，只有显式消息清除', async () => {
    const api = createChrome();
    const controller = createBackgroundController(api, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });
    await expect(controller.handle({ type: 'upsert-engine', engine: { ...custom, model: 'next-model', apiKey: '' } }, sender)).resolves.toEqual({ ok: true });
    expect((api.local().translatorSettings as Settings).engines.find((engine) => engine.id === 'custom-work')).toMatchObject({ model: 'next-model', apiKey: 'secret-value' });
    await expect(controller.handle({ type: 'clear-engine-api-key', engineId: 'custom-work' }, sender)).resolves.toEqual({ ok: true });
    expect((api.local().translatorSettings as Settings).engines.find((engine) => engine.id === 'custom-work')).toMatchObject({ apiKey: '' });
  });

  it('更新 custom 的 origin 时清除旧密钥并要求重新输入', async () => {
    const api = createChrome();
    const controller = createBackgroundController(api, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });
    await expect(controller.handle({ type: 'upsert-engine', engine: { ...custom, baseUrl: 'https://other.example/v1', apiKey: '' } }, sender)).resolves.toEqual({ ok: true });
    expect((api.local().translatorSettings as Settings).engines.find((engine) => engine.id === custom.id)).toMatchObject({ baseUrl: 'https://other.example/v1', apiKey: '' });
  });

  it('CRUD 只允许 custom，拒绝改写内置项和删除不存在实例', async () => {
    const api = createChrome();
    const controller = createBackgroundController(api, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });

    await expect(controller.handle({ type: 'upsert-engine', engine: { ...DEFAULT_SETTINGS.engines[0], name: '伪造 Google' } }, sender))
      .resolves.toEqual({ ok: false, error: '只能编辑自定义 AI 实例' });
    await expect(controller.handle({ type: 'delete-engine', engineId: 'custom-missing' }, sender))
      .resolves.toEqual({ ok: false, error: '翻译引擎不存在' });
    expect(api.storage.local.set).not.toHaveBeenCalled();
  });

  it('清除当前 custom 的密钥后自动回退到可用内置项', async () => {
    const api = createChrome({ translatorSettings: { ...DEFAULT_SETTINGS, activeEngineId: custom.id, engines: [...DEFAULT_SETTINGS.engines, custom] } });
    const controller = createBackgroundController(api, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });

    await expect(controller.handle({ type: 'clear-engine-api-key', engineId: custom.id }, sender)).resolves.toEqual({ ok: true });
    expect(api.local()).toHaveProperty('translatorSettings.activeEngineId', 'google');
  });

  it('删除当前 custom 时跳过已停用的 Google 并回退到 Bing', async () => {
    const engines: Engine[] = [{ ...DEFAULT_SETTINGS.engines[0], enabled: false }, DEFAULT_SETTINGS.engines[1], custom];
    const api = createChrome({ translatorSettings: { ...DEFAULT_SETTINGS, activeEngineId: custom.id, engines } });
    const controller = createBackgroundController(api, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });

    await expect(controller.handle({ type: 'delete-engine', engineId: custom.id }, sender)).resolves.toEqual({ ok: true });
    expect(api.local()).toHaveProperty('translatorSettings.activeEngineId', 'bing');
  });

  it('拒绝已删除的旧配置写入消息和旧 Options 消息别名', async () => {
    const api = createChrome();
    const controller = createBackgroundController(api, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });

    await expect(controller.handle({ type: 'save-settings', settings: DEFAULT_SETTINGS }, sender)).resolves.toEqual({ ok: false, error: '不支持的消息类型' });
    await expect(controller.handle({ type: 'get-options-config' }, sender)).resolves.toEqual({ ok: false, error: '不支持的消息类型' });
    await expect(controller.handle({ type: 'test-connection', engineId: 'google' }, sender)).resolves.toEqual({ ok: false, error: '不支持的消息类型' });
  });

  it('仅接受包含所有引擎且无重复的完整安全排序', async () => {
    const api = createChrome();
    const controller = createBackgroundController(api, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });
    await expect(controller.handle({ type: 'reorder-engines', engineIds: ['custom-work', 'google', 'bing'] }, sender)).resolves.toEqual({ ok: true });
    expect((api.local().translatorSettings as Settings).engines.map(({ id, order }) => [id, order])).toEqual([['custom-work', 0], ['google', 1], ['bing', 2]]);
    await expect(controller.handle({ type: 'reorder-engines', engineIds: ['google', 'bing'] }, sender)).resolves.toEqual({ ok: false, error: '翻译引擎排序无效' });
    await expect(controller.handle({ type: 'reorder-engines', engineIds: ['google', 'google', 'bing'] }, sender)).resolves.toEqual({ ok: false, error: '翻译引擎排序无效' });
  });

  it('停用 active 自动回退 Google，且不能停用作为最终可用回退的 Google', async () => {
    const api = createChrome({ translatorSettings: { ...DEFAULT_SETTINGS, activeEngineId: custom.id, engines: [...DEFAULT_SETTINGS.engines, custom] } });
    const controller = createBackgroundController(api, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });
    await expect(controller.handle({ type: 'set-engine-enabled', engineId: custom.id, enabled: false }, sender)).resolves.toEqual({ ok: true });
    expect(api.local()).toHaveProperty('translatorSettings.activeEngineId', 'google');

    const onlyGoogle = createChrome({ translatorSettings: { ...DEFAULT_SETTINGS, engines: [DEFAULT_SETTINGS.engines[0], { ...DEFAULT_SETTINGS.engines[1], enabled: false }] } });
    const onlyGoogleController = createBackgroundController(onlyGoogle, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });
    await expect(onlyGoogleController.handle({ type: 'set-engine-enabled', engineId: 'google', enabled: false }, sender)).resolves.toEqual({ ok: false, error: '至少保留一个可用的翻译引擎' });
  });

  it('测试 existing custom 时使用未保存 candidate 并继承同源旧 key', async () => {
    const api = createChrome();
    const created: Engine[] = [];
    const controller = createBackgroundController(api, { createProvider: (engine) => { created.push(engine); return provider(engine.id); }, clearCache: vi.fn() });
    await expect(controller.handle({ type: 'test-engine', engineId: custom.id, candidate: { ...custom, model: 'unsaved', apiKey: '' } }, sender)).resolves.toEqual({ ok: true });
    expect(created.at(-1)).toMatchObject({ id: custom.id, model: 'unsaved', apiKey: 'secret-value' });
  });

  it('Google/Bing 划词仅调用一次 translate 并发送单 chunk，custom 保持流式', async () => {
    const api = createChrome();
    const google = provider('google');
    const customProvider = provider('custom-work', true);
    createBackgroundController(api, { createProvider: (engine) => engine.id === 'custom-work' ? customProvider : google, clearCache: vi.fn() }).register();
    const posted: unknown[] = [];
    const messages: Array<(message: unknown) => void> = [];
    api.ports[0]({ name: 'vast-selection-stream', sender, postMessage: (value: unknown) => posted.push(value), disconnect: vi.fn(), onMessage: { addListener: (listener: (message: unknown) => void) => messages.push(listener) }, onDisconnect: { addListener: vi.fn() } } as unknown as chrome.runtime.Port);

    messages[0]({ type: 'translate-selection', requestId: 'google-selection', engineId: 'google', text: 'hello', sourceLanguage: 'en', targetLanguage: 'zh-Hans' });
    await vi.waitFor(() => expect(posted).toContainEqual({ type: 'selection-complete', requestId: 'google-selection', engineId: 'google' }));
    expect(posted).toContainEqual({ type: 'selection-chunk', requestId: 'google-selection', engineId: 'google', chunk: 'google:hello' });
    expect(google.translate).toHaveBeenCalledOnce();

    messages[0]({ type: 'translate-selection', requestId: 'custom-selection', engineId: 'custom-work', text: 'hello', sourceLanguage: 'en', targetLanguage: 'zh-Hans' });
    await vi.waitFor(() => expect(posted).toContainEqual({ type: 'selection-complete', requestId: 'custom-selection', engineId: 'custom-work' }));
    expect(posted).toContainEqual({ type: 'selection-chunk', requestId: 'custom-selection', engineId: 'custom-work', chunk: 'custom-work-a' });
  });
});

describe('运行时 provider 缓存', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('按 adapter cacheIdentity 隔离引擎，且内置引擎忽略 userInstruction', async () => {
    const storage = new Map<string, string>();
    const cache = { get: vi.fn(async (key: string) => storage.get(key)), set: vi.fn(async (key: string, value: string) => { storage.set(key, value); }) };
    const google = provider('google');
    const bing = provider('bing');
    const dependencies = createRuntimeDependencies({ cache, createProvider: (engine) => engine.id === 'google' ? google : bing });
    const request = { sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'p1', text: 'hello' }], userInstruction: 'first' };
    await dependencies.translate!(google, request, new AbortController().signal);
    await dependencies.translate!(google, { ...request, userInstruction: 'second' }, new AbortController().signal);
    await dependencies.translate!(bing, request, new AbortController().signal);
    expect(google.translate).toHaveBeenCalledOnce();
    expect(bing.translate).toHaveBeenCalledOnce();
  });

  it('缓存 get/open/update 失败按 miss 继续 provider', async () => {
    const google = provider('google');
    const cache = {
      get: vi.fn(async () => { throw new Error('cache read failed'); }),
      set: vi.fn(async () => undefined),
    };
    const dependencies = createRuntimeDependencies({ cache, createProvider: () => google });
    const request = { sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'p1', text: 'hello' }] };

    await expect(dependencies.translate!(google, request, new AbortController().signal))
      .resolves.toEqual([{ id: 'p1', text: 'google:hello' }]);
    expect(google.translate).toHaveBeenCalledOnce();
  });

  it.each(['set', 'count', 'evict'] as const)('缓存 %s 失败不覆盖 provider 成功结果', async (failure) => {
    const google = provider('google');
    const storage: CacheStorage = {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => { if (failure === 'set') throw new Error('cache set failed'); }),
      delete: vi.fn(async () => undefined),
      count: vi.fn(async () => { if (failure === 'count') throw new Error('cache count failed'); return 2; }),
      deleteOldest: vi.fn(async () => { if (failure === 'evict') throw new Error('cache evict failed'); }),
    };
    const cache = new TranslationCache(storage, { maxEntries: 1 });
    const dependencies = createRuntimeDependencies({ cache, createProvider: () => google });
    const request = { sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'p1', text: 'hello' }] };

    await expect(dependencies.translate!(google, request, new AbortController().signal))
      .resolves.toEqual([{ id: 'p1', text: 'google:hello' }]);
  });
});

describe('后台设置写入串行化', () => {
  it('并发启停、设默认和排序均基于队列内最新 settings，不丢更新', async () => {
    const api = createChrome();
    const controller = createBackgroundController(api, { createProvider: (engine) => provider(engine.id), clearCache: vi.fn() });

    await Promise.all([
      controller.handle({ type: 'set-engine-enabled', engineId: 'bing', enabled: false }, sender),
      controller.handle({ type: 'set-active-engine', engineId: 'custom-work' }, sender),
      controller.handle({ type: 'reorder-engines', engineIds: ['custom-work', 'google', 'bing'] }, sender),
    ]);

    const settings = api.local().translatorSettings as Settings;
    expect(settings.activeEngineId).toBe('custom-work');
    expect(settings.engines.find((engine) => engine.id === 'bing')?.enabled).toBe(false);
    expect(settings.engines.map(({ id, order }) => [id, order])).toEqual([['custom-work', 0], ['google', 1], ['bing', 2]]);
  });
});
