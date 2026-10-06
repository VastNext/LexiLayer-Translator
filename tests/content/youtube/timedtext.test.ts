import { describe, expect, it } from 'vitest';

import {
  buildReplayUrl, hasTranslation, parseJson3, zipCues, type SubtitleCue,
} from '../../../src/content/youtube/timedtext';

// JSON3 解析与轨道对齐：pot 门禁下重放响应的解析是字幕功能的地基。

const originalBody = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
    { tStartMs: 1600, dDurationMs: 1200, segs: [{ utf8: 'Second line' }] },
    { tStartMs: 3000, dDurationMs: 500, aAppend: 1, segs: [{ utf8: 'append window' }] },
    { tStartMs: 3600, dDurationMs: 800, segs: [] },
    { tStartMs: 4500, dDurationMs: 900, segs: [{ utf8: '&gt;&gt; Speaker: quoted &amp; more' }] },
  ],
});

describe('parseJson3', () => {
  it('解析事件为 cue，丢弃 aAppend 与空事件，拼接 segs', () => {
    const cues = parseJson3(originalBody);
    expect(cues).toEqual([
      { start: 0, end: 1.5, text: 'Hello world' },
      { start: 1.6, end: 2.8, text: 'Second line' },
      { start: 4.5, end: 5.4, text: 'Speaker: quoted & more' },
    ]);
  });

  it('空 body（pot 门禁静默失败）与坏 JSON 显式报错', () => {
    expect(() => parseJson3('')).toThrow();
    expect(() => parseJson3('{invalid')).toThrow();
    expect(() => parseJson3('{"events": null}')).toThrow();
  });

  it('全部事件为空时返回空数组', () => {
    const cues = parseJson3(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 100, aAppend: 1, segs: [{ utf8: 'x' }] }] }));
    expect(cues).toEqual([]);
  });
});

describe('buildReplayUrl', () => {
  it('强制 fmt=json3，可选附加 tlang，保留 pot 等其余参数', () => {
    const captured = 'https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=srv3&pot=XYZ';
    expect(buildReplayUrl(captured, {})).toBe('https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3&pot=XYZ');
    const withTlang = new URL(buildReplayUrl(captured, { tlang: 'zh-Hans' }));
    expect(withTlang.searchParams.get('fmt')).toBe('json3');
    expect(withTlang.searchParams.get('tlang')).toBe('zh-Hans');
    expect(withTlang.searchParams.get('pot')).toBe('XYZ');
    expect(buildReplayUrl('not-a-url', {})).toBeUndefined();
  });
});

describe('zipCues 与 hasTranslation', () => {
  const source: SubtitleCue[] = [
    { start: 0, end: 1, text: 'Hello' },
    { start: 2, end: 3, text: 'World' },
  ];

  it('条数一致时按序配对', () => {
    const translated: SubtitleCue[] = [
      { start: 0, end: 1, text: '你好' },
      { start: 2, end: 3, text: '世界' },
    ];
    const zipped = zipCues(source, translated);
    expect(zipped?.[0]).toEqual({ start: 0, end: 1, text: 'Hello', translation: '你好' });
  });

  it('条数不一致判为对齐失败', () => {
    expect(zipCues(source, [{ start: 0, end: 1, text: '你好' }])).toBeUndefined();
  });

  it('翻译轨与原文逐条相同视为未翻译', () => {
    expect(hasTranslation(source, structuredClone(source))).toBe(false);
    expect(hasTranslation(source, [
      { start: 0, end: 1, text: '你好' },
      { start: 2, end: 3, text: '世界' },
    ])).toBe(true);
  });
});
