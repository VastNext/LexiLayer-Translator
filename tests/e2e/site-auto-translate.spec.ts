import { expect, test } from './fixtures';

// 站内跳转自动延续：同域名跳转后自动继续翻译，还原后停止（后台 tabs.onUpdated 驱动）。

const API_KEY = 'e2e-secret-key-not-for-dom';

async function useLegacyRenderer(options: import('@playwright/test').Page): Promise<void> {
  await expect(options.getByRole('button', { name: '新增自定义 AI' })).toBeEnabled();
  await options.getByLabel('渲染器模式').selectOption('legacy');
  await expect(options.getByRole('status')).toHaveText('设置已保存');
}

async function saveConfiguration(options: import('@playwright/test').Page, baseUrl: string): Promise<void> {
  await options.getByRole('button', { name: '新增自定义 AI' }).click();
  const card = options.getByRole('group').last();
  await expect(card.getByLabel('Base URL')).toBeEnabled();
  await card.getByLabel('名称').fill('E2E 自定义 AI');
  await card.getByLabel('Base URL').fill(baseUrl);
  await card.getByLabel('API Key', { exact: true }).fill(API_KEY);
  await card.getByLabel('模型').fill('e2e-model');
  await card.getByRole('button', { name: '保存实例' }).click();
  await expect(options.getByRole('status')).toHaveText('实例已保存');
  await card.getByRole('button', { name: '设为默认' }).click();
  await expect(options.getByRole('status')).toHaveText('默认引擎已更新');
  await useLegacyRenderer(options);
}

async function openFixture(context: import('@playwright/test').BrowserContext, url: string) {
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('main')).toBeVisible();
  return page;
}

async function openPopupForFixture(
  openExtensionPage: (path: 'popup.html' | 'options.html') => Promise<import('@playwright/test').Page>,
  fixture: import('@playwright/test').Page,
): Promise<import('@playwright/test').Page> {
  const popup = await openExtensionPage('popup.html');
  await fixture.bringToFront();
  await popup.reload();
  await expect(popup.getByLabel('翻译引擎')).not.toHaveValue('google');
  return popup;
}

async function clickPopupButton(
  popup: import('@playwright/test').Page,
  fixture: import('@playwright/test').Page,
  name: string,
): Promise<void> {
  await fixture.bringToFront();
  const button = popup.getByRole('button', { name });
  await expect(button).toBeEnabled();
  await button.evaluate((element: HTMLButtonElement) => element.click());
}

test('同域名跳转自动延续翻译，还原后跳转不再翻译', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await saveConfiguration(options, server.baseUrl);
  await options.close();

  const page = await openFixture(context, server.siteAFixtureUrl);
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译当前页面');
  await expect(page.locator('#site-a-1 + [data-vast-translator]')).toHaveText('站点第一页。');

  // 同域名跳转：第二页自动出现译文，无需再次点击翻译。
  await page.click('#site-link-b');
  await expect(page.locator('#site-b-1')).toBeVisible();
  await expect(page.locator('#site-b-1 + [data-vast-translator]')).toHaveText('站点第二页。');

  // 还原后：当前页恢复原文，再次同域名跳转不再自动翻译。
  await clickPopupButton(popup, page, '显示当前页面原文');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await page.click('#site-link-a');
  await expect(page.locator('#site-a-1')).toBeVisible();
  // complete 事件后的重试窗口最长约 3 秒；窗口结束仍无译文即视为未自动翻译。
  await page.waitForTimeout(4_000);
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
});
