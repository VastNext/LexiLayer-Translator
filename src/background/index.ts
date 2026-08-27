import { createTranslationBatches, orderTranslationResults } from './batching';
import { createCacheKey, IndexedDbCacheStorage, TranslationCache } from './cache';
import { createProvider, streamProviderSelection } from './provider-registry';
import type { Provider } from './provider';
import {
  DEFAULT_SETTINGS, engineReady, exportSafeSettings, importSettings, migrateSettings, normalizeSettings, validateEngine, validateSettings,
  type CustomAiEngine, type Engine, type ReadingPreferences, type Settings,
} from '../shared/config';
import { mapChromeUiLanguage } from '../shared/languages';
import type { TranslationRequest, TranslationResult, TranslationSegment } from '../shared/messages';

type AsyncMessageListener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean | void;

export interface BackgroundChrome {
  runtime: { id: string; sendMessage(message: unknown): Promise<unknown>; onMessage: { addListener(listener: AsyncMessageListener): void }; onConnect: { addListener(listener: (port: chrome.runtime.Port) => void): void } };
  commandsApi: { onCommand: { addListener(listener: (command: string) => void): void } };
  contextMenus: { create(properties: chrome.contextMenus.CreateProperties): void; removeAll(): Promise<void> | void; onClicked: { addListener(listener: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void): void } };
  tabs: { query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>; sendMessage(tabId: number, message: unknown): Promise<unknown> };
  storage: { local: Pick<chrome.storage.StorageArea, 'get' | 'set'> & { setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> }; session?: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  i18n: { getUILanguage(): string; getMessage?(key: string): string };
}

interface CacheLike { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }

export interface BackgroundDependencies {
  createProvider(engine: Engine): Provider;
  translate?(provider: Provider, request: TranslationRequest, signal: AbortSignal): Promise<TranslationResult[]>;
  streamSelection?(provider: Provider, text: string, sourceLanguage: string, targetLanguage: string, userInstruction: string | undefined, context: string | undefined, signal: AbortSignal): AsyncIterable<string>;
  clearCache(): Promise<void>;
}

interface RuntimeDependencyOptions { cache?: CacheLike; createProvider?: (engine: Engine) => Provider }
type IncomingMessage = Record<string, unknown> & { type: string };
const allowedTypes = new Set([
  'translate-batch', 'cancel-task', 'get-public-config', 'get-popup-config', 'get-options-settings',
  'test-engine', 'translate-selection-fallback', 'cancel-selection-fallback', 'clear-cache',
  'save-reading-preferences', 'upsert-engine', 'delete-engine', 'set-active-engine', 'set-engine-enabled', 'reorder-engines', 'import-settings',
  'save-popup-preferences',
  'clear-engine-api-key',
  'page-progress', 'get-page-progress',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || (Object.prototype.hasOwnProperty.call(prototype, 'hasOwnProperty') && Object.getPrototypeOf(prototype) === null);
}
function isMessage(value: unknown): value is IncomingMessage { return isRecord(value) && typeof value.type === 'string'; }
function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function isSafeString(value: unknown, max = 10_000): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function isSafeId(value: unknown): value is string { return isSafeString(value, 200) && !['__proto__', 'prototype', 'constructor'].includes(value); }

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

function sameOrigin(left: string, right: string): boolean {
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
}

function requireEngine(settings: Settings, engineId: string): Engine {
  const engine = settings.engines.find((candidate) => candidate.id === engineId);
  if (!engine) throw new Error('翻译引擎不存在');
  if (!engine.enabled) throw new Error('翻译引擎已停用');
  if (!engineReady(engine)) throw new Error('翻译引擎尚未配置');
  return engine;
}

function effectivePreferences(settings: Settings, api: BackgroundChrome): ReadingPreferences {
  const preferences = structuredClone(settings.readingPreferences);
  if (preferences.targetLanguage === 'auto') preferences.targetLanguage = mapChromeUiLanguage(api.i18n.getUILanguage());
  return preferences;
}

function publicConfig(settings: Settings, api: BackgroundChrome, dependencies: BackgroundDependencies) {
  return {
    preferences: effectivePreferences(settings, api),
    activeEngineId: settings.activeEngineId,
    availableEngines: settings.engines.map((engine) => {
      let capabilities = { streaming: engine.kind === 'custom-ai' };
      if (engineReady(engine)) {
        try { capabilities = dependencies.createProvider(engine).capabilities; } catch { /* 摘要保持未就绪。 */ }
      }
      return { id: engine.id, kind: engine.kind, name: engine.name, ready: engineReady(engine), capabilities };
    }),
  };
}

export async function readSettings(api: BackgroundChrome): Promise<Settings> {
  const stored = await api.storage.local.get(['translatorSettings', 'translatorConfig']) as { translatorSettings?: unknown; translatorConfig?: unknown };
  if (stored.translatorSettings !== undefined) {
    const settings = normalizeSettings(stored.translatorSettings);
    const raw = stored.translatorSettings as { mvpDefaultsVersion?: number };
    if (raw?.mvpDefaultsVersion !== 1) {
      settings.mvpDefaultsVersion = 1;
      settings.readingPreferences.targetLanguage = 'auto';
      settings.readingPreferences.scanScope = 'whole-page';
      await api.storage.local.set({ translatorSettings: settings });
    }
    return settings;
  }
  if (stored.translatorConfig !== undefined) {
    const migrated = migrateSettings(stored.translatorConfig);
    await api.storage.local.set({ translatorSettings: migrated });
    return migrated;
  }
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.readingPreferences.targetLanguage = mapChromeUiLanguage(api.i18n.getUILanguage());
  return settings;
}

export function sanitizeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : '';
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[已隐藏]');
  message = message.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, '$1[已隐藏]');
  if (/Google.*(?:429|请求过于频繁)/i.test(message)) return 'Google 翻译请求过于频繁，请稍后重试或切换到 Bing';
  if (/^(?:Google|Bing) 翻译/u.test(message)) return message;
  const safe = /^[\u3400-\u9fff]/u.test(message) && !/https?:\/\//i.test(message);
  return safe ? message : '请求处理失败，请检查配置或网络后重试';
}

