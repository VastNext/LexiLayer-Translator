import { resolve } from 'node:path';

import { expect, test } from './fixtures';

const API_KEY = 'e2e-secret-key-not-for-dom';
const evidence = (name: string) => resolve(import.meta.dirname, `../evidence/e2e-${name}.png`);

async function configure(options: import('@playwright/test').Page, baseUrl: string): Promise<void> {
  await expect(options.getByLabel('Base URL')).toBeEnabled();
  await options.getByLabel('Base URL').fill(baseUrl);
  await options.getByLabel('API Key').fill(API_KEY);
  await options.getByLabel('模型').fill('e2e-model');
}

async function saveConfiguration(options: import('@playwright/test').Page, baseUrl: string): Promise<void> {
  await configure(options, baseUrl);
  await options.getByRole('button', { name: '保存设置' }).click();
  await expect(options.getByRole('status')).toHaveText('设置已保存');
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
) {
  const popup = await openExtensionPage('popup.html');
  await fixture.bringToFront();
  return popup;
}

async function clickPopupButton(
  popup: import('@playwright/test').Page,
  fixture: import('@playwright/test').Page,
  name: string,
): Promise<void> {
  await fixture.bringToFront();
  await popup.getByRole('button', { name }).evaluate((button: HTMLButtonElement) => button.click());
}

test.describe.configure({ mode: 'serial' });

