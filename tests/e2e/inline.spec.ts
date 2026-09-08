import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from './fixtures';
import type { MockServer } from './mock-server';

const API_KEY = 'e2e-secret-key-not-for-dom';
// 内联模式证据独立输出到 test-results，避免覆盖 tests/evidence 历史截图。
const evidenceDir = resolve(import.meta.dirname, '../../test-results/evidence');
mkdirSync(evidenceDir, { recursive: true });
const evidence = (name: string) => resolve(evidenceDir, `inline-${name}.png`);

async function configureInlineEngine(options: import('@playwright/test').Page, server: MockServer): Promise<void> {
  await options.getByRole('button', { name: '新增自定义 AI' }).click();
  const card = options.getByRole('group').last();
  await card.getByLabel('名称').fill('Inline E2E AI');
  await card.getByLabel('Base URL').fill(server.baseUrl);
  await card.getByLabel('API Key', { exact: true }).fill(API_KEY);
  await card.getByLabel('模型').fill('inline-model');
  await card.getByRole('button', { name: '保存实例' }).click();
  await expect(options.getByRole('status')).toHaveText('实例已保存');
  await options.getByRole('group', { name: 'Inline E2E AI' }).getByRole('button', { name: '设为默认' }).click();
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

test('内联请求期间角色改变后错误入口可见，真实点击重试成功且保留页面结构', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await configureInlineEngine(options, server);
  await options.close();
  server.setMode('delay');
  const page = await openFixture(context, server.inlineFixtureUrl);
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');
  await expect(page.locator('#plain > [data-vast-state="loading"]')).toBeVisible();
  // role 不在当前观察器属性过滤器内，确保由结果拒绝后的错误回退负责收口。
  await page.locator('#plain').evaluate((element) => element.setAttribute('role', 'button'));
  server.setMode('401');
  server.releaseDelay();
  const retry = page.locator('#plain + [data-vast-state="error"] [data-vast-retry-all]');
  await expect(retry).toBeVisible();
  await expect(page.locator('#plain [data-vast-state="loading"]')).toHaveCount(0);
  server.setMode('success');
  await retry.click();
  await expect(page.locator('#plain [data-vast-state="translated"]')).toHaveText('内联段落译文。');
  await expect(page.locator('#plain')).toHaveAttribute('role', 'button');
  await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);
  await expect(page.locator('[data-vast-state="error"]')).toHaveCount(0);
  await popup.close();
  await page.close();
});

test('新安装默认内联渲染器，Options 下拉说明切换在下次全新翻译生效', async ({ openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await expect(options.getByLabel('渲染器模式')).toHaveValue('inline');
  await expect(options.getByText(/修改在下次全新页面翻译时生效/)).toBeVisible();
});

test('旧 v2 存档缺渲染器模式字段时首次打开 Options 受控回退兼容模式', async ({ openExtensionPage }) => {
  const seed = await openExtensionPage('popup.html');
  await seed.evaluate(() => chrome.storage.local.set({ translatorSettings: {
    schemaVersion: 2, mvpDefaultsVersion: 1, theme: 'pearl-reader',
    readingPreferences: {
      targetLanguage: 'ja', displayMode: 'bilingual', userInstruction: '', translationPosition: 'after',
      scanScope: 'whole-page', selectionContext: true, selectionPopupEnabled: true, inlineSelectionModifier: 'Control',
    },
    engines: [
      { id: 'google', kind: 'google', name: 'Google', enabled: true, order: 0 },
      { id: 'bing', kind: 'bing', name: 'Bing', enabled: true, order: 1 },
    ],
    activeEngineId: 'google',
  } }));
  await seed.close();

  const options = await openExtensionPage('options.html');
  await expect(options.getByLabel('渲染器模式')).toHaveValue('legacy');
  // 缺字段只受控补齐渲染器模式，其余偏好保留不被重置。
  await expect(options.getByLabel('目标语言')).toHaveValue('ja');
});

test('旧版 translatorConfig 迁移：偏好保留并生成迁移自定义引擎', async ({ openExtensionPage, server }) => {
  const seed = await openExtensionPage('popup.html');
  await seed.evaluate((baseUrl) => chrome.storage.local.set({ translatorConfig: {
    targetLanguage: 'ja', displayMode: 'translation', userInstruction: '', translationPosition: 'before',
    scanScope: 'whole-page', selectionContext: true,
    baseUrl, model: 'migrated-model', apiKey: 'migrated-key',
  } }), server.baseUrl);
  await seed.close();

  const options = await openExtensionPage('options.html');
  await expect(options.getByLabel('渲染器模式')).toHaveValue('legacy');
  await expect(options.getByLabel('目标语言')).toHaveValue('ja');
  await expect(options.getByLabel('默认模式')).toHaveValue('translation');
  await expect(options.getByRole('group', { name: '迁移的自定义 AI' })).toBeVisible();
});

test('页面加载后无需按需注入即有消息监听器（manifest 单条目按序注入）', async ({ context, server, openExtensionPage }) => {
  const page = await openFixture(context, server.inlineFixtureUrl);
  const probe = await openExtensionPage('popup.html');
  // restore-page 为无副作用探测消息：content-main.js 注册的监听器就绪时才有响应。
  // 若合并后的单条目注入顺序被破坏（装配层先于控制器库执行），监听器不会注册，探测保持失败。
  await expect.poll(() => probe.evaluate(async (origin) => {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    if (!tabs[0]?.id) return false;
    try {
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'restore-page' });
      return true;
    } catch {
      return false;
    }
  }, server.origin)).toBe(true);
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
});

