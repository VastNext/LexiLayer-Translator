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
    '[itemscope][itemtype="https://schema.org/abstract"] > h2:first-child',
    '[itemscope][itemtype="https://schema.org/abstract"] > p[align="center"]',
    '[data-testid="screen-reader-heading"]', '[class*="InternalVisuallyHidden" i]', '[class*="ScreenReaderHeading" i]',
    '[data-testid="latest-commit"]', '[data-testid="latest-commit-html"]', '[data-testid="latest-commit-details"]',
    '[data-testid="latest-commit-details-toggle"]', '[data-testid="author-avatar"]',
    '[data-testid="commit-row-item"]', '[data-testid="breadcrumbs"]', 'relative-time',
    '.BorderGrid-cell', '.vcard-names-container', '.author', '.assignee',
    '.timeline-comment-header', '.review-thread-reply', '.repository-content .octicon', 'a.anchor', 'g-emoji', 'img',
    '.blob-code', 'table', 'pre', 'code',
  ],
};
