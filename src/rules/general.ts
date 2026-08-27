import type { SiteRule } from './types';

export const generalRule: SiteRule = {
  id: 'general',
  mainContentSelectors: ['main', 'article', '[role="main"]'],
};
