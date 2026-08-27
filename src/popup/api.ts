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

export function createPopupApi(api: PopupChromeApi) {
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
      const response = await api.runtime.sendMessage({ type: 'get-public-config' }) as { data: { targetLanguage: string; displayMode: string } };
      return response.data;
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
      const response = await api.runtime.sendMessage({ type: 'get-page-progress', tabId, frameId: 0 }) as { data?: Progress };
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
        const response = await api.runtime.sendMessage({ type: 'get-page-progress', tabId, frameId: 0 }) as { data?: Progress };
        if (response.data) listener(response.data);
      }
      return () => api.runtime.onMessage.removeListener(onMessage);
    },
  };
}