test('内联模式页面翻译：普通段落内部渲染，flex/grid 多子项与交互子树回退兼容', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await configureInlineEngine(options, server);
  await options.close();
  const page = await openFixture(context, server.inlineFixtureUrl);
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');

  // 普通段落由内联渲染器处理：译文与原文包装都在段落内部。
  await expect(page.locator('#plain')).toHaveAttribute('data-vast-inline', '');
  await expect(page.locator('#plain > [data-vast-translator]')).toHaveText('内联段落译文。');
  await expect(page.locator('#plain > [data-vast-source]')).toHaveCount(1);
  // 内联模式不产生兄弟 wrapper。
  await expect(page.locator('#plain + [data-vast-translator]')).toHaveCount(0);

  // flex/grid 容器多子项：折叠子项会改变布局，保守回退兼容模式（兄弟 wrapper，无内联标记）。
  await expect(page.locator('#flex-many')).not.toHaveAttribute('data-vast-inline', '');
  await expect(page.locator('#flex-many + [data-vast-translator]')).toHaveText('多子项布局译文。');
  await expect(page.locator('#grid-many')).not.toHaveAttribute('data-vast-inline', '');
  await expect(page.locator('#grid-many + [data-vast-translator]')).toHaveText('网格布局译文。');
  // 单子项 flex 容器保持内联。
  await expect(page.locator('#flex-one')).toHaveAttribute('data-vast-inline', '');
  await expect(page.locator('#flex-one > [data-vast-translator]')).toHaveText('单子项布局译文。');

  // 交互子树（含链接）回退兼容模式。
  await expect(page.locator('#interactive')).not.toHaveAttribute('data-vast-inline', '');
  await expect(page.locator('#interactive + [data-vast-translator]')).toHaveText('交互子树译文。');

  await page.screenshot({ path: evidence('translated'), fullPage: true });

  // 恢复后无插件节点残留，原节点还原。
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(page.locator('[data-vast-inline]')).toHaveCount(0);
  await expect(page.locator('#plain')).toHaveText('Plain paragraph for inline.');
  await popup.close();
});

