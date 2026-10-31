import { test, expect } from './fixtures';

const sectionIds = [
  'builtin-engines', 'custom-engines', 'ai-experts', 'reading-preferences',
  'selection-preferences', 'vocabulary-book', 'shortcuts-triggers',
  'appearance-theme', 'data-privacy',
];

test('设置导航与正文在桌面和窄屏保持相同顺序', async ({ openExtensionPage }, testInfo) => {
  const page = await openExtensionPage('options.html');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.options-content').evaluate((node) => node.scrollTo({ top: 0, behavior: 'instant' }));
    const sections = page.locator('.options-content > section');
    await expect(sections).toHaveCount(sectionIds.length);
    expect(await sections.evaluateAll((nodes) => nodes.map((node) => node.id))).toEqual(sectionIds);
    const tops = await sections.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
    expect(tops.every((top, index) => index === 0 || top > tops[index - 1])).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`options-${width}.png`) });

    const navigation = page.locator('.options-nav nav');
    const items = navigation.locator('button, a');
    await expect(items).toHaveCount(sectionIds.length);
    for (let index = 0; index < sectionIds.length; index += 1) {
      await items.nth(index).click();
      await expect(items.nth(index)).toHaveAttribute('aria-current', 'location');
      await expect.poll(async () => page.locator(`#${sectionIds[index]}`).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top < window.innerHeight && rect.bottom > 0;
      })).toBe(true);
      await expect.poll(() => page.locator('.options-content').evaluate((node) => {
        const active = document.querySelector('.options-nav [aria-current="location"]');
        const target = document.getElementById(active?.getAttribute('aria-controls') ?? '');
        return target ? Math.abs(target.getBoundingClientRect().top - node.getBoundingClientRect().top - 24) < 2
          || node.scrollTop + node.clientHeight >= node.scrollHeight - 1 : false;
      })).toBe(true);
      await expect(items.nth(index)).toHaveAttribute('aria-current', 'location');
    }
  }
});
