import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'x',
  mainContentSelectors: ['main', '[role="main"]'],
  includeSelectors: ['article', '[data-testid="tweetText"]'],
  excludeSelectors: [
    'header', 'nav', '[role="complementary"]', '[role="group"]', 'time',
    '[data-testid="User-Name"]', '[data-testid="socialContext"]',
    '[data-testid="reply"]', '[data-testid="retweet"]', '[data-testid="like"]', '[data-testid="bookmark"]',
  ],
};
