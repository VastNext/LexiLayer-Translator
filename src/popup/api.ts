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
  i18n: { getMessage(key: string): string };
}

interface Progress {
  status: string;
  completed: number;
  failed: number;
  total: number;
}

export interface PopupConfigResponse {
  preferences?: { targetLanguage: string; displayMode: string; scanScope: 'main-content' | 'whole-page'; translationPosition: 'before' | 'after'; userInstruction: string; selectionContext: boolean };
  activeEngineId?: string;
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
    async sendToPage(message: unknown) {
      const tabId = await activeTabId();
      if (tabId === undefined) throw new Error(createTranslator(api.i18n.getMessage.bind(api.i18n))('pageUnavailable'));
      return api.tabs.sendMessage(tabId, message);
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
