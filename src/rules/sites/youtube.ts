import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'youtube',
  mainContentSelectors: ['#primary', 'main'],
  includeSelectors: ['h1', '#description', '#comments'],
  excludeSelectors: [
    '#guide', '#masthead', '#movie_player', '#owner', '#actions', '#toolbar',
    'ytd-thumbnail', 'ytd-video-meta-block', 'ytd-watch-metadata #info',
    '[aria-label*="action" i]', '[role="button"]', 'button',
  ],
};
