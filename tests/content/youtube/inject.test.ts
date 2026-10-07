import { describe, expect, it, vi } from 'vitest';

import { createYouTubeCapture, isTimedtextUrl, normKey } from '../../../src/content/youtube/inject';

// MAIN world 捕获脚本：hook fetch/XHR + PerformanceObserver 兜底，
// 捕获播放器自己的 /api/timedtext 请求（携带 pot）并 postMessage 转发。

describe('timedtext URL 判别与规范化', () => {
  it('识别 timedtext 请求', () => {
    expect(isTimedtextUrl('https://www.youtube.com/api/timedtext?v=abc&fmt=json3')).toBe(true);
    expect(isTimedtextUrl('https://www.youtube.com/watch?v=abc')).toBe(false);
  });

  it('normKey 剥离 pot/fmt/tlang/expire：轮换后身份稳定，tlang 变体与原文轨同键', () => {
    const first = normKey('https://www.youtube.com/api/timedtext?v=abc&lang=en&pot=AAA&fmt=json3&expire=123');
    const rotated = normKey('https://www.youtube.com/api/timedtext?v=abc&lang=en&pot=BBB&fmt=json3&expire=456');
    const withTlang = normKey('https://www.youtube.com/api/timedtext?v=abc&lang=en&pot=AAA&tlang=zh-Hans');
    expect(first).toBe(rotated);
    expect(first).toBe(withTlang);
    expect(normKey('not a url')).toBeUndefined();
  });
});

describe('createYouTubeCapture', () => {
  function createCapture() {
    const posted: Array<{ source: string; url: string }> = [];
    const capture = createYouTubeCapture({
      postMessage: vi.fn((message: { source: string; url: string }) => posted.push(message)),
      origin: () => 'https://www.youtube.com',
      baseUri: () => 'https://www.youtube.com/watch?v=abc',
    });
    return { posted, capture };
  }

  it('包装 fetch：捕获 timedtext 请求并透传原调用', async () => {
    const { posted, capture } = createCapture();
    const original = vi.fn(async () => 'page-response');
    const hooked = capture.wrapFetch(original as unknown as typeof globalThis.fetch);
    const result = await hooked('https://www.youtube.com/api/timedtext?v=abc&pot=XYZ');
    expect(result).toBe('page-response');
    expect(original).toHaveBeenCalledWith('https://www.youtube.com/api/timedtext?v=abc&pot=XYZ', undefined);
    expect(posted).toEqual([{ source: 'lexiytds-inject', url: 'https://www.youtube.com/api/timedtext?v=abc&pot=XYZ' }]);
  });

  it('非 timedtext 请求不转发；相对地址解析为绝对地址；Request 对象取 url', async () => {
    const { posted, capture } = createCapture();
    const hooked = capture.wrapFetch(vi.fn(async () => null) as unknown as typeof globalThis.fetch);
    await hooked('/api/timedtext?v=rel&pot=R');
    await hooked('https://www.youtube.com/watch?v=x');
    await hooked(new Request('https://www.youtube.com/api/timedtext?v=req&pot=Q'));
    expect(posted).toHaveLength(2);
    expect(posted[0].url).toBe('https://www.youtube.com/api/timedtext?v=rel&pot=R');
    expect(posted[1].url).toBe('https://www.youtube.com/api/timedtext?v=req&pot=Q');
  });

  it('包装 XHR open：捕获地址且原调用透传', () => {
    const { posted, capture } = createCapture();
    const original = vi.fn(() => undefined);
    const hooked = capture.wrapXhrOpen(original as unknown as XMLHttpRequest['open']);
    const fakeXhr = {} as XMLHttpRequest;
    hooked.call(fakeXhr, 'GET', 'https://www.youtube.com/api/timedtext?v=xhr&pot=H', true);
    expect(original).toHaveBeenCalledWith('GET', 'https://www.youtube.com/api/timedtext?v=xhr&pot=H', true);
    expect(posted).toEqual([{ source: 'lexiytds-inject', url: 'https://www.youtube.com/api/timedtext?v=xhr&pot=H' }]);
  });

  it('PerformanceObserver 兜底捕获资源条目（创建时即注册回调）', () => {
    const posted: Array<{ source: string; url: string }> = [];
    let fireResource: ((url: string) => void) | undefined;
    createYouTubeCapture({
      postMessage: (message) => posted.push(message),
      origin: () => 'https://www.youtube.com',
      baseUri: () => 'https://www.youtube.com/watch?v=abc',
      observeResources: (callback) => { fireResource = callback; return () => undefined; },
    });
    expect(fireResource).toBeTypeOf('function');
    fireResource?.('https://www.youtube.com/api/timedtext?v=po&pot=P');
    expect(posted).toEqual([{ source: 'lexiytds-inject', url: 'https://www.youtube.com/api/timedtext?v=po&pot=P' }]);
  });

  it('页面请求抛错不影响捕获', async () => {
    const { posted, capture } = createCapture();
    const hooked = capture.wrapFetch(vi.fn(async () => { throw new Error('page error'); }));
    await expect(hooked('https://www.youtube.com/api/timedtext?v=err&pot=E')).rejects.toThrow('page error');
    expect(posted).toEqual([{ source: 'lexiytds-inject', url: 'https://www.youtube.com/api/timedtext?v=err&pot=E' }]);
  });
});
