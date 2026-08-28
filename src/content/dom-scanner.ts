import type { SiteRule } from '../rules/types';

export type ScanScope = 'main-content' | 'whole-page';
export interface ScanMetrics { normalizedTexts: number; ancestorChecks: number }

const paragraphSelector = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, td, th';
const builtInExclusions = [
  'script',
  'style',
  'noscript',
  'template',
  'pre',
  'code',
  'nav',
  'button',
  'form',
  'input',
  'textarea',
  'select',
  '[role="navigation"]',
  '[role="button"]',
  '[contenteditable="true"]',
  '[hidden]',
  '[aria-hidden="true"]',
  '[data-vast-translator]',
  '[data-vast-inline-selection-translation]',
];
const breadcrumbContainerSelector = 'nav[aria-label*="breadcrumb" i], [role="navigation"][aria-label*="breadcrumb" i], ol[class*="breadcrumb" i], [class*="breadcrumb" i]';
const breadcrumbLeafSelector = 'a span, button a span, span[aria-current="page"], a';

function queryRoots(root: Document | Element, rule: SiteRule, scope: ScanScope): Element[] {
  const document = root instanceof Document ? root : root.ownerDocument;
  if (scope === 'whole-page') return [root instanceof Document ? root.body : root];

  const selectors = [...(rule.mainContentSelectors ?? []), ...(rule.includeSelectors ?? [])];
  if (root instanceof Element) {
    const allowed = selectors.some((selector) => root.matches(selector) || Boolean(root.closest(selector)));
    return allowed ? [root] : [];
  }
  const roots = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
  return roots.length > 0 ? Array.from(new Set(roots)) : [document.body];
}

function isExcluded(element: Element, rule: SiteRule): boolean {
  const selectors = [...builtInExclusions, ...(rule.excludeSelectors ?? [])];
  if (selectors.some((selector) => element.closest(selector))) return true;

  const view = element.ownerDocument.defaultView;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = view?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return true;
  }
  return false;
}

function hasText(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && Boolean(element.textContent?.trim());
}

function breadcrumbCandidates(root: Document | Element): HTMLElement[] {
  const containers = [
    ...(root instanceof Element && root.matches(breadcrumbContainerSelector) ? [root] : []),
    ...root.querySelectorAll(breadcrumbContainerSelector),
  ];
  const candidates = new Set<HTMLElement>();
  for (const container of containers) {
    for (const element of container.querySelectorAll(breadcrumbLeafSelector)) {
      if (!(element instanceof HTMLElement) || element.closest('[aria-hidden="true"], [hidden]')) continue;
      const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      if (!text || !Array.from(element.childNodes).some((node) => node.nodeType === node.TEXT_NODE && Boolean(node.textContent?.trim()))) continue;
      if (element.matches('a') && element.querySelector('span')) continue;
      candidates.add(element);
    }
  }
  return Array.from(candidates);
}

export function scanParagraphElements(
  root: Document | Element,
  rule: SiteRule,
  scope: ScanScope,
  metrics?: ScanMetrics,
): HTMLElement[] {
  const results = new Set<HTMLElement>();
  const forced = new Set(
    (rule.includeSelectors ?? []).flatMap((selector) => Array.from(root.querySelectorAll(selector))),
  );

  for (const scanRoot of queryRoots(root, rule, scope)) {
    const candidates = scanRoot.matches(paragraphSelector)
      ? [scanRoot, ...scanRoot.querySelectorAll(paragraphSelector)]
      : Array.from(scanRoot.querySelectorAll(paragraphSelector));

    for (const candidate of candidates) {
      if (hasText(candidate) && !isExcluded(candidate, rule)) results.add(candidate);
    }
    for (const candidate of breadcrumbCandidates(scanRoot)) results.add(candidate);
  }

  for (const candidate of forced) {
    const hasDirectText = Array.from(candidate.childNodes).some(
      (node) => node.nodeType === node.TEXT_NODE && Boolean(node.textContent?.trim()),
    );
    if (hasDirectText && hasText(candidate) && !isExcluded(candidate, rule)) results.add(candidate);
  }

  const texts = new Map(Array.from(results, (element) => {
    if (metrics) metrics.normalizedTexts += 1;
    return [element, element.textContent?.replace(/\s+/g, ' ').trim()];
  }));
  const redundant = new Set<HTMLElement>();
  for (const candidate of results) {
    for (let ancestor = candidate.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (metrics) metrics.ancestorChecks += 1;
      if (results.has(ancestor) && texts.get(ancestor) === texts.get(candidate)) redundant.add(ancestor);
    }
  }
  return Array.from(results).filter((candidate) => !redundant.has(candidate));
}
