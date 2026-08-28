import { resolve } from 'node:path';

import { expect, test } from './fixtures';

const API_KEY = 'e2e-secret-key-not-for-dom';
const evidence = (name: string) => resolve(import.meta.dirname, `../evidence/e2e-${name}.png`);
const themeEvidence = (name: string) => resolve(import.meta.dirname, `../evidence/theme-${name}.png`);

async function addCustomEngine(
  options: import('@playwright/test').Page,
  baseUrl: string,
  name = 'E2E 自定义 AI',
  apiKey = API_KEY,
  model = 'e2e-model',
): Promise<import('@playwright/test').Locator> {
  await options.getByRole('button', { name: '新增自定义 AI' }).click();
  const card = options.getByRole('group').last();
  await expect(card.getByLabel('Base URL')).toBeEnabled();
  await card.getByLabel('名称').fill(name);
  await card.getByLabel('Base URL').fill(baseUrl);
  await card.getByLabel('API Key', { exact: true }).fill(apiKey);
  await card.getByLabel('模型').fill(model);
  await card.getByRole('button', { name: '保存实例' }).click();
  await expect(options.getByRole('status')).toHaveText('实例已保存');
  return options.getByRole('group', { name });
}

async function saveConfiguration(options: import('@playwright/test').Page, baseUrl: string): Promise<void> {
  const card = await addCustomEngine(options, baseUrl);
  await card.getByRole('button', { name: '设为默认' }).click();
  await expect(options.getByRole('status')).toHaveText('默认引擎已更新');
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
  await expect(popup.getByLabel('翻译引擎')).not.toHaveValue('google');
  await fixture.bringToFront();
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

test('五套主题从 Options 即时保存并在重开 Popup 后持久应用', async ({ openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await expect(options.locator('html')).toHaveAttribute('data-theme', 'pearl-reader');
  await expect(options.getByText('v0.3.0').first()).toBeVisible();
  const nav = options.locator('.options-nav');
  const navBefore = await nav.boundingBox();
  if (!navBefore) throw new Error('设置导航不可见');
  await nav.getByRole('button', { name: '外观主题' }).click();
  await expect(options.locator('.options-content')).not.toHaveJSProperty('scrollTop', 0);
  const navAfter = await nav.boundingBox();
  expect(navAfter).toEqual(navBefore);
  await expect(nav).toBeVisible();
  expect(await options.evaluate(() => ({ body: document.body.scrollTop, root: document.documentElement.scrollTop }))).toEqual({ body: 0, root: 0 });
  await options.screenshot({ path: themeEvidence('pearl-reader-options'), fullPage: true });

  const themes = [
    ['pearl-reader', 'Pearl Reader'],
    ['command-translator', 'Command Translator'],
    ['sage-global', 'Sage Global'],
    ['editorial-lingua', 'Editorial Lingua'],
    ['precision-blue', 'Precision Blue'],
  ] as const;

  for (const [theme, name] of themes) {
    await options.getByRole('button', { name: new RegExp(name) }).click();
    await expect(options.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(options.getByRole('status')).toHaveText('主题已保存');

    const popup = await openExtensionPage('popup.html');
    await expect(popup.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(popup.getByRole('main')).toHaveAttribute('data-theme', theme);
    if (theme === 'command-translator') {
      const background = await popup.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(background).toBe('rgb(7, 8, 10)');
    }
    await popup.screenshot({ path: themeEvidence(theme), fullPage: true });
    await popup.close();
  }
});

test('MV3、Popup 与 Options 无错误加载，自定义实例可测试并在保存后持久化', async ({
  context, extensionId, serviceWorker, server, openExtensionPage, errors,
}) => {
  expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/background.js`);
  const fixture = await openFixture(context, server.networkFixtureUrl);
  await expect.poll(() => fixture.evaluate(async () => {
    try {
      const value = await chrome.storage.local.get('translatorSettings');
      return { accessible: true, value };
    } catch (error) {
      return { accessible: false, error: String(error) };
    }
  })).toMatchObject({ accessible: false });
  await fixture.close();
  const popup = await openExtensionPage('popup.html');
  await expect(popup.getByText('Vast Translator', { exact: true })).toBeVisible();
  await popup.getByLabel('翻译引擎').selectOption('bing');
  await popup.getByLabel('目标语言').selectOption('ja');
  await popup.getByRole('button', { name: '双语对照' }).click();
  await popup.close();
  const reopenedPopup = await openExtensionPage('popup.html');
  await expect(reopenedPopup.getByLabel('翻译引擎')).toHaveValue('bing');
  await expect(reopenedPopup.getByLabel('目标语言')).toHaveValue('ja');
  await expect(reopenedPopup.getByRole('button', { name: '仅译文' })).toBeVisible();
  await reopenedPopup.close();

  const options = await openExtensionPage('options.html');
  const card = await addCustomEngine(options, server.baseUrl);
  const secretProbe = await openFixture(context, server.networkFixtureUrl);
  await expect.poll(() => secretProbe.evaluate(async () => {
    try {
      const value = await chrome.storage.local.get('translatorSettings');
      return { accessible: true, serialized: JSON.stringify(value) };
    } catch (error) {
      return { accessible: false, serialized: String(error) };
    }
  })).toMatchObject({ accessible: false });
  expect(await secretProbe.content()).not.toContain(API_KEY);
  await secretProbe.close();
  await expect(card.getByLabel('Base URL')).toHaveValue(server.baseUrl);
  await expect(card.getByLabel('API Key', { exact: true })).toHaveValue(API_KEY);
  await expect(card.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await card.getByRole('button', { name: '显示 API Key' }).click();
  await expect(card.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'text');
  await card.getByRole('button', { name: '隐藏 API Key' }).click();
  await expect(card.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await expect(card.getByLabel('模型')).toHaveValue('e2e-model');
  await card.getByRole('button', { name: '测试连接' }).click();
  await expect.poll(() => server.requests.length, { message: `测试连接应到达本地模拟 API；命中记录: ${server.hits.join(', ')}` }).toBe(1);
  await expect(options.getByRole('status')).toHaveText('连接成功');
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
  expect(JSON.stringify(server.requests[0].body)).not.toContain(API_KEY);

  await options.close();
  const reopened = await openExtensionPage('options.html');
  const reopenedCard = reopened.getByRole('group', { name: 'E2E 自定义 AI' });
  await expect(reopenedCard.getByLabel('Base URL')).toHaveValue(server.baseUrl);
  await expect(reopenedCard.getByLabel('模型')).toHaveValue('e2e-model');
  await expect(reopenedCard.getByLabel('API Key', { exact: true })).toHaveValue(API_KEY);
  await expect(reopenedCard.getByText('已保存 API Key；留空会保留现有密钥。')).toBeVisible();
  expect(await reopened.evaluate(() => JSON.stringify(localStorage))).not.toContain(API_KEY);
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

test('新安装默认 Google 且有 Bing，多实例排序、默认、密钥、导出与删除彼此隔离', async ({ openExtensionPage, server }) => {
  const options = await openExtensionPage('options.html');
  await expect(options.getByText('Google').first()).toBeVisible();
  await expect(options.getByText('Bing').first()).toBeVisible();
  await expect(options.getByText('当前默认').first()).toBeVisible();

  await addCustomEngine(options, server.baseUrl, '实例甲', 'secret-alpha');
  await addCustomEngine(options, server.baseUrl, '实例乙', 'secret-beta');
  const beta = options.getByRole('group', { name: '实例乙' });
  await beta.getByRole('button', { name: '上移' }).click();
  await expect(options.getByRole('status')).toHaveText('引擎顺序已保存');
  await beta.getByRole('button', { name: '设为默认' }).click();
  await expect(options.getByRole('status')).toHaveText('默认引擎已更新');
  await options.reload();
  const groups = options.getByRole('group');
  await expect(groups.nth(0)).toHaveAccessibleName('实例乙');
  await expect(groups.nth(1)).toHaveAccessibleName('实例甲');
  await expect(options.getByRole('group', { name: '实例乙' }).getByText('当前默认')).toBeVisible();
  await expect(options.getByRole('group', { name: '实例甲' }).getByText('已保存 API Key；留空会保留现有密钥。')).toBeVisible();
  await expect(options.getByRole('group', { name: '实例乙' }).getByText('已保存 API Key；留空会保留现有密钥。')).toBeVisible();

  const alphaKey = options.getByRole('group', { name: '实例甲' });
  await alphaKey.getByRole('button', { name: '清除 API Key' }).click();
  await alphaKey.getByRole('button', { name: '确认清除 API Key' }).click();
  await expect(options.getByRole('status')).toHaveText('API Key 已清除');
  await expect(options.getByRole('group', { name: '实例甲' }).getByText('已保存 API Key；留空会保留现有密钥。')).toHaveCount(0);
  await expect(options.getByRole('group', { name: '实例乙' }).getByText('已保存 API Key；留空会保留现有密钥。')).toBeVisible();

  const downloadPromise = options.waitForEvent('download');
  await options.getByRole('button', { name: '导出配置' }).click();
  const exportPath = await (await downloadPromise).path();
  if (!exportPath) throw new Error('导出配置下载失败');
  const exported = await import('node:fs/promises').then(({ readFile }) => readFile(exportPath, 'utf8'));
  expect(exported).not.toContain('secret-alpha');
  expect(exported).not.toContain('secret-beta');
  expect(exported).not.toContain('apiKey');

  const alphaAfterReload = options.getByRole('group', { name: '实例甲' });
  await alphaAfterReload.getByRole('button', { name: '删除实例' }).click();
  await alphaAfterReload.getByRole('button', { name: '确认删除实例' }).click();
  await expect(options.getByRole('group', { name: '实例甲' })).toHaveCount(0);
  await expect(options.getByRole('group', { name: '实例乙' })).toBeVisible();
  expect(await options.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await options.screenshot({ path: evidence('options'), fullPage: true });

  const popup = await openExtensionPage('popup.html');
  await expect(popup.getByLabel('翻译引擎').getByRole('option')).toHaveCount(3);
  await expect(popup.getByLabel('翻译引擎').getByRole('option').allTextContents()).resolves.toEqual(expect.arrayContaining([
    expect.stringContaining('Google'), expect.stringContaining('Bing'), expect.stringContaining('实例乙'),
  ]));
  await popup.getByLabel('翻译引擎').selectOption('google');
  await popup.getByLabel('翻译引擎').selectOption('bing');
  const customValue = await popup.getByLabel('翻译引擎').getByRole('option', { name: /实例乙/ }).getAttribute('value');
  if (!customValue) throw new Error('Popup 自定义引擎选项缺少 value');
  await popup.getByLabel('翻译引擎').selectOption(customValue);
  await expect(popup.getByLabel('翻译引擎')).toHaveValue(customValue);
  await popup.screenshot({ path: evidence('popup'), fullPage: true });
});

test('两个 custom 实例的本地路径、Authorization 和 model 在 test-engine 中完全隔离', async ({ openExtensionPage, server }) => {
  const options = await openExtensionPage('options.html');
  const alpha = await addCustomEngine(options, `${server.origin}/alpha/v1`, '隔离实例甲', 'key-alpha', 'model-alpha');
  const beta = await addCustomEngine(options, `${server.origin}/beta/v1`, '隔离实例乙', 'key-beta', 'model-beta');

  await alpha.getByRole('button', { name: '测试连接' }).click();
  await expect(options.getByRole('status')).toHaveText('连接成功');
  await beta.getByRole('button', { name: '测试连接' }).click();
  await expect(options.getByRole('status')).toHaveText('连接成功');

  expect(server.requests.map(({ path, headers, body }) => ({ path, authorization: headers.authorization, model: body.model }))).toEqual([
    { path: '/alpha/v1/chat/completions', authorization: 'Bearer key-alpha', model: 'model-alpha' },
    { path: '/beta/v1/chat/completions', authorization: 'Bearer key-beta', model: 'model-beta' },
  ]);
});

test('Popup 通过真实 Google/Bing clients 完成生产主链路并发送各自协议', async ({ context, server, openExtensionPage }) => {
  const requests: Array<{ provider: string; url: string; body: string | null; contentType?: string }> = [];
  await context.route('https://translate.googleapis.com/translate_a/t?**', async (route, request) => {
    requests.push({ provider: 'google', url: request.url(), body: request.postData(), contentType: request.headers()['content-type'] });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([['你好']]) });
  });
  await context.route('https://edge.microsoft.com/translate/translatetext?**', async (route, request) => {
    requests.push({ provider: 'bing', url: request.url(), body: request.postData(), contentType: request.headers()['content-type'] });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ translations: [{ text: '您好' }] }]) });
  });
  const page = await openFixture(context, server.networkFixtureUrl);
  const popup = await openExtensionPage('popup.html');
  await page.bringToFront();
  await popup.getByLabel('目标语言').selectOption('zh-Hans');

  await popup.getByLabel('翻译引擎').selectOption('google');
  await clickPopupButton(popup, page, '翻译 (Alt + A)');
  await expect(page.locator('#hello + [data-vast-translator]')).toHaveText('你好');
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(page.locator('#hello')).toBeVisible();
  await expect(popup.getByRole('status')).toHaveText('就绪');

  await popup.getByLabel('翻译引擎').selectOption('bing');
  await clickPopupButton(popup, page, '翻译 (Alt + A)');
  await expect(page.locator('#hello + [data-vast-translator]')).toHaveText('您好');
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(page.locator('#hello')).toBeVisible();
  await expect(popup.getByRole('status')).toHaveText('就绪');

  const google = requests.find((request) => request.provider === 'google')!;
  expect(new URL(google.url).searchParams.get('sl')).toBe('auto');
  expect(new URLSearchParams(google.body ?? '').getAll('q')).toEqual(['hello']);
  expect(google.contentType).toContain('application/x-www-form-urlencoded');
  const bing = requests.find((request) => request.provider === 'bing')!;
  expect(JSON.parse(bing.body ?? '[]')).toEqual(['hello']);
  expect(bing.contentType).toContain('application/json');
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
  await clickPopupButton(popup, page, '翻译 (Alt + A)');
  await expect(page.locator('[data-vast-translator][data-vast-state="translated"]')).toHaveCount(5);
  await expect(page.locator('#first + [data-vast-translator]')).toHaveText('用于翻译的第一段。');
  await expect(page.locator('#outside + [data-vast-translator]')).toHaveCount(1);
  await expect(popup.getByRole('button', { name: '显示原文 (Alt + A)' })).toBeVisible();
  await popup.screenshot({ path: evidence('popup'), fullPage: true });
  await page.screenshot({ path: evidence('translated-fixture'), fullPage: true });

  await popup.getByRole('button', { name: '双语对照' }).click();
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await clickPopupButton(popup, page, '翻译 (Alt + A)');
  await expect(page.locator('#first')).toBeHidden();
  await popup.getByRole('button', { name: '仅译文' }).click();
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await clickPopupButton(popup, page, '翻译 (Alt + A)');
  await expect(page.locator('#first')).toBeVisible();

  await page.locator('#dynamic-root').evaluate((root) => { root.innerHTML = '<p id="added">Dynamically added paragraph.</p>'; });
  await expect(page.locator('#added + [data-vast-translator]')).toHaveText('动态添加的段落。');
  await page.locator('#first').evaluate((element) => { element.textContent = 'Changed source paragraph.'; });
  await expect(page.locator('#first + [data-vast-translator]')).toHaveText('修改后的原文段落。');

  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
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
  await expect(host).toHaveAttribute('data-vast-ready', '');
  await expect(host).toHaveAttribute('data-vast-ready', '');
  expect(await host.evaluate((element) => element.shadowRoot)).toBeNull();
  const hostBox = await host.boundingBox();
  if (!hostBox) throw new Error('划词按钮不可见');
  await page.mouse.click(hostBox.x + Math.min(16, hostBox.width / 2), hostBox.y + Math.min(16, hostBox.height / 2));
  await expect(host).toHaveAttribute('data-vast-state', 'translated');
  const resizeResult = await host.evaluate((element) => {
    const host = element as HTMLElement;
    const before = host.getBoundingClientRect();
    host.style.setProperty('--vast-panel-width', '420px');
    host.style.setProperty('--vast-panel-height', '260px');
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const after = host.getBoundingClientRect();
      resolve({ grew: after.width > before.width && after.height > before.height, clamped: after.left >= 8 && after.top >= 8 && after.right <= innerWidth - 8 && after.bottom <= innerHeight - 8 });
    })));
  });
  expect(resizeResult).toEqual({ grew: true, clamped: true });
  const resizedBounds = await host.boundingBox();
  if (!resizedBounds) throw new Error('缩放后的划词面板不可见');
  await page.mouse.click(resizedBounds.x + resizedBounds.width - 27, resizedBounds.y + resizedBounds.height - 27);
  await expect(host).toHaveAttribute('data-vast-toast', 'copied');
  await expect(host).not.toHaveAttribute('data-vast-toast', { timeout: 2_500 });
  await expect.poll(() => server.requests.filter((request) => request.body.stream === true).length).toBe(1);
  expect(JSON.stringify(server.requests.at(-1)?.body)).toContain('Select this sentence');

  await page.keyboard.press('Escape');
  await page.locator('#editor').click({ clickCount: 3 });
  await expect(page.locator('[data-vast-selection-host]')).toHaveCount(0);
});

test('长页面底部划词面板始终在视口内，可拖动关闭，Ctrl 内联切换且 popup 可关闭', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await saveConfiguration(options, server.baseUrl);
  await options.getByLabel('目标语言').selectOption('zh-Hans');
  await options.getByRole('button', { name: '保存阅读偏好' }).click();
  await options.close();
  const page = await openFixture(context, server.selectionFixtureUrl);
  const paragraph = page.locator('#bottom-selection');
  await paragraph.scrollIntoViewIfNeeded();
  const box = await paragraph.boundingBox(); if (!box) throw new Error('底部选区不可见');
  await page.mouse.move(box.x + 4, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
  const host = page.locator('[data-vast-selection-host]');
  await expect(host).toBeVisible();
  await expect(host).toHaveAttribute('data-vast-ready', '');
  await expect.poll(() => host.evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.left >= 8 && rect.top >= 8 && rect.right <= innerWidth - 8 && rect.bottom <= innerHeight - 8; })).toBe(true);
  const triggerBox = await host.boundingBox(); if (!triggerBox) throw new Error('V 按钮不可见');
  await page.mouse.click(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
  await expect(host).toHaveAttribute('data-vast-state', 'translated');
  const openedBounds = await host.boundingBox();
  const selectionBounds = await paragraph.boundingBox();
  if (!openedBounds || !selectionBounds) throw new Error('无法测量底部划词面板或选区');
  expect(openedBounds.y).toBeLessThan(selectionBounds.y);
  expect(openedBounds.y + openedBounds.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight - 8));
  await expect.poll(() => host.evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.left >= 8 && rect.top >= 8 && rect.right <= innerWidth - 8 && rect.bottom <= innerHeight - 8; })).toBe(true);
  const beforeScroll = await host.boundingBox();
  await page.mouse.wheel(0, -500);
  const afterScroll = await host.boundingBox();
  expect(afterScroll?.x).toBeCloseTo(beforeScroll?.x ?? 0, 0); expect(afterScroll?.y).toBeCloseTo(beforeScroll?.y ?? 0, 0);
  const hostBounds = await host.boundingBox(); if (!hostBounds) throw new Error('面板不可见');
  await page.mouse.move(hostBounds.x + 22, hostBounds.y + 27); await page.mouse.down();
  await page.mouse.move(Math.min(hostBounds.x + 80, 300), Math.min(hostBounds.y + 80, 200), { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => host.evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.left >= 8 && rect.top >= 8 && rect.right <= innerWidth - 8 && rect.bottom <= innerHeight - 8; })).toBe(true);
  const draggedBounds = await host.boundingBox(); if (!draggedBounds) throw new Error('拖动后面板不可见');
  expect(Math.abs(draggedBounds.x - hostBounds.x) + Math.abs(draggedBounds.y - hostBounds.y)).toBeGreaterThan(10);
  await page.screenshot({ path: evidence('selection-panel'), fullPage: false });
  await page.keyboard.press('Escape');
  await expect(host).toHaveCount(0);

  await paragraph.scrollIntoViewIfNeeded();
  const selectedBox = await paragraph.boundingBox(); if (!selectedBox) throw new Error('内联选区不可见');
  await page.mouse.move(selectedBox.x + 4, selectedBox.y + selectedBox.height / 2); await page.mouse.down(); await page.mouse.move(selectedBox.x + selectedBox.width - 4, selectedBox.y + selectedBox.height / 2, { steps: 10 }); await page.mouse.up();
  await page.keyboard.press('Control');
  await expect(page.locator('#bottom-selection + [data-vast-inline-selection-translation]')).toContainText('请使用真实鼠标手势选择这句话');
  await page.screenshot({ path: evidence('selection-inline'), fullPage: false });
  await page.keyboard.press('Control');
  await expect(page.locator('[data-vast-inline-selection-translation]')).toHaveCount(0);

  const reopenedOptions = await openExtensionPage('options.html');
  await reopenedOptions.getByRole('checkbox', { name: '显示划词悬浮按钮' }).uncheck();
  await reopenedOptions.getByRole('button', { name: '保存阅读偏好' }).click();
  await reopenedOptions.close();
  await page.bringToFront();
  const disabledBox = await paragraph.boundingBox(); if (!disabledBox) throw new Error('关闭悬浮按钮后的选区不可见');
  await page.mouse.move(disabledBox.x + 4, disabledBox.y + disabledBox.height / 2); await page.mouse.down(); await page.mouse.move(disabledBox.x + disabledBox.width - 4, disabledBox.y + disabledBox.height / 2, { steps: 10 }); await page.mouse.up();
  await expect(page.locator('[data-vast-selection-host]')).toHaveCount(0);
});

test('整个页面翻译 findryai 面包屑四个文本叶', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html'); await saveConfiguration(options, server.baseUrl); await options.close();
  const page = await openFixture(context, server.selectionFixtureUrl);
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');
  for (const text of ['Home', 'Category', 'Image Generation', 'trainengine ai']) {
    await expect(page.getByText(text, { exact: true }).locator('+ [data-vast-translator]')).toHaveCount(1);
  }
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
  await page.bringToFront(); await page.keyboard.press('Alt+A');
  const shortcutTriggered = await page.locator('[data-vast-state="translated"]').first().waitFor({ state: 'attached', timeout: 1500 }).then(() => true).catch(() => false);
  if (!shortcutTriggered) {
    const commands = await serviceWorker.evaluate(async () => chrome.commands.getAll());
    expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'translate_page', description: expect.any(String) })]));
    const popup = await openPopupForFixture(openExtensionPage, page);
    await clickPopupButton(popup, page, '翻译 (Alt + A)');
  }
  await expect(page.locator('[data-vast-state="translated"]')).toHaveCount(10);
  const nonStream = () => server.requests.filter((request) => request.body.stream !== true);
  await expect.poll(() => nonStream().length).toBe(2);
  expect(nonStream().map((request) => JSON.parse(((request.body.messages as Array<{ role: string; content: string }>).find((message) => message.role === 'user')?.content ?? '{}')).segments.length).sort((a, b) => a - b)).toEqual([2, 8]);
  expect(server.maxConcurrency()).toBeLessThanOrEqual(3);
  await expect(page.locator('#offscreen + [data-vast-translator]')).toHaveAttribute('data-vast-state', 'loading');
  expect(nonStream()).toHaveLength(2);
  await expect.poll(async () => {
    const session = await serviceWorker.evaluate(async () => chrome.storage.session.get('pageProgress')) as { pageProgress?: Record<string, { status: string; completed: number; total: number }> };
    return Object.values(session.pageProgress ?? {});
  }).toContainEqual(expect.objectContaining({ status: 'translating', completed: 10, total: 11 }));
  await page.locator('#header').evaluate((header) => { header.innerHTML = '<p id="late-header">Late header</p>'; });
  await expect(page.locator('#late-header + [data-vast-translator]')).toHaveCount(0);
  await page.locator('#offscreen').scrollIntoViewIfNeeded();
  await expect(page.locator('#offscreen + [data-vast-translator]')).toHaveText('屏幕外段落');
  await expect.poll(() => nonStream().length).toBe(3);
  await expect.poll(async () => {
    const session = await serviceWorker.evaluate(async () => chrome.storage.session.get('pageProgress')) as { pageProgress?: Record<string, { completed: number; failed: number; total: number }> };
    return Object.values(session.pageProgress ?? {}).some((progress) => progress.completed === 11 && progress.failed === 0 && progress.total >= 11);
  }).toBe(true);
  await expect(page.locator('#late-header + [data-vast-translator]')).toHaveCount(0);
});

test('德语划词遇畸形 SSE 自动回退非流式', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await saveConfiguration(options, server.baseUrl);
  await options.getByLabel('目标语言').selectOption('de');
  await options.getByRole('button', { name: '保存阅读偏好' }).click();
  await expect(options.getByRole('status')).toHaveText('设置已保存');
  await options.close();
  server.setMode('invalid-sse');
  const page = await openFixture(context, server.fixtureUrl); const paragraph = page.locator('#selection'); const box = await paragraph.boundingBox(); if (!box) throw new Error('段落不可见');
  await page.mouse.move(box.x + 8, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
  const host = page.locator('[data-vast-selection-host]'); await expect(host).toHaveAttribute('data-vast-ready', ''); const hostBox = await host.boundingBox(); if (!hostBox) throw new Error('按钮不可见'); await page.mouse.click(hostBox.x + 16, hostBox.y + 16);
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
    await clickPopupButton(popup, page, '翻译 (Alt + A)');
    await expect(page.locator('[data-vast-state="error"]')).toHaveCount(5);
    await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);
    await expect(page.locator('[data-vast-retry-all]').first()).toBeVisible();

    server.setMode('success');
    await page.locator('[data-vast-retry-all]').first().click();
    await expect(page.locator('[data-vast-state="translated"]')).toHaveCount(5);
    await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);
  });
}
