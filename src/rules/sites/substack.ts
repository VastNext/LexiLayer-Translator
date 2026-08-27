import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'substack',
  mainContentSelectors: ['article', 'main', '.post'],
  excludeSelectors: ['header', 'nav', '.subscribe-widget'],
};
