import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'bing-search',
  mainContentSelectors: ['#b_results', 'main'],
  excludeSelectors: ['#b_context', 'form'],
};
