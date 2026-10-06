import { describe, expect, it, vi } from 'vitest';

import { createVideoSession, type VideoSessionDeps } from '../../../src/content/youtube/session';

// 视频字幕会话：捕获 → 获取原文 → 翻译 → 同步渲染；SPA 重建与广告期间停画。

const CAPTURED = 'https://www.youtube.com/api/timedtext?v=vid1&lang=en&pot=AAA';

const sourceBody = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'World' }] },
  ],
});
const translatedBody = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '你好' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: '世界' }] },
  ],
});

interface Harness {
  renderer: { show: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; showNotice: ReturnType<typeof vi.fn> };
  deps: VideoSessionDeps;
  session: ReturnType<typeof createVideoSession>;
  video: { currentTime: number };
  playerClasses: Set<string>;
  fetchText: ReturnType<typeof vi.fn>;
  translateBatch: ReturnType<typeof vi.fn>;
  ensureCaptions: ReturnType<typeof vi.fn>;
}

function createHarness(overrides: Partial<VideoSessionDeps> = {}): Harness {
  const renderer = { show: vi.fn(), clear: vi.fn(), showNotice: vi.fn() };
  const video = { currentTime: 0 };
  const playerClasses = new Set<string>();
  const fetchText = vi.fn(async (url: string) => (url.includes('tlang=') ? translatedBody : sourceBody));
  const translateBatch = vi.fn(async (_segments: unknown[], _source: string, _target: string, _engineId: string, _taskId: string, onPartial?: (translations: Map<string, string>) => void) => {
    onPartial?.(new Map([['yt-0', '你好'], ['yt-1', '世界']]));
  });
  const deps: VideoSessionDeps = {
    getConfig: vi.fn(async () => ({ enabled: true, engine: 'youtube-tlang' as const, engineId: 'google', targetLanguage: 'zh-Hans' })),
    fetchText,
    translateBatch,
    getVideoTime: () => video.currentTime,
    isAdShowing: () => playerClasses.has('ad-showing'),
    ensureCaptionsEnabled: vi.fn(async () => true),
    renderer: renderer as unknown as VideoSessionDeps['renderer'],
    notices: { readFailed: '未能读取字幕', noSubtitles: '该视频没有可用字幕', translateUnavailable: '字幕翻译暂不可用' },
    ...overrides,
  };
  const session = createVideoSession(deps);
  return { renderer, deps, session, video, playerClasses, fetchText, translateBatch, ensureCaptions: deps.ensureCaptionsEnabled as ReturnType<typeof vi.fn> };
}

