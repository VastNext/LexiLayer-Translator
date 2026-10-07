import { describe, expect, it, vi } from 'vitest';

import { installBilibiliIdentityPolling, readVideoIdentity } from '../../../src/content/bilibili/inject';

// B 站 MAIN world 注入：从页面初始化数据读取视频标识，分 P 切换（cid 变化）时通知。

describe('readVideoIdentity', () => {
  it('从 __INITIAL_STATE__.videoData 读取 aid/cid/bvid', () => {
    const win = { __INITIAL_STATE__: { videoData: { aid: 100, bvid: 'BV1xx', cid: 200 } } } as unknown as Window;
    expect(readVideoIdentity(win)).toEqual({ aid: '100', bvid: 'BV1xx', cid: '200' });
  });

  it('缺 aid 或 cid 时返回 undefined', () => {
    expect(readVideoIdentity({ __INITIAL_STATE__: { videoData: { aid: 100 } } } as unknown as Window)).toBeUndefined();
    expect(readVideoIdentity({} as unknown as Window)).toBeUndefined();
  });
});

describe('installBilibiliIdentityPolling', () => {
  function createFakeWin(identity: () => unknown) {
    const posted: Array<Record<string, unknown>> = [];
    const timers: Array<() => void> = [];
    const win = {
      __INITIAL_STATE__: undefined,
      setInterval: (callback: () => void) => { timers.push(callback); return timers.length; },
      postMessage: vi.fn((message: Record<string, unknown>) => posted.push(message)),
      location: { origin: 'https://www.bilibili.com' },
    } as unknown as Window & { setInterval: (callback: () => void) => number; postMessage: (m: Record<string, unknown>, o: string) => void; location: { origin: string } };
    Object.defineProperty(win, '__INITIAL_STATE__', { get: identity, configurable: true });
    return { win, posted, timers };
  }

  it('身份出现时通知一次，cid 变化（分 P）再次通知', () => {
    let state: unknown = undefined;
    const { win, posted, timers } = createFakeWin(() => state);
    installBilibiliIdentityPolling(win, {
      setInterval: (callback: () => void) => { timers.push(callback); return 1; },
      postMessage: (message, origin) => { void origin; posted.push(message); },
      origin: () => 'https://www.bilibili.com',
    });
    expect(timers).toHaveLength(1);

    state = { videoData: { aid: 100, cid: 200 } };
    timers[0]();
    expect(posted).toEqual([{ source: 'lexibili-inject', aid: '100', cid: '200' }]);

    timers[0]();
    expect(posted).toHaveLength(1);

    state = { videoData: { aid: 100, cid: 300 } };
    timers[0]();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual({ source: 'lexibili-inject', aid: '100', cid: '300' });
  });

  it('重复安装幂等', () => {
    const { win, timers } = createFakeWin(() => undefined);
    installBilibiliIdentityPolling(win, { setInterval: (callback: () => void) => { timers.push(callback); return 1; } });
    installBilibiliIdentityPolling(win, { setInterval: (callback: () => void) => { timers.push(callback); return 2; } });
    expect(timers).toHaveLength(1);
  });
});
