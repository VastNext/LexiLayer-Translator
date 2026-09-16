import { test, expect } from './fixtures';

test('输入框快捷键无需整页翻译，独立语言、部分替换和跨源 frame', async ({ context, serviceWorker, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await expect(options.getByLabel('输入框目标语言')).toBeEnabled();
  await expect(options.getByLabel('输入框目标语言')).toHaveValue('en');
  await options.getByLabel('输入框目标语言').selectOption('ja');
  await expect(options.getByRole('status')).toHaveText('设置已保存');
  await expect.poll(() => serviceWorker.evaluate(async () => {
    const settings = (await chrome.storage.local.get('translatorSettings')).translatorSettings as import('../../src/shared/config').Settings | undefined;
    return settings?.readingPreferences?.inputTargetLanguage;
  })).toBe('ja');
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
  const status = page.locator('[data-lexilayer-input-translation-status]');
  await expect(status).toHaveAttribute('aria-label', '翻译完成');
  await expect(status).toHaveAttribute('data-state', 'success');
  expect(await status.evaluate((element) => element.shadowRoot)).toBeNull();
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

test('窄 frame 内输入翻译状态始终位于可见视口', async ({ context, serviceWorker, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await expect(options.getByLabel('输入框目标语言')).toBeEnabled();
  await options.getByLabel('输入框目标语言').selectOption('ja');
  await expect.poll(() => serviceWorker.evaluate(async () => {
    const settings = (await chrome.storage.local.get('translatorSettings')).translatorSettings as import('../../src/shared/config').Settings | undefined;
    return settings?.readingPreferences?.inputTargetLanguage;
  })).toBe('ja');
  await serviceWorker.evaluate(async (baseUrl) => {
    const settings = (await chrome.storage.local.get('translatorSettings')).translatorSettings as import('../../src/shared/config').Settings;
    settings.engines.push({ id: 'custom-input-frame', kind: 'custom-ai', name: '窄框测试', baseUrl, model: 'test', apiKey: 'input-test-key', enabled: true, order: 2 });
    settings.activeEngineId = 'custom-input-frame';
    await chrome.storage.local.set({ translatorSettings: settings });
  }, server.baseUrl);
  const page = await context.newPage(); await page.goto(server.fixtureUrl);
  await page.evaluate((url) => {
    const frame = document.createElement('iframe'); frame.src = url; frame.style.width = '150px'; frame.style.height = '80px'; document.body.append(frame);
  }, server.fixtureUrl.replace('127.0.0.1', 'localhost'));
  await expect.poll(() => page.frames().some((candidate) => candidate.url().includes('localhost'))).toBe(true);
  const frame = page.frames().find((candidate) => candidate.url().includes('localhost'))!;
  const input = frame.locator('#editor'); await input.fill('前hello后');
  await input.evaluate((element: HTMLInputElement) => { element.style.position = 'fixed'; element.style.right = '0'; element.style.bottom = '0'; element.style.width = '60px'; element.setSelectionRange(1, 6); });
  server.setMode('delay'); await input.press('Alt+Shift+X');
  await expect.poll(() => server.requests.length).toBe(1);
  const placement = await frame.locator('[data-lexilayer-input-translation-status]').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight };
  });
  expect(placement.x).toBeGreaterThanOrEqual(0); expect(placement.y).toBeGreaterThanOrEqual(0);
  expect(placement.right).toBeLessThanOrEqual(placement.width); expect(placement.bottom).toBeLessThanOrEqual(placement.height);
  server.releaseDelay();
});

test('输入框在途修改和重复按键不覆盖，普通富文本只替换选区', async ({ context, serviceWorker, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await expect(options.getByLabel('输入框目标语言')).toBeEnabled();
  await options.getByLabel('输入框目标语言').selectOption('ja');
  await expect(options.getByRole('status')).toHaveText('设置已保存');
  await expect.poll(() => serviceWorker.evaluate(async () => {
    const settings = (await chrome.storage.local.get('translatorSettings')).translatorSettings as import('../../src/shared/config').Settings | undefined;
    return settings?.readingPreferences?.inputTargetLanguage;
  })).toBe('ja');
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
  const status = page.locator('[data-lexilayer-input-translation-status]');
  await expect(status).toHaveAttribute('aria-label', '翻译中…');
  await input.press('Alt+Shift+X');
  await expect(status).toHaveCount(1);
  expect(server.requests).toHaveLength(1);
  await input.fill('用户新输入'); server.releaseDelay(); server.setMode('success');
  await expect(status).toHaveAttribute('aria-label', '翻译已取消');
  await expect(input).toHaveValue('用户新输入');
  await page.evaluate(() => { const editor = document.createElement('div'); editor.id = 'rich'; editor.contentEditable = 'true'; editor.innerHTML = '前<b>hello</b>后'; document.body.append(editor); });
  const rich = page.locator('#rich'); await rich.focus();
  await rich.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element.querySelector('b')!); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  await rich.press('Alt+Shift+X');
  await expect(rich).toHaveText('前中文译文：hello后');
  await expect(input).toHaveValue('用户新输入');
});

test('输入框翻译失败保留原文并显示失败状态', async ({ context, serviceWorker, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await expect(options.getByLabel('输入框目标语言')).toBeEnabled();
  await options.getByLabel('输入框目标语言').selectOption('ja');
  await expect(options.getByRole('status')).toHaveText('设置已保存');
  await expect.poll(() => serviceWorker.evaluate(async () => {
    const settings = (await chrome.storage.local.get('translatorSettings')).translatorSettings as import('../../src/shared/config').Settings | undefined;
    return settings?.readingPreferences?.inputTargetLanguage;
  })).toBe('ja');
  await serviceWorker.evaluate(async (baseUrl) => {
    const settings = (await chrome.storage.local.get('translatorSettings')).translatorSettings as import('../../src/shared/config').Settings;
    settings.engines.push({ id: 'custom-input-error', kind: 'custom-ai', name: '输入失败测试', baseUrl, model: 'test', apiKey: 'input-test-key', enabled: true, order: 2 });
    settings.activeEngineId = 'custom-input-error';
    await chrome.storage.local.set({ translatorSettings: settings });
  }, server.baseUrl);
  expect((await context.request.get(server.fixtureUrl)).ok()).toBeTruthy();
  server.setMode('401');
  const page = await context.newPage(); await page.goto(server.fixtureUrl);
  const input = page.locator('#editor'); await input.fill('前hello后');
  await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 6));
  await input.press('Alt+Shift+X');
  await expect(page.locator('[data-lexilayer-input-translation-status]')).toHaveAttribute('aria-label', '翻译失败，原文已保留');
  await expect(input).toHaveValue('前hello后');
});
