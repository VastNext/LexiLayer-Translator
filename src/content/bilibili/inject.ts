// Bilibili MAIN world 注入脚本：读取页面初始化数据中的视频标识（aid/cid），
// 轮询变化（分 P 切换）后经 window.postMessage 转发给 ISOLATED 控制脚本。

export const BILI_MESSAGE_SOURCE = 'lexibili-inject';

export interface BiliVideoIdentity {
  aid: string;
  bvid?: string;
  cid: string;
}

export interface BiliInjectEnvironment {
  setInterval(callback: () => void, intervalMs: number): number;
  postMessage(message: Record<string, unknown>, targetOrigin: string): void;
  origin(): string;
}

// 从页面初始化数据读取当前视频标识（仅视频页存在；番剧等页面返回 undefined）。
export function readVideoIdentity(win: Window = globalThis as unknown as Window): BiliVideoIdentity | undefined {
  try {
    const videoData = (win as unknown as {
      __INITIAL_STATE__?: { videoData?: { aid?: number | string; bvid?: string; cid?: number | string } };
    }).__INITIAL_STATE__?.videoData;
    if (!videoData?.aid || !videoData?.cid) return undefined;
    return {
      aid: String(videoData.aid),
      cid: String(videoData.cid),
      ...(videoData.bvid ? { bvid: String(videoData.bvid) } : {}),
    };
  } catch {
    return undefined;
  }
}

export function installBilibiliIdentityPolling(win: Window = globalThis as unknown as Window, environment?: Partial<BiliInjectEnvironment>): void {
  const scoped = win as Window & { __lexiBiliInjectInstalled?: boolean };
  if (scoped.__lexiBiliInjectInstalled) return;
  scoped.__lexiBiliInjectInstalled = true;
  const deps: BiliInjectEnvironment = {
    setInterval: win.setInterval.bind(win),
    postMessage: (message, targetOrigin) => win.postMessage(message, targetOrigin),
    origin: () => win.location.origin,
    ...environment,
  };
  let lastKey = '';
  deps.setInterval(() => {
    try {
      const identity = readVideoIdentity(win);
      if (!identity) return;
      const key = `${identity.aid}:${identity.cid}`;
      if (key === lastKey) return;
      lastKey = key;
      deps.postMessage({ source: BILI_MESSAGE_SOURCE, ...identity }, deps.origin());
    } catch { /* 读取失败忽略，下个轮询周期重试 */ }
  }, 1_000);
}

// IIFE 自启动：仅在 bilibili.com 上安装（测试导入时不触发）。
if (typeof location !== 'undefined' && location.hostname === 'www.bilibili.com') {
  installBilibiliIdentityPolling();
}