export function createRuntimeDependencies(options: RuntimeDependencyOptions = {}): BackgroundDependencies {
  const storage = options.cache ? undefined : new IndexedDbCacheStorage();
  const cache = options.cache ?? new TranslationCache(storage!);
  const providerFactory = options.createProvider ?? createProvider;
  return {
    createProvider: providerFactory,
    async translate(provider, request, signal) {
      const results: TranslationResult[] = [];
      for (const segments of createTranslationBatches(request.segments)) {
        if (signal.aborted) throw new Error('任务已取消');
        const misses: TranslationSegment[] = [];
        const keys = new Map<string, string>();
        for (const segment of segments) {
          const identity = provider.cacheIdentity;
          const key = await createCacheKey({
            text: segment.text, sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage,
            ...identity, promptVersion: '1',
            effectiveInstruction: identity.engineId.startsWith('custom-') ? request.userInstruction ?? '' : '',
          });
          keys.set(segment.id, key);
          const cached = await cache.get(key).catch(() => undefined);
          if (cached === undefined) misses.push(segment); else results.push({ id: segment.id, text: cached });
        }
        if (misses.length) {
          const translated = await provider.translate({ ...request, segments: misses }, signal);
          for (const result of translated) { await cache.set(keys.get(result.id)!, result.text).catch(() => undefined); results.push(result); }
        }
      }
      return orderTranslationResults(request.segments, results);
    },
    streamSelection: (provider, text, source, target, userInstruction, context, signal) => streamProviderSelection(provider, text, source, target, userInstruction, context, signal),
    clearCache: () => storage?.clear() ?? Promise.resolve(),
  };
}

