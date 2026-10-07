// Bilibili 双语字幕 ISOLATED 控制脚本：接收 MAIN world 的视频标识 →
// 读取站内字幕轨 → 当前引擎渐进翻译 → 播放器内双语渲染（原生字幕行保留，
// 译文行由本扩展注入）。依赖用户已登录 B 站（AI 字幕）；功能开关与 YouTube 共用。

import { BILI_MESSAGE_SOURCE, type BiliVideoIdentity } from './inject';
import { fetchBiliSubtitleCues, fetchBiliSubtitleTracks, type BiliSubtitleTrack } from './api';
import { createSubtitleRenderer } from '../subtitles/renderer';
import { createWordTooltip } from '../subtitles/word-tooltip';
import { saveWordToVocabulary } from '../subtitles/vocabulary';

const TARGET_ORIGIN = 'https://www.bilibili.com';
const TICK_INTERVAL_MS = 120;

interface PublicConfigResponse {
  ok?: boolean;
  data?: { activeEngineId?: string; preferences?: { targetLanguage?: string; videoSubtitleEnabled?: boolean } };
  error?: string;
}

function isVideoPage(): boolean {
  return location.hostname === 'www.bilibili.com' && location.pathname.startsWith('/video/');
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && location.hostname.endsWith('bilibili.com')) {
  let rendererInstance: import('../subtitles/renderer').SubtitleRenderer | undefined;
  let rendererPlayer: HTMLElement | undefined;

  const t = (key: string, fallback: string): string => chrome.i18n.getMessage(key) || fallback;

  // 字幕点词（Phase 3）：释义经当前引擎查词，收词走生词本管线。
  const wordTooltip = createWordTooltip(document, {
    getTargetLanguage: async () => (await activeConfig()).targetLanguage,
    translateWord: async (word, _sentence, targetLanguage) => {
      const { engineId } = await activeConfig();
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

  const rendererFor = (): import('../subtitles/renderer').SubtitleRenderer | undefined => {
    const player = document.getElementById('bilibili-player');
    if (rendererInstance && rendererPlayer && player === rendererPlayer && rendererPlayer.isConnected) {
      return rendererInstance;
    }
    rendererInstance?.destroy();
    if (!player) return undefined;
    rendererPlayer = player;
    rendererInstance = createSubtitleRenderer(player, {
      onWordClick: (word, sentence, rect) => wordTooltip.open(word, sentence, rect),
    });
    return rendererInstance;
  };
  const renderer = {
    show: (source: string, translation: string | undefined) => rendererFor()?.show(source, translation),
    showNotice: (message: string) => rendererFor()?.showNotice(message),
    clear: () => rendererFor()?.clear(),
  };

  async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, { credentials: 'include' });
    return response.text();
  }

  async function activeConfig(): Promise<{ enabled: boolean; engineId: string; targetLanguage: string }> {
    const response = await chrome.runtime.sendMessage({ type: 'get-public-config' }) as PublicConfigResponse | undefined;
    const data = response?.data;
    return {
      enabled: data?.preferences?.videoSubtitleEnabled ?? true,
      engineId: data?.activeEngineId ?? 'google',
      targetLanguage: data?.preferences?.targetLanguage ?? 'en',
    };
  }

  const session = createBiliSession();

  function createBiliSession() {
    let sessionId = 0;
    let cidKey = '';
    let cues: Array<{ start: number; end: number; text: string; translation?: string }> = [];
    let lastRenderKey = '';
    let disabled = false;

    async function begin(identity: BiliVideoIdentity): Promise<void> {
      const generation = sessionId;
      renderer.clear();
      const config = await activeConfig().catch(() => undefined);
      if (generation !== sessionId || disabled) return;
      if (!config?.enabled) return;
      let tracks: BiliSubtitleTrack[] = [];
      let needLogin = false;
      try {
        const subtitles = await fetchBiliSubtitleTracks({ fetchText }, identity.aid, identity.cid);
        tracks = subtitles.tracks;
        needLogin = subtitles.needLogin;
      } catch {
        renderer.showNotice(t('ytdsNoticeReadFailed', '未能读取字幕'));
        return;
      }
      if (generation !== sessionId || disabled) return;
      if (!tracks.length) {
        renderer.showNotice(needLogin
          ? t('ytdsNoticeBiliLogin', '登录 B 站后可读取 AI 字幕')
          : t('ytdsNoticeNoSubtitles', '该视频没有可用字幕'));
        return;
      }
      let cueList;
      try {
        cueList = await fetchBiliSubtitleCues({ fetchText }, tracks[0].url);
      } catch {
        renderer.showNotice(t('ytdsNoticeReadFailed', '未能读取字幕'));
        return;
      }
      if (generation !== sessionId || disabled) return;
      if (!cueList.length) {
        renderer.showNotice(t('ytdsNoticeNoSubtitles', '该视频没有可用字幕'));
        return;
      }
      // 渐进渲染基座：原文先行，逐批补译文。
      cues = cueList.map((cue) => ({ ...cue }));
      const chunks: Array<typeof cueList> = [];
      for (let index = 0; index < cueList.length; index += 8) chunks.push(cueList.slice(index, index + 8));
      void (async () => {
        for (const [batchIndex, chunk] of chunks.entries()) {
          if (generation !== sessionId || disabled) return;
          try {
            const response = await chrome.runtime.sendMessage({
              type: 'translate-batch', sourceLanguage: 'auto', targetLanguage: config.targetLanguage,
              segments: chunk.map((cue, index) => ({ id: `bili-${batchIndex}-${index}`, text: cue.text })),
              engineId: config.engineId, taskId: `bil-${generation}-${batchIndex}`,
            }) as { ok?: boolean; data?: Array<{ id: string; text: string }>; error?: string } | undefined;
            if (!response?.ok || !response.data) throw new Error(response?.error ?? '翻译失败');
            for (const item of response.data) {
              const match = /^bili-(\d+)-(\d+)$/u.exec(item.id);
              const position = match ? Number(match[2]) + Number(match[1]) * 8 : -1;
              if (position >= 0 && cues[position]) cues[position] = { ...cues[position], translation: item.text };
            }
            rerender();
          } catch { /* 单批失败该段保持原文，继续后续批次 */ }
        }
      })();
    }

    function rerender(): void {
      const time = getVideoTime();
      if (time === undefined) return;
      renderAt(time);
    }

    function getVideoTime(): number | undefined {
      const video = document.querySelector('#bilibili-player video');
      if (!(video instanceof HTMLVideoElement)) return undefined;
      // 合成播放器（E2E 夹具）经 data-current-time 注入模拟时间；真实播放器不会设置该属性。
      const simulated = video.getAttribute('data-current-time');
      if (simulated) {
        const value = Number(simulated);
        if (Number.isFinite(value)) return value;
      }
      return video.currentTime;
    }

    function renderAt(time: number): void {
      if (!cues.length) return;
      let low = 0;
      let high = cues.length - 1;
      let index = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (cues[mid].start <= time) { index = mid; low = mid + 1; } else { high = mid - 1; }
      }
      const active = index >= 0 && time <= cues[index].end ? cues[index] : undefined;
      if (!active) {
        if (lastRenderKey) { renderer.clear(); lastRenderKey = ''; }
        return;
      }
      const key = `${active.start}:${active.text}:${active.translation ?? ''}`;
      if (key === lastRenderKey) return;
      lastRenderKey = key;
      renderer.show(active.text, active.translation);
    }

    return {
      async onIdentity(identity: BiliVideoIdentity): Promise<void> {
        if (disabled) return;
        if (!isVideoPage()) return;
        const key = `${identity.aid}:${identity.cid}`;
        if (key === cidKey) return;
        cidKey = key;
        sessionId += 1;
        cues = [];
        lastRenderKey = '';
        await begin(identity);
      },
      tick(): void {
        if (disabled || !cues.length) return;
        const time = getVideoTime();
        if (time !== undefined) renderAt(time);
      },
      reset(): void {
        sessionId += 1;
        cidKey = '';
        cues = [];
        lastRenderKey = '';
        renderer.clear();
      },
      disable(): void {
        disabled = true;
        this.reset();
      },
      enable(): void {
        disabled = false;
      },
    };
  }

  // MAIN world 视频标识 → 会话。
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== TARGET_ORIGIN) return;
    const data = event.data as { source?: string; aid?: string; cid?: string; bvid?: string } | null;
    if (data?.source !== BILI_MESSAGE_SOURCE || typeof data.aid !== 'string' || typeof data.cid !== 'string') return;
    void session.onIdentity({ aid: data.aid, cid: data.cid, bvid: data.bvid });
  });

  window.setInterval(() => session.tick(), TICK_INTERVAL_MS);

  // 功能开关：关闭停用并清屏；开启重建（等待下一次身份轮询或立即补发）。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' && area !== 'sync') return;
    const settingsChange = changes.translatorSettings;
    if (!settingsChange) return;
    const preferences = (settingsChange.newValue as { readingPreferences?: { videoSubtitleEnabled?: boolean } } | undefined)?.readingPreferences;
    if (preferences?.videoSubtitleEnabled === false) {
      session.disable();
      return;
    }
    session.enable();
    const identity = readIdentityFromWindow();
    if (identity) void session.onIdentity(identity);
  });

  function readIdentityFromWindow(): BiliVideoIdentity | undefined {
    try {
      const videoData = (window as unknown as { __INITIAL_STATE__?: { videoData?: { aid?: number | string; cid?: number | string; bvid?: string } } }).__INITIAL_STATE__?.videoData;
      if (!videoData?.aid || !videoData?.cid) return undefined;
      return { aid: String(videoData.aid), cid: String(videoData.cid), ...(videoData.bvid ? { bvid: String(videoData.bvid) } : {}) };
    } catch {
      return undefined;
    }
  }
}
