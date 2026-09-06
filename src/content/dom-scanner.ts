import type { SiteRule } from '../rules/types';

export type ScanScope = 'main-content' | 'whole-page';
export interface ScanMetrics { normalizedTexts: number; ancestorChecks: number }
const MAX_TRANSLATABLE_TEXT_LENGTH = 6000;

const paragraphSelector = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, td, th';
const hardExclusions = [
  'script',
  'style',
  'noscript',
  'template',
  'pre',
  'code',
  'form',
  'input',
  'textarea',
  'select',
  'svg',
  'canvas',
  'mat-icon',
  '[class*="material-icons" i]',
  '[class*="icon-font" i]',
  '[role="img"]',
  '[role="tooltip"]',
  'relative-time',
  '[contenteditable="true"]',
  '[hidden]',
  '[aria-hidden="true"]',
  '[inert]',
  '.sr-only',
  '.visually-hidden',
  '[data-vast-translator]',
  '[data-vast-inline-selection-translation]',
];
const semanticContainerExclusions = ['nav', 'button', 'label', '[role="navigation"]', '[role="button"]'];

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
  const selectors = [...hardExclusions, ...semanticContainerExclusions, ...(rule.excludeSelectors ?? [])];
  if (selectors.some((selector) => element.closest(selector))) return true;
  if ((element as HTMLElement).inert || element.closest('[inert]')) return true;

  const view = element.ownerDocument.defaultView;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if ((current as HTMLElement).inert || current.hasAttribute('inert')) return true;
    const style = view?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return true;
  }
  return false;
}

function isTextLeafExcluded(element: Element, rule: SiteRule): boolean {
  const selectors = [...hardExclusions, ...(rule.excludeSelectors ?? [])];
  if (selectors.some((selector) => element.closest(selector))) return true;
  if ((element as HTMLElement).inert || element.closest('[inert]')) return true;
  const interactive = element.closest('button,[role="button"]');
  if (interactive === element) return true;
  const view = element.ownerDocument.defaultView;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if ((current as HTMLElement).inert || current.hasAttribute('inert')) return true;
    const style = view?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return true;
  }
  return false;
}

function hasText(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && Boolean(element.textContent?.trim());
}

function isWithinTranslationLimit(element: Element): boolean {
  return (element.textContent?.length ?? 0) <= MAX_TRANSLATABLE_TEXT_LENGTH;
}

function hasDirectText(element: Element): boolean {
  return Array.from(element.childNodes).some((node) => node.nodeType === node.TEXT_NODE && Boolean(node.textContent?.trim()));
}

/**
 * 将孤立的 TextNode 安全地包装在一个可逆的行内 span 内（标记 data-vast-text-leaf）。
 * 并在需要时可通过 unwrapAllTextLeaves 完全解包还原，不改变任何 DOM 节点身份。
 */
function wrapDirectTextNode(textNode: Text): HTMLElement {
  const parent = textNode.parentElement!;
  const span = parent.ownerDocument.createElement('span');
  span.dataset.vastTextLeaf = '';
  textNode.replaceWith(span);
  span.append(textNode);
  return span;
}

export function unwrapAllTextLeaves(root: Element | Document = document): void {
  const leaves = root.querySelectorAll<HTMLElement>('[data-vast-text-leaf]');
  for (const leaf of leaves) {
    leaf.replaceWith(...leaf.childNodes);
  }
}

function textLeafCandidates(root: Element, covered: Set<HTMLElement>, rule: SiteRule): HTMLElement[] {
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || isTextLeafExcluded(parent, rule)) return NodeFilter.FILTER_REJECT;
      if (parent.closest('ga-help-tooltip,xap-icon-trigger,[aria-haspopup="dialog"][role="button"]')) return NodeFilter.FILTER_REJECT;
      if (parent.matches('[class*="ripple" i],[class*="focus-indicator" i],[class*="touch-target" i]')) return NodeFilter.FILTER_REJECT;
      for (let current: Element | null = parent; current; current = current.parentElement) {
        if (covered.has(current as HTMLElement)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // 先完整收集所有命中的 Text 节点，避免在遍历中修改 DOM 导致 TreeWalker 丢节点
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    textNodes.push(node as Text);
  }

  const candidates = new Set<HTMLElement>();
  for (const node of textNodes) {
    // 若 node 已经在之前的操作中脱离文档或已在 data-vast-text-leaf 中，直接处理
    let parent = node.parentElement;
    if (parent?.closest('[data-vast-source], [data-vast-translator]')) continue;
    if (parent?.matches('[data-vast-text-leaf]')) {
      candidates.add(parent);
      continue;
    }
    if (parent && isWithinTranslationLimit(parent)) {
      const hasSiblingElements = Array.from(parent.children).some(
        (child) => !child.matches('[data-vast-translator], [data-vast-source], [data-vast-text-leaf]'),
      );
      const isControlContainer = parent.closest('label, button, [role="button"]') !== null;
      if ((isControlContainer && hasSiblingElements) || parent.matches('label')) {
        const wrapped = wrapDirectTextNode(node);
        candidates.add(wrapped);
      } else if (hasDirectText(parent)) {
        candidates.add(parent);
      }
    }
  }
  const grouped = [...candidates];
  return grouped.filter((candidate) => !grouped.some((ancestor) => ancestor !== candidate && ancestor.contains(candidate) && hasDirectText(ancestor)));
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
      if (candidate.matches('li') && !hasDirectText(candidate)) continue;
      // 包含按钮或交互控件的语义块不可作为整体候选（避免隐藏/破坏按钮），留由文本叶下钻
      if (candidate.querySelector('button, [role="button"]') !== null) continue;
      if (hasText(candidate) && isWithinTranslationLimit(candidate) && !isExcluded(candidate, rule)) results.add(candidate);
    }
    for (const candidate of textLeafCandidates(scanRoot, results, rule)) results.add(candidate);
  }

  for (const candidate of forced) {
    const hasDirectText = Array.from(candidate.childNodes).some(
      (node) => node.nodeType === node.TEXT_NODE && Boolean(node.textContent?.trim()),
    );
    if (hasDirectText && hasText(candidate) && isWithinTranslationLimit(candidate) && !isExcluded(candidate, rule)) results.add(candidate);
  }

  const redundant = new Set<HTMLElement>();
  for (const candidate of results) {
    if (metrics) metrics.normalizedTexts += 1;
    for (let ancestor = candidate.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (metrics) metrics.ancestorChecks += 1;
      if (results.has(ancestor as HTMLElement)) redundant.add(ancestor as HTMLElement);
    }
  }
  return Array.from(results).filter((candidate) => !redundant.has(candidate));
}