test('内联翻译保持 heading 计算样式，恢复保留原节点事件，Options 切换下次全新翻译生效', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await configureInlineEngine(options, server);
  await options.close();
  const page = await openFixture(context, server.inlineFixtureUrl);
  await page.evaluate(() => {
    (window as unknown as { clicks: number }).clicks = 0;
    document.getElementById('event-source')?.addEventListener('click', () => {
      (window as unknown as { clicks: number }).clicks += 1;
    });
  });
  const headingStyleBefore = await page.locator('#heading').evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontSize: style.fontSize, color: style.color };
  });
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');

  // 译文容器是 heading 的子节点，heading 自身计算样式不受包装影响。
  await expect(page.locator('#heading > [data-vast-translator]')).toHaveText('标题译文。');
  const headingStyleAfter = await page.locator('#heading').evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontSize: style.fontSize, color: style.color };
  });
  expect(headingStyleAfter).toEqual(headingStyleBefore);
  // 译文 span 继承 heading 的字体与颜色。
  await expect(page.locator('#heading > [data-vast-translator]')).toHaveCSS('font-size', headingStyleBefore.fontSize);
  await expect(page.locator('#heading > [data-vast-translator]')).toHaveCSS('color', headingStyleBefore.color);

  // 恢复后原节点事件监听器保留（移动而非克隆）。
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await page.locator('#event-source').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);

  // Options 切回兼容模式：下一次全新翻译会话生效（不再是会话内改判）。
  const reopened = await openExtensionPage('options.html');
  await reopened.getByLabel('渲染器模式').selectOption('legacy');
  await expect(reopened.getByRole('status')).toHaveText('设置已保存');
  await expect(reopened.getByRole('status')).toHaveText('设置已保存');
  await reopened.close();
  await clickPopupButton(popup, page, '翻译 (Alt + A)');
  await expect(page.locator('#plain')).not.toHaveAttribute('data-vast-inline', '');
  await expect(page.locator('#plain + [data-vast-translator]')).toHaveText('内联段落译文。');
  await page.screenshot({ path: evidence('switched-legacy'), fullPage: true });
  await popup.close();
});

test('inline 错误归属保持，重试后恢复混合渲染并可完整还原', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await configureInlineEngine(options, server);
  await options.close();
  server.setMode('401');
  const page = await openFixture(context, server.inlineFixtureUrl);
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');

  // 失败时归属保持首次判定：安全段落错误提示在段落内部（inline），布局不安全段落用兄弟容器（legacy）。
  await expect(page.locator('#plain')).toHaveAttribute('data-vast-inline', '');
  await expect(page.locator('#plain [data-vast-retry-all]')).toHaveCount(1);
  await expect(page.locator('#flex-many + [data-vast-translator] [data-vast-retry-all]')).toHaveCount(1);
  await expect(page.locator('[data-vast-state="error"]')).toHaveCount(8);
  await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);

  server.setMode('success');
  // 从 inline 错误提示里的重试按钮触发全局重试。
  await page.locator('#plain [data-vast-retry-all]').click();
  await expect(page.locator('#plain')).toHaveAttribute('data-vast-inline', '');
  await expect(page.locator('#plain > [data-vast-translator]')).toHaveText('内联段落译文。');
  // 归属未翻转：错误→重试链路后布局不安全段落仍走兼容模式兄弟容器。
  await expect(page.locator('#flex-many + [data-vast-translator]')).toHaveText('多子项布局译文。');
  await expect(page.locator('#interactive + [data-vast-translator]')).toHaveText('交互子树译文。');
  await expect(page.locator('#flex-one > [data-vast-translator]')).toHaveText('单子项布局译文。');
  await expect(page.locator('[data-vast-state="error"]')).toHaveCount(0);

  // 混合 inline/legacy 状态下恢复原文：两类渲染节点与内联标记全部清理。
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(page.locator('[data-vast-inline]')).toHaveCount(0);
  await expect(page.locator('#plain')).toHaveText('Plain paragraph for inline.');
  await expect(page.locator('#flex-many')).toHaveText('Multi firstsecond');
  await popup.close();
});

