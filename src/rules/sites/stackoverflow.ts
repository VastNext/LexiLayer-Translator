import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'stackoverflow',
  mainContentSelectors: ['#mainbar', '#content'],
  includeSelectors: ['.question', '.answer', '.comment-copy'],
  excludeSelectors: ['#sidebar', '.js-post-menu', '.s-topbar'],
};
