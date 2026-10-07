// YouTube 双语字幕 ISOLATED 控制脚本：桥接 MAIN world 捕获（window.postMessage）、
// 装配会话依赖（fetch 重放 / translate-batch / DOM 播放器访问），驱动 120ms 同步轮询。
// 监听器在 youtube.com 任意页面注册（SPA 从首页点进 /watch 不重新加载文档），
// watch 页判断在回调内进行；SPA 导航（yt-navigate-finish + 轮询兜底）重建会话。
// MAIN world 捕获由独立脚本 youtube-inject.js 负责，这里绝不重复 hook（世界不同）。

import { INJECT_MESSAGE_SOURCE } from './inject';
import { createVideoSession, type SessionConfig } from './session';
import { createSubtitleRenderer, type SubtitlePosition, type SubtitleRenderer } from '../subtitles/renderer';
import { createWordTooltip } from '../subtitles/word-tooltip';
import { saveWordToVocabulary } from '../subtitles/vocabulary';

const TARGET_ORIGIN = 'https://www.youtube.com';
const TICK_INTERVAL_MS = 120;
const NAVIGATION_POLL_MS = 1_000;
const CC_RETRY_MS = 800;
const CC_RETRY_MAX = 5;
const POSITION_KEY = 'videoSubtitlePosition';

interface PublicConfigResponse {
  ok?: boolean;
  data?: { activeEngineId?: string; preferences?: { targetLanguage?: string; videoSubtitleEnabled?: boolean; videoSubtitleEngine?: 'youtube-tlang' | 'current-engine' } };
  error?: string;
}

function isWatchPage(): boolean {
  return location.hostname === 'www.youtube.com' && location.pathname === '/watch';
}

