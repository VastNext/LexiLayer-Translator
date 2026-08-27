import { describe, expect, it, vi } from 'vitest';

import type { RuleCatalogEntry, SiteRule } from '../../src/rules/types';
import { matchSiteRule } from '../../src/content/rule-matcher';
import { ruleCatalog } from '../../src/rules/catalog';

const generalRule: SiteRule = {
  id: 'general',
  mainContentSelectors: ['main', 'article'],
};

describe('matchSiteRule', () => {
  it.each([
    ['https://www.google.com/search?q=tdd', 'google-search'],
    ['https://www.bing.com/search?q=tdd', 'bing-search'],
    ['https://github.com/vitest-dev/vitest', 'github'],
    ['https://www.youtube.com/watch?v=123', 'youtube'],
    ['https://www.reddit.com/r/typescript/', 'reddit'],
    ['https://x.com/typescript', 'x'],
    ['https://stackoverflow.com/questions/1/example', 'stackoverflow'],
    ['https://writer.substack.com/p/example', 'substack'],
  ])('从轻量目录动态加载 %s 对应的原创规则', async (href, expectedId) => {
    await expect(matchSiteRule(new URL(href))).resolves.toMatchObject({ id: expectedId });
  });

  it('轻量目录不内联规则详情', () => {
    expect(ruleCatalog).toHaveLength(8);
    for (const entry of ruleCatalog) {
      expect(entry).not.toHaveProperty('mainContentSelectors');
      expect(entry).not.toHaveProperty('includeSelectors');
      expect(entry).not.toHaveProperty('excludeSelectors');
      expect(entry.load).toEqual(expect.any(Function));
    }
  });

  it('只加载 URL 命中的规则详情', async () => {
    const googleRule: SiteRule = { id: 'google-search', mainContentSelectors: ['#search'] };
    const googleLoader = vi.fn(async () => googleRule);
    const githubLoader = vi.fn(async () => ({ id: 'github' } satisfies SiteRule));
    const catalog: RuleCatalogEntry[] = [
      { id: 'google-search', hostnames: ['www.google.com'], pathPrefixes: ['/search'], load: googleLoader },
      { id: 'github', hostnames: ['github.com'], load: githubLoader },
    ];

    await expect(matchSiteRule(new URL('https://www.google.com/search?q=tdd'), catalog, generalRule))
      .resolves.toBe(googleRule);
    expect(googleLoader).toHaveBeenCalledOnce();
    expect(githubLoader).not.toHaveBeenCalled();
  });

  it('排除规则声明的路径且不加载详情', async () => {
    const loader = vi.fn(async () => ({ id: 'github' } satisfies SiteRule));
    const catalog: RuleCatalogEntry[] = [{
      id: 'github',
      hostnames: ['github.com'],
      excludePathPrefixes: ['/settings'],
      load: loader,
    }];

    await expect(matchSiteRule(new URL('https://github.com/settings/profile'), catalog, generalRule))
      .resolves.toBe(generalRule);
    expect(loader).not.toHaveBeenCalled();
  });

  it('支持子域名匹配并在未命中时回退 general', async () => {
    const loader = vi.fn(async () => ({ id: 'substack' } satisfies SiteRule));
    const catalog: RuleCatalogEntry[] = [
      { id: 'substack', hostnameSuffixes: ['.substack.com'], load: loader },
    ];

    await expect(matchSiteRule(new URL('https://writer.substack.com/p/post'), catalog, generalRule))
      .resolves.toMatchObject({ id: 'substack' });
    await expect(matchSiteRule(new URL('https://example.com/article'), catalog, generalRule))
      .resolves.toBe(generalRule);
    expect(loader).toHaveBeenCalledOnce();
  });
});
