import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'youtube',
  mainContentSelectors: ['#primary', 'main'],
  includeSelectors: ['h1', '#description', '#comments'],
  excludeSelectors: ['#guide', '#masthead', 'ytd-thumbnail'],
};