test('仅译文模式下动态页面外部变化不触发重译闪烁，翻译请求计数保持稳定', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await configureInlineEngine(options, server);
  await options.close();
  const page = await openFixture(context, server.inlineFixtureUrl);
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');

  // 首轮翻译完成（默认双语）：下钻段落译文挂载在链接内部。
  await expect(page.locator('#user-release-link [data-vast-translator]')).toHaveText('发布版本。');

  // 通过 popup 模式按钮切到仅译文（popup 会以 translation-only 重翻整页），
  // 渲染后源包装被扩展隐藏——回归曾在此状态下无限重译闪烁。
  await clickPopupButton(popup, page, '双语对照');
  const translationOnly = page.locator('#user-release-link [data-vast-translator]');
  await expect(translationOnly).toHaveText('发布版本。');
  await expect(page.locator('#user-release-link [data-vast-source]')).toBeHidden();
  await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);
  const requestsAfterFirstPass = server.requests.length;
  expect(requestsAfterFirstPass).toBeGreaterThan(0);

  // 模拟动态页面在段落内部持续产生外部变化（时间戳刷新、徽标、懒加载装饰节点），
  // 覆盖段落祖先、下钻挂载目标与源包装内部三个层级。
  for (let round = 0; round < 4; round += 1) {
    await page.evaluate((index) => {
      const host = document.querySelector('#user-release-h2 .d-flex') as HTMLElement;
      const noise = document.createElement('span');
      noise.dataset.e2eNoise = String(index);
      host.append(noise);
      const target = document.querySelector('#user-release-title') as HTMLElement;
      const innerNoise = document.createElement('i');
      innerNoise.dataset.e2eNoise = `target-${index}`;
      target.append(innerNoise);
      const sourceWrapper = target.querySelector('[data-vast-source]') as HTMLElement;
      if (sourceWrapper) {
        const wrappedNoise = document.createElement('em');
        wrappedNoise.dataset.e2eNoise = `source-${index}`;
        sourceWrapper.append(wrappedNoise);
      }
    }, round);
    await page.waitForTimeout(400);
  }
  // 超过观察器 debounce 的多轮等待，确认没有自续的失效循环。
  await page.waitForTimeout(1000);

  // 无重复翻译请求：闪烁的表象是 loading 反复出现与请求计数持续增长。
  expect(server.requests.length).toBe(requestsAfterFirstPass);
  await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);
  await expect(translationOnly).toHaveText('发布版本。');
  // 原文包装内的源文本保持可读可恢复，version 未被重写为空串。
  await expect(page.locator('#user-release-link [data-vast-source]')).toHaveText('Releases');
  await expect(page.locator('#user-release-link [data-vast-source]')).toBeHidden();
  // 再次确认等待窗口内请求计数没有增长（排除延迟点燃的循环）。
  await page.waitForTimeout(1500);
  expect(server.requests.length).toBe(requestsAfterFirstPass);
  await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);

  await page.screenshot({ path: evidence('translation-only-stable'), fullPage: true });
  await popup.close();
});

test('用户结构 h2>span>a>span Releases 下钻内联翻译，保持计算样式、点击与辅助节点完整', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await configureInlineEngine(options, server);
  await options.close();
  const page = await openFixture(context, server.inlineFixtureUrl);

  // 绑定链接点击测试
  await page.evaluate(() => {
    (window as unknown as { linkClicks: number }).linkClicks = 0;
    document.getElementById('user-release-link')?.addEventListener('click', (event) => {
      event.preventDefault();
      (window as unknown as { linkClicks: number }).linkClicks += 1;
    });
  });

  const h2StyleBefore = await page.locator('#user-release-h2').evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, fontSize: style.fontSize };
  });

  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');

  // 1. h2 不被 hidden，外部无相邻 wrapper
  await expect(page.locator('#user-release-h2')).toBeVisible();
  await expect(page.locator('#user-release-h2 + [data-vast-translator]')).toHaveCount(0);

  // 2. 译文挂载在 a 内部
  const translation = page.locator('#user-release-link [data-vast-translator]');
  await expect(translation).toBeVisible();
  await expect(translation).toHaveText('发布版本。');

  // 3. 计算样式保持一致
  const h2StyleAfter = await page.locator('#user-release-h2').evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, fontSize: style.fontSize };
  });
  expect(h2StyleAfter).toEqual(h2StyleBefore);

  // 4. Counter 与 SVG 辅助节点保持原位且不混入译文
  await expect(page.locator('#user-release-h2 .Counter')).toHaveText('12');
  await expect(page.locator('#user-release-h2 .sr-only')).toHaveText('12 releases');

  // 5. 点击译文触发原链接点击监听
  await translation.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { linkClicks: number }).linkClicks)).toBe(1);

  await page.screenshot({ path: evidence('user-release-translated'), fullPage: true });

  // 6. 恢复原文：完整还原原结构与事件
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(page.locator('[data-vast-inline]')).toHaveCount(0);
  await expect(page.locator('#user-release-title')).toHaveText('Releases');

  await page.locator('#user-release-title').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { linkClicks: number }).linkClicks)).toBe(2);

  await page.screenshot({ path: evidence('user-release-restored'), fullPage: true });
  await popup.close();
});

