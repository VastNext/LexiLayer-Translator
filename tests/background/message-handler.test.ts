import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type CustomAiEngine, type Settings } from '../../src/shared/config';
import {
  createBackgroundController,
  sanitizeError,
  type BackgroundChrome,
  type BackgroundDependencies,
} from '../../src/background/index';
import type { TranslationRequest } from '../../src/shared/messages';
import type { Provider } from '../../src/background/provider';

const customEngine: CustomAiEngine = {
  id: 'custom-work', kind: 'custom-ai', name: '工作接口', enabled: true, order: 2,
  baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiKey: 'sk-secret-value',
};
const configured: Settings = { ...DEFAULT_SETTINGS, engines: [...DEFAULT_SETTINGS.engines, customEngine] };

function createChrome(): BackgroundChrome & {
  messages: Array<(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean | void>;
  ports: Array<(port: chrome.runtime.Port) => void>;
  commands: Array<(command: string) => void>;
  menus: Array<(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void>;
} {
  const messages: Array<(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean | void> = [];
  const ports: Array<(port: chrome.runtime.Port) => void> = [];
  const commands: Array<(command: string) => void> = [];
  const menus: Array<(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void> = [];
  let sessionState: Record<string, unknown> = {};
  return {
    messages,
    ports,
    commands,
    menus,
    runtime: {
      id: 'extension-id',
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: vi.fn((listener) => messages.push(listener)) },
      onConnect: { addListener: vi.fn((listener) => ports.push(listener)) },
    },
    commandsApi: { onCommand: { addListener: (listener) => commands.push(listener) } },
    contextMenus: {
      create: vi.fn(),
      removeAll: vi.fn(async () => undefined),
      onClicked: { addListener: (listener) => menus.push(listener) },
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7 } as chrome.tabs.Tab]),
      sendMessage: vi.fn(async () => undefined),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ translatorSettings: configured })),
        set: vi.fn(async () => undefined),
        setAccessLevel: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async (key: string): Promise<Record<string, unknown>> => ({ [key]: sessionState[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => { sessionState = { ...sessionState, ...items }; }),
      },
    },
    i18n: { getUILanguage: () => 'zh-CN' },
  };
}

function createDependencies(): BackgroundDependencies {
  const providers = new Map(configured.engines.map((engine) => [engine.id, {
    capabilities: { streaming: engine.kind === 'custom-ai' },
    cacheIdentity: { engineId: engine.id, engineFingerprint: engine.id, adapterVersion: '1' },
    translate: vi.fn(), testConnection: vi.fn(async () => undefined),
  } as Provider]));
  return {
    createProvider: vi.fn((engine) => providers.get(engine.id) ?? ({
      capabilities: { streaming: engine.kind === 'custom-ai' },
      cacheIdentity: { engineId: engine.id, engineFingerprint: engine.id, adapterVersion: '1' },
      translate: vi.fn(), testConnection: vi.fn(async () => undefined),
    } as Provider)),
    translate: vi.fn(async (_provider, request: TranslationRequest) => request.segments.map((segment) => ({ ...segment, text: `译:${segment.text}` }))),
    streamSelection: vi.fn(async function* () { yield '流'; yield '式'; }),
    clearCache: vi.fn(async () => undefined),
  };
}

