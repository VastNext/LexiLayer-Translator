import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'google-search',
  mainContentSelectors: ['#search', '[role="main"]'],
  excludeSelectors: [
    '[role="navigation"]', 'form', 'table', '.trends-data', '#tads', '#tadsb', '#top_nav',
    '#result-stats', '#sfooter', '#searchform', '.b5ZQcf', '.CEMjEf', '.adDDi', '.WZ8Tjf',
  ],
};
