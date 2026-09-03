import { assertSafeBaseUrl } from './url';
import { canonicalExpertId, defaultExperts, MAX_EXPERTS, MAX_EXPERT_PROMPT_LENGTH, type Expert } from './experts';

export type DisplayMode = 'bilingual' | 'translation';
export type InlineSelectionModifier = 'Control' | 'Alt' | 'Shift' | 'Meta' | 'Off';
export type Theme = 'pearl-reader' | 'command-translator' | 'sage-global' | 'editorial-lingua' | 'precision-blue';

export const THEMES: Theme[] = ['pearl-reader', 'command-translator', 'sage-global', 'editorial-lingua', 'precision-blue'];

export interface ReadingPreferences {
  sourceLanguage?: string;
  targetLanguage: string;
  displayMode: DisplayMode;
  userInstruction: string;
  translationPosition: 'before' | 'after';
  scanScope: 'main-content' | 'whole-page';
  selectionContext: boolean;
  selectionPopupEnabled: boolean;
  inlineSelectionModifier: InlineSelectionModifier;
}

interface EngineBase {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
}

export interface GoogleEngine extends EngineBase {
  id: 'google';
  kind: 'google';
}

export interface BingEngine extends EngineBase {
  id: 'bing';
  kind: 'bing';
}

export interface CustomAiEngine extends EngineBase {
  kind: 'custom-ai';
  baseUrl: string;
  model: string;
  apiKey: string;
}

export type Engine = GoogleEngine | BingEngine | CustomAiEngine;

export interface Settings {
  schemaVersion: 2;
  mvpDefaultsVersion?: 1;
  expertDefaultsVersion?: 6;
  theme: Theme;
  readingPreferences: ReadingPreferences;
  engines: Engine[];
  activeEngineId: string;
  experts?: Expert[];
  activeExpertByEngine?: Record<string, string>;
}

export type PublicEngineSummary = Pick<Engine, 'id' | 'kind' | 'name' | 'enabled' | 'order'>;
export type SafeEngine = GoogleEngine | BingEngine | Omit<CustomAiEngine, 'apiKey'>;
export type SafeSettings = Omit<Settings, 'engines'> & { engines: SafeEngine[] };
export type OptionsEngine = GoogleEngine | BingEngine | (Omit<CustomAiEngine, 'apiKey'> & { hasApiKey: boolean });
export type OptionsSettings = Omit<Settings, 'engines'> & { engines: OptionsEngine[] };

export const MAX_CUSTOM_ENGINES = 20;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 2,
  mvpDefaultsVersion: 1,
  expertDefaultsVersion: 6,
  theme: 'pearl-reader',
  readingPreferences: {
    sourceLanguage: 'auto',
    targetLanguage: 'auto',
    displayMode: 'bilingual',
    userInstruction: '',
    translationPosition: 'after',
    scanScope: 'whole-page',
    selectionContext: true,
    selectionPopupEnabled: true,
    inlineSelectionModifier: 'Control',
  },
  engines: [
    { id: 'google', kind: 'google', name: 'Google', enabled: true, order: 0 },
    { id: 'bing', kind: 'bing', name: 'Bing', enabled: true, order: 1 },
  ],
  activeEngineId: 'google',
  experts: defaultExperts(),
  activeExpertByEngine: {},
};

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CUSTOM_ID = /^custom-[a-z0-9](?:[a-z0-9-]{0,62})$/;

