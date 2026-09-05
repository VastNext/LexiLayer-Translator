import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'substack',
  mainContentSelectors: ['article', 'main', '.post'],
  excludeSelectors: ['nav', '.subscribe-widget', '.post-meta', '.post-actions', '.share-dialog', 'button', '[role="button"]'],
};
