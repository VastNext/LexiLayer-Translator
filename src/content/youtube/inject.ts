// YouTube MAIN world 捕获脚本：hook fetch/XHR + PerformanceObserver 兜底，
// 捕获播放器自己发出的 /api/timedtext 请求（携带 pot 令牌）并 postMessage 转发。
// 所有 hook 全 try/catch：绝不能向页面抛异常或破坏页面请求。
// 本脚本经 manifest 以 world: "MAIN" + document_start 注入，独立于 ISOLATED 世界。

export const INJECT_MESSAGE_SOURCE = 'lexiytds-inject';

export interface CaptureMessage { source: string; url: string }

export interface CaptureEnvironment {
  postMessage(message: CaptureMessage, targetOrigin: string): void;
  origin(): string;
  baseUri(): string;
  observeResources?(callback: (url: string) => void): () => void;
}

export function isTimedtextUrl(url: string): boolean {
  try {
    return new URL(url, 'https://www.youtube.com').pathname === '/api/timedtext';
  } catch {
    return false;
  }
}

// 轨道身份键：剥离 pot/potc/fmt/tlang/expire（会轮换或仅是格式差异），保留其余参数。
// 原文轨与其 tlang 变体共享同一身份键——会话以原文轨为锚，tlang 由重放自行派生。
export function normKey(url: string): string | undefined {
  try {
    const parsed = new URL(url, 'https://www.youtube.com');
    if (parsed.pathname !== '/api/timedtext') return undefined;
    const keep = new URLSearchParams();
    const drop = new Set(['pot', 'potc', 'fmt', 'tlang', 'expire']);
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!drop.has(key)) keep.append(key, value);
    }
    keep.sort();
    return `${parsed.origin}${parsed.pathname}?${keep.toString()}`;
  } catch {
    return undefined;
  }
}

export function createYouTubeCapture(environment: CaptureEnvironment) {
  // PerformanceObserver 兜底在创建时注册：其他扩展锁死原型时仍能捕获资源条目。
  environment.observeResources?.((url) => captureUrl(url));

  function captureUrl(raw: unknown): void {
    try {
      if (typeof raw !== 'string' && !(raw instanceof URL)) return;
      const value = String(raw);
      if (!isTimedtextUrl(value)) return;
      const absolute = new URL(value, environment.baseUri()).href;
      environment.postMessage({ source: INJECT_MESSAGE_SOURCE, url: absolute }, environment.origin());
    } catch { /* 捕获失败不影响页面请求 */ }
  }

  // 包装页面 fetch：先记 URL 再透传原请求，返回原始 Promise。
  function wrapFetch(original: typeof globalThis.fetch): typeof globalThis.fetch {
    return (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        captureUrl(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input));
      } catch { /* 忽略捕获异常 */ }
      return original(input, init);
    };
  }

  // 包装 XMLHttpRequest.prototype.open：签名保持不变，先记 URL 再透传。
  function wrapXhrOpen(original: (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => unknown): XMLHttpRequest['open'] {
    return function hookedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      try {
        captureUrl(url);
      } catch { /* 忽略捕获异常 */ }
      return original.apply(this, [method, url, ...rest] as Parameters<XMLHttpRequest['open']>);
    } as XMLHttpRequest['open'];
  }

  return { captureUrl, wrapFetch, wrapXhrOpen };
}

export function installYouTubeCapture(win: Window = globalThis as unknown as Window): void {
  const scoped = win as Window & { __lexiYouTubeInjectInstalled?: boolean };
  if (scoped.__lexiYouTubeInjectInstalled) return;
  scoped.__lexiYouTubeInjectInstalled = true;
  const capture = createYouTubeCapture({
    postMessage: (message, targetOrigin) => win.postMessage(message, targetOrigin),
    origin: () => win.location.origin,
    baseUri: () => win.location.href,
    observeResources: (callback) => {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) callback(entry.name);
      });
      observer.observe({ type: 'resource', buffered: true });
      return () => observer.disconnect();
    },
  });
  try {
    win.fetch = capture.wrapFetch(win.fetch.bind(win)) as typeof win.fetch;
  } catch { /* hook 失败时仍可用 PerformanceObserver 兜底 */ }
  try {
    XMLHttpRequest.prototype.open = capture.wrapXhrOpen(XMLHttpRequest.prototype.open);
  } catch { /* 其他扩展可能已锁死原型；PerformanceObserver 兜底 */ }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        try { capture.captureUrl(entry.name); } catch { /* 忽略 */ }
      }
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch { /* PerformanceObserver 不可用时依赖 fetch/XHR hook */ }
}

// MAIN world IIFE 自启动：仅在 youtube.com 上安装（测试导入时 location 非 youtube，不触发）。
if (typeof location !== 'undefined' && location.hostname === 'www.youtube.com') {
  installYouTubeCapture();
}
