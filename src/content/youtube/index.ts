// YouTube 双语字幕 ISOLATED 控制脚本：桥接 MAIN world 捕获（window.postMessage）、
// 装配会话依赖（fetch 重放 / translate-batch / DOM 播放器访问），驱动 120ms 同步轮询。
// 仅在 /watch 页面激活；SPA 导航（yt-navigate-finish + 轮询兜底）自动重建会话。
// MAIN world 捕获由独立脚本 youtube-inject.js 负责，这里绝不重复 hook（世界不同）。

import { INJECT_MESSAGE_SOURCE } from './inject';
import { createVideoSession, type SessionConfig } from './session';
import { createSubtitleRenderer, type SubtitleRenderer } from './renderer';

const TARGET_ORIGIN = 'https://www.youtube.com';
const TICK_INTERVAL_MS = 120;
const NAVIGATION_POLL_MS = 1_000;
const CC_RETRY_MS = 800;
const CC_RETRY_MAX = 5;

interface PublicConfigResponse {
  ok?: boolean;
  data?: { preferences?: { targetLanguage?: string; videoSubtitleEnabled?: boolean; videoSubtitleEngine?: 'youtube-tlang' | 'current-engine' } };
  error?: string;
}

function isWatchPage(): boolean {
  return location.hostname === 'www.youtube.com' && location.pathname === '/watch';
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && isWatchPage()) {
  let lastVideoId: string | undefined = new URL(location.href).searchParams.get('v') ?? undefined;
  let ccOpenedByExtension = false;
  let rendererInstance: SubtitleRenderer | undefined;

  // 播放器元素可能晚于内容脚本出现（SPA），延迟解析；找不到时渲染调用安全降级。
  const rendererFor = (): SubtitleRenderer | undefined => {
    if (rendererInstance) return rendererInstance;
    const player = document.getElementById('movie_player');
    if (!player) return undefined;
    rendererInstance = createSubtitleRenderer(player);
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
      const preferences = response?.data?.preferences;
      return {
        enabled: preferences?.videoSubtitleEnabled ?? true,
        engine: preferences?.videoSubtitleEngine ?? 'youtube-tlang',
        targetLanguage: preferences?.targetLanguage ?? 'en',
      };
    },
    async fetchText(url: string) {
      const response = await fetch(url, { credentials: 'include' });
      return response.text();
    },
    async translateBatch(segments, sourceLanguage, targetLanguage, onPartial) {
      const response = await chrome.runtime.sendMessage({
        type: 'translate-batch', sourceLanguage, targetLanguage, segments,
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
  });

  // MAIN world 捕获 → 会话。
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
    lastVideoId = new URL(location.href).searchParams.get('v') ?? undefined;
    session.reset();
    void handleNavigation();
  });

  window.setInterval(() => session.tick(), TICK_INTERVAL_MS);
  window.setInterval(() => {
    const videoId = isWatchPage() ? new URL(location.href).searchParams.get('v') ?? undefined : undefined;
    if (videoId !== lastVideoId) {
      lastVideoId = videoId;
      session.reset();
      void handleNavigation();
    }
  }, NAVIGATION_POLL_MS);

  // 功能开关关闭：停止会话并恢复原生字幕（若为扩展开启）。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' && area !== 'sync') return;
    const settingsChange = changes.translatorSettings;
    if (!settingsChange) return;
    const preferences = (settingsChange.newValue as { readingPreferences?: { videoSubtitleEnabled?: boolean } } | undefined)?.readingPreferences;
    if (preferences?.videoSubtitleEnabled === false) {
      session.disable();
      if (ccOpenedByExtension) {
        document.querySelector('.ytp-subtitles-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        ccOpenedByExtension = false;
      }
    }
  });
}
