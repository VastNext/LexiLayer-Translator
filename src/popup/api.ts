import type { Theme } from '../shared/config';
import type { Expert } from '../shared/experts';
import { createTranslator } from '../shared/i18n';
import { resolvePageTranslationShortcut, type ShortcutState } from '../shared/shortcuts';

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
  scripting?: {
    executeScript(injection: { target: { tabId: number; allFrames?: boolean }; files: string[] }): Promise<unknown>;
    insertCSS(injection: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
  action?: {
    setBadgeText(details: { tabId: number; text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void>;
  };
  commands?: { getAll(): Promise<unknown[]> };
  i18n: { getMessage(key: string): string };
}

interface Progress {
  status: string;
  completed: number;
  failed: number;
  total: number;
}

export interface PopupConfigResponse {
  preferences?: { sourceLanguage?: string; targetLanguage: string; displayMode: string; scanScope: 'main-content' | 'whole-page'; translationPosition: 'before' | 'after'; userInstruction: string; selectionContext: boolean; selectionPopupEnabled: boolean; inlineSelectionModifier: 'Control' | 'Alt' | 'Shift' | 'Meta' | 'Off'; inlineSelectionTriggerCount: 1 | 2 | 3; rendererMode: 'legacy' | 'inline' };
  activeEngineId?: string;
  theme?: Theme;
  availableEngines?: Array<{ id: string; kind: string; name: string; ready: boolean; capabilities: { streaming: boolean } }>;
  experts?: Array<Pick<Expert, 'id' | 'name' | 'description' | 'enabled'>>;
  activeExpertByEngine?: Record<string, string>;
}

export function createPopupApi(api: PopupChromeApi) {
  let cachedTabIdPromise: Promise<number | undefined> | undefined;

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

  function getTargetTabId(): Promise<number | undefined> {
    if (!cachedTabIdPromise) {
      cachedTabIdPromise = activeTabId();
    }
    return cachedTabIdPromise;
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
    async savePopupState(engineId: string, readingPreferences: PopupConfigResponse['preferences'], expertId?: string | null) {
      await backgroundAction({ type: 'save-popup-preferences', engineId, readingPreferences, ...(expertId !== undefined ? { expertId } : {}) }, '快捷设置保存失败');
    },
    async sendToPage(message: unknown) {
      const tabId = await getTargetTabId();
      if (tabId === undefined) throw new Error(createTranslator(api.i18n.getMessage.bind(api.i18n))('pageUnavailable'));
      try {
        return await api.tabs.sendMessage(tabId, message);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!/Receiving end does not exist|Could not establish connection/i.test(text) || !api.scripting) throw error;
        try {
          // 声明式 content_scripts 常驻注入两套样式与三个脚本；按需注入必须按
          // manifest 顺序保持一致：先 insertCSS（content.css + content-inline.css）
          // 再 executeScript（控制器库 → 内联渲染器 → 装配层）。样式缺失会导致
          // 译文与划词节点无排版，脚本缺一会导致渲染器或装配层未就绪。
          await api.scripting.insertCSS({ target: { tabId }, files: ['content.css', 'content-inline.css'] });
          // 输入翻译是独立的 all_frames content script；旧标签页补注入时必须同步恢复，
          // 其自身全局 guard 可安全忽略已声明式注入的 frame。
          await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['input-translation.js'] });
          await api.scripting.executeScript({ target: { tabId }, files: ['content.js', 'content-inline.js', 'content-main.js'] });
          return await api.tabs.sendMessage(tabId, message);
        } catch {
          throw new Error('当前页面暂时无法注入翻译脚本，请刷新页面后重试');
        }
      }
    },
    async setTranslationBadge(active: boolean) {
      const tabId = await getTargetTabId();
      if (tabId === undefined || !api.action) return;
      if (active) await api.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' });
      await api.action.setBadgeText({ tabId, text: active ? '✓' : '' });
    },
    openOptions: () => void api.runtime.openOptionsPage(),
    async getPageTranslationShortcut(): Promise<ShortcutState> {
      try {
        if (!api.commands) return { status: 'unavailable', reason: 'api-error' };
        return resolvePageTranslationShortcut(await api.commands.getAll());
      } catch {
        return { status: 'unavailable', reason: 'api-error' };
      }
    },
    async subscribeProgress(listener: (progress: Progress) => void) {
      let hasReceivedRealtime = false;
      let unsubscribed = false;
      let tabId: number | undefined;
      const bufferedMessages: Array<{ tabId?: number; frameId?: number; progress?: Progress }> = [];

      const onMessage = (message: unknown) => {
        if (unsubscribed) return;
        const value = message as { type?: string; tabId?: number; frameId?: number; progress?: Progress };
        if (value.type !== 'page-progress' || value.frameId !== 0 || !value.progress) return;
        if (tabId === undefined) {
          bufferedMessages.push(value);
          return;
        }
        if (value.tabId === tabId) {
          hasReceivedRealtime = true;
          listener(value.progress);
        }
      };

      api.runtime.onMessage.addListener(onMessage);

      try {
        tabId = await getTargetTabId();
        if (unsubscribed) {
          api.runtime.onMessage.removeListener(onMessage);
          return () => undefined;
        }
        for (const value of bufferedMessages.splice(0)) {
          if (value.tabId === tabId && value.progress) {
            hasReceivedRealtime = true;
            listener(value.progress);
          }
        }
        if (tabId !== undefined) {
          const response = await api.runtime.sendMessage({ type: 'get-page-progress', tabId, frameId: 0 }) as { ok?: boolean; data?: Progress; error?: string } | undefined;
          if (!response || response.ok === false) throw new Error(response?.error ?? '页面进度响应无效');
          if (!unsubscribed && !hasReceivedRealtime && response.data) {
            listener(response.data);
          }
        }
      } catch {
        // 快照读取失败时不阻断实时监听
      }

      return () => {
        unsubscribed = true;
        api.runtime.onMessage.removeListener(onMessage);
      };
    },
  };
}