test('MV3、Popup 与 Options 无错误加载，未保存配置可测试并在保存后持久化', async ({
  extensionId, serviceWorker, server, openExtensionPage, errors,
}) => {
  expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/background.js`);
  const popup = await openExtensionPage('popup.html');
  await expect(popup.getByRole('heading', { name: 'Vast Translator' })).toBeVisible();

  const options = await openExtensionPage('options.html');
  await configure(options, server.baseUrl);
  await expect(options.getByLabel('Base URL')).toHaveValue(server.baseUrl);
  await expect(options.getByLabel('API Key')).toHaveValue(API_KEY);
  await expect(options.getByLabel('模型')).toHaveValue('e2e-model');
  await options.getByRole('button', { name: '测试连接' }).click();
  await expect.poll(() => server.requests.length, { message: `测试连接应到达本地模拟 API；命中记录: ${server.hits.join(', ')}` }).toBe(1);
  await expect(options.getByRole('status')).toHaveText('连接成功');
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
  expect(JSON.stringify(server.requests[0].body)).not.toContain(API_KEY);

  await options.getByRole('button', { name: '保存设置' }).click();
  await expect(options.getByRole('status')).toHaveText('设置已保存');
  await options.close();
  const reopened = await openExtensionPage('options.html');
  await expect(reopened.getByLabel('Base URL')).toHaveValue(server.baseUrl);
  await expect(reopened.getByLabel('模型')).toHaveValue('e2e-model');
  await expect(reopened.getByLabel('API Key')).toHaveValue('');
  expect(await reopened.evaluate(() => JSON.stringify(localStorage))).not.toContain(API_KEY);
  expect(await reopened.evaluate(() => JSON.stringify({
    html: document.documentElement.outerHTML,
    keyValue: (document.querySelector('[aria-label="API Key"]') as HTMLInputElement).value,
  }))).not.toContain(API_KEY);
  const downloadPromise = reopened.waitForEvent('download');
  await reopened.getByRole('button', { name: '导出配置' }).click();
  const download = await downloadPromise;
  const exportPath = await download.path();
  if (!exportPath) throw new Error('导出配置下载失败');
  const exported = await import('node:fs/promises').then(({ readFile }) => readFile(exportPath, 'utf8'));
  expect(exported).not.toContain(API_KEY);
  expect(exported).not.toContain('apiKey');
  expect(errors.messages.join('\n')).not.toContain(API_KEY);
  expect(errors.console).toHaveLength(0);
  expect(errors.page).toHaveLength(0);
  expect(errors.worker).toHaveLength(0);
  await reopened.screenshot({ path: evidence('options'), fullPage: true });
});

test('普通文章由 Popup 翻译，支持进度、模式切换、动态更新、恢复与按需规则 chunk', async ({
  context, server, openExtensionPage,
}) => {
  const options = await openExtensionPage('options.html');
  await saveConfiguration(options, server.baseUrl);
  await options.close();
  const page = await openFixture(context, server.fixtureUrl);
  const extensionRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('chrome-extension://')) extensionRequests.push(request.url());
  });
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  expect(extensionRequests.some((url) => /rules\/(github|google-search|bing-search|youtube|reddit|x|stackoverflow|substack)\.json/.test(url))).toBe(false);

  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译当前页面');
  await expect(page.locator('[data-vast-translator][data-vast-state="translated"]')).toHaveCount(4);
  await expect(page.locator('#first + [data-vast-translator]')).toHaveText('译：First paragraph for translation.');
  await expect(page.locator('#outside + [data-vast-translator]')).toHaveCount(0);
  await expect(popup.getByRole('status')).toHaveText('已完成 4/4');
  await popup.screenshot({ path: evidence('popup'), fullPage: true });
  await page.screenshot({ path: evidence('translated-fixture'), fullPage: true });

  await popup.getByLabel('显示模式').selectOption('translation-only');
  await clickPopupButton(popup, page, '翻译当前页面');
  await expect(page.locator('#first')).toBeHidden();
  await popup.getByLabel('显示模式').selectOption('bilingual');
  await clickPopupButton(popup, page, '翻译当前页面');
  await expect(page.locator('#first')).toBeVisible();

  await page.locator('#dynamic-root').evaluate((root) => { root.innerHTML = '<p id="added">Dynamically added paragraph.</p>'; });
  await expect(page.locator('#added + [data-vast-translator]')).toHaveText('译：Dynamically added paragraph.');
  await page.locator('#first').evaluate((element) => { element.textContent = 'Changed source paragraph.'; });
  await expect(page.locator('#first + [data-vast-translator]')).toHaveText('译：Changed source paragraph.');

  await clickPopupButton(popup, page, '恢复原文');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(page.locator('#first')).toBeVisible();
  expect(extensionRequests.some((url) => /rules\/.+\.json/.test(url))).toBe(false);
});

test('真实鼠标划词使用 closed shadow，输入框选区不触发，结果通过宿主状态可观察', async ({
  context, server, openExtensionPage,
}) => {
  const options = await openExtensionPage('options.html');
  await saveConfiguration(options, server.baseUrl);
  await options.close();
  const page = await openFixture(context, server.fixtureUrl);
  const paragraph = page.locator('#selection');
  const box = await paragraph.boundingBox();
  if (!box) throw new Error('划词段落不可见');
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();

  const host = page.locator('[data-vast-selection-host]');
  await expect(host).toBeVisible();
  expect(await host.evaluate((element) => element.shadowRoot)).toBeNull();
  const hostBox = await host.boundingBox();
  if (!hostBox) throw new Error('划词按钮不可见');
  await page.mouse.click(hostBox.x + Math.min(16, hostBox.width / 2), hostBox.y + Math.min(16, hostBox.height / 2));
  await expect(host).toHaveAttribute('data-vast-state', 'translated');
  await expect.poll(() => server.requests.filter((request) => request.body.stream === true).length).toBe(1);
  expect(JSON.stringify(server.requests.at(-1)?.body)).toContain('Select this sentence');

  await page.keyboard.press('Escape');
  await page.locator('#editor').click({ clickCount: 3 });
  await expect(page.locator('[data-vast-selection-host]')).toHaveCount(0);
});

test('恶意页面篡改划词宿主视觉后真实点击被拒绝', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html'); await saveConfiguration(options, server.baseUrl); await options.close();
  const page = await openFixture(context, server.fixtureUrl);
  const paragraph = page.locator('#selection'); const box = await paragraph.boundingBox(); if (!box) throw new Error('段落不可见');
  await page.mouse.move(box.x + 8, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
  const host = page.locator('[data-vast-selection-host]'); await expect(host).toBeVisible();
  await host.evaluate((element) => { (element as HTMLElement).style.setProperty('transform', 'translate(300px, 0)', 'important'); });
  const moved = await host.boundingBox(); if (!moved) throw new Error('宿主不可见');
  await page.mouse.click(moved.x + 16, moved.y + 16);
  await expect(host).toHaveCount(0);
  expect(server.requests.filter((request) => request.body.stream === true)).toHaveLength(0);
});

test('网页按 8+2 批处理，动态范围正确且离屏滚动后才请求', async ({ context, server, openExtensionPage, serviceWorker }) => {
  const options = await openExtensionPage('options.html'); await saveConfiguration(options, server.baseUrl); await options.close();
  const page = await openFixture(context, server.batchFixtureUrl);
  const initialOffscreen = await page.locator('#offscreen').boundingBox();
  expect(initialOffscreen?.y ?? 0).toBeGreaterThan(1000);
  await page.bringToFront(); await page.keyboard.press('Alt+Shift+A');
  const shortcutTriggered = await page.locator('[data-vast-state="translated"]').first().waitFor({ state: 'attached', timeout: 1500 }).then(() => true).catch(() => false);
  if (!shortcutTriggered) {
    const commands = await serviceWorker.evaluate(async () => chrome.commands.getAll());
    expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'translate_page', description: expect.any(String) })]));
    const popup = await openPopupForFixture(openExtensionPage, page);
    await clickPopupButton(popup, page, '翻译当前页面');
  }
  await expect(page.locator('[data-vast-state="translated"]')).toHaveCount(10);
  const nonStream = () => server.requests.filter((request) => request.body.stream !== true);
  await expect.poll(() => nonStream().length).toBe(2);
  expect(nonStream().map((request) => JSON.parse(((request.body.messages as Array<{ role: string; content: string }>).find((message) => message.role === 'user')?.content ?? '{}')).segments.length).sort((a, b) => a - b)).toEqual([2, 8]);
  expect(server.maxConcurrency()).toBeLessThanOrEqual(3);
  await expect(page.locator('#offscreen + [data-vast-translator]')).toHaveAttribute('data-vast-state', 'loading');
  expect(nonStream()).toHaveLength(2);
  await page.locator('#header').evaluate((header) => { header.innerHTML = '<p id="late-header">Late header</p>'; });
  await expect(page.locator('#late-header + [data-vast-translator]')).toHaveCount(0);
  await page.locator('#offscreen').scrollIntoViewIfNeeded();
  await expect(page.locator('#offscreen + [data-vast-translator]')).toHaveText('译：Offscreen paragraph');
  await expect.poll(() => nonStream().length).toBe(3);
  const session = await serviceWorker.evaluate(async () => chrome.storage.session.get('pageProgress')) as { pageProgress?: Record<string, { status: string }> };
  expect(Object.values(session.pageProgress ?? {}).some((progress) => progress.status === 'complete')).toBe(true);
});

test('德语划词遇畸形 SSE 自动回退非流式', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html'); await saveConfiguration(options, server.baseUrl); await options.getByLabel('目标语言').selectOption('de'); await options.getByRole('button', { name: '保存设置' }).click(); await options.close();
  server.setMode('invalid-sse');
  const page = await openFixture(context, server.fixtureUrl); const paragraph = page.locator('#selection'); const box = await paragraph.boundingBox(); if (!box) throw new Error('段落不可见');
  await page.mouse.move(box.x + 8, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
  const host = page.locator('[data-vast-selection-host]'); const hostBox = await host.boundingBox(); if (!hostBox) throw new Error('按钮不可见'); await page.mouse.click(hostBox.x + 16, hostBox.y + 16);
  await expect(host).toHaveAttribute('data-vast-state', 'translated');
  expect(server.requests.some((request) => request.body.stream === true && JSON.stringify(request.body).includes('de'))).toBe(true);
  expect(server.requests.some((request) => request.body.stream !== true && JSON.stringify(request.body).includes('de'))).toBe(true);
});

for (const mode of ['401', 'invalid-json'] as const) {
  test(`${mode} 错误显示失败，可重试且不残留 loading`, async ({ context, server, openExtensionPage }) => {
    const options = await openExtensionPage('options.html');
    await saveConfiguration(options, server.baseUrl);
    await options.close();
    server.setMode(mode);
    const page = await openFixture(context, server.fixtureUrl);
    const popup = await openPopupForFixture(openExtensionPage, page);
    await clickPopupButton(popup, page, '翻译当前页面');
    await expect(page.locator('[data-vast-state="error"]')).toHaveCount(4);
    await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);
    await expect(popup.getByRole('status')).toContainText('翻译失败');

    server.setMode('success');
    await clickPopupButton(popup, page, '重试');
    await expect(page.locator('[data-vast-state="translated"]')).toHaveCount(4);
    await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);
  });
}