test('手风琴折叠结构：保留 h3/button/aria/事件且 svg 不隐藏，inert 折叠区展开后动态调度与 checkbox 交互保持', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await configureInlineEngine(options, server);
  await options.close();
  const page = await openFixture(context, server.accordionFixtureUrl);
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');

  // 1. 初始折叠状态：h3 与 button 保持原位且未被 hidden
  await expect(page.locator('#europe-accordion-h3')).toBeVisible();
  await expect(page.locator('#europe-accordion-button')).toBeVisible();
  await expect(page.locator('#europe-accordion-button')).toHaveAttribute('aria-expanded', 'false');

  // 2. 译文挂载在 button 内部的文本 span，svg 图标保留
  const buttonTranslation = page.locator('#europe-accordion-span [data-vast-translator]');
  await expect(buttonTranslation).toBeVisible();
  await expect(buttonTranslation).toHaveText('欧洲。');
  await expect(page.locator('#europe-accordion-span svg')).toBeVisible();

  // 3. inert 折叠区初始未被扫描与翻译（不占位、无 loading、无译文）
  const region = page.locator('#europe-accordion-region');
  await expect(region).toHaveAttribute('inert', '');
  await expect(region.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(region.locator('[data-vast-state="loading"]')).toHaveCount(0);

  await page.screenshot({ path: evidence('accordion-initial-translated'), fullPage: true });

  // 4. 点击按钮展开折叠区（鼠标点击）
  await page.locator('#europe-accordion-button').click();
  await expect(page.locator('#europe-accordion-button')).toHaveAttribute('aria-expanded', 'true');
  await expect(region).not.toHaveAttribute('inert');

  // 5. 动态观察器自动感知属性变化并重新扫描，展开区域内的城市 label 完成翻译
  await expect(page.locator('#paris-label [data-vast-translator]')).toHaveText('巴黎。');
  await expect(page.locator('#london-label [data-vast-translator]')).toHaveText('伦敦。');

  // 6. Checkbox 与 label 关联保持：点击 label 成功勾选 checkbox
  const parisCheckbox = page.locator('#paris-checkbox');
  await expect(parisCheckbox).not.toBeChecked();
  await page.locator('#paris-label').click();
  await expect(parisCheckbox).toBeChecked();

  // 7. 键盘操作折叠与展开：聚焦按钮按 Enter/Space 键
  await page.locator('#europe-accordion-button').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#europe-accordion-button')).toHaveAttribute('aria-expanded', 'false');
  await expect(region).toHaveAttribute('inert', '');

  await page.keyboard.press('Enter');
  await expect(page.locator('#europe-accordion-button')).toHaveAttribute('aria-expanded', 'true');
  await expect(region).not.toHaveAttribute('inert');

  await page.screenshot({ path: evidence('accordion-expanded-translated'), fullPage: true });

  // 8. 仅译文模式测试：断言 svg 与 input 必须保持可见与可交互！
  await clickPopupButton(popup, page, '双语对照');
  await expect(page.locator('#europe-accordion-span [data-vast-translator]')).toHaveText('欧洲。');
  await expect(page.locator('#europe-accordion-span [data-vast-source]')).toBeHidden();
  await expect(page.locator('#europe-accordion-button')).toBeVisible();
  // 核心断言：仅译文模式下，button 内部的 svg 依然可见
  await expect(page.locator('#europe-accordion-span svg')).toBeVisible();
  // 核心断言：仅译文模式下，展开区域内的 input 与 label 保持可见且可点击
  await expect(page.locator('#paris-label [data-vast-translator]')).toHaveText('巴黎。');
  await expect(page.locator('#paris-checkbox')).toBeVisible();
  await page.locator('#london-label').click();
  await expect(page.locator('#london-checkbox')).toBeChecked();

  // 9. 恢复原文：完整还原原 DOM 与事件
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(page.locator('[data-vast-inline]')).toHaveCount(0);
  await expect(page.locator('[data-vast-text-leaf]')).toHaveCount(0);
  await expect(page.locator('#europe-accordion-span')).toContainText('Europe');
  await expect(page.locator('#paris-label')).toContainText('Paris');
  await expect(page.locator('#europe-accordion-span svg')).toBeVisible();
  await expect(page.locator('#paris-checkbox')).toBeVisible();

  // 恢复后按钮点击展开/折叠依然正常
  await page.locator('#europe-accordion-button').click();
  await expect(page.locator('#europe-accordion-button')).toHaveAttribute('aria-expanded', 'false');

  await page.screenshot({ path: evidence('accordion-restored'), fullPage: true });
  await popup.close();
});