export function createBackgroundController(api: BackgroundChrome, dependencies: BackgroundDependencies) {
  const tasks = new Map<string, Set<AbortController>>();
  const fallbackTasks = new Map<string, AbortController>();
  const selectionPorts = new Map<number, chrome.runtime.Port>();
  const selectionRequests = new Map<number, number[]>();
  let settingsMutationQueue = Promise.resolve();
  const settingsMutationTypes = new Set([
    'save-reading-preferences', 'upsert-engine', 'delete-engine', 'set-active-engine', 'set-engine-enabled',
    'save-popup-preferences',
    'reorder-engines', 'import-settings', 'clear-engine-api-key',
  ]);
  const translateWithProvider = (provider: Provider, request: TranslationRequest, signal: AbortSignal) => dependencies.translate?.(provider, request, signal) ?? provider.translate(request, signal);
  const streamWithProvider = (provider: Provider, text: string, source: string, target: string, userInstruction: string | undefined, context: string | undefined, signal: AbortSignal) => dependencies.streamSelection?.(provider, text, source, target, userInstruction, context, signal) ?? streamProviderSelection(provider, text, source, target, userInstruction, context, signal);

  async function saveSettings(settings: Settings): Promise<void> {
    const errors = validateSettings(settings);
    if (errors.length) throw new Error(errors[0]);
    await api.storage.local.set({ translatorSettings: settings });
  }

  function withSettingsMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = settingsMutationQueue.then(mutation, mutation);
    settingsMutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    if (sender.id !== api.runtime.id) return { ok: false, error: '消息来源无效' };
    if (!isMessage(message) || !allowedTypes.has(message.type)) return { ok: false, error: '不支持的消息类型' };
    if (message.type === 'cancel-selection-fallback') {
      if (!hasOnlyKeys(message, ['type', 'requestId']) || !isSafeId(message.requestId)) return { ok: false, error: '消息格式无效' };
      const key = pageTaskKey(sender, message.requestId);
      if (!key) return { ok: false, error: '消息来源无效' };
      fallbackTasks.get(key)?.abort(); fallbackTasks.delete(key); return { ok: true };
    }
    let fallbackReservation: { key: string; controller: AbortController; engineId: string; sourceLanguage: string; targetLanguage: string; text: string; context?: string } | undefined;
    if (message.type === 'translate-selection-fallback') {
      if (!hasOnlyKeys(message, ['type', 'requestId', 'engineId', 'sourceLanguage', 'targetLanguage', 'text', 'context']) || !isSafeId(message.requestId) || !isSafeId(message.engineId) || !isSafeString(message.sourceLanguage, 64) || !isSafeString(message.targetLanguage, 64) || !isSafeString(message.text, 5000) || (message.context !== undefined && (typeof message.context !== 'string' || message.context.length > 600))) return { ok: false, error: '消息格式无效' };
      const key = pageTaskKey(sender, message.requestId); if (!key) return { ok: false, error: '消息来源无效' };
      fallbackTasks.get(key)?.abort();
      const controller = new AbortController(); fallbackTasks.set(key, controller);
      fallbackReservation = { key, controller, engineId: message.engineId, sourceLanguage: message.sourceLanguage, targetLanguage: message.targetLanguage, text: message.text, context: typeof message.context === 'string' ? message.context : undefined };
    }
    const execute = async (): Promise<unknown> => {
      let secrets: string[] = [];
      try {
      const settings = await readSettings(api);
      secrets = settings.engines.filter((engine): engine is CustomAiEngine => engine.kind === 'custom-ai').map((engine) => engine.apiKey);
      if (message.type === 'get-public-config' || message.type === 'get-popup-config') return { ok: true, data: publicConfig(settings, api, dependencies) };
      if (message.type === 'get-options-settings') {
        const safe = exportSafeSettings(settings);
        return { ok: true, data: { ...safe, engines: safe.engines.map((engine) => {
          const original = settings.engines.find((item): item is CustomAiEngine => item.id === engine.id && item.kind === 'custom-ai');
          return { ...engine, ...(engine.kind === 'custom-ai' ? { hasApiKey: Boolean(original?.apiKey) } : {}) };
        }) } };
      }
      if (message.type === 'clear-cache') { await dependencies.clearCache(); return { ok: true }; }
      if (message.type === 'save-reading-preferences') {
        if (!hasOnlyKeys(message, ['type', 'readingPreferences'])) return { ok: false, error: '消息格式无效' };
        const candidate = { ...settings, readingPreferences: message.readingPreferences as ReadingPreferences };
        await saveSettings(candidate); return { ok: true };
      }
      if (message.type === 'save-popup-preferences') {
        if (!hasOnlyKeys(message, ['type', 'engineId', 'readingPreferences']) || !isSafeId(message.engineId)) return { ok: false, error: '消息格式无效' };
        requireEngine(settings, message.engineId);
        const candidate = { ...settings, activeEngineId: message.engineId, readingPreferences: message.readingPreferences as ReadingPreferences };
        await saveSettings(candidate);
        return { ok: true };
      }
      if (message.type === 'set-active-engine') {
        if (!hasOnlyKeys(message, ['type', 'engineId']) || !isSafeId(message.engineId)) return { ok: false, error: '消息格式无效' };
        requireEngine(settings, message.engineId); await saveSettings({ ...settings, activeEngineId: message.engineId }); return { ok: true };
      }
      if (message.type === 'set-engine-enabled') {
        if (!hasOnlyKeys(message, ['type', 'engineId', 'enabled']) || !isSafeId(message.engineId) || typeof message.enabled !== 'boolean') return { ok: false, error: '消息格式无效' };
        const engine = settings.engines.find((item) => item.id === message.engineId);
        if (!engine) return { ok: false, error: '翻译引擎不存在' };
        const engines = settings.engines.map((item) => item.id === engine.id ? { ...item, enabled: message.enabled as boolean } : item) as Engine[];
        const ready = engines.filter(engineReady);
        if (!ready.length) return { ok: false, error: '至少保留一个可用的翻译引擎' };
        const activeEngineId = !message.enabled && settings.activeEngineId === engine.id
          ? (ready.find((item) => item.id === 'google') ?? ready[0]).id
          : settings.activeEngineId;
        await saveSettings({ ...settings, engines, activeEngineId }); return { ok: true };
      }
      if (message.type === 'reorder-engines') {
        if (!hasOnlyKeys(message, ['type', 'engineIds']) || !Array.isArray(message.engineIds) || message.engineIds.some((id) => !isSafeId(id))) return { ok: false, error: '消息格式无效' };
        const ids = message.engineIds as string[];
        const existingIds = settings.engines.map(({ id }) => id);
        if (ids.length !== existingIds.length || new Set(ids).size !== ids.length || ids.some((id) => !existingIds.includes(id))) return { ok: false, error: '翻译引擎排序无效' };
        const engines = ids.map((id, order) => ({ ...settings.engines.find((engine) => engine.id === id)!, order }));
        await saveSettings({ ...settings, engines }); return { ok: true };
      }
      if (message.type === 'import-settings') {
        if (!hasOnlyKeys(message, ['type', 'settings'])) return { ok: false, error: '消息格式无效' };
        await saveSettings(importSettings(message.settings, settings)); return { ok: true };
      }
      if (message.type === 'upsert-engine') {
        if (!hasOnlyKeys(message, ['type', 'engine']) || validateEngine(message.engine).length) return { ok: false, error: '消息格式无效' };
        let engine = message.engine as unknown as Engine;
        if (engine.kind !== 'custom-ai') return { ok: false, error: '只能编辑自定义 AI 实例' };
        const existing = settings.engines.find((item) => item.id === engine.id);
        if (engine.kind === 'custom-ai' && !engine.apiKey && existing?.kind === 'custom-ai' && sameOrigin(engine.baseUrl, existing.baseUrl)) engine = { ...engine, apiKey: existing.apiKey };
        const engines = settings.engines.some((item) => item.id === engine.id) ? settings.engines.map((item) => item.id === engine.id ? engine : item) : [...settings.engines, engine];
        await saveSettings({ ...settings, engines }); return { ok: true };
      }
      if (message.type === 'clear-engine-api-key') {
        if (!hasOnlyKeys(message, ['type', 'engineId']) || !isSafeId(message.engineId)) return { ok: false, error: '消息格式无效' };
        const engine = settings.engines.find((item) => item.id === message.engineId);
        if (engine?.kind !== 'custom-ai') return { ok: false, error: '翻译引擎不存在' };
        const engines = settings.engines.map((item) => item.id === engine.id ? { ...engine, apiKey: '' } : item);
        const ready = engines.filter(engineReady);
        if (!ready.length) return { ok: false, error: '至少保留一个可用的翻译引擎' };
        const activeEngineId = settings.activeEngineId === engine.id
          ? (ready.find((item) => item.id === 'google') ?? ready.find((item) => item.id === 'bing') ?? ready[0]).id
          : settings.activeEngineId;
        await saveSettings({ ...settings, engines, activeEngineId });
        return { ok: true };
      }
      if (message.type === 'delete-engine') {
        if (!hasOnlyKeys(message, ['type', 'engineId']) || !isSafeId(message.engineId) || ['google', 'bing'].includes(message.engineId)) return { ok: false, error: '消息格式无效' };
        if (!settings.engines.some((engine) => engine.id === message.engineId && engine.kind === 'custom-ai')) return { ok: false, error: '翻译引擎不存在' };
        const engines = settings.engines.filter((engine) => engine.id !== message.engineId);
        const ready = engines.filter(engineReady);
        if (!ready.length) return { ok: false, error: '至少保留一个可用的翻译引擎' };
        const activeEngineId = settings.activeEngineId === message.engineId
          ? (ready.find((engine) => engine.id === 'google') ?? ready.find((engine) => engine.id === 'bing') ?? ready[0]).id
          : settings.activeEngineId;
        await saveSettings({ ...settings, engines, activeEngineId }); return { ok: true };
      }
      if (message.type === 'test-engine') {
        if (!hasOnlyKeys(message, ['type', 'engineId', 'candidate']) || (message.engineId !== undefined && !isSafeId(message.engineId))) return { ok: false, error: '消息格式无效' };
        let engine: Engine;
        if (message.candidate !== undefined) {
          if (validateEngine(message.candidate).length) return { ok: false, error: '消息格式无效' };
          engine = message.candidate as unknown as Engine;
          const existing = settings.engines.find((item) => item.id === message.engineId);
          if (engine.kind === 'custom-ai' && !engine.apiKey && existing?.kind === 'custom-ai' && sameOrigin(engine.baseUrl, existing.baseUrl)) engine = { ...engine, apiKey: existing.apiKey };
          if (!engineReady(engine)) throw new Error('翻译引擎尚未配置');
        } else engine = requireEngine(settings, String(message.engineId ?? settings.activeEngineId));
        await dependencies.createProvider(engine).testConnection(); return { ok: true };
      }
      if (message.type === 'page-progress') {
        if (!isRecord(message.progress) || !hasOnlyKeys(message, ['type', 'progress'])) return { ok: false, error: '消息格式无效' };
        const { status, completed, failed, total, engineId } = message.progress;
        if (!['idle', 'translating', 'complete', 'partial', 'error'].includes(String(status)) || ![completed, failed, total].every((value) => Number.isInteger(value) && Number(value) >= 0) || (engineId !== undefined && !isSafeId(engineId))) return { ok: false, error: '消息格式无效' };
        if (sender.tab?.id === undefined || sender.frameId === undefined || !api.storage.session) return { ok: false, error: '消息来源无效' };
        const key = `${sender.tab.id}:${sender.frameId}`;
        const progress = { status: String(status), completed: Number(completed), failed: Number(failed), total: Number(total), ...(engineId ? { engineId } : {}) };
        const value = await api.storage.session.get('pageProgress'); const stored = isRecord(value.pageProgress) ? value.pageProgress : {};
        await api.storage.session.set({ pageProgress: { ...stored, [key]: progress } });
        void api.runtime.sendMessage({ type: 'page-progress', tabId: sender.tab.id, frameId: sender.frameId, progress }); return { ok: true };
      }
      if (message.type === 'get-page-progress') {
        if (!hasOnlyKeys(message, ['type', 'tabId', 'frameId']) || !Number.isInteger(message.tabId) || !Number.isInteger(message.frameId) || !api.storage.session) return { ok: false, error: '消息格式无效' };
        const value = await api.storage.session.get('pageProgress'); const stored = isRecord(value.pageProgress) ? value.pageProgress : {};
        return { ok: true, data: stored[`${Number(message.tabId)}:${Number(message.frameId)}`] };
      }
      if (message.type === 'cancel-task') {
        if (!hasOnlyKeys(message, ['type', 'taskId']) || !isSafeId(message.taskId)) return { ok: false, error: '消息格式无效' };
        const key = pageTaskKey(sender, message.taskId); if (!key) return { ok: false, error: '消息来源无效' };
        for (const controller of tasks.get(key) ?? []) controller.abort(); return { ok: true };
      }
      if (message.type === 'translate-selection-fallback') {
        const reservation = fallbackReservation!;
        const engine = requireEngine(settings, reservation.engineId);
        if (engine.kind !== 'custom-ai') return { ok: false, error: '内置翻译引擎不需要回退请求' };
        const { key, controller } = reservation;
        try {
          if (controller.signal.aborted) return { ok: false, error: '任务已取消' };
          const instruction = [settings.readingPreferences.userInstruction, reservation.context ? `以下邻近文本仅用于消歧，不要翻译或输出：${reservation.context}` : ''].filter(Boolean).join('\n');
          const data = await translateWithProvider(dependencies.createProvider(engine), { sourceLanguage: reservation.sourceLanguage, targetLanguage: reservation.targetLanguage, segments: [{ id: 'selection', text: reservation.text }], userInstruction: instruction }, controller.signal);
          if (controller.signal.aborted) return { ok: false, error: '任务已取消' }; return { ok: true, data };
        } finally { if (fallbackTasks.get(key) === controller) fallbackTasks.delete(key); }
      }
      if (message.type === 'translate-batch') {
        if (!hasOnlyKeys(message, ['type', 'taskId', 'engineId', 'sourceLanguage', 'targetLanguage', 'segments', 'context']) || !isSafeId(message.taskId) || !isSafeId(message.engineId) || !isSafeString(message.sourceLanguage, 64) || !isSafeString(message.targetLanguage, 64)) return { ok: false, error: '消息格式无效' };
        const segments = parseSegments(message.segments); if (!segments) return { ok: false, error: '消息格式无效' };
        const key = pageTaskKey(sender, message.taskId); if (!key) return { ok: false, error: '消息来源无效' };
        const engine = requireEngine(settings, message.engineId); const provider = dependencies.createProvider(engine);
        const controller = new AbortController(); const controllers = tasks.get(key) ?? new Set<AbortController>(); controllers.add(controller); tasks.set(key, controllers);
        try {
          const context = typeof message.context === 'string' && message.context.length <= 600 ? `以下邻近文本仅用于消歧，不要翻译或输出：${message.context}` : '';
          const instruction = engine.kind === 'custom-ai' ? [settings.readingPreferences.userInstruction, context].filter(Boolean).join('\n') : undefined;
          const data = await translateWithProvider(provider, { sourceLanguage: message.sourceLanguage, targetLanguage: message.targetLanguage, segments, userInstruction: instruction }, controller.signal);
          if (controller.signal.aborted) return { ok: false, error: '任务已取消' }; return { ok: true, data };
        } finally { controllers.delete(controller); if (!controllers.size) tasks.delete(key); }
      }
      } catch (error) { return { ok: false, error: sanitizeError(error, secrets) }; }
      finally {
        if (fallbackReservation && fallbackTasks.get(fallbackReservation.key) === fallbackReservation.controller) fallbackTasks.delete(fallbackReservation.key);
      }
      return { ok: false, error: '不支持的消息类型' };
    };
    return settingsMutationTypes.has(message.type) ? withSettingsMutation(execute) : execute();
  }

  function sendToActiveTab(message: unknown): void { void api.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab?.id === undefined ? undefined : api.tabs.sendMessage(tab.id, message)).catch(() => undefined); }

  function register(): void {
    void api.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
    api.runtime.onMessage.addListener((message, sender, respond) => {
      void handle(message, sender).then(respond).catch((error) => respond({ ok: false, error: sanitizeError(error) }));
      return true;
    });
    api.runtime.onConnect.addListener((port) => {
      if (port.name !== 'vast-selection-stream') return;
      const sender = port.sender; const tabId = sender?.tab?.id;
      if (sender?.id !== api.runtime.id || tabId === undefined || sender.frameId === undefined || !sender.documentId || selectionPorts.has(tabId)) { port.disconnect(); return; }
      selectionPorts.set(tabId, port); const controllers = new Map<string, AbortController>();
      port.onMessage.addListener((message: unknown) => {
        if (!isMessage(message)) return;
        if (message.type === 'cancel-selection' && isSafeId(message.requestId)) { controllers.get(message.requestId)?.abort(); controllers.delete(message.requestId); return; }
        if (message.type !== 'translate-selection' || !isSafeId(message.requestId) || !isSafeId(message.engineId) || !isSafeString(message.text, 5000)) return;
        const now = Date.now(); const recent = (selectionRequests.get(tabId) ?? []).filter((timestamp) => now - timestamp < 10_000);
        if (recent.length >= 5) { port.postMessage({ type: 'selection-error', requestId: message.requestId, engineId: message.engineId, canFallback: false, error: '划词翻译请求过于频繁，请稍后重试' }); return; }
        recent.push(now); selectionRequests.set(tabId, recent);
        const requestId = message.requestId; const engineId = message.engineId; const text = message.text; const controller = new AbortController(); controllers.set(requestId, controller);
        void (async () => {
          let canFallback = false;
          try {
            const settings = await readSettings(api);
            const engine = requireEngine(settings, engineId);
            canFallback = engine.kind === 'custom-ai';
            const provider = dependencies.createProvider(engine);
            const instruction = engine.kind === 'custom-ai' ? settings.readingPreferences.userInstruction : undefined;
            const context = typeof message.context === 'string' ? message.context.slice(0, 600) : undefined;
            for await (const chunk of streamWithProvider(provider, text, String(message.sourceLanguage ?? 'auto'), String(message.targetLanguage ?? settings.readingPreferences.targetLanguage), instruction, context, controller.signal)) {
              if (!controller.signal.aborted) port.postMessage({ type: 'selection-chunk', requestId, engineId, chunk });
            }
            if (!controller.signal.aborted) port.postMessage({ type: 'selection-complete', requestId, engineId });
          } catch (error) {
            if (!controller.signal.aborted) port.postMessage({ type: 'selection-error', requestId, engineId, canFallback, error: sanitizeError(error) });
          } finally {
            if (controllers.get(requestId) === controller) controllers.delete(requestId);
          }
        })();
      });
      port.onDisconnect.addListener(() => { for (const controller of controllers.values()) controller.abort(); if (selectionPorts.get(tabId) === port) selectionPorts.delete(tabId); });
    });
    api.commandsApi.onCommand.addListener((command) => { if (command === 'translate_page') sendToActiveTab({ type: 'toggle-page-translation' }); });
    api.contextMenus.onClicked.addListener((info, tab) => {
      if (tab?.id === undefined) return;
      const messages: Record<string, unknown> = { 'vast-translate-page': { type: 'translate-page' }, 'vast-restore-page': { type: 'restore-page' }, 'vast-translate-selection': { type: 'translate-selection', source: 'context-menu', text: info.selectionText ?? '' } };
      const message = messages[String(info.menuItemId)]; if (message) void api.tabs.sendMessage(tab.id, message).catch(() => undefined);
    });
    void Promise.resolve(api.contextMenus.removeAll()).then(() => {
      api.contextMenus.create({ id: 'vast-translate-page', title: api.i18n.getMessage?.('menuTranslatePage') || '翻译页面', contexts: ['page'] });
      api.contextMenus.create({ id: 'vast-restore-page', title: api.i18n.getMessage?.('menuRestorePage') || '恢复原文', contexts: ['page'] });
      api.contextMenus.create({ id: 'vast-translate-selection', title: api.i18n.getMessage?.('menuTranslateSelection') || '翻译选中内容', contexts: ['selection'] });
    });
  }
  return { handle, register };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  createBackgroundController({ runtime: chrome.runtime, commandsApi: chrome.commands, contextMenus: chrome.contextMenus, tabs: chrome.tabs, storage: { local: chrome.storage.local, session: chrome.storage.session }, i18n: chrome.i18n }, createRuntimeDependencies()).register();
}
