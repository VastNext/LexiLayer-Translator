import { expect, test } from './fixtures';

// YouTube 双语字幕 E2E：在真实 youtube.com 源上用路由拦截提供合成播放器页与
// 字幕响应，验证「MAIN world 捕获 → 重放 → tlang 翻译 → 双语渲染 → 进度切换」闭环。
// 真实 YouTube 的 pot 令牌链路无法在 CI 复现（由真机验收）；此处验证扩展自身的
// 捕获、重放、解析、渲染管线在 youtube.com 环境中真实运行。

const sourceJson3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'World' }] },
  ],
});
const translatedJson3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '你好' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: '世界' }] },
  ],
});

// 合成播放器页：结构与 youtube.com 播放器一致（.html5-video-player / video /
// CC 按钮），加载后 300ms 发出一次带 pot 的字幕请求（由页面自身 fetch 触发捕获）。
const playerHtml = `<!doctype html><html><head><meta charset="utf-8"><title>YT Subtitle Fixture</title></head>
<body>
<div id="movie_player" class="html5-video-player">
  <video class="html5-main-video"></video>
  <button class="ytp-subtitles-button" aria-pressed="false" aria-disabled="false"></button>
</div>
<script>
  const video = document.querySelector('video');
  let fakeTime = 0;
  Object.defineProperty(video, 'currentTime', { get: () => fakeTime, set: (value) => { fakeTime = Number(value); video.dataset.currentTime = String(fakeTime); } });
  setTimeout(() => { fetch('/api/timedtext?v=testvid&lang=en&fmt=srv3&pot=PLAYERPOT').catch(() => {}); }, 300);
</script>
</body></html>`;

test('YouTube 双语字幕：捕获-重放-渲染闭环与进度切换', async ({ context }) => {
  await context.route('https://www.youtube.com/api/timedtext*', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      contentType: 'application/json; charset=utf-8',
      body: url.searchParams.has('tlang') ? translatedJson3 : sourceJson3,
    });
  });
  await context.route('https://www.youtube.com/watch*', async (route) => {
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: playerHtml });
  });

  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=testvid');

  // 双语两行渲染（原文 + tlang 译文）。
  const host = page.locator('#movie_player [data-lexiytds-host]');
  await expect(host.locator('[data-lexiytds-source]')).toHaveText('Hello', { timeout: 15_000 });
  await expect(host.locator('[data-lexiytds-translation]')).toHaveText('你好');

  // 播放进度推进后切换到第二条字幕。
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video) video.currentTime = 2.5;
  });
  await expect(host.locator('[data-lexiytds-source]')).toHaveText('World');
  await expect(host.locator('[data-lexiytds-translation]')).toHaveText('世界');
});