test('手风琴折叠结构在 Legacy 兼容模式下：h3/button 不被隐藏，svg 保持可见，展开后 checkbox 正常交互', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await configureInlineEngine(options, server);
  await options.getByLabel('渲染器模式').selectOption('legacy');
  await expect(options.getByRole('status')).toHaveText('设置已保存');
  await expect(options.getByRole('status')).toHaveText('设置已保存');
  await options.close();

  const page = await openFixture(context, server.accordionFixtureUrl);
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');

  // 1. Legacy 模式下，因按钮外壳跳过而精准提取了内部文本叶，因此 h3/button 不会被隐藏
  await expect(page.locator('#europe-accordion-h3')).toBeVisible();
  await expect(page.locator('#europe-accordion-button')).toBeVisible();
  await expect(page.locator('#europe-accordion-span svg')).toBeVisible();

  // 2. 点击展开区域
  await page.locator('#europe-accordion-button').click();
  await expect(page.locator('#europe-accordion-button')).toHaveAttribute('aria-expanded', 'true');

  // 3. 展开后城市 label 翻译完成，且 label 点击勾选正常
  await expect(page.locator('#paris-label [data-vast-translator]')).toHaveText('巴黎。');
  const parisCheckbox = page.locator('#paris-checkbox');
  await page.locator('#paris-label').click();
  await expect(parisCheckbox).toBeChecked();

  // 4. 仅译文模式测试：svg 依然可见，checkbox 依然可用
  await clickPopupButton(popup, page, '双语对照');
  await expect(page.locator('#europe-accordion-span svg')).toBeVisible();
  await expect(page.locator('#paris-checkbox')).toBeVisible();
  await page.locator('#london-label').click();
  await expect(page.locator('#london-checkbox')).toBeChecked();

  // 5. 恢复原文
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(page.locator('[data-vast-text-leaf]')).toHaveCount(0);
  await expect(page.locator('#europe-accordion-span')).toContainText('Europe');
  await expect(page.locator('#paris-label')).toContainText('Paris');
  await expect(page.locator('#europe-accordion-span svg')).toBeVisible();

    await page.screenshot({ path: evidence('accordion-legacy-restored'), fullPage: true });
  await popup.close();
  await page.close();
});

