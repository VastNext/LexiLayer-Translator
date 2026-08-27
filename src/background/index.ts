import { createTranslationBatches, orderTranslationResults } from './batching';
import { createCacheKey, IndexedDbCacheStorage, TranslationCache } from './cache';
import { OpenAiClient } from './openai-client';
import { DEFAULT_CONFIG, exportSafeConfig, validateConfig, type TranslatorConfig } from '../shared/config';
import { mapChromeUiLanguage } from '../shared/languages';
import type { TranslationRequest, TranslationResult, TranslationSegment } from '../shared/messages';

type AsyncMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

export interface BackgroundChrome {
  runtime: {
    id: string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(listener: AsyncMessageListener): void };
    onConnect: { addListener(listener: (port: chrome.runtime.Port) => void): void };
  };
  commandsApi: { onCommand: { addListener(listener: (command: string) => void): void } };
  contextMenus: {
    create(properties: chrome.contextMenus.CreateProperties): void;
    removeAll(): Promise<void> | void;
    onClicked: { addListener(listener: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void): void };
  };
  tabs: {
    query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  storage: {
    local: Pick<chrome.storage.StorageArea, 'get' | 'set'>;
    session?: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
  };
  i18n: { getUILanguage(): string; getMessage?(key: string): string };
}

export interface BackgroundDependencies {
  translate(request: TranslationRequest, config: TranslatorConfig, signal: AbortSignal): Promise<TranslationResult[]>;
  streamSelection(text: string, sourceLanguage: string, targetLanguage: string, context: string | undefined, config: TranslatorConfig, signal: AbortSignal): AsyncIterable<string>;
  testConnection(config: TranslatorConfig): Promise<void>;
  clearCache(): Promise<void>;
}

type IncomingMessage = Record<string, unknown> & { type: string };
const allowedTypes = new Set([
  'translate-batch', 'cancel-task', 'test-connection', 'get-public-config',
  'translate-selection-fallback', 'cancel-selection-fallback',
  'save-public-config', 'clear-cache', 'clear-api-key',
  'get-options-config', 'save-secret-config',
  'page-progress', 'get-page-progress',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null
    || (Object.prototype.hasOwnProperty.call(prototype, 'hasOwnProperty')
      && Object.getPrototypeOf(prototype) === null);
}

function isMessage(value: unknown): value is IncomingMessage {
  return isRecord(value) && typeof value.type === 'string';
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isSafeString(value: unknown, max = 10_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isSafeId(value: unknown): value is string {
  return isSafeString(value, 200) && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function parseSegments(value: unknown): TranslationSegment[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return undefined;
  const segments: TranslationSegment[] = [];
  let characters = 0;
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ['id', 'text']) || !isSafeId(item.id) || !isSafeString(item.text, 6000)) return undefined;
    characters += item.text.length;
    if (characters > 6000) return undefined;
    segments.push({ id: item.id, text: item.text });
  }
  return segments;
}

function pageTaskKey(sender: chrome.runtime.MessageSender, taskId: string): string | undefined {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId === undefined || !sender.documentId) return undefined;
  return `${tabId}:${sender.frameId}:${sender.documentId}:${taskId}`;
}

function copyConfigUpdate(value: unknown, allowApiKey: boolean): Partial<TranslatorConfig> | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = ['baseUrl', 'model', 'targetLanguage', 'displayMode', 'userInstruction', 'translationPosition', 'scanScope', 'selectionContext', ...(allowApiKey ? ['apiKey'] : [])];
  if (!hasOnlyKeys(value, allowed)) return undefined;
  const update: Partial<TranslatorConfig> = {};
  for (const key of allowed) {
    const field = value[key];
    if (field !== undefined) {
      if (key === 'selectionContext' ? typeof field !== 'boolean' : typeof field !== 'string') return undefined;
      Object.defineProperty(update, key, { value: field, enumerable: true, writable: true, configurable: true });
    }
  }
  return update;
}

