// 视频字幕会话：捕获 URL → 获取原文 → 翻译 → 同步渲染。
// 生命周期：onCapturedUrl 开启会话（generation 隔离）；pot 轮换只更新捕获地址；
// reset 用于 SPA 导航重建；tick 由 120ms 轮询驱动渲染；广告期间停画。

import { buildReplayUrl, normKey, parseJson3, type DualSubtitleCue } from './timedtext';
import { translateSubtitles, type SubtitleTranslateDeps } from './translate';
import type { VideoSubtitleEngine } from '../../shared/config';

export interface SessionConfig {
  enabled: boolean;
  engine: VideoSubtitleEngine;
  engineId: string;
  targetLanguage: string;
}

export interface SessionRenderer {
  show(source: string, translation: string | undefined): void;
  showNotice(message: string): void;
  clear(): void;
}

export interface VideoSessionDeps extends SubtitleTranslateDeps {
  getConfig(): Promise<SessionConfig>;
  // 状态提示文案由装配层经 i18n 解析（内容脚本无共享 i18n 通道）。
  notices: { readFailed: string; noSubtitles: string; translateUnavailable: string };
  getVideoTime(): number | undefined;
  isAdShowing(): boolean;
  ensureCaptionsEnabled(): Promise<boolean>;
  renderer: SessionRenderer;
}

export interface SessionState {
  sessionId: number;
  status: 'idle' | 'loading' | 'translated' | 'untranslated' | 'unavailable-source';
  cueCount: number;
}

export function createVideoSession(deps: VideoSessionDeps) {
  let sessionId = 0;
  let normKeyValue: string | undefined;
  let capturedUrl: string | undefined;
  let cues: DualSubtitleCue[] = [];
  let status: SessionState['status'] = 'idle';
  let lastRenderKey = '';
  let disabled = false;

  async function startSession(url: string, key: string): Promise<void> {
    sessionId += 1;
    const generation = sessionId;
    normKeyValue = key;
    capturedUrl = url;
    cues = [];
    status = 'loading';
    lastRenderKey = '';
    deps.renderer.clear();
    const config = await deps.getConfig().catch(() => undefined);
    if (generation !== sessionId || disabled) return;
    if (!config?.enabled) {
      status = 'idle';
      return;
    }
    // 开启原生字幕是捕获链路的前置条件；捕获已到达说明 CC 已开启，此处失败不阻断。
    await deps.ensureCaptionsEnabled().catch(() => false);
    if (generation !== sessionId || disabled) return;
    const sourceUrl = buildReplayUrl(url, {});
    if (!sourceUrl) {
      status = 'unavailable-source';
      deps.renderer.showNotice(deps.notices.readFailed);
      return;
    }
    let sourceCues;
    try {
      const body = await deps.fetchText(sourceUrl);
      sourceCues = parseJson3(body);
    } catch {
      status = 'unavailable-source';
      deps.renderer.showNotice(deps.notices.readFailed);
      return;
    }
    if (generation !== sessionId || disabled) return;
    if (!sourceCues.length) {
      status = 'unavailable-source';
      deps.renderer.showNotice(deps.notices.noSubtitles);
      return;
    }
    const sourceLanguage = new URL(url).searchParams.get('lang') ?? 'auto';
    // 渐进渲染基座：先以原文填充 cues，翻译批次到达时逐句补译文。
    cues = sourceCues.map((cue) => ({ ...cue }));
    const result = await translateSubtitles(deps, {
      engine: config.engine, engineId: config.engineId, taskIdPrefix: `yts-${generation}`,
      capturedUrl: url, sourceLanguage, targetLanguage: config.targetLanguage, cues: sourceCues,
      onPartial: (partial) => {
        if (generation !== sessionId || disabled) return;
        partial.forEach((text, index) => {
          if (cues[index]) cues[index] = { ...cues[index], translation: text };
        });
        rerenderCurrent();
      },
    });
    if (generation !== sessionId || disabled) return;
    cues = result.cues;
    status = result.status;
    if (result.status === 'untranslated') deps.renderer.showNotice(deps.notices.translateUnavailable);
    rerenderCurrent();
  }

  function rerenderCurrent(): void {
    const time = deps.getVideoTime();
    if (time === undefined) return;
    renderAt(time);
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
      if (lastRenderKey) { deps.renderer.clear(); lastRenderKey = ''; }
      return;
    }
    const cue = active;
    const key = `${cue.start}:${cue.text}:${cue.translation ?? ''}`;
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    deps.renderer.show(cue.text, cue.translation);
  }

  return {
    async onCapturedUrl(url: string): Promise<void> {
      if (disabled) return;
      const key = normKey(url);
      if (!key) return;
      if (key === normKeyValue) {
        // pot 轮换：仅更新捕获地址；源不可用（瞬时失败）时允许重建会话重试。
        capturedUrl = url;
        if (status === 'unavailable-source') await startSession(url, key);
        return;
      }
      try {
        await startSession(url, key);
      } catch {
        if (sessionId > 0 && !disabled) {
          status = 'unavailable-source';
          deps.renderer.showNotice(deps.notices.readFailed);
        }
      }
    },

    // SPA 导航到新视频后调用：请求开启原生字幕以触发播放器发出捕获请求。
    async prepareForVideo(): Promise<void> {
      if (disabled) return;
      await deps.ensureCaptionsEnabled().catch(() => false);
    },

    tick(): void {
      if (disabled || !cues.length) return;
      if (deps.isAdShowing()) {
        if (lastRenderKey) { deps.renderer.clear(); lastRenderKey = ''; }
        return;
      }
      const time = deps.getVideoTime();
      if (time === undefined) return;
      renderAt(time);
    },

    reset(): void {
      sessionId += 1;
      normKeyValue = undefined;
      capturedUrl = undefined;
      cues = [];
      status = 'idle';
      lastRenderKey = '';
      deps.renderer.clear();
    },

    disable(): void {
      disabled = true;
      this.reset();
    },

    enable(): void {
      disabled = false;
    },

    getState(): SessionState {
      return { sessionId, status, cueCount: cues.length };
    },

    // 供测试/调试：当前会话的重放地址。
    getCapturedUrl(): string | undefined {
      return capturedUrl;
    },
  };
}