function currentVideoId(): string | undefined {
  return isWatchPage() ? new URL(location.href).searchParams.get('v') ?? undefined : undefined;
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && location.hostname === 'www.youtube.com') {
  let lastVideoId: string | undefined = currentVideoId();
  let ccOpenedByExtension = false;
  let rendererInstance: SubtitleRenderer | undefined;
  let rendererPlayer: HTMLElement | undefined;

  const t = (key: string, fallback: string): string => chrome.i18n.getMessage(key) || fallback;

  // 播放器元素可能晚于内容脚本出现且可能被重建：每次渲染调用前校验连接状态。
  const rendererFor = (): SubtitleRenderer | undefined => {
    const player = document.getElementById('movie_player');
    if (rendererInstance && rendererPlayer && player === rendererPlayer && rendererPlayer.isConnected) {
      return rendererInstance;
    }
    rendererInstance?.destroy();
    if (!player) return undefined;
    rendererPlayer = player;
    rendererInstance = createSubtitleRenderer(player, {
      onWordClick: (word, sentence, rect) => wordTooltip.open(word, sentence, rect),
      getPosition: async () => {
        const stored = await chrome.storage.local.get(POSITION_KEY);
        const position = stored[POSITION_KEY] as SubtitlePosition | undefined;
        return position && Number.isFinite(position.x) && Number.isFinite(position.y) ? position : undefined;
      },
      setPosition: (position) => { void chrome.storage.local.set({ [POSITION_KEY]: position }); },
    });
    return rendererInstance;
  };
  const renderer: SubtitleRenderer = {
    show(source, translation) { rendererFor()?.show(source, translation); },
    showNotice(message) { rendererFor()?.showNotice(message); },
    clear() { rendererFor()?.clear(); },
    destroy() { rendererFor()?.destroy(); rendererInstance = undefined; },
  };

  const session = createVideoSession({
    async getConfig(): Promise<SessionConfig> {
      const response = await chrome.runtime.sendMessage({ type: 'get-public-config' }) as PublicConfigResponse | undefined;
      const data = response?.data;
      return {
        enabled: data?.preferences?.videoSubtitleEnabled ?? true,
        engine: data?.preferences?.videoSubtitleEngine ?? 'youtube-tlang',
        engineId: data?.activeEngineId ?? 'google',
        targetLanguage: data?.preferences?.targetLanguage ?? 'en',
      };
    },
    async fetchText(url: string) {
      const response = await fetch(url, { credentials: 'include' });
      return response.text();
    },
    async translateBatch(segments, sourceLanguage, targetLanguage, engineId, taskId, onPartial) {
      const response = await chrome.runtime.sendMessage({
        type: 'translate-batch', sourceLanguage, targetLanguage, segments, engineId, taskId,
      }) as { ok?: boolean; data?: Array<{ id: string; text: string }>; error?: string } | undefined;
      if (!response?.ok || !response.data) throw new Error(response?.error ?? '字幕翻译请求失败');
      const translations = new Map<string, string>();
      for (const result of response.data) translations.set(result.id, result.text);
      onPartial(translations);
    },
    getVideoTime() {
      const video = document.querySelector('video.html5-main-video') ?? document.querySelector('#movie_player video');
      if (!(video instanceof HTMLVideoElement)) return undefined;
      // 合成播放器（E2E 夹具）经 data-current-time 注入模拟时间；真实播放器不会设置该属性。
      const simulated = video.getAttribute('data-current-time');
      if (simulated) {
        const value = Number(simulated);
        if (Number.isFinite(value)) return value;
      }
      return video.currentTime;
    },
    isAdShowing() {
      return document.getElementById('movie_player')?.classList.contains('ad-showing') ?? false;
    },
    async ensureCaptionsEnabled() {
      for (let attempt = 0; attempt < CC_RETRY_MAX; attempt += 1) {
        const button = document.querySelector('.ytp-subtitles-button');
        if (button instanceof HTMLButtonElement) {
          if (button.getAttribute('aria-disabled') !== 'true') {
            if (button.getAttribute('aria-pressed') !== 'true') {
              button.click();
              ccOpenedByExtension = true;
            }
            return true;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, CC_RETRY_MS));
      }
      return false;
    },
    renderer,
    notices: {
      readFailed: t('ytdsNoticeReadFailed', '未能读取字幕（该视频可能无字幕或被限制）'),
      noSubtitles: t('ytdsNoticeNoSubtitles', '该视频没有可用字幕'),
      translateUnavailable: t('ytdsNoticeTranslateUnavailable', '字幕翻译暂不可用，已保留原文'),
    },
  });

  // 字幕点词（Phase 3）：释义经当前引擎查词，收词走生词本管线。
  const wordTooltip = createWordTooltip(document, {
    getTargetLanguage: async () => {
      const response = await chrome.runtime.sendMessage({ type: 'get-public-config' }) as PublicConfigResponse | undefined;
      return response?.data?.preferences?.targetLanguage ?? 'en';
    },
    translateWord: async (word, _sentence, targetLanguage) => {
      const configResponse = await chrome.runtime.sendMessage({ type: 'get-public-config' }) as PublicConfigResponse | undefined;
      const engineId = configResponse?.data?.activeEngineId ?? 'google';
      const response = await chrome.runtime.sendMessage({
        type: 'translate-batch', sourceLanguage: 'auto', targetLanguage,
        segments: [{ id: 'ytw-0', text: word }], engineId, taskId: 'ytw-word',
      }) as { ok?: boolean; data?: Array<{ id: string; text: string }>; error?: string } | undefined;
      if (!response?.ok || !response.data?.[0]) throw new Error(response?.error ?? '查词失败');
      return response.data[0].text;
    },
    saveToVocabulary: (entry) => saveWordToVocabulary(
      (message) => chrome.runtime.sendMessage(message),
      entry,
      { sourceUrl: location.href, pageTitle: document.title },
    ),
  });

  // MAIN world 捕获 → 会话（session 内部按 normKey 幂等，页面脚本误发消息无副作用）。
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== TARGET_ORIGIN) return;
    const data = event.data as { source?: string; url?: string } | null;
    if (data?.source !== INJECT_MESSAGE_SOURCE || typeof data.url !== 'string') return;
    void session.onCapturedUrl(data.url);
  });

  // SPA 导航：yt-navigate-finish 优先，轮询兜底。新视频先重置会话再请求开启原生
  // 字幕（触发播放器发出捕获请求）；同一视频重复触发由会话 normKey 幂等吸收。
  async function handleNavigation(): Promise<void> {
    if (!isWatchPage()) return;
    await session.prepareForVideo();
  }

  document.addEventListener('yt-navigate-finish', () => {
    lastVideoId = currentVideoId();
    session.reset();
    void handleNavigation();
  });

  window.setInterval(() => session.tick(), TICK_INTERVAL_MS);
  window.setInterval(() => {
    const videoId = currentVideoId();
    if (videoId !== lastVideoId) {
      lastVideoId = videoId;
      session.reset();
      void handleNavigation();
    }
  }, NAVIGATION_POLL_MS);

  // 启动时已在 watch 页（整页加载）：请求开启原生字幕以触发捕获。
  void handleNavigation();

  // 功能开关/引擎变化：关闭 → 停止会话并恢复原生字幕；开启或引擎切换 → 重建会话。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' && area !== 'sync') return;
    const settingsChange = changes.translatorSettings;
    if (!settingsChange) return;
    const preferences = (settingsChange.newValue as { readingPreferences?: { videoSubtitleEnabled?: boolean; videoSubtitleEngine?: string } } | undefined)?.readingPreferences;
    if (!preferences) return;
    if (preferences.videoSubtitleEnabled === false) {
      session.disable();
      if (ccOpenedByExtension) {
        document.querySelector('.ytp-subtitles-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        ccOpenedByExtension = false;
      }
      return;
    }
    session.enable();
    session.reset();
    void handleNavigation();
  });
}
