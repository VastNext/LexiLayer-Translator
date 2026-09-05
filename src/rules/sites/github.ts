import type { SiteRule } from '../types.ts';

export const rule: SiteRule = {
  id: 'github',
  mainContentSelectors: ['#readme', '[data-testid="readme"]', 'main'],
  excludeSelectors: [
    'header', 'nav', '[role="banner"]', '[role="navigation"]', '[role="button"]', 'button',
    '.js-navigation-container', '.js-repo-nav', '.AppHeader-context', '.Layout-header', '.Layout-sidebar',
    '.file-navigation', '.file-header', '.file-info', '.gh-header-actions', '.gh-header-meta',
    '[aria-label*="repository files" i]', '[aria-label*="file navigation" i]',
    '[aria-label*="repository navigation" i]', '[data-testid="repository-name"]', '[itemprop="name"]',
    '[data-testid="breadcrumbs"]', '.BorderGrid-cell', '.vcard-names-container', '.author', '.assignee',
    '.timeline-comment-header', '.review-thread-reply', '.repository-content .octicon', 'a.anchor', 'g-emoji', 'img',
    '.blob-code', 'table', 'pre', 'code',
  ],
};
