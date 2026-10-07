import { expect, test } from './fixtures';

// Phase 2：B 站双语字幕闭环——在真实 bilibili.com 源上用路由拦截提供合成播放器页、
// 站内字幕接口与字幕内容，验证「身份轮询 → 轨道读取 → 当前引擎翻译 → 双语渲染」。
// 真实站内接口的登录态/签名策略无法在 CI 复现，由真机验收。

const biliSubtitleJson = JSON.stringify({ body: [
  { from: 0, to: 1, content: 'Hello' },
  { from: 2, to: 3, content: 'World' },
] });

const biliPlayerHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Bili Subtitle Fixture</title></head>
<body>
<div id="bilibili-player"><video></video></div>
<script>
  window.__INITIAL_STATE__ = { videoData: { aid: 100, bvid: 'BV1test', cid: 200 } };
  const video = document.querySelector('video');
  let fakeTime = 0;
  Object.defineProperty(video, 'currentTime', { get: () => fakeTime, set: (value) => { fakeTime = Number(value); video.dataset.currentTime = String(fakeTime); } });
</script>
</body></html>`;

test('B站双语字幕：身份识别-轨道读取-AI翻译-双语渲染与进度切换', async ({ context, server, openExtensionPage }) => {
  // 「跟随当前翻译引擎」需要已配置引擎；先在 Options 配置自定义 AI（指向 mock 服务器）。
  const options = await openExtensionPage('options.html');
  await options.getByRole('button', { name: '新增自定义 AI' }).click();
  const card = options.getByRole('group').last();
  await expect(card.getByLabel('Base URL')).toBeEnabled();
  await card.getByLabel('名称').fill('E2E AI');
  await card.getByLabel('Base URL').fill(server.baseUrl);
  await card.getByLabel('API Key', { exact: true }).fill('e2e-key');
  await card.getByLabel('模型').fill('e2e-model');
  await card.getByRole('button', { name: '保存实例' }).click();
  await expect(options.getByRole('status')).toHaveText('实例已保存');
  await card.getByRole('button', { name: '设为默认' }).click();
  await expect(options.getByRole('status')).toHaveText('默认引擎已更新');
  await options.close();

  await context.route('https://api.bilibili.com/x/player/wbi/v2*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [
        { lan: 'ai-zh', lan_doc: 'AI 中文', subtitle_url: 'https://aisubtitle.hdslb.com/test.json' },
      ] } } }),
    });
  });
  await context.route('https://aisubtitle.hdslb.com/*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: biliSubtitleJson });
  });
  await context.route('https://www.bilibili.com/video/*', async (route) => {
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: biliPlayerHtml });
  });

  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/video/BV1test');

  const host = page.locator('#bilibili-player [data-lexiytds-host]');
  await expect(host.locator('[data-lexiytds-source]')).toHaveText('Hello', { timeout: 20_000 });
  await expect(host.locator('[data-lexiytds-translation]')).toHaveText(/.+/);

  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video) video.currentTime = 2.5;
  });
  await expect(host.locator('[data-lexiytds-source]')).toHaveText('World');
});
