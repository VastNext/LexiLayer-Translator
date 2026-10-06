import { describe, expect, it, vi } from 'vitest';

import { translateSubtitles, type SubtitleTranslateDeps } from '../../../src/content/youtube/translate';
import type { SubtitleCue } from '../../../src/content/youtube/timedtext';

// 字幕翻译管线：tlang 优先（同文/失败降级），current-engine 渐进回调，双失败仅原文。

const cues: SubtitleCue[] = [
  { start: 0, end: 1, text: 'Hello' },
  { start: 2, end: 3, text: 'World' },
];

function createDeps(overrides: Partial<SubtitleTranslateDeps> = {}) {
  return {
    fetchText: vi.fn(async () => JSON.stringify({ events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '你好' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: '世界' }] },
    ] })),
    translateBatch: vi.fn(async (_segments: string[], _source: string, _target: string, onPartial?: (translations: Map<number, string>) => void) => {
      onPartial?.(new Map([['yt-0', '你好'], ['yt-1', '世界']]));
    }),
    ...overrides,
  } as SubtitleTranslateDeps & { fetchText: ReturnType<typeof vi.fn>; translateBatch: ReturnType<typeof vi.fn> };
}

describe('translateSubtitles', () => {
  it('youtube-tlang 引擎：重放 tlang 轨并按序配对', async () => {
    const deps = createDeps();
    const result = await translateSubtitles(deps, {
      engine: 'youtube-tlang', capturedUrl: 'https://www.youtube.com/api/timedtext?v=a&lang=en&pot=P',
      sourceLanguage: 'en', targetLanguage: 'zh-Hans', cues,
    });
    expect(deps.fetchText).toHaveBeenCalledWith(expect.stringContaining('tlang=zh-Hans'));
    expect(deps.translateBatch).not.toHaveBeenCalled();
    expect(result.status).toBe('translated');
    expect(result.cues[0]).toEqual({ start: 0, end: 1, text: 'Hello', translation: '你好' });
  });

  it('tlang 同文视为未翻译，降级 current-engine', async () => {
    const deps = createDeps({
      fetchText: vi.fn(async () => JSON.stringify({ events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] },
        { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'World' }] },
      ] })),
    });
    const result = await translateSubtitles(deps, {
      engine: 'youtube-tlang', capturedUrl: 'https://www.youtube.com/api/timedtext?v=a&lang=en&pot=P',
      sourceLanguage: 'en', targetLanguage: 'zh-Hans', cues,
    });
    expect(deps.translateBatch).toHaveBeenCalled();
    expect(result.status).toBe('translated');
    expect(result.cues[1]?.translation).toBe('世界');
  });

  it('current-engine：分批渐进回调', async () => {
    const deps = createDeps();
    const partials: Array<Map<number, string>> = [];
    const result = await translateSubtitles(deps, {
      engine: 'current-engine', capturedUrl: 'https://www.youtube.com/api/timedtext?v=a&lang=en&pot=P',
      sourceLanguage: 'en', targetLanguage: 'zh-Hans', cues,
      onPartial: (partial) => partials.push(partial),
    });
    expect(deps.fetchText).not.toHaveBeenCalled();
    expect(partials).toHaveLength(1);
    expect(result.status).toBe('translated');
  });

  it('双引擎失败时仅原文并明确状态', async () => {
    const deps = createDeps({
      fetchText: vi.fn(async () => ''),
      translateBatch: vi.fn(async () => { throw new Error('engine down'); }),
    });
    const result = await translateSubtitles(deps, {
      engine: 'youtube-tlang', capturedUrl: 'https://www.youtube.com/api/timedtext?v=a&lang=en&pot=P',
      sourceLanguage: 'en', targetLanguage: 'zh-Hans', cues,
    });
    expect(result.status).toBe('untranslated');
    expect(result.cues).toEqual(cues);
  });

  it('current-engine 引擎下 tlang 不被调用，翻译失败仅原文', async () => {
    const deps = createDeps({
      translateBatch: vi.fn(async () => { throw new Error('down'); }),
    });
    const result = await translateSubtitles(deps, {
      engine: 'current-engine', capturedUrl: 'https://www.youtube.com/api/timedtext?v=a&lang=en&pot=P',
      sourceLanguage: 'en', targetLanguage: 'zh-Hans', cues,
    });
    expect(deps.fetchText).not.toHaveBeenCalled();
    expect(result.status).toBe('untranslated');
  });
});
