import type { RuleCatalogEntry, SiteRule } from './types';

async function loadRule(id: string): Promise<SiteRule> {
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    const response = await fetch(chrome.runtime.getURL(`rules/${id}.json`));
    if (!response.ok) throw new Error('站点规则加载失败');
    return response.json() as Promise<SiteRule>;
  }
  return { id };
}

export const ruleCatalog: RuleCatalogEntry[] = [
  {
    id: 'google-search',
    hostnames: ['www.google.com', 'www.google.com.hk'],
    pathPrefixes: ['/search'],
    load: () => loadRule('google-search'),
  },
  {
    id: 'bing-search',
    hostnames: ['www.bing.com'],
    pathPrefixes: ['/search'],
    load: () => loadRule('bing-search'),
  },
  {
    id: 'github',
    hostnames: ['github.com'],
    excludePathPrefixes: ['/settings', '/login', '/signup'],
    load: () => loadRule('github'),
  },
  {
    id: 'youtube',
    hostnames: ['www.youtube.com', 'youtube.com'],
    load: () => loadRule('youtube'),
  },
  {
    id: 'reddit',
    hostnames: ['www.reddit.com', 'reddit.com', 'old.reddit.com'],
    load: () => loadRule('reddit'),
  },
  {
    id: 'x',
    hostnames: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
    load: () => loadRule('x'),
  },
  {
    id: 'stackoverflow',
    hostnames: ['stackoverflow.com'],
    load: () => loadRule('stackoverflow'),
  },
  {
    id: 'substack',
    hostnames: ['substack.com', 'www.substack.com'],
    hostnameSuffixes: ['.substack.com'],
    load: () => loadRule('substack'),
  },
];
