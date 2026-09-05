import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'reddit',
  mainContentSelectors: ['main', '[role="main"]', 'shreddit-post', 'shreddit-comment'],
  includeSelectors: ['article', '[data-testid="comment"]'],
  excludeSelectors: [
    'header', 'nav', 'aside', 'form', 'button', '[role="button"]',
    '[data-testid="post-action-row"]', '[data-testid="comment-action-row"]',
    '[data-testid="vote-arrows"]', '[data-testid="content-gate"]',
    'shreddit-comment-action-row', 'faceplate-hovercard', '.text-neutral-content-weak',
  ],
};