export function engineReady(engine: Engine): boolean {
  return engine.enabled && (engine.kind !== 'custom-ai' || Boolean(engine.baseUrl.trim() && engine.model.trim() && engine.apiKey.trim()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePreferences(value: unknown): string[] {
  if (!isRecord(value)) return ['阅读偏好必须是对象'];
  const errors: string[] = [];
  if (value.sourceLanguage !== undefined && (typeof value.sourceLanguage !== 'string' || !value.sourceLanguage.trim())) errors.push('源语言不能为空');
  if (typeof value.targetLanguage !== 'string' || !value.targetLanguage.trim()) errors.push('目标语言不能为空');
  if (value.displayMode !== 'bilingual' && value.displayMode !== 'translation') errors.push('显示模式无效');
  if (typeof value.userInstruction !== 'string') errors.push('用户要求必须是字符串');
  if (value.translationPosition !== 'before' && value.translationPosition !== 'after') errors.push('译文位置无效');
  if (value.scanScope !== 'main-content' && value.scanScope !== 'whole-page') errors.push('翻译范围无效');
  if (typeof value.selectionContext !== 'boolean') errors.push('有限上下文配置无效');
  if (typeof value.selectionPopupEnabled !== 'boolean') errors.push('划词悬浮按钮配置无效');
  if (!['Control', 'Alt', 'Shift', 'Meta', 'Off'].includes(String(value.inlineSelectionModifier))) errors.push('选区内联翻译快捷键无效');
  return errors;
}

export function validateEngine(engine: unknown): string[] {
  if (!isRecord(engine)) return ['翻译引擎必须是对象'];
  const errors: string[] = [];
  if (typeof engine.name !== 'string' || !engine.name.trim()) errors.push('翻译引擎名称不能为空');
  if (typeof engine.enabled !== 'boolean') errors.push('翻译引擎启用状态无效');
  if (!Number.isInteger(engine.order) || Number(engine.order) < 0) errors.push('翻译引擎顺序无效');

  if (engine.kind === 'google') {
    if (engine.id !== 'google') errors.push('Google 翻译引擎 ID 无效');
  } else if (engine.kind === 'bing') {
    if (engine.id !== 'bing') errors.push('Bing 翻译引擎 ID 无效');
  } else if (engine.kind === 'custom-ai') {
    if (typeof engine.id !== 'string' || !CUSTOM_ID.test(engine.id) || engine.id === 'google' || engine.id === 'bing' || DANGEROUS_KEYS.has(engine.id)) {
      errors.push('自定义翻译引擎 ID 无效');
    }
    if (typeof engine.baseUrl !== 'string' || !engine.baseUrl.trim()) {
      errors.push('Base URL 不能为空');
    } else {
      try { assertSafeBaseUrl(engine.baseUrl); } catch (error) { errors.push(error instanceof Error ? error.message : 'Base URL 无效'); }
    }
      if (typeof engine.model !== 'string' || !engine.model.trim()) errors.push('模型不能为空');
    if (typeof engine.apiKey !== 'string') errors.push('API Key 必须是字符串');
  } else {
    errors.push('翻译引擎类型无效');
  }
  return errors;
}

export function validateSettings(settings: unknown): string[] {
  if (!isRecord(settings)) return ['设置必须是对象'];
  const errors: string[] = [];
  if (settings.schemaVersion !== 2) errors.push('设置版本无效');
  if (!THEMES.includes(settings.theme as Theme)) errors.push('外观主题无效');
  errors.push(...validatePreferences(settings.readingPreferences));
  if (settings.experts !== undefined && (!Array.isArray(settings.experts) || settings.experts.length > MAX_EXPERTS)) errors.push('AI 专家列表无效');
  else if (Array.isArray(settings.experts)) {
    const expertIds = settings.experts.map((expert) => isRecord(expert) ? expert.id : undefined);
    if (expertIds.some((id) => typeof id !== 'string') || new Set(expertIds).size !== expertIds.length) errors.push('AI 专家 ID 不能重复');
    for (const expert of settings.experts) {
      if (!isRecord(expert) || !['builtin', 'custom'].includes(String(expert.kind)) || typeof expert.id !== 'string' || typeof expert.name !== 'string' || !expert.name.trim() || typeof expert.description !== 'string' || (expert.kind === 'custom' && (typeof expert.prompt !== 'string' || !expert.prompt.trim())) || (expert.prompt !== undefined && typeof expert.prompt !== 'string') || (typeof expert.prompt === 'string' && expert.prompt.length > MAX_EXPERT_PROMPT_LENGTH) || typeof expert.enabled !== 'boolean' || !Number.isInteger(expert.order)) errors.push('AI 专家配置无效');
      if (isRecord(expert) && expert.kind === 'builtin' && !defaultExperts().some((item) => item.id === expert.id)) errors.push('内置 AI 专家来源无效');
      if (isRecord(expert) && expert.kind === 'custom' && defaultExperts().some((item) => item.id === expert.id)) errors.push('自定义 AI 专家不能使用内置 ID');
    }
  }
  if (settings.activeExpertByEngine !== undefined && !isRecord(settings.activeExpertByEngine)) errors.push('AI 专家选择无效');
  if (!Array.isArray(settings.engines)) {
    errors.push('翻译引擎列表无效');
  } else {
    settings.engines.forEach((engine) => errors.push(...validateEngine(engine)));
    const ids = settings.engines.filter(isRecord).map((engine) => engine.id);
    if (new Set(ids).size !== ids.length) errors.push('翻译引擎 ID 不能重复');
    if (settings.engines.filter((engine) => isRecord(engine) && engine.kind === 'custom-ai').length > MAX_CUSTOM_ENGINES) {
      errors.push(`自定义翻译引擎不能超过 ${MAX_CUSTOM_ENGINES} 个`);
    }
    const google = settings.engines.filter((engine) => isRecord(engine) && engine.id === 'google' && engine.kind === 'google');
    const bing = settings.engines.filter((engine) => isRecord(engine) && engine.id === 'bing' && engine.kind === 'bing');
    if (google.length !== 1 || bing.length !== 1) errors.push('必须包含唯一的 Google 和 Bing 翻译引擎');
    if (typeof settings.activeEngineId !== 'string' || !ids.includes(settings.activeEngineId)) errors.push('当前翻译引擎无效');
    const engines = settings.engines.filter((engine): engine is Engine => validateEngine(engine).length === 0);
    const ready = engines.filter(engineReady);
    if (!ready.length) errors.push('至少保留一个可用的翻译引擎');
    if (typeof settings.activeEngineId === 'string' && ids.includes(settings.activeEngineId)
      && !ready.some((engine) => engine.id === settings.activeEngineId)) errors.push('当前翻译引擎必须可用');
  }
  return errors;
}

export function resolveEngine(settings: Settings, engineId = settings.activeEngineId): Engine {
  return settings.engines.find((engine) => engine.id === engineId && engineReady(engine))
    ?? settings.engines.find((engine) => engine.id === 'google' && engineReady(engine))
    ?? settings.engines.find(engineReady)
    ?? DEFAULT_SETTINGS.engines[0];
}

export function getPublicEngineSummaries(settings: Settings): PublicEngineSummary[] {
  return settings.engines.map(({ id, kind, name, enabled, order }) => ({ id, kind, name, enabled, order }));
}

function cloneDefaults(): Settings {
  return structuredClone(DEFAULT_SETTINGS);
}

function migrateExpertDefaults(value: Record<string, unknown>): void {
  if (!Array.isArray(value.experts)) value.experts = defaultExperts();
  if (!isRecord(value.activeExpertByEngine)) value.activeExpertByEngine = {};
  if (value.expertDefaultsVersion === 6) return;
  const legacyExperts = (value.experts as unknown[]).filter((expert): expert is Expert => isRecord(expert)
    && typeof expert.id === 'string'
    && (expert.kind === 'builtin' || expert.kind === 'custom'));
  const existing = new Map(legacyExperts.map((expert) => [canonicalExpertId(expert.id), expert]));
  const builtins = defaultExperts().map((expert) => {
    const previous = existing.get(expert.id);
    return previous?.kind === 'builtin' ? { ...expert, enabled: previous.enabled } : expert;
  });
  const custom = legacyExperts.filter((expert) => expert.kind === 'custom');
  value.expertDefaultsVersion = 6;
  value.experts = [...builtins, ...custom].map((expert, order) => ({ ...expert, order }));
  value.activeExpertByEngine = Object.fromEntries(Object.entries(value.activeExpertByEngine as Record<string, string>)
    .filter(([, expertId]) => typeof expertId === 'string')
    .map(([engineId, expertId]) => [engineId, canonicalExpertId(expertId)])
    .filter(([, expertId]) => (value.experts as Expert[]).some((expert) => expert.id === expertId && expert.enabled)));
}

export function normalizeSettings(value: unknown): Settings {
  if (!isRecord(value) || value.schemaVersion !== 2) return cloneDefaults();
  const normalizedValue = structuredClone(value) as Record<string, unknown>;
  if (normalizedValue.theme === undefined) normalizedValue.theme = DEFAULT_SETTINGS.theme;
  migrateExpertDefaults(normalizedValue);
  if (isRecord(normalizedValue.readingPreferences) && normalizedValue.readingPreferences.sourceLanguage === undefined) normalizedValue.readingPreferences.sourceLanguage = 'auto';
  if (isRecord(normalizedValue.readingPreferences) && normalizedValue.readingPreferences.selectionPopupEnabled === undefined) normalizedValue.readingPreferences.selectionPopupEnabled = true;
  if (isRecord(normalizedValue.readingPreferences) && normalizedValue.readingPreferences.inlineSelectionModifier === undefined) normalizedValue.readingPreferences.inlineSelectionModifier = 'Control';
  const errors = validateSettings(normalizedValue).filter((error) => error !== '至少保留一个可用的翻译引擎' && error !== '当前翻译引擎必须可用');
  if (errors.length) return cloneDefaults();
  const settings = normalizedValue as unknown as Settings;
  settings.experts = settings.experts?.length ? settings.experts : defaultExperts();
  const ready = settings.engines.filter(engineReady);
  if (!ready.length) return cloneDefaults();
  if (!ready.some((engine) => engine.id === settings.activeEngineId)) settings.activeEngineId = ready[0].id;
  return settings;
}

function containsForbiddenKey(value: unknown, forbidden: (key: string) => boolean): boolean {
  if (!isRecord(value) && !Array.isArray(value)) return false;
  return Object.keys(value).some((key) => forbidden(key) || containsForbiddenKey((value as Record<string, unknown>)[key], forbidden));
}

function removeApiKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeApiKeys);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() !== 'apikey') Object.defineProperty(result, key, { value: removeApiKeys(item), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export function exportSafeSettings(settings: Settings): SafeSettings {
  return removeApiKeys(settings) as SafeSettings;
}

export function stripApiKeys(value: unknown): unknown {
  return removeApiKeys(value);
}

export function exportSettingsWithApiKeys(settings: Settings, includeApiKeys: boolean): Settings | SafeSettings {
  return includeApiKeys ? structuredClone(settings) : exportSafeSettings(settings);
}

function endpointOrigin(baseUrl: string): string | undefined {
  try { return new URL(baseUrl).origin; } catch { return undefined; }
}

export function importSettings(value: unknown, current: Settings = DEFAULT_SETTINGS, allowApiKeys = false): Settings {
  if (!allowApiKeys && containsForbiddenKey(value, (key) => key.toLowerCase() === 'apikey')) throw new Error('导入配置不能包含 API Key');
  if (containsForbiddenKey(value, (key) => DANGEROUS_KEYS.has(key))) throw new Error('配置包含危险字段');
  if (!isRecord(value) || value.schemaVersion !== 2 || !Array.isArray(value.engines)) throw new Error('导入设置格式无效');

  const input = structuredClone(value) as Record<string, unknown> & { engines: Array<Record<string, unknown>> };
  if (input.theme === undefined) input.theme = DEFAULT_SETTINGS.theme;
  if (input.experts === undefined) input.experts = defaultExperts();
  if (input.activeExpertByEngine === undefined) input.activeExpertByEngine = {};
  migrateExpertDefaults(input);
  if (isRecord(input.readingPreferences) && input.readingPreferences.selectionPopupEnabled === undefined) input.readingPreferences.selectionPopupEnabled = true;
  if (isRecord(input.readingPreferences) && input.readingPreferences.inlineSelectionModifier === undefined) input.readingPreferences.inlineSelectionModifier = 'Control';
  const inputIds = input.engines.map((engine) => engine.id);
  if (new Set(inputIds).size !== inputIds.length) throw new Error('翻译引擎 ID 不能重复');
  for (const engine of input.engines) {
    if ((engine.id === 'google' && engine.kind !== 'google') || (engine.id === 'bing' && engine.kind !== 'bing')) {
      throw new Error('导入配置不能使用内置引擎保留 ID');
    }
  }
  const missingBuiltins = DEFAULT_SETTINGS.engines.filter((builtin) => !input.engines.some((engine) => engine.id === builtin.id));
  const imported = {
    ...input,
    engines: [...structuredClone(missingBuiltins), ...input.engines].map((engine) => {
      if (engine.kind === 'google') return { ...engine, id: 'google', kind: 'google', name: 'Google' };
      if (engine.kind === 'bing') return { ...engine, id: 'bing', kind: 'bing', name: 'Bing' };
      const customInput = engine as Record<string, unknown>;
      const local = current.engines.find((candidate): candidate is CustomAiEngine => candidate.kind === 'custom-ai' && candidate.id === engine.id);
      const importedApiKey = allowApiKeys && typeof customInput.apiKey === 'string' ? customInput.apiKey : '';
      const apiKey = importedApiKey || (local && typeof customInput.baseUrl === 'string' && endpointOrigin(local.baseUrl) === endpointOrigin(customInput.baseUrl) ? local.apiKey : '');
      return { ...engine, apiKey };
    }),
  } as unknown as Settings;
  imported.engines = imported.engines.map((engine, order) => ({ ...engine, order }));
  const ready = imported.engines.filter(engineReady);
  if (!ready.length) throw new Error('至少保留一个可用的翻译引擎');
  const active = imported.engines.find((engine) => engine.id === imported.activeEngineId);
  if (!active || !engineReady(active)) {
    imported.activeEngineId = ready.find((engine) => engine.id === 'google')?.id
      ?? ready.find((engine) => engine.id === 'bing')?.id
      ?? ready[0].id;
  }
  const errors = validateSettings(imported);
  if (errors.length) throw new Error(errors.join('；'));
  return imported as unknown as Settings;
}

export function createGeneratedExpertId(existingIds: string[] = []): string {
  const seed = `custom-expert-${Date.now().toString(36)}`;
  if (!existingIds.includes(seed)) return seed;
  let suffix = 2;
  while (existingIds.includes(`${seed}-${suffix}`)) suffix += 1;
  return `${seed}-${suffix}`;
}

export function migrateSettings(value: unknown): Settings {
  if (isRecord(value) && value.schemaVersion === 2) return normalizeSettings(value);
  if (!isRecord(value)) return cloneDefaults();
  const migrated = cloneDefaults();
  const legacyPreferences: ReadingPreferences = {
      targetLanguage: value.targetLanguage as string,
      displayMode: value.displayMode as DisplayMode,
      userInstruction: value.userInstruction as string,
      translationPosition: value.translationPosition as 'before' | 'after',
      scanScope: value.scanScope as 'main-content' | 'whole-page',
      selectionContext: value.selectionContext as boolean,
      selectionPopupEnabled: true,
      inlineSelectionModifier: 'Control',
  };
  if (validatePreferences(legacyPreferences).length === 0) migrated.readingPreferences = legacyPreferences;
  const candidate: CustomAiEngine = {
    id: 'custom-migrated', kind: 'custom-ai', name: '迁移的自定义 AI', enabled: true, order: 2,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    model: typeof value.model === 'string' ? value.model : '',
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
  };
  if (validateEngine(candidate).length === 0 && candidate.apiKey.trim()) migrated.engines.push(candidate);
  delete migrated.experts;
  delete migrated.activeExpertByEngine;
  return migrated;
}
