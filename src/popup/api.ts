import type { Theme } from '../shared/config';
import { createTranslator } from '../shared/i18n';

interface PopupChromeApi {
  runtime: {
    id?: string;
    sendMessage(message: unknown): Promise<unknown>;
    openOptionsPage(): void;
    onMessage: {
      addListener(listener: (message: unknown) => void): void;
      removeListener(listener: (message: unknown) => void): void;
    };
  };
  tabs: {
    getCurrent?(): Promise<{ id?: number } | undefined>;
    query(queryInfo: chrome.tabs.QueryInfo): Promise<Array<{ id?: number; url?: string; active?: boolean }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  scripting?: { executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown> };
  action?: {
    setBadgeText(details: { tabId: number; text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void>;
  };
  i18n: { getMessage(key: string): string };
}

interface Progress {
  status: string;
  completed: number;
  failed: number;
  total: number;
}

export interface PopupConfigResponse {
  preferences?: { sourceLanguage?: string; targetLanguage: string; displayMode: string; scanScope: 'main-content' | 'whole-page'; translationPosition: 'before' | 'after'; userInstruction: string; selectionContext: boolean; selectionPopupEnabled: boolean; inlineSelectionModifier: 'Control' | 'Alt' | 'Shift' | 'Meta' | 'Off' };
  activeEngineId?: string;
  theme?: Theme;
  availableEngines?: Array<{ id: string; kind: string; name: string; ready: boolean; capabilities: { streaming: boolean } }>;
}

export function createPopupApi(api: PopupChromeApi) {
  async function backgroundRequest<T>(message: unknown, invalidMessage: string): Promise<T> {
    const response = await api.runtime.sendMessage(message) as { ok?: boolean; data?: T; error?: string } | undefined;
    if (!response || response.ok === false) throw new Error(response?.error ?? invalidMessage);
    if (response.data === undefined) throw new Error(invalidMessage);
    return response.data;
  }

  async function backgroundAction(message: unknown, invalidMessage: string): Promise<void> {
    const response = await api.runtime.sendMessage(message) as { ok?: boolean; error?: string } | undefined;
    if (!response || response.ok === false) throw new Error(response?.error ?? invalidMessage);
  }

  async function activeTabId(): Promise<number | undefined> {
    const tabs = await api.tabs.query({ currentWindow: true });
    const currentTabId = (await api.tabs.getCurrent?.())?.id;
    const extensionPrefix = api.runtime.id ? `chrome-extension://${api.runtime.id}/` : undefined;
    const candidates = tabs.filter((candidate) => candidate.id !== currentTabId);
    const tab = candidates.find((candidate) => candidate.active && !candidate.url?.startsWith('chrome-extension://'))
      ?? candidates.find((candidate) => !extensionPrefix || !candidate.url?.startsWith(extensionPrefix));
    return tab?.id;
  }

  return {
    async getConfig() {
      return backgroundRequest<PopupConfigResponse>({ type: 'get-popup-config' }, 'Popup 配置响应无效');
    },
    async savePreferences(readingPreferences: PopupConfigResponse['preferences']) {
      await backgroundAction({ type: 'save-reading-preferences', readingPreferences }, '偏好设置保存失败');
    },
    async setActiveEngine(engineId: string) {
      await backgroundAction({ type: 'set-active-engine', engineId }, '翻译引擎保存失败');
    },
    async savePopupState(engineId: string, readingPreferences: PopupConfigResponse['preferences']) {
      await backgroundAction({ type: 'save-popup-preferences', engineId, readingPreferences }, '快捷设置保存失败');
    },
    async sendToPage(message: unknown) {
      const tabId = await activeTabId();
      if (tabId === undefined) throw new Error(createTranslator(api.i18n.getMessage.bind(api.i18n))('pageUnavailable'));
      try {
        return await api.tabs.sendMessage(tabId, message);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!/Receiving end does not exist|Could not establish connection/i.test(text) || !api.scripting) throw error;
        try {
          await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          return await api.tabs.sendMessage(tabId, message);
        } catch {
          throw new Error('当前页面暂时无法注入翻译脚本，请刷新页面后重试');
        }
      }
    },
    async setTranslationBadge(active: boolean) {
      const tabId = await activeTabId();
      if (tabId === undefined || !api.action) return;
      if (active) await api.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' });
      await api.action.setBadgeText({ tabId, text: active ? '✓' : '' });
    },
    openOptions: () => void api.runtime.openOptionsPage(),
    async getProgress() {
      const tabId = await activeTabId();
      if (tabId === undefined) return undefined;
      const response = await api.runtime.sendMessage({ type: 'get-page-progress', tabId, frameId: 0 }) as { ok?: boolean; data?: Progress; error?: string } | undefined;
      if (!response || response.ok === false) throw new Error(response?.error ?? '页面进度响应无效');
      return response.data;
    },
    async subscribeProgress(listener: (progress: Progress) => void) {
      const tabId = await activeTabId();
      const onMessage = (message: unknown) => {
        const value = message as { type?: string; tabId?: number; frameId?: number; progress?: Progress };
        if (value.type === 'page-progress' && value.tabId === tabId && value.frameId === 0 && value.progress) listener(value.progress);
      };
      api.runtime.onMessage.addListener(onMessage);
      if (tabId !== undefined) {
        const response = await api.runtime.sendMessage({ type: 'get-page-progress', tabId, frameId: 0 }) as { ok?: boolean; data?: Progress; error?: string } | undefined;
        if (!response || response.ok === false) throw new Error(response?.error ?? '页面进度响应无效');
        if (response.data) listener(response.data);
      }
      return () => api.runtime.onMessage.removeListener(onMessage);
    },
  };
}
