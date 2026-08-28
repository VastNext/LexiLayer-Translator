import { DEFAULT_SETTINGS, type CustomAiEngine, type Engine, type OptionsSettings, type ReadingPreferences, type Theme } from '../shared/config';

interface OptionsChromeApi { runtime: { sendMessage(message: unknown): Promise<unknown> } }

export function createOptionsApi(chromeApi: OptionsChromeApi) {
  async function request<T = void>(message: unknown): Promise<T> {
    const response = await chromeApi.runtime.sendMessage(message) as { ok?: boolean; data?: T; error?: string };
    if (response.ok === false) throw new Error(response.error ?? '设置操作失败');
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
    importSettings: (settings: unknown) => request({ type: 'import-settings', settings }),
    clearCache: () => request({ type: 'clear-cache' }),
  };
}
