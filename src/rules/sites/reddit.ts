import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'reddit',
  mainContentSelectors: ['main', '[role="main"]'],
  includeSelectors: ['article', '[data-testid="comment"]'],
  excludeSelectors: ['header', 'nav', 'aside'],
};
