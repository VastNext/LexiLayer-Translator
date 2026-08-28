import { beforeEach, describe, expect, it } from 'vitest';

import { scanParagraphElements, type ScanMetrics } from '../../src/content/dom-scanner';
import type { SiteRule } from '../../src/rules/types';

const rule: SiteRule = {
  id: 'test',
  mainContentSelectors: ['main'],
  includeSelectors: ['.extra'],
  excludeSelectors: ['.sponsored'],
};

describe('scanParagraphElements', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <nav><p>导航文字</p></nav>
      <main>
        <h1>标题</h1>
        <p id="body">正文段落</p>
        <blockquote>引用内容</blockquote>
        <figure><figcaption>图片说明</figcaption></figure>
        <ul><li>列表内容</li></ul>
        <table><tbody><tr><td>表格内容</td></tr></tbody></table>
        <pre>预格式文本</pre>
        <code>代码文本</code>
        <button>按钮文本</button>
        <form><p>表单文本</p></form>
        <p hidden>隐藏文本</p>
        <p aria-hidden="true">辅助隐藏文本</p>
        <div contenteditable="true"><p>编辑文本</p></div>
        <div data-vast-translator><p>插件文本</p></div>
        <div data-vast-inline-selection-translation><p>内联插件文本</p></div>
        <div class="sponsored"><p>广告文本</p></div>
      </main>
      <aside class="extra"><p id="extra">额外正文</p></aside>
      <section><p id="outside">页面其他内容</p></section>
    `;
  });

  it('主要内容模式提取语义正文，并排除交互、代码、隐藏和插件节点', () => {
    const elements = scanParagraphElements(document, rule, 'main-content');

    expect(elements.map((element) => element.textContent?.trim())).toEqual([
      '标题', '正文段落', '引用内容', '图片说明', '列表内容', '表格内容', '额外正文',
    ]);
  });

  it('整个页面模式扫描页面正文和导航可见文字，但仍排除危险节点', () => {
    const elements = scanParagraphElements(document, rule, 'whole-page');

    expect(elements.map((element) => element.id)).toContain('outside');
    expect(elements.map((element) => element.textContent?.trim())).toContain('导航文字');
  });

  it.each(['whole-page', 'main-content'] as const)('识别 findryai 面包屑文本叶且不产生父子重复：%s', (scope) => {
    document.body.innerHTML = `
      <main>
        <nav aria-label="Breadcrumb">
          <ol class="flex items-center">
            <li><a href="/"><span>Home</span></a></li>
            <li aria-hidden="true"><svg><path /></svg></li>
            <li><button type="button"><a href="/category"><span>Category</span></a></button></li>
            <li><a href="/category/image-generation"><span>Image Generation</span></a></li>
            <li><span aria-current="page">trainengine ai</span></li>
            <li aria-hidden="true"><span>Hidden crumb</span></li>
            <li><a href="/icon"><svg aria-label="icon"><path /></svg></a></li>
          </ol>
        </nav>
      </main>`;

    const elements = scanParagraphElements(document, rule, scope);

    expect(elements.map((element) => element.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Home', 'Category', 'Image Generation', 'trainengine ai',
    ]);
    expect(elements.map((element) => element.tagName)).toEqual(['SPAN', 'SPAN', 'SPAN', 'SPAN']);
  });

  it.each(['whole-page', 'main-content'] as const)('识别 Angular 管理卡片中的说明和菜单文本叶：%s', (scope) => {
    document.body.innerHTML = `
      <main>
        <div class="admin-link-group-list-container">
          <ga-admin-link-group class="admin-link-group-list-item">
            <xap-card class="admin-link-group">
              <xap-card-header><xap-card-title><h3>Property</h3></xap-card-title></xap-card-header>
              <xap-card-sub-header><xap-card-subtitle><span class="admin-card-description">These settings affect your property <a href="#">What's a property?</a></span></xap-card-subtitle></xap-card-sub-header>
              <xap-card-content><mat-list class="admin-group-links-list">
                ${['Property details','Property access management','Property change history','Property data API quota history','Custom insights','Scheduled emails','Analytics Intelligence search history'].map((text) => `
                  <mat-list-item><span class="mdc-list-item__content"><ga-admin-link><div class="admin-link"><a role="link"><img alt=""><div class="admin-link-text"><div class="admin-link-text-title">${text}</div></div></a><ga-help-tooltip><xap-icon-trigger role="button" aria-label="Tooltip for ${text}"><mat-icon aria-hidden="true">help_outline</mat-icon></xap-icon-trigger></ga-help-tooltip></div></ga-admin-link></span></mat-list-item>
                `).join('')}
              </mat-list></xap-card-content>
            </xap-card>
          </ga-admin-link-group>
        </div>
      </main>`;

    const elements = scanParagraphElements(document, rule, scope);
    const texts = elements.map((element) => element.textContent?.replace(/\s+/g, ' ').trim());

    expect(texts).toEqual([
      'Property',
      "These settings affect your property What's a property?",
      'Property details',
      'Property access management',
      'Property change history',
      'Property data API quota history',
      'Custom insights',
      'Scheduled emails',
      'Analytics Intelligence search history',
    ]);
    expect(texts.some((text) => text?.includes('Tooltip for') || text === 'help_outline')).toBe(false);
  });

  it.each(['whole-page', 'main-content'] as const)('识别 mat-tree 按钮内独立文本叶并排除图标与按钮直接文本：%s', (scope) => {
    document.body.innerHTML = `<main><ga-secondary-nav role="navigation"><mat-tree role="tree">
      <mat-tree-node role="treeitem"><button><span class="mdc-button__label"><div><span id="reports">Reports snapshot</span></div></span><span class="mat-focus-indicator"></span></button></mat-tree-node>
      <mat-tree-node role="treeitem"><button><span class="mdc-button__label"><div><mat-icon aria-hidden="true">arrow_drop_down</mat-icon><span id="leads">Generate leads</span></div></span><span class="mat-ripple"></span></button></mat-tree-node>
      <mat-tree-node role="treeitem"><button><span class="mdc-button__label"><div><span id="objectives">Business objectives</span><mat-icon aria-hidden="true">keyboard_arrow_up</mat-icon></div></span></button></mat-tree-node>
      <button id="direct-button">Direct button text</button>
    </mat-tree></ga-secondary-nav></main>`;
    const elements = scanParagraphElements(document, rule, scope);
    expect(elements.map((element) => element.id)).toEqual(['reports', 'leads', 'objectives']);
    expect(elements.map((element) => element.textContent?.trim())).toEqual(['Reports snapshot', 'Generate leads', 'Business objectives']);
  });

  it('多个扫描根和选择器命中同一元素时只返回一次', () => {
    const duplicateRule: SiteRule = {
      id: 'duplicate',
      mainContentSelectors: ['main', '#body'],
      includeSelectors: ['main', '#body'],
    };

    const elements = scanParagraphElements(document, duplicateRule, 'main-content');
    expect(elements.filter((element) => element.id === 'body')).toHaveLength(1);
  });

  it.each([
    ['<li id="outer"><p id="inner">列表段落</p></li>', 'inner'],
    ['<blockquote id="outer"><p id="inner">引用段落</p></blockquote>', 'inner'],
    ['<table><tbody><tr><td id="outer"><p id="inner">单元格段落</p></td></tr></tbody></table>', 'inner'],
  ])('父子语义候选只保留最具体边界：%s', (markup, expectedId) => {
    document.body.innerHTML = `<main>${markup}</main>`;
    const elements = scanParagraphElements(document, rule, 'main-content');

    expect(elements).toHaveLength(1);
    expect(elements[0].id).toBe(expectedId);
  });

  it('支持 Element 局部根且 main-content 不扫描新增 header', () => {
    const main = document.querySelector('main')!;
    expect(scanParagraphElements(main, rule, 'main-content').map((element) => element.id)).toContain('body');
    const header = document.createElement('header'); header.innerHTML = '<p id="late-header">header</p>'; document.body.append(header);
    expect(scanParagraphElements(header, rule, 'main-content')).toEqual([]);
  });

  it('1000 个候选仅沿祖先链去重，不做候选两两 contains 比较', () => {
    document.body.innerHTML = `<main>${Array.from({ length: 1000 }, (_, index) => `<p id="p${index}">text ${index}</p>`).join('')}</main>`;
    const metrics: ScanMetrics = { normalizedTexts: 0, ancestorChecks: 0 };

    expect(scanParagraphElements(document, rule, 'main-content', metrics)).toHaveLength(1000);
    expect(metrics.normalizedTexts).toBe(1000);
    expect(metrics.ancestorChecks).toBeLessThan(5000);
  });

  it('includeSelectors 命中的直接文本 div/span 是强制候选', () => {
    document.body.innerHTML = `
      <main><p>正文</p></main>
      <div class="extra" id="forced-div">直接文本</div>
      <span class="extra" id="forced-span">行内文本</span>
      <div class="extra" id="excluded"><code>危险文本</code></div>
    `;

    const elements = scanParagraphElements(document, rule, 'main-content');
    expect(elements.map((element) => element.id)).toEqual(expect.arrayContaining(['forced-div', 'forced-span']));
    expect(elements.map((element) => element.id)).not.toContain('excluded');
  });

  it.each([
    ['hidden', '<section hidden><p id="target">隐藏</p></section>'],
    ['aria-hidden', '<section aria-hidden="true"><p id="target">隐藏</p></section>'],
    ['display none', '<section style="display:none"><p id="target">隐藏</p></section>'],
    ['visibility hidden', '<section style="visibility:hidden"><p id="target">隐藏</p></section>'],
  ])('排除具有 %s 的隐藏祖先', (_, markup) => {
    document.body.innerHTML = `<main>${markup}<p id="visible">可见</p></main>`;
    const elements = scanParagraphElements(document, rule, 'main-content');

    expect(elements.map((element) => element.id)).toEqual(['visible']);
  });
});