describe('createVideoSession', () => {
  it('捕获 URL 后获取原文并按 tlang 引擎翻译', async () => {
    const harness = createHarness();
    await harness.session.onCapturedUrl(CAPTURED);
    const state = harness.session.getState();
    expect(state.status).toBe('translated');
    expect(state.cueCount).toBe(2);
    expect(harness.fetchText).toHaveBeenCalledTimes(2);
    expect(harness.translateBatch).not.toHaveBeenCalled();
  });

  it('pot 轮换（同 normKey 不同 URL）不重建会话', async () => {
    const harness = createHarness();
    await harness.session.onCapturedUrl(CAPTURED);
    await harness.session.onCapturedUrl(CAPTURED.replace('pot=AAA', 'pot=BBB'));
    expect(harness.fetchText).toHaveBeenCalledTimes(2);
  });

  it('功能关闭时不建立会话', async () => {
    const harness = createHarness({ getConfig: vi.fn(async () => ({ enabled: false, engine: 'youtube-tlang' as const, engineId: 'google', targetLanguage: 'zh-Hans' })) });
    await harness.session.onCapturedUrl(CAPTURED);
    expect(harness.session.getState().status).toBe('idle');
    expect(harness.fetchText).not.toHaveBeenCalled();
  });

  it('原文获取失败（pot 空 body）时显示状态提示', async () => {
    const harness = createHarness({ fetchText: vi.fn(async () => '') });
    await harness.session.onCapturedUrl(CAPTURED);
    expect(harness.session.getState().status).toBe('unavailable-source');
    expect(harness.renderer.showNotice).toHaveBeenCalled();
  });

  it('tlang 同文时降级 current-engine', async () => {
    const harness = createHarness({ fetchText: vi.fn(async () => sourceBody) });
    await harness.session.onCapturedUrl(CAPTURED);
    expect(harness.translateBatch).toHaveBeenCalled();
    expect(harness.session.getState().status).toBe('translated');
  });

  it('tick 按播放进度渲染对应 cue，拖动进度可回跳', async () => {
    const harness = createHarness();
    await harness.session.onCapturedUrl(CAPTURED);
    harness.video.currentTime = 0.5;
    harness.session.tick();
    expect(harness.renderer.show).toHaveBeenLastCalledWith('Hello', '你好');
    harness.video.currentTime = 2.5;
    harness.session.tick();
    expect(harness.renderer.show).toHaveBeenLastCalledWith('World', '世界');
    harness.video.currentTime = 0.5;
    harness.session.tick();
    expect(harness.renderer.show).toHaveBeenLastCalledWith('Hello', '你好');
    harness.video.currentTime = 1.5;
    harness.session.tick();
    expect(harness.renderer.clear).toHaveBeenCalled();
  });

  it('广告期间停画', async () => {
    const harness = createHarness();
    harness.video.currentTime = 1.5;
    await harness.session.onCapturedUrl(CAPTURED);
    harness.playerClasses.add('ad-showing');
    harness.session.tick();
    expect(harness.renderer.show).not.toHaveBeenCalled();
    expect(harness.renderer.clear).toHaveBeenCalled();
  });

  it('reset 后旧会话的迟到结果被丢弃', async () => {
    const harness = createHarness();
    harness.session.reset();
    await harness.session.onCapturedUrl(CAPTURED);
    const generation = harness.session.getState().sessionId;
    harness.session.reset();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.session.getState().sessionId).not.toBe(generation);
    expect(harness.session.getState().cueCount).toBe(0);
  });

  it('current-engine 渐进渲染：批次到达即显示已翻译句子', async () => {
    const harness = createHarness({
      fetchText: vi.fn(async () => sourceBody),
      translateBatch: vi.fn(async (_segments: unknown[], _source: string, _target: string, _engineId: string, _taskId: string, onPartial?: (translations: Map<string, string>) => void) => {
        // 批次挂起期间（翻译未完成）也应显示已到译文：渐进渲染的核心断言。
        await vi.waitFor(() => {
          onPartial?.(new Map([['yt-0', '你好']]));
          expect(harness.renderer.show).toHaveBeenLastCalledWith('Hello', '你好');
        });
        expect(harness.session.getState().status).toBe('loading');
      }),
      getConfig: vi.fn(async () => ({ enabled: true, engine: 'current-engine' as const, engineId: 'google', targetLanguage: 'zh-Hans' })),
    });
    harness.video.currentTime = 0.5;
    void harness.session.onCapturedUrl(CAPTURED);
    await vi.waitFor(() => expect(harness.session.getState().status).toBe('translated'));
  });

  it('enable() 重新启用后再次捕获可建立会话', async () => {
    const harness = createHarness();
    harness.session.disable();
    await harness.session.onCapturedUrl(CAPTURED);
    expect(harness.session.getState().status).toBe('idle');
    harness.session.enable();
    await harness.session.onCapturedUrl(CAPTURED);
    expect(harness.session.getState().status).toBe('translated');
  });

  it('字幕间隙清屏（非启动期 clear）', async () => {
    const harness = createHarness();
    await harness.session.onCapturedUrl(CAPTURED);
    const clearsBefore = vi.mocked(harness.renderer.clear).mock.calls.length;
    harness.video.currentTime = 1.5;
    harness.session.tick();
    expect(vi.mocked(harness.renderer.clear).mock.calls.length).toBeGreaterThan(clearsBefore);
  });

  it('prepareForVideo 请求开启原生字幕（触发播放器发出捕获请求）', async () => {
    const harness = createHarness();
    await harness.session.prepareForVideo();
    expect(harness.ensureCaptions).toHaveBeenCalled();
  });
});
