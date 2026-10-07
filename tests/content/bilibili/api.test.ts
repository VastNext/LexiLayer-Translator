import { describe, expect, it, vi } from 'vitest';

import { fetchBiliSubtitleCues, fetchBiliSubtitleTracks } from '../../../src/content/bilibili/api';

// B 站字幕数据访问：轨道列表（含未登录态）与字幕内容解析。

describe('fetchBiliSubtitleTracks', () => {
  it('解析字幕轨并把 http 地址升级为 https', async () => {
    const fetchText = vi.fn(async (_url: string) => JSON.stringify({
      code: 0,
      data: { subtitle: { subtitles: [
        { lan: 'ai-zh', lan_doc: 'AI 中文', subtitle_url: 'http://aisubtitle.hdslb.com/abc.json' },
        { lan: 'zh-Hans', lan_doc: '中文（自动）', subtitle_url: 'https://i0.hdslb.com/def.json' },
      ] } },
    }));
    const subtitles = await fetchBiliSubtitleTracks({ fetchText }, '100', '200');
    expect(subtitles.needLogin).toBe(false);
    expect(subtitles.tracks).toEqual([
      { lan: 'ai-zh', lanDoc: 'AI 中文', url: 'https://aisubtitle.hdslb.com/abc.json' },
      { lan: 'zh-Hans', lanDoc: '中文（自动）', url: 'https://i0.hdslb.com/def.json' },
    ]);
    expect(vi.mocked(fetchText).mock.calls[0][0]).toContain('aid=100');
    expect(vi.mocked(fetchText).mock.calls[0][0]).toContain('cid=200');
  });

  it('未登录时 needLogin=true 且轨道为空', async () => {
    const fetchText = vi.fn(async (_url: string) => JSON.stringify({ code: 0, data: { subtitle: { subtitles: [], need_login_subtitle: true } } }));
    const subtitles = await fetchBiliSubtitleTracks({ fetchText }, '1', '2');
    expect(subtitles.needLogin).toBe(true);
    expect(subtitles.tracks).toEqual([]);
  });

  it('坏 JSON 显式报错', async () => {
    await expect(fetchBiliSubtitleTracks({ fetchText: vi.fn(async () => '{bad') }, '1', '2')).rejects.toThrow('字幕接口响应无效');
  });
});

describe('fetchBiliSubtitleCues', () => {
  it('解析 from/to/content 为 cue，过滤空行并保证最短时长', async () => {
    const fetchText = vi.fn(async (_url: string) => JSON.stringify({ body: [
      { from: 0, to: 2.5, content: '  第一句  ' },
      { from: 3, to: 3, content: '零时长' },
      { from: 4, to: 5, content: '   ' },
    ] }));
    const cues = await fetchBiliSubtitleCues({ fetchText }, 'https://aisubtitle.hdslb.com/abc.json');
    expect(cues).toEqual([
      { start: 0, end: 2.5, text: '第一句' },
      { start: 3, end: 3.2, text: '零时长' },
    ]);
  });

  it('坏 JSON 与非站内 CDN 地址显式报错', async () => {
    await expect(fetchBiliSubtitleCues({ fetchText: vi.fn(async () => 'nope') }, 'https://aisubtitle.hdslb.com/x.json')).rejects.toThrow('字幕内容响应无效');
    await expect(fetchBiliSubtitleCues({ fetchText: vi.fn(async () => '{}') }, 'https://evil.example/sub.json')).rejects.toThrow('字幕内容地址无效');
  });
});