export function sanitizeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : '';
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[已隐藏]');
  message = message
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, '$1[已隐藏]');
  const safeValidationError = message === 'Base URL 仅允许 HTTPS，HTTP 仅限本机回环地址';
  return (safeValidationError || /^[\u3400-\u9fff]/u.test(message)) && !/https?:\/\//i.test(message)
    ? message
    : '请求处理失败，请检查配置或网络后重试';
}

async function readConfig(api: BackgroundChrome): Promise<TranslatorConfig> {
  const stored = await api.storage.local.get('translatorConfig') as { translatorConfig?: Partial<TranslatorConfig> };
  return {
    ...DEFAULT_CONFIG,
    targetLanguage: mapChromeUiLanguage(api.i18n.getUILanguage()),
    ...stored.translatorConfig,
  };
}

export function createBackgroundController(api: BackgroundChrome, dependencies: BackgroundDependencies) {
  const tasks = new Map<string, Set<AbortController>>();
  const fallbackTasks = new Map<string, AbortController>();
  const selectionPorts = new Map<number, chrome.runtime.Port>();
  const selectionRequests = new Map<number, number[]>();

  function requireValidConfig(config: TranslatorConfig): void {
    const errors = validateConfig(config);
    if (errors.length) throw new Error(errors[0]);
  }

  async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    if (sender.id !== api.runtime.id) return { ok: false, error: '消息来源无效' };
    if (!isMessage(message) || !allowedTypes.has(message.type)) return { ok: false, error: '不支持的消息类型' };
    let fallbackReservation: {
      key: string;
      controller: AbortController;
      sourceLanguage: string;
      targetLanguage: string;
      text: string;
      context?: string;
    } | undefined;
    if (message.type === 'translate-selection-fallback') {
      if (!hasOnlyKeys(message, ['type', 'requestId', 'sourceLanguage', 'targetLanguage', 'text', 'context'])
        || !isSafeId(message.requestId) || !isSafeString(message.sourceLanguage, 64)
        || !isSafeString(message.targetLanguage, 64) || !isSafeString(message.text, 5000)
        || (message.context !== undefined && (typeof message.context !== 'string' || message.context.length > 600))) {
        return { ok: false, error: '消息格式无效' };
      }
      const key = pageTaskKey(sender, message.requestId);
      if (!key) return { ok: false, error: '消息来源无效' };
      fallbackTasks.get(key)?.abort();
      const controller = new AbortController();
      fallbackTasks.set(key, controller);
      fallbackReservation = {
        key,
        controller,
        sourceLanguage: message.sourceLanguage,
        targetLanguage: message.targetLanguage,
        text: message.text,
        context: message.context,
      };
    }
    if (message.type === 'cancel-selection-fallback') {
      if (!hasOnlyKeys(message, ['type', 'requestId']) || !isSafeId(message.requestId)) return { ok: false, error: '消息格式无效' };
      const key = pageTaskKey(sender, message.requestId);
      if (!key) return { ok: false, error: '消息来源无效' };
      fallbackTasks.get(key)?.abort();
      fallbackTasks.delete(key);
      return { ok: true };
    }
    const config = await readConfig(api);
    try {
      if (message.type === 'get-public-config') return { ok: true, data: exportSafeConfig({ ...config, targetLanguage: config.targetLanguage === 'auto' ? mapChromeUiLanguage(api.i18n.getUILanguage()) : config.targetLanguage }) };
      if (message.type === 'get-options-config') return { ok: true, data: { ...exportSafeConfig(config), hasApiKey: Boolean(config.apiKey) } };
      if (message.type === 'clear-cache') {
        await dependencies.clearCache();
        return { ok: true };
      }
      if (message.type === 'clear-api-key') {
        await api.storage.local.set({ translatorConfig: { ...config, apiKey: '' } });
        return { ok: true };
      }
      if (message.type === 'save-public-config') {
        const update = copyConfigUpdate(message.config, false);
        if (!update) return { ok: false, error: '消息格式无效' };
        const next = { ...config, ...update, apiKey: config.apiKey };
        requireValidConfig(next);
        await api.storage.local.set({ translatorConfig: next });
        return { ok: true };
      }
      if (message.type === 'save-secret-config') {
        const update = copyConfigUpdate(message.config, true);
        if (!update) return { ok: false, error: '消息格式无效' };
        const next = { ...config, ...update, apiKey: typeof update.apiKey === 'string' && update.apiKey ? update.apiKey : config.apiKey };
        requireValidConfig(next);
        await api.storage.local.set({ translatorConfig: next });
        return { ok: true };
      }
      if (message.type === 'test-connection') {
        const candidate = message.config === undefined
          ? { ...config, apiKey: typeof message.apiKey === 'string' && message.apiKey ? message.apiKey : config.apiKey }
          : copyConfigUpdate(message.config, true);
        if (!candidate) return { ok: false, error: '消息格式无效' };
        const testConfig = message.config === undefined ? candidate as TranslatorConfig : { ...config, ...candidate };
        requireValidConfig(testConfig);
        await dependencies.testConnection(testConfig);
        return { ok: true };
      }
      if (message.type === 'page-progress') {
        if (!isRecord(message.progress) || !hasOnlyKeys(message, ['type', 'progress'])) return { ok: false, error: '消息格式无效' };
        const { status, completed, failed, total } = message.progress;
        if (!['idle', 'translating', 'complete', 'partial', 'error'].includes(String(status)) || ![completed, failed, total].every((value) => Number.isInteger(value) && Number(value) >= 0)) return { ok: false, error: '消息格式无效' };
        if (sender.tab?.id === undefined || sender.frameId === undefined) return { ok: false, error: '消息来源无效' };
        if (!api.storage.session) return { ok: false, error: '会话存储不可用' };
        const key = `${sender.tab.id}:${sender.frameId}`;
        const progress = { status: String(status), completed: Number(completed), failed: Number(failed), total: Number(total) };
        const value = await api.storage.session.get('pageProgress');
        const stored = isRecord(value.pageProgress) ? value.pageProgress : {};
        await api.storage.session.set({ pageProgress: { ...stored, [key]: progress } });
        void api.runtime.sendMessage({ type: 'page-progress', tabId: sender.tab.id, frameId: sender.frameId, progress });
        return { ok: true };
      }
      if (message.type === 'get-page-progress') {
        if (!hasOnlyKeys(message, ['type', 'tabId', 'frameId']) || !Number.isInteger(message.tabId) || !Number.isInteger(message.frameId)) return { ok: false, error: '消息格式无效' };
        if (!api.storage.session) return { ok: false, error: '会话存储不可用' };
        const value = await api.storage.session.get('pageProgress');
        const stored = isRecord(value.pageProgress) ? value.pageProgress : {};
        return { ok: true, data: stored[`${Number(message.tabId)}:${Number(message.frameId)}`] };
      }
      if (message.type === 'cancel-task') {
        if (!hasOnlyKeys(message, ['type', 'taskId']) || !isSafeId(message.taskId)) return { ok: false, error: '消息格式无效' };
        const key = pageTaskKey(sender, message.taskId);
        if (!key) return { ok: false, error: '消息来源无效' };
        for (const controller of tasks.get(key) ?? []) controller.abort();
        return { ok: true };
      }
      if (message.type === 'translate-selection-fallback') {
        const { key, controller, sourceLanguage, targetLanguage, text, context } = fallbackReservation!;
        try {
          if (controller.signal.aborted) return { ok: false, error: '任务已取消' };
          requireValidConfig(config);
          if (!config.apiKey) throw new Error('请先在设置中填写 API Key');
          const userInstruction = context !== undefined
            ? [config.userInstruction, `以下邻近文本仅用于消歧，不要翻译或输出：${context}`].filter(Boolean).join('\n')
            : config.userInstruction;
          const data = await dependencies.translate({
            sourceLanguage,
            targetLanguage,
            segments: [{ id: 'selection', text }],
            userInstruction,
          }, config, controller.signal);
          if (controller.signal.aborted) return { ok: false, error: '任务已取消' };
          return { ok: true, data };
        } finally {
          if (fallbackTasks.get(key) === controller) fallbackTasks.delete(key);
        }
      }
      if (message.type === 'translate-batch') {
        if (!hasOnlyKeys(message, ['type', 'taskId', 'sourceLanguage', 'targetLanguage', 'segments', 'context'])) return { ok: false, error: '消息格式无效' };
        if (!isSafeId(message.taskId) || !isSafeString(message.sourceLanguage, 64) || !isSafeString(message.targetLanguage, 64)) return { ok: false, error: '消息格式无效' };
        const segments = parseSegments(message.segments);
        if (!segments) return { ok: false, error: '消息格式无效' };
        const key = pageTaskKey(sender, message.taskId);
        if (!key) return { ok: false, error: '消息来源无效' };
        requireValidConfig(config);
        if (!config.apiKey) throw new Error('请先在设置中填写 API Key');
        const controller = new AbortController();
        const controllers = tasks.get(key) ?? new Set<AbortController>();
        controllers.add(controller);
        tasks.set(key, controllers);
        try {
          const results = await dependencies.translate({
            sourceLanguage: message.sourceLanguage,
            targetLanguage: message.targetLanguage,
            segments,
            userInstruction: typeof message.context === 'string' && message.context.length <= 600
              ? [config.userInstruction, `以下邻近文本仅用于消歧，不要翻译或输出：${message.context}`].filter(Boolean).join('\n')
              : config.userInstruction,
          }, config, controller.signal);
          if (controller.signal.aborted) return { ok: false, error: '任务已取消' };
          return { ok: true, data: results };
        } finally {
          controllers.delete(controller);
          if (controllers.size === 0) tasks.delete(key);
        }
      }
    } catch (error) {
      return { ok: false, error: sanitizeError(error, [config.apiKey]) };
    }
    return { ok: false, error: '不支持的消息类型' };
  }

  function sendToActiveTab(message: unknown): void {
    void api.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id !== undefined) return api.tabs.sendMessage(tab.id, message);
    }).catch(() => undefined);
  }

  function register(): void {
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      void handle(message, sender).then(sendResponse);
      return true;
    });
    api.runtime.onConnect.addListener((port) => {
      if (port.name !== 'vast-selection-stream') return;
      const sender = port.sender;
      const tabId = sender?.tab?.id;
      if (sender?.id !== api.runtime.id || tabId === undefined || sender.frameId === undefined || !sender.documentId) {
        port.disconnect();
        return;
      }
      if (selectionPorts.has(tabId)) {
        port.disconnect();
        return;
      }
      selectionPorts.set(tabId, port);
      const controllers = new Map<string, AbortController>();
      port.onMessage.addListener((message: unknown) => {
        if (!isMessage(message)) return;
        if (message.type === 'cancel-selection' && typeof message.requestId === 'string') { controllers.get(message.requestId)?.abort(); controllers.delete(message.requestId); return; }
        if (message.type !== 'translate-selection' || typeof message.text !== 'string') return;
        const now = Date.now();
        const recent = (selectionRequests.get(tabId) ?? []).filter((timestamp) => now - timestamp < 10_000);
        if (recent.length >= 5) {
          port.postMessage({ type: 'selection-error', error: '划词翻译请求过于频繁，请稍后重试' });
          return;
        }
        recent.push(now);
        selectionRequests.set(tabId, recent);
        if (!isSafeId(message.requestId) || !isSafeString(message.text, 5000)) return;
        const text = message.text;
        const requestController = new AbortController();
        const requestId = message.requestId;
        controllers.set(requestId, requestController);
        void readConfig(api).then(async (config) => {
          requireValidConfig(config);
          if (!config.apiKey) throw new Error('请先在设置中填写 API Key');
          for await (const chunk of dependencies.streamSelection(
            text,
            String(message.sourceLanguage ?? 'auto'),
            String(message.targetLanguage ?? config.targetLanguage),
            typeof message.context === 'string' ? message.context : undefined,
            config,
            requestController.signal,
          )) {
            if (!requestController.signal.aborted) port.postMessage({ type: 'selection-chunk', requestId, chunk });
          }
          if (!requestController.signal.aborted) port.postMessage({ type: 'selection-complete', requestId });
        }).catch((error) => {
          if (!requestController.signal.aborted) port.postMessage({ type: 'selection-error', requestId, error: sanitizeError(error) });
        });
      });
      port.onDisconnect.addListener(() => {
        for (const controller of controllers.values()) controller.abort();
        if (selectionPorts.get(tabId) === port) selectionPorts.delete(tabId);
      });
    });
    api.commandsApi.onCommand.addListener((command) => {
      if (command === 'translate_page') sendToActiveTab({ type: 'toggle-page-translation' });
    });
    api.contextMenus.onClicked.addListener((info, tab) => {
      if (tab?.id === undefined) return;
      const messages: Record<string, unknown> = {
        'vast-translate-page': { type: 'translate-page' },
        'vast-restore-page': { type: 'restore-page' },
        'vast-translate-selection': { type: 'translate-selection', source: 'context-menu', text: info.selectionText ?? '' },
      };
      const message = messages[String(info.menuItemId)];
      if (message) void api.tabs.sendMessage(tab.id, message).catch(() => undefined);
    });
    void Promise.resolve(api.contextMenus.removeAll()).then(() => {
      api.contextMenus.create({ id: 'vast-translate-page', title: api.i18n.getMessage?.('menuTranslatePage') || '翻译页面', contexts: ['page'] });
      api.contextMenus.create({ id: 'vast-restore-page', title: api.i18n.getMessage?.('menuRestorePage') || '恢复原文', contexts: ['page'] });
      api.contextMenus.create({ id: 'vast-translate-selection', title: api.i18n.getMessage?.('menuTranslateSelection') || '翻译选中内容', contexts: ['selection'] });
    });
  }

  return { handle, register };
}

