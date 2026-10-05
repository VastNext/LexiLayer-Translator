import { DEFAULT_SETTINGS, type CustomAiEngine, type Engine, type OptionsSettings, type ReadingPreferences, type Theme } from '../shared/config';
import type { Expert } from '../shared/experts';
import { getShortcutSettingsUrl, resolvePageTranslationShortcut, type BrowserIdentity, type ShortcutState } from '../shared/shortcuts';
import type { VocabularyEntry } from '../shared/vocabulary';

export type AnkiNoteTypeInput = 'basic' | 'cloze';

export interface VocabularyPreferencesInput {
  endpoint: string;
  deck: string;
  noteType: AnkiNoteTypeInput;
  apiKey?: string;
}

export interface AnkiCandidateInput {
  endpoint: string;
  apiKey?: string;
}

export interface AnkiSyncResult {
  added: number;
  skipped: number;
  failed: number;
}

/** 后台错误响应可能携带结构化失败码（如 AnkiConnect 的 network/cors/auth）。 */
export class OptionsRequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'OptionsRequestError';
  }
}

interface OptionsChromeApi {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  commands?: { getAll(): Promise<unknown[]> };
  tabs?: { create(createProperties: { url: string }): Promise<unknown> };
}

interface NavigatorIdentitySource {
  userAgent: string;
  userAgentData?: { brands?: Array<{ brand: string }> };
}

export function browserIdentityFromNavigator(navigatorApi: NavigatorIdentitySource): BrowserIdentity {
  return {
    brands: navigatorApi.userAgentData?.brands,
    userAgent: navigatorApi.userAgent,
  };
}

export function createOptionsApi(chromeApi: OptionsChromeApi, browserIdentity?: BrowserIdentity) {
  async function request<T = void>(message: unknown): Promise<T> {
    const response = await chromeApi.runtime.sendMessage(message) as { ok?: boolean; data?: T; error?: string; code?: string };
    if (response.ok === false) throw new OptionsRequestError(response.error ?? '设置操作失败', response.code);
    return response.data as T;
  }

  return {
    async load(): Promise<OptionsSettings> {
      return await request<OptionsSettings>({ type: 'get-options-settings' }) ?? structuredClone(DEFAULT_SETTINGS);
    },
    async getEngineApiKey(engineId: string): Promise<string> {
      return (await request<{ key: string }>({ type: 'get-engine-api-key', engineId }))?.key ?? '';
    },
    savePreferences: (readingPreferences: ReadingPreferences) => request({ type: 'save-reading-preferences', readingPreferences }),
    saveTheme: (theme: Theme) => request({ type: 'save-theme', theme }),
    upsertEngine: (engine: Engine) => request({ type: 'upsert-engine', engine }),
    deleteEngine: (engineId: string) => request({ type: 'delete-engine', engineId }),
    setActiveEngine: (engineId: string) => request({ type: 'set-active-engine', engineId }),
    setEngineEnabled: (engineId: string, enabled: boolean) => request({ type: 'set-engine-enabled', engineId, enabled }),
    reorderEngines: (engineIds: string[]) => request({ type: 'reorder-engines', engineIds }),
    testEngine: (engineId: string, candidate?: CustomAiEngine) => request({ type: 'test-engine', engineId, ...(candidate ? { candidate } : {}) }),
    clearEngineApiKey: (engineId: string) => request({ type: 'clear-engine-api-key', engineId }),
    setExpertEnabled: (expertId: string, enabled: boolean) => request({ type: 'set-expert-enabled', expertId, enabled }),
    upsertExpert: (expert: Expert) => request({ type: 'upsert-expert', expert }),
    deleteExpert: (expertId: string) => request({ type: 'delete-expert', expertId }),
    importSettings: (settings: unknown, allowApiKeys?: boolean) => request({ type: 'import-settings', settings, ...(allowApiKeys !== undefined ? { allowApiKeys } : {}) }),
    clearCache: () => request({ type: 'clear-cache' }),
    async getVocabularyEntries(): Promise<VocabularyEntry[]> {
      return await request<VocabularyEntry[]>({ type: 'get-vocabulary-entries' }) ?? [];
    },
    async deleteVocabularyEntry(id: string): Promise<boolean> {
      return (await request<{ deleted: boolean }>({ type: 'delete-vocabulary-entry', id }))?.deleted ?? false;
    },
    clearVocabulary: () => request({ type: 'clear-vocabulary' }),
    saveVocabularyPreferences: (preferences: VocabularyPreferencesInput) => request({
      type: 'save-vocabulary-preferences',
      endpoint: preferences.endpoint,
      deck: preferences.deck,
      noteType: preferences.noteType,
      ...(preferences.apiKey !== undefined ? { apiKey: preferences.apiKey } : {}),
    }),
    async getAnkiApiKey(): Promise<string> {
      return (await request<{ key: string }>({ type: 'get-anki-api-key' }))?.key ?? '';
    },
    clearAnkiApiKey: () => request({ type: 'clear-anki-api-key' }),
    testAnkiConnection: (candidate: AnkiCandidateInput) => request({ type: 'test-anki-connection', candidate }),
    syncVocabularyAnki: () => request<AnkiSyncResult>({ type: 'sync-vocabulary-anki' }),
    async getPageTranslationShortcut(): Promise<ShortcutState> {
      try {
        if (!chromeApi.commands) return { status: 'unavailable', reason: 'api-error' };
        return resolvePageTranslationShortcut(await chromeApi.commands.getAll());
      } catch {
        return { status: 'unavailable', reason: 'api-error' };
      }
    },
    async openShortcutSettings() {
      const manualUrl = getShortcutSettingsUrl(browserIdentity);
      try {
        if (!chromeApi.tabs) throw new Error('tabs API unavailable');
        await chromeApi.tabs.create({ url: manualUrl });
        return { ok: true as const, manualUrl };
      } catch {
        return {
          ok: false as const,
          manualUrl,
        };
      }
    },
  };
}