test('内联模式下段落内部发生深克隆/替换后动态观察器与渲染器协同自愈，无残留 loading 且完成统计真实', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await configureInlineEngine(options, server);
  await options.close();

  const page = await openFixture(context, server.inlineFixtureUrl);
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');

  // 1. 首轮翻译完成：断言页面内联译文与 Popup 状态真实同步
  await expect(page.locator('#plain > [data-vast-translator]')).toHaveText('内联段落译文。');
  await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: '显示原文 (Alt + A)' })).toBeVisible();

  // 2. 模拟前端框架对 #plain 内部子树进行深克隆替换，并将克隆的 translator 改为 loading+文字“翻译中…”（精准复现现场问题结构）
  await page.evaluate(() => {
    const plain = document.getElementById('plain') as HTMLElement;
    const cloned = Array.from(plain.childNodes).map((n) => n.cloneNode(true));
    const translator = cloned.find((node) => node instanceof HTMLElement && node.hasAttribute('data-vast-translator')) as HTMLElement | undefined;
    if (translator) {
      translator.dataset.vastState = 'loading';
      translator.textContent = '翻译中…';
      translator.id = 'cloned-fake-loading';
    }
    plain.replaceChildren(...cloned);
  });

  // 保留克隆假 loading 节点的 handle 并断言其可见
  const fakeLoading = page.locator('#cloned-fake-loading');
  await expect(fakeLoading).toBeVisible();
  await expect(fakeLoading).toHaveText('翻译中…');

  // 3. 等待动态观察器生效并完成重新调度与翻译：
  // 必须断言被克隆注入的 fake loading wrapper 彻底断开/被替换！
  await expect(fakeLoading).toHaveCount(0);

  // 真实 translated 译文呈现，页面无任何 loading 残留，Popup 保持翻译激活态
  await expect(page.locator('#plain > [data-vast-translator]')).toHaveText('内联段落译文。');
  await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);
  await expect(page.locator('#plain [data-vast-source]')).toHaveCount(1);
  await expect(popup.getByRole('button', { name: '显示原文 (Alt + A)' })).toBeVisible();

  // 4. 恢复原文：断言 Popup 回到就绪态且页面干净还原
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(page.locator('[data-vast-inline]')).toHaveCount(0);
  await expect(page.locator('#plain')).toHaveText('Plain paragraph for inline.');
  await expect(popup.getByRole('status')).toHaveText('就绪');
  await expect(popup.getByRole('button', { name: '翻译 (Alt + A)' })).toBeVisible();
  await popup.close();
  await page.close();
});
test('内联模式下请求 pending 期间发生内部克隆替换，旧结果释放后被隔离拒绝，新任务正常收敛完成', async ({ context, server, openExtensionPage }) => {
  const options = await openExtensionPage('options.html');
  await configureInlineEngine(options, server);
  await options.close();

  // 设置服务端延迟模式，模拟首轮请求处于 pending 飞行中
  server.setMode('delay');

  const page = await openFixture(context, server.inlineFixtureUrl);
  const popup = await openPopupForFixture(openExtensionPage, page);
  await clickPopupButton(popup, page, '翻译 (Alt + A)');

  // 验证处于 loading 状态
  await expect(page.locator('#plain [data-vast-state="loading"]')).toBeVisible();

  // 在首轮请求 pending 期间，模拟前端框架对 #plain 内部进行深克隆重置
  await page.evaluate(() => {
    const plain = document.getElementById('plain') as HTMLElement;
    const cloned = Array.from(plain.childNodes).map((n) => n.cloneNode(true));
    const loadingNode = cloned.find((node) => node instanceof HTMLElement && node.hasAttribute('data-vast-translator')) as HTMLElement | undefined;
    if (loadingNode) {
      loadingNode.id = 'stale-pending-loading';
    }
    plain.replaceChildren(...cloned);
  });

  const staleLoading = page.locator('#stale-pending-loading');
  await expect(staleLoading).toBeVisible();

  // 切回正常模式并释放首轮 pending 延迟请求
  server.setMode('success');
  server.releaseDelay();

  // 旧请求返回时因挂载脱离被严格拒绝，observer/controller 自愈调度新任务，
  // 旧 loading 节点被清理断开，新译文正常到达并收敛到完成态
  await expect(staleLoading).toHaveCount(0);
  await expect(page.locator('#plain > [data-vast-translator]')).toHaveText('内联段落译文。');
  await expect(page.locator('[data-vast-state="loading"]')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: '显示原文 (Alt + A)' })).toBeVisible();

  // 恢复原文
  await clickPopupButton(popup, page, '显示原文 (Alt + A)');
  await expect(page.locator('[data-vast-translator]')).toHaveCount(0);
  await expect(page.locator('#plain')).toHaveText('Plain paragraph for inline.');
  await expect(popup.getByRole('status')).toHaveText('就绪');
  await expect(popup.getByRole('button', { name: '翻译 (Alt + A)' })).toBeVisible();
  await popup.close();
  await page.close();
});
