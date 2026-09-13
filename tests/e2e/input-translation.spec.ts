import { test, expect } from './fixtures';

test('输入框快捷键无需整页翻译，独立语言、部分替换和跨源 frame', async ({ context, serviceWorker, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await expect(options.getByLabel('输入框目标语言')).toBeEnabled();
  await expect(options.getByLabel('输入框目标语言')).toHaveValue('en');
  await options.getByLabel('输入框目标语言').selectOption('ja');
  await expect(options.getByRole('status')).toHaveText('设置已保存');
  await options.getByLabel('输入框目标语言').scrollIntoViewIfNeeded();
  await options.screenshot({ path: 'test-results/input-translation-options.png' });
  await serviceWorker.evaluate(async (baseUrl) => {
    const stored = await chrome.storage.local.get('translatorSettings');
    const settings = stored.translatorSettings as import('../../src/shared/config').Settings;
    settings.engines.push({ id: 'custom-input', kind: 'custom-ai', name: '输入测试', baseUrl, model: 'test', apiKey: 'input-test-key', enabled: true, order: 2 });
    settings.activeEngineId = 'custom-input';
    await chrome.storage.local.set({ translatorSettings: settings });
  }, server.baseUrl);
  const response = await context.request.get(server.fixtureUrl);
  expect(response.ok()).toBeTruthy();
  const page = await context.newPage(); await page.goto(server.fixtureUrl);
  const input = page.locator('#editor');
  await input.fill('前hello后');
  await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 6));
  await input.press('Alt+Shift+X');
  await expect(input).toHaveValue('前中文译文：hello后');
  expect(server.requests).toHaveLength(1);
  const body = JSON.stringify(server.requests[0].body);
  expect(body).toContain('ja'); expect(body).not.toContain('前hello后');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);

  await page.evaluate((url) => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); }, server.fixtureUrl.replace('127.0.0.1', 'localhost'));
  const frameInput = page.frameLocator('iframe').locator('#editor');
  await frameInput.fill('前hello后');
  await frameInput.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 6));
  await frameInput.press('Alt+Shift+X');
  await expect(frameInput).toHaveValue('前中文译文：hello后');
});

test('输入框在途修改和重复按键不覆盖，普通富文本只替换选区', async ({ context, serviceWorker, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await expect(options.getByLabel('输入框目标语言')).toBeEnabled();
  await options.getByLabel('输入框目标语言').selectOption('ja');
  await expect(options.getByRole('status')).toHaveText('设置已保存');
  await serviceWorker.evaluate(async (baseUrl) => {
    const settings = (await chrome.storage.local.get('translatorSettings')).translatorSettings as import('../../src/shared/config').Settings;
    settings.engines = settings.engines.filter((engine: { kind: string }) => engine.kind !== 'custom-ai');
    settings.engines.push({ id: 'custom-input', kind: 'custom-ai', name: '输入测试', baseUrl, model: 'test', apiKey: 'input-test-key', enabled: true, order: 2 });
    settings.activeEngineId = 'custom-input';
    await chrome.storage.local.set({ translatorSettings: settings });
  }, server.baseUrl);
  expect((await context.request.get(server.fixtureUrl)).ok()).toBeTruthy();
  const page = await context.newPage(); await page.goto(server.fixtureUrl);
  const input = page.locator('#editor'); await input.fill('前hello后');
  await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 6));
  server.setMode('delay'); await input.press('Alt+Shift+X');
  await expect.poll(() => server.requests.length).toBe(1);
  await input.press('Alt+Shift+X');
  await input.fill('用户新输入'); server.releaseDelay(); server.setMode('success');
  await expect(input).toHaveValue('用户新输入');
  await page.evaluate(() => { const editor = document.createElement('div'); editor.id = 'rich'; editor.contentEditable = 'true'; editor.innerHTML = '前<b>hello</b>后'; document.body.append(editor); });
  const rich = page.locator('#rich'); await rich.focus();
  await rich.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element.querySelector('b')!); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  await rich.press('Alt+Shift+X');
  await expect(rich).toHaveText('前中文译文：hello后');
  await expect(input).toHaveValue('用户新输入');
});
