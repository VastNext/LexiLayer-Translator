import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'github',
  mainContentSelectors: ['main', '[role="main"]', '#readme'],
  excludeSelectors: ['nav', '[role="navigation"]', '.js-navigation-container,table'],
};