function createRuntimeDependencies(): BackgroundDependencies {
  const storage = new IndexedDbCacheStorage();
  const cache = new TranslationCache(storage);
  return {
    async translate(request, config, signal) {
      const client = new OpenAiClient(config);
      const results: TranslationResult[] = [];
      for (const segments of createTranslationBatches(request.segments)) {
        if (signal.aborted) throw new Error('任务已取消');
        const misses: TranslationSegment[] = [];
        const keys = new Map<string, string>();
        for (const segment of segments) {
          const key = await createCacheKey({
            text: segment.text, sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage,
            baseUrl: config.baseUrl, model: config.model, promptVersion: '1', userInstruction: request.userInstruction ?? config.userInstruction,
          });
          keys.set(segment.id, key);
          const cached = await cache.get(key);
          if (cached === undefined) misses.push(segment);
          else results.push({ id: segment.id, text: cached });
        }
        if (misses.length) {
          const translated = await client.translate({ ...request, segments: misses }, signal);
          for (const result of translated) {
            await cache.set(keys.get(result.id)!, result.text);
            results.push(result);
          }
        }
      }
      return orderTranslationResults(request.segments, results);
    },
    streamSelection(text, sourceLanguage, targetLanguage, context, config, signal) {
      return new OpenAiClient(config).streamText(text, sourceLanguage, targetLanguage, signal, context);
    },
    async testConnection(config) {
      await new OpenAiClient(config).translate({ sourceLanguage: 'en', targetLanguage: config.targetLanguage, segments: [{ id: 'test', text: 'test' }] });
    },
    clearCache: () => storage.clear(),
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  createBackgroundController({
    runtime: chrome.runtime,
    commandsApi: chrome.commands,
    contextMenus: chrome.contextMenus,
    tabs: chrome.tabs,
    storage: { local: chrome.storage.local, session: chrome.storage.session },
    i18n: chrome.i18n,
  }, createRuntimeDependencies()).register();
}