describe('service worker 消息编排', () => {
  let chromeApi: ReturnType<typeof createChrome>;
  let dependencies: BackgroundDependencies;

  beforeEach(() => {
    chromeApi = createChrome();
    dependencies = createDependencies();
    createBackgroundController(chromeApi, dependencies).register();
  });

  function send(message: unknown, sender: chrome.runtime.MessageSender = { id: 'extension-id', tab: { id: 1 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc' }): Promise<unknown> {
    return new Promise((resolve) => {
      expect(chromeApi.messages[0](message, sender, resolve)).toBe(true);
    });
  }

  it('同步注册消息、端口、命令和菜单监听，并用 true 保活异步响应', async () => {
    expect(chromeApi.messages).toHaveLength(1);
    expect(chromeApi.ports).toHaveLength(1);
    expect(chromeApi.commands).toHaveLength(1);
    expect(chromeApi.menus).toHaveLength(1);
    await vi.waitFor(() => expect(chromeApi.contextMenus.create).toHaveBeenCalledTimes(3));
    expect(chromeApi.contextMenus.removeAll).toHaveBeenCalledBefore(vi.mocked(chromeApi.contextMenus.create));
    await expect(send({ type: 'get-public-config' })).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it('注册监听前最早限制 local storage 仅可信扩展上下文可访问', async () => {
    expect(chromeApi.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(vi.mocked(chromeApi.storage.local.setAccessLevel!).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(chromeApi.runtime.onMessage.addListener).mock.invocationCallOrder[0]);
  });

  it('旧版 Chrome 不支持 setAccessLevel 时仍继续初始化', () => {
    const legacyChrome = createChrome();
    delete legacyChrome.storage.local.setAccessLevel;

    createBackgroundController(legacyChrome, createDependencies()).register();

    expect(legacyChrome.messages).toHaveLength(1);
  });

  it('拒绝非白名单消息和伪造 sender', async () => {
    await expect(send({ type: 'fetch', url: 'https://example.com' }))
      .resolves.toEqual({ ok: false, error: '不支持的消息类型' });
    await expect(send({ type: 'get-public-config' }, { id: 'other-extension' }))
      .resolves.toEqual({ ok: false, error: '消息来源无效' });
  });

  it('读取本地配置但绝不向消息返回 API Key', async () => {
    const response = await send({ type: 'get-public-config' });
    expect(response).toEqual({ ok: true, data: expect.not.objectContaining({ apiKey: expect.anything() }) });
    expect(JSON.stringify(response)).not.toContain('sk-secret-value');
  });

  it('设置协议按 custom 返回 hasApiKey 且不返回密钥', async () => {
    const options = await send({ type: 'get-options-settings' });
    expect(options).toEqual({ ok: true, data: expect.objectContaining({ engines: expect.arrayContaining([expect.objectContaining({ id: 'custom-work', hasApiKey: true })]) }) });
    expect(JSON.stringify(options)).not.toContain('sk-secret-value');
  });

  it('Popup 和 Options 读取主题，并可通过 save-theme 持久化', async () => {
    let persisted = structuredClone(configured);
    vi.mocked(chromeApi.storage.local.get).mockImplementation(async () => ({ translatorSettings: persisted }));
    vi.mocked(chromeApi.storage.local.set).mockImplementation(async (items) => { persisted = (items as { translatorSettings: Settings }).translatorSettings; });

    await expect(send({ type: 'get-popup-config' })).resolves.toEqual(expect.objectContaining({ data: expect.objectContaining({ theme: 'pearl-reader' }) }));
    await expect(send({ type: 'save-theme', theme: 'command-translator' })).resolves.toEqual({ ok: true });
    expect(persisted.theme).toBe('command-translator');
    await expect(send({ type: 'save-theme', theme: 'unknown' })).resolves.toEqual({ ok: false, error: '消息格式无效' });
  });

  it('公开配置把 auto 目标解析为 Chrome UI 语言', async () => {
    vi.mocked(chromeApi.storage.local.get).mockImplementation(async () => ({ translatorSettings: { ...configured, readingPreferences: { ...configured.readingPreferences, targetLanguage: 'auto' } } }));
    chromeApi.i18n.getUILanguage = () => 'de-DE';
    await expect(send({ type: 'get-public-config' })).resolves.toEqual(expect.objectContaining({ data: expect.objectContaining({ preferences: expect.objectContaining({ targetLanguage: 'de' }) }) }));
  });

  it('批量翻译、取消任务并阻止取消后的结果返回', async () => {
    const pending = new Promise<never>(() => undefined);
    vi.mocked(dependencies.translate!).mockReturnValueOnce(pending);
    const translation = send({
      type: 'translate-batch',
      taskId: 'task-1',
      engineId: 'google',
      sourceLanguage: 'auto',
      targetLanguage: 'zh-Hans',
      segments: [{ id: 'p1', text: 'hello' }],
    });
    await expect(send({ type: 'cancel-task', taskId: 'task-1' }))
      .resolves.toEqual({ ok: true });
    expect(await Promise.race([translation, Promise.resolve('pending')])).toBe('pending');
  });

  it('测试引擎和清理缓存均走固定消息', async () => {
    await expect(send({ type: 'test-engine', engineId: 'google' })).resolves.toEqual({ ok: true });
    await expect(send({ type: 'clear-cache' }))
      .resolves.toEqual({ ok: true });
    expect(dependencies.createProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'google' }));
    expect(dependencies.clearCache).toHaveBeenCalledOnce();
  });

  it('Google/Bing 可在停用后恢复启用', async () => {
    let persisted: Settings = {
      ...configured,
      activeEngineId: 'custom-work',
      engines: configured.engines.map((engine) => engine.id === 'google' || engine.id === 'bing' ? { ...engine, enabled: false } : engine),
    };
    vi.mocked(chromeApi.storage.local.get).mockImplementation(async () => ({ translatorSettings: persisted }));
    vi.mocked(chromeApi.storage.local.set).mockImplementation(async (items) => { persisted = (items as { translatorSettings: Settings }).translatorSettings; });

    await expect(send({ type: 'set-engine-enabled', engineId: 'google', enabled: true })).resolves.toEqual({ ok: true });
    await expect(send({ type: 'set-active-engine', engineId: 'google' })).resolves.toEqual({ ok: true });

    expect(persisted.activeEngineId).toBe('google');
    expect(persisted.engines.find((engine) => engine.id === 'google')?.enabled).toBe(true);
  });

  it.each(['clear-engine-api-key', 'delete-engine'] as const)('%s 拒绝移除最后一个 ready 引擎', async (type) => {
    const onlyCustom: Settings = {
      ...configured,
      activeEngineId: 'custom-work',
      engines: configured.engines.map((engine) => engine.id === 'google' || engine.id === 'bing' ? { ...engine, enabled: false } : engine),
    };
    vi.mocked(chromeApi.storage.local.get).mockImplementation(async () => ({ translatorSettings: onlyCustom }));

    await expect(send({ type, engineId: 'custom-work' })).resolves.toEqual({ ok: false, error: '至少保留一个可用的翻译引擎' });
    expect(chromeApi.storage.local.set).not.toHaveBeenCalled();
  });

  it('某次 storage.set 失败后后续 mutation 继续，并基于最新持久数据', async () => {
    let persisted = structuredClone(configured);
    vi.mocked(chromeApi.storage.local.get).mockImplementation(async () => ({ translatorSettings: structuredClone(persisted) }));
    vi.mocked(chromeApi.storage.local.set)
      .mockRejectedValueOnce(new Error('storage failed'))
      .mockImplementation(async (items) => { persisted = structuredClone((items as { translatorSettings: Settings }).translatorSettings); });

    const failed = send({ type: 'set-engine-enabled', engineId: 'bing', enabled: false });
    const succeeded = send({ type: 'set-engine-enabled', engineId: 'google', enabled: false });

    await expect(failed).resolves.toEqual({ ok: false, error: '请求处理失败，请检查配置或网络后重试' });
    await expect(succeeded).resolves.toEqual({ ok: true });
    expect(persisted.engines.find((engine) => engine.id === 'bing')?.enabled).toBe(true);
    expect(persisted.engines.find((engine) => engine.id === 'google')?.enabled).toBe(false);
  });

  it('测试引擎使用完整未保存 candidate 且不持久化', async () => {
    const candidate = { ...customEngine, id: 'custom-candidate', baseUrl: 'https://candidate.example/v1', model: 'candidate-model', apiKey: 'candidate-key' };
    await expect(send({ type: 'test-engine', candidate })).resolves.toEqual({ ok: true });
    expect(dependencies.createProvider).toHaveBeenCalledWith(candidate);
    expect(chromeApi.storage.local.set).not.toHaveBeenCalled();
  });

  it('selection fallback 使用独立 requestId，并将实际 userInstruction 交给翻译与缓存层', async () => {
    await send({
      type: 'translate-selection-fallback', requestId: 'selection-fallback', engineId: 'custom-work', sourceLanguage: 'en', targetLanguage: 'zh-Hans',
      context: 'nearby only', text: 'selected only',
    });
    expect(dependencies.translate).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({
        segments: [{ id: 'selection', text: 'selected only' }],
        userInstruction: '以下邻近文本仅用于消歧，不要翻译或输出：nearby only',
      }), expect.any(AbortSignal),
    );
  });

  it('内联选区翻译通过统一非流式 provider 路由，custom 合并 instruction/context，builtin 忽略', async () => {
    await expect(send({ type: 'translate-selection-inline', engineId: 'custom-work', targetLanguage: 'zh-Hans', text: 'selected', context: 'nearby' }))
      .resolves.toEqual({ ok: true, data: { text: '译:selected' } });
    expect(dependencies.translate).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      segments: [{ id: 'selection-inline', text: 'selected' }],
      userInstruction: '以下邻近文本仅用于消歧，不要翻译或输出：nearby',
    }), expect.any(AbortSignal));

    await send({ type: 'translate-selection-inline', engineId: 'google', targetLanguage: 'zh-Hans', text: 'selected', context: 'nearby' });
    expect(dependencies.translate).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ userInstruction: undefined }), expect.any(AbortSignal));
  });

  it('内联选区翻译严格校验 sender、text/context/engine/lang 并脱敏错误', async () => {
    for (const message of [
      { type: 'translate-selection-inline', engineId: 'google', targetLanguage: 'zh-Hans', text: 'x'.repeat(5001) },
      { type: 'translate-selection-inline', engineId: 'google', targetLanguage: 'zh-Hans', text: 'ok', context: 'x'.repeat(601) },
      { type: 'translate-selection-inline', engineId: '', targetLanguage: 'zh-Hans', text: 'ok' },
      { type: 'translate-selection-inline', engineId: 'google', targetLanguage: '', text: 'ok' },
    ]) await expect(send(message)).resolves.toEqual({ ok: false, error: '消息格式无效' });
    await expect(send({ type: 'translate-selection-inline', engineId: 'google', targetLanguage: 'zh-Hans', text: 'ok' }, { id: 'extension-id' }))
      .resolves.toEqual({ ok: false, error: '消息来源无效' });
    vi.mocked(dependencies.translate!).mockRejectedValueOnce(new Error('Bearer sk-secret-value https://secret.example?token=leak'));
    await expect(send({ type: 'translate-selection-inline', engineId: 'custom-work', targetLanguage: 'zh-Hans', text: 'ok' }))
      .resolves.toEqual({ ok: false, error: '请求处理失败，请检查配置或网络后重试' });
  });

  it('后台可按独立 selection requestId 中止 fallback fetch', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(dependencies.translate!).mockImplementationOnce((_provider, _request, value) => {
      signal = value;
      return new Promise(() => undefined);
    });
    void send({ type: 'translate-selection-fallback', requestId: 'fallback-1', engineId: 'custom-work', sourceLanguage: 'en', targetLanguage: 'zh-Hans', text: 'selected' });
    await vi.waitFor(() => expect(signal).toBeDefined());

    await expect(send({ type: 'cancel-selection-fallback', requestId: 'fallback-1' })).resolves.toEqual({ ok: true });
    expect(signal?.aborted).toBe(true);
  });

  it('fallback 尚在读取配置时收到取消也不会启动后台请求', async () => {
    let releaseConfig!: (value: { translatorSettings: Settings }) => void;
    vi.mocked(chromeApi.storage.local.get).mockReturnValueOnce(new Promise((resolve) => { releaseConfig = resolve; }) as never);
    const sender = { id: 'extension-id', tab: { id: 4 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc-race' };

    const fallback = send({
      type: 'translate-selection-fallback', requestId: 'fallback-race', engineId: 'custom-work', sourceLanguage: 'en', targetLanguage: 'zh-Hans', text: 'selected',
    }, sender);
    await Promise.resolve();
    await expect(send({ type: 'cancel-selection-fallback', requestId: 'fallback-race' }, sender)).resolves.toEqual({ ok: true });
    releaseConfig({ translatorSettings: configured });

    await expect(fallback).resolves.toEqual({ ok: false, error: '任务已取消' });
    expect(dependencies.translate).not.toHaveBeenCalled();
  });

  it('storage.get 拒绝时返回结构化脱敏错误并清理 fallback reservation', async () => {
    vi.mocked(chromeApi.storage.local.get).mockRejectedValueOnce(new Error('https://secret.example?api_key=leaked'));
    const request = { type: 'translate-selection-fallback', requestId: 'storage-failure', engineId: 'custom-work', sourceLanguage: 'en', targetLanguage: 'zh-Hans', text: 'selected' };

    await expect(send(request)).resolves.toEqual({ ok: false, error: '请求处理失败，请检查配置或网络后重试' });
    await expect(send({ type: 'cancel-selection-fallback', requestId: 'storage-failure' })).resolves.toEqual({ ok: true });
    expect(dependencies.translate).not.toHaveBeenCalled();
  });

  it('runtime listener 为 handle rejection 提供结构化响应兜底', async () => {
    vi.mocked(chromeApi.storage.local.get).mockRejectedValueOnce(new Error('storage exploded'));
    await expect(send({ type: 'get-public-config' })).resolves.toEqual({ ok: false, error: '请求处理失败，请检查配置或网络后重试' });
  });

  it('存储并按页面身份返回最小 progress 状态', async () => {
    const page = { id: 'extension-id', tab: { id: 5 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc' };
    await expect(send({ type: 'page-progress', progress: { status: 'partial', completed: 2, failed: 1, total: 3 } }, page)).resolves.toEqual({ ok: true });
    expect(chromeApi.runtime.sendMessage).toHaveBeenCalledWith({ type: 'page-progress', tabId: 5, frameId: 0, progress: { status: 'partial', completed: 2, failed: 1, total: 3 } });
    await expect(send({ type: 'get-page-progress', tabId: 5, frameId: 0 })).resolves.toEqual({ ok: true, data: { status: 'partial', completed: 2, failed: 1, total: 3 } });
    await expect(send({ type: 'get-page-progress', tabId: 5, frameId: 2 })).resolves.toEqual({ ok: true, data: undefined });
    expect(chromeApi.storage.session?.set).toHaveBeenCalledWith({ pageProgress: { '5:0': { status: 'partial', completed: 2, failed: 1, total: 3 } } });
  });

  it.each(['translating', 'complete', 'partial', 'error'] as const)('页面进度 %s 时按 tab 显示绿色勾 Badge', async (status) => {
    const page = { id: 'extension-id', tab: { id: 6 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc' };

    await send({ type: 'page-progress', progress: { status, completed: 0, failed: 0, total: 0 } }, page);

    expect(chromeApi.action?.setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 6, color: '#16a34a' });
    expect(chromeApi.action?.setBadgeText).toHaveBeenCalledWith({ tabId: 6, text: '✓' });
  });

  it('页面进度 idle 时按 tab 清除 Badge', async () => {
    const page = { id: 'extension-id', tab: { id: 6 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc' };

    await send({ type: 'page-progress', progress: { status: 'idle', completed: 0, failed: 0, total: 0 } }, page);

    expect(chromeApi.action?.setBadgeText).toHaveBeenCalledWith({ tabId: 6, text: '' });
  });

  it('service worker controller 重建后从 storage.session 恢复进度', async () => {
    vi.mocked(chromeApi.storage.session!.get).mockResolvedValue({ pageProgress: { '8:0': { status: 'complete', completed: 3, failed: 0, total: 3 } } });
    const rebuilt = createBackgroundController(chromeApi, dependencies);
    await expect(rebuilt.handle({ type: 'get-page-progress', tabId: 8, frameId: 0 }, { id: 'extension-id' })).resolves.toEqual({ ok: true, data: { status: 'complete', completed: 3, failed: 0, total: 3 } });
  });

  it('每次查询以 storage.session 为准，不使用 controller 内存 fallback', async () => {
    vi.mocked(chromeApi.storage.session!.get).mockResolvedValue({ pageProgress: { '9:0': { status: 'idle', completed: 0, failed: 0, total: 0 } } });

    await expect(send({ type: 'get-page-progress', tabId: 9, frameId: 0 })).resolves.toEqual({
      ok: true,
      data: { status: 'idle', completed: 0, failed: 0, total: 0 },
    });
  });

  it('restore 上报的 idle 状态持久化到 storage.session', async () => {
    const page = { id: 'extension-id', tab: { id: 5 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc' };
    await send({ type: 'page-progress', progress: { status: 'idle', completed: 0, failed: 0, total: 0 } }, page);

    expect(chromeApi.storage.session!.set).toHaveBeenCalledWith({
      pageProgress: expect.objectContaining({ '5:0': { status: 'idle', completed: 0, failed: 0, total: 0 } }),
    });
  });

  it('命令与右键菜单只发送批准的页面动作', async () => {
    chromeApi.commands[0]('translate_page');
    chromeApi.menus[0]({ menuItemId: 'vast-restore-page' } as chrome.contextMenus.OnClickData, { id: 9 } as chrome.tabs.Tab);
    chromeApi.menus[0]({ menuItemId: 'vast-translate-selection', selectionText: 'hello' } as chrome.contextMenus.OnClickData, { id: 9 } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(chromeApi.tabs.sendMessage).toHaveBeenCalledTimes(3));
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'toggle-page-translation' });
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(9, { type: 'restore-page' });
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(9, { type: 'translate-selection', source: 'context-menu', text: 'hello' });
  });

  it('划词流端口只接受本扩展并传递有限上下文', async () => {
    const messageListeners: Array<(message: unknown) => void> = [];
    const posted: unknown[] = [];
    chromeApi.ports[0]({
      name: 'vast-selection-stream',
      sender: { id: 'extension-id', tab: { id: 3 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc-1' },
      postMessage: (message: unknown) => posted.push(message),
      onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
      onDisconnect: { addListener: vi.fn() },
    } as unknown as chrome.runtime.Port);
    messageListeners[0]({
      type: 'translate-selection', requestId: 'request-1', text: 'selection', context: 'nearby context',
      engineId: 'custom-work', sourceLanguage: 'en', targetLanguage: 'zh-Hans',
    });
    await vi.waitFor(() => expect(posted).toContainEqual({ type: 'selection-complete', requestId: 'request-1', engineId: 'custom-work' }));
    expect(dependencies.streamSelection).toHaveBeenCalledWith(
      expect.anything(), 'selection', 'en', 'zh-Hans', '', 'nearby context', expect.any(AbortSignal),
    );
  });

  it('custom 流式划词合并阅读偏好要求和有限上下文', async () => {
    vi.mocked(chromeApi.storage.local.get).mockImplementation(async () => ({
      translatorSettings: { ...configured, readingPreferences: { ...configured.readingPreferences, userInstruction: '使用正式语气' } },
    }) as never);
    const listeners: Array<(message: unknown) => void> = [];
    chromeApi.ports[0]({
      name: 'vast-selection-stream', sender: { id: 'extension-id', tab: { id: 13 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc-13' },
      disconnect: vi.fn(), postMessage: vi.fn(), onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) }, onDisconnect: { addListener: vi.fn() },
    } as unknown as chrome.runtime.Port);

    listeners[0]({ type: 'translate-selection', requestId: 'custom-instruction', engineId: 'custom-work', text: 'selection', context: 'nearby', sourceLanguage: 'en', targetLanguage: 'zh-Hans' });

    await vi.waitFor(() => expect(dependencies.streamSelection).toHaveBeenCalledWith(
      expect.anything(), 'selection', 'en', 'zh-Hans', '使用正式语气', 'nearby', expect.any(AbortSignal),
    ));
  });

  it('按独立 requestId 取消划词请求', async () => {
    const listeners: Array<(message: unknown) => void> = [];
    let aborted = false;
    vi.mocked(dependencies.streamSelection!).mockImplementation(async function* (_provider, _text, _source, _target, _instruction, _context, signal) {
      signal.addEventListener('abort', () => { aborted = true; });
      await new Promise(() => undefined);
    });
    chromeApi.ports[0]({ name: 'vast-selection-stream', sender: { id: 'extension-id', tab: { id: 3 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc-1' }, disconnect: vi.fn(), postMessage: vi.fn(), onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) }, onDisconnect: { addListener: vi.fn() } } as unknown as chrome.runtime.Port);
    listeners[0]({ type: 'translate-selection', requestId: 'selection-1', engineId: 'google', text: 'text' });
    await vi.waitFor(() => expect(dependencies.streamSelection).toHaveBeenCalled());
    listeners[0]({ type: 'cancel-selection', requestId: 'selection-1' });
    expect(aborted).toBe(true);
  });

  it('拒绝缺少 tab、frame 或 document 身份的异常划词端口', () => {
    const disconnect = vi.fn();
    chromeApi.ports[0]({
      name: 'vast-selection-stream',
      sender: { id: 'extension-id' },
      disconnect,
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    } as unknown as chrome.runtime.Port);

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('每个 tab 只允许一个活动划词流', () => {
    const firstDisconnect = vi.fn();
    const secondDisconnect = vi.fn();
    const createPort = (documentId: string, disconnect: () => void) => ({
      name: 'vast-selection-stream',
      sender: { id: 'extension-id', tab: { id: 3 } as chrome.tabs.Tab, frameId: 0, documentId },
      disconnect,
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    }) as unknown as chrome.runtime.Port;

    chromeApi.ports[0](createPort('doc-1', firstDisconnect));
    chromeApi.ports[0](createPort('doc-2', secondDisconnect));

    expect(firstDisconnect).not.toHaveBeenCalled();
    expect(secondDisconnect).toHaveBeenCalledOnce();
  });

  it('同一 tab 十秒内最多启动五次划词翻译', async () => {
    const listeners: Array<(message: unknown) => void> = [];
    const posted: unknown[] = [];
    chromeApi.ports[0]({
      name: 'vast-selection-stream',
      sender: { id: 'extension-id', tab: { id: 3 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc-1' },
      disconnect: vi.fn(),
      postMessage: (message: unknown) => posted.push(message),
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) },
      onDisconnect: { addListener: vi.fn() },
    } as unknown as chrome.runtime.Port);

    for (let index = 0; index < 6; index += 1) {
      listeners[0]({ type: 'translate-selection', requestId: `request-${index}`, engineId: 'google', text: `selection-${index}` });
    }

    await vi.waitFor(() => {
      expect(posted).toContainEqual({ type: 'selection-error', requestId: 'request-5', engineId: 'google', canFallback: false, error: '划词翻译请求过于频繁，请稍后重试' });
      expect(dependencies.streamSelection).toHaveBeenCalledTimes(5);
    });
  });

  it.each(['complete', 'error'] as const)('划词请求 %s 后从 controller 集合精确删除', async (outcome) => {
    const listeners: Array<(message: unknown) => void> = [];
    let activeSignal: AbortSignal | undefined;
    vi.mocked(dependencies.streamSelection!).mockImplementation(async function* (_provider, _text, _source, _target, _instruction, _context, signal) {
      activeSignal = signal;
      if (outcome === 'error') throw new Error('流式失败');
      yield '完成';
    });
    chromeApi.ports[0]({
      name: 'vast-selection-stream', sender: { id: 'extension-id', tab: { id: 14 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc-14' },
      disconnect: vi.fn(), postMessage: vi.fn(), onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) }, onDisconnect: { addListener: vi.fn() },
    } as unknown as chrome.runtime.Port);

    listeners[0]({ type: 'translate-selection', requestId: `finished-${outcome}`, engineId: 'google', text: 'selection' });
    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    await vi.waitFor(() => expect(activeSignal?.aborted).toBe(false));
    listeners[0]({ type: 'cancel-selection', requestId: `finished-${outcome}` });

    expect(activeSignal?.aborted).toBe(false);
  });

  it('后台请求前拒绝未保存 candidate 的远程 HTTP Base URL', async () => {
    const response = await send({ type: 'test-engine', candidate: { ...customEngine, id: 'custom-unsafe', baseUrl: 'http://api.example.com/v1' } });

    expect(response).toEqual({ ok: false, error: '消息格式无效' });
    expect(dependencies.translate).not.toHaveBeenCalled();
  });
});

describe('错误脱敏', () => {
  it('移除密钥、Bearer、URL 参数和英文内部错误', () => {
    expect(sanitizeError(new Error('Bearer sk-abcdef at https://api.test/v1?api_key=secret timeout'), ['sk-abcdef']))
      .toBe('请求处理失败，请检查配置或网络后重试');
  });
});
