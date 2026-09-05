import { beforeEach, describe, expect, it } from 'vitest';

import { scanParagraphElements, type ScanMetrics } from '../../src/content/dom-scanner';
import type { SiteRule } from '../../src/rules/types';
import { rule as githubRule } from '../../src/rules/sites/github';
import { rule as googleSearchRule } from '../../src/rules/sites/google-search';
import { rule as redditRule } from '../../src/rules/sites/reddit';
import { rule as bingSearchRule } from '../../src/rules/sites/bing-search';
import { rule as stackoverflowRule } from '../../src/rules/sites/stackoverflow';
import { rule as substackRule } from '../../src/rules/sites/substack';
import { rule as xRule } from '../../src/rules/sites/x';
import { rule as youtubeRule } from '../../src/rules/sites/youtube';

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

  it('页脚列表中的直接文本链接作为链接元素候选返回', () => {
    document.body.innerHTML = '<footer><ul><li><a id="home" href="/">Home</a></li><li><a id="category" href="/category">Category</a></li></ul></footer>';
    const elements = scanParagraphElements(document, rule, 'whole-page');

    expect(elements.map((element) => element.id)).toEqual(['home', 'category']);
    expect(elements.every((element) => element.tagName === 'A')).toBe(true);
  });

  it('排除 sr-only 与 visually-hidden 辅助文本，避免隐藏文案变为可见译文', () => {
    document.body.innerHTML = '<main><button><svg></svg><span class="sr-only">Toggle theme</span></button><a href="/"><span class="visually-hidden">Home accessibility label</span><span id="visible">Home</span></a></main>';
    const elements = scanParagraphElements(document, rule, 'whole-page');

    expect(elements.map((element) => element.textContent?.trim())).toEqual(['Home']);
    expect(elements[0].id).toBe('visible');
  });

  it('排除屏幕阅读器标题和时间元数据，避免隐藏辅助文案生成可见译文', () => {
    document.body.innerHTML = `<main>
      <h2 data-testid="screen-reader-heading">Latest commit</h2>
      <h2 class="prc-src-InternalVisuallyHidden-abc">Repository files navigation</h2>
      <relative-time>Sep 5, 2026</relative-time>
      <p id="visible">可见正文</p>
    </main>`;

    const elements = scanParagraphElements(document, githubRule, 'main-content');

    expect(elements.map((element) => element.id)).toEqual(['visible']);
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

  it('GitHub 数据表格不作为正文候选，但 README 普通段落仍可翻译', () => {
    document.body.innerHTML = `
      <main>
        <div class="js-navigation-container"><table><tbody><tr><td id="file">README.md</td></tr></tbody></table></div>
        <div id="readme"><p id="readme-text">README 正文</p></div>
      </main>`;

    const elements = scanParagraphElements(document, githubRule, 'main-content');

    expect(elements.map((element) => element.id)).toEqual(['readme-text']);
  });

  it('Google Trends 数据展示表格不进入翻译候选', () => {
    document.body.innerHTML = `
      <main>
        <section class="trends-data"><table><tbody><tr><td id="metric">搜索热度</td></tr></tbody></table></section>
        <p id="summary">趋势摘要</p>
      </main>`;

    const elements = scanParagraphElements(document, googleSearchRule, 'main-content');

    expect(elements.map((element) => element.id)).toEqual(['summary']);
  });

  it('GitHub 仓库名、文件导航和图标不翻译，但 README 正文保留', () => {
    document.body.innerHTML = `
      <main>
        <div class="js-repo-nav"><a id="owner">owner</a><strong id="repo">sample-repo</strong></div>
        <aside class="Layout-sidebar">
          <a id="readme-nav"><svg aria-hidden="true"><path /></svg><span>存储库文件导航</span></a>
        </aside>
        <div class="js-navigation-container"><table><tbody><tr><td id="file">README.md</td></tr></tbody></table></div>
        <div id="readme"><h1 id="readme-title">Beginner Racing &amp; Controls</h1><p id="readme-text">Keyboard and controller setups.</p></div>
      </main>`;

    const elements = scanParagraphElements(document, githubRule, 'main-content');
    const ids = elements.map((element) => element.id);

    expect(ids).toEqual(['readme-title', 'readme-text']);
    expect(ids).not.toEqual(expect.arrayContaining(['owner', 'repo', 'readme-nav', 'file']));
  });

  it('GitHub Issue 元信息、评论操作区和代码行不翻译，Markdown 正文保留', () => {
    document.body.innerHTML = `
      <main>
        <article>
          <h1 id="issue-title">Fix translation issue</h1>
          <div class="vcard-names-container"><a id="author">author</a></div>
          <div class="timeline-comment-header"><span id="comment-meta">comment metadata</span></div>
          <div class="markdown-body"><p id="issue-body">This is the issue body.</p><pre><code id="code">const value = 1</code></pre></div>
          <div class="review-thread-reply"><button id="reply">Reply</button></div>
        </article>
      </main>`;

    const elements = scanParagraphElements(document, githubRule, 'main-content');
    const ids = elements.map((element) => element.id);

    expect(ids).toEqual(['issue-title', 'issue-body']);
    expect(ids).not.toEqual(expect.arrayContaining(['author', 'comment-meta', 'code', 'reply']));
  });

  it('GitHub Repository files 标题和 Latest commit 模块不翻译，README 正文保留', () => {
    document.body.innerHTML = `<main>
      <div itemscope itemtype="https://schema.org/abstract">
        <h2 id="repo-files-heading">Repository files navigation</h2>
        <nav aria-label="Repository files"><span>README</span><span>Contributing</span></nav>
        <div data-testid="latest-commit">
          <h2 data-testid="screen-reader-heading">Latest commit</h2>
          <div data-testid="author-avatar"><a>sunsunsun-java</a></div>
          <span data-testid="latest-commit-html">Merge pull request #299</span>
          <relative-time>Sep 5, 2026</relative-time>
          <div data-testid="latest-commit-details"><span>219 Commits</span></div>
        </div>
        <div id="readme"><h1 id="readme-heading">Archify</h1><p id="readme-copy">README body</p></div>
      </div>
    </main>`;

    const ids = scanParagraphElements(document, githubRule, 'main-content').map((element) => element.id);

    expect(ids).toEqual(['readme-heading', 'readme-copy']);
    expect(ids).not.toContain('repo-files-heading');
  });

  it('GitHub 新版 Repository files 父容器中的导航标题和语言切换不翻译', () => {
    document.body.innerHTML = `<main>
      <div itemscope itemtype="https://schema.org/abstract" class="OverviewRepoFiles-module__Box_3__bBU1C">
        <h2 id="files-heading">Repository files navigation</h2>
        <nav aria-label="Repository files"><ul><li><a><span data-component="text">README</span></a></li></ul></nav>
        <p align="center" id="language-switch"><strong>English</strong> · <a href="/repo/blob/main/README_ZH.md">简体中文</a></p>
        <div class="markdown-body"><p id="readme-body">This is the README body.</p></div>
      </div>
    </main>`;

    const ids = scanParagraphElements(document, githubRule, 'main-content').map((element) => element.id);

    expect(ids).toEqual(['readme-body']);
    expect(ids).not.toEqual(expect.arrayContaining(['files-heading', 'language-switch']));
  });

  it('Reddit 帖子和评论可翻译，但投票、操作区和侧栏不翻译', () => {
    document.body.innerHTML = `
      <main>
        <article id="post">
          <h1 id="post-title">A useful title</h1>
          <p id="post-body">Post body</p>
          <button id="vote">Upvote</button>
          <button id="share">Share</button>
          <div data-testid="comment"><p id="comment-body">Comment body</p><button id="reply">Reply</button></div>
        </article>
        <aside><p id="sidebar">Recommended communities</p></aside>
      </main>`;

    const elements = scanParagraphElements(document, redditRule, 'main-content');
    const ids = elements.map((element) => element.id);

    expect(ids).toEqual(['post-title', 'post-body', 'comment-body']);
    expect(ids).not.toEqual(expect.arrayContaining(['vote', 'share', 'reply', 'sidebar']));
  });

  it('Reddit Shreddit 帖子和评论正文可翻译，操作区不翻译', () => {
    document.body.innerHTML = `
      <main>
        <shreddit-post><h1 id="shreddit-title">Post title</h1><div><p id="shreddit-body">Post body</p></div><div data-testid="post-action-row"><button>Share</button></div></shreddit-post>
        <shreddit-comment><p id="shreddit-comment-body">Comment body</p><div data-testid="comment-action-row"><button>Reply</button></div></shreddit-comment>
      </main>`;

    const elements = scanParagraphElements(document, redditRule, 'main-content');
    const ids = elements.map((element) => element.id);

    expect(ids).toEqual(['shreddit-title', 'shreddit-body', 'shreddit-comment-body']);
  });

  it('Google 搜索的广告、工具栏和分页不翻译，搜索结果正文保留', () => {
    document.body.innerHTML = `
      <main>
        <div id="search">
          <form><input aria-label="Search"><button id="search-button">Search</button></form>
          <div id="tads"><p id="ad">Sponsored result</p></div>
          <div class="MjjYud"><h3 id="result-title">Useful result</h3><p id="result-snippet">Result snippet</p></div>
          <div role="navigation"><a id="page">Next</a></div>
        </div>
      </main>`;

    const elements = scanParagraphElements(document, googleSearchRule, 'main-content');
    const ids = elements.map((element) => element.id);

    expect(ids).toEqual(['result-title', 'result-snippet']);
    expect(ids).not.toEqual(expect.arrayContaining(['ad', 'search-button', 'page']));
  });

  it('Bing 搜索保留结果正文，排除侧栏、广告、统计和分页', () => {
    document.body.innerHTML = `<main>
      <div id="b_tween"><span id="stats">12 results</span></div>
      <ol id="b_results"><li><h2 id="bing-title">Useful result</h2><p id="bing-copy">Result summary</p></li></ol>
      <aside id="b_context"><p id="bing-side">Related information</p></aside>
      <div id="b_pag"><a id="bing-next">Next</a></div>
    </main>`;

    const ids = scanParagraphElements(document, bingSearchRule, 'main-content').map((element) => element.id);

    expect(ids).toEqual(['bing-title', 'bing-copy']);
  });

  it('YouTube 保留标题、描述和评论正文，排除播放器、作者元数据与操作区', () => {
    document.body.innerHTML = `<main><div id="primary">
      <div id="movie_player"><p id="player-label">Play</p></div>
      <h1 id="youtube-title">Video title</h1>
      <div id="owner"><p id="channel">Channel name</p></div>
      <div id="description"><p id="youtube-description">Video description</p></div>
      <div id="actions"><button>Like</button><span id="likes">123 likes</span></div>
      <div id="comments"><ytd-comment-thread-renderer><p id="youtube-comment">Helpful comment</p><div id="toolbar"><button>Reply</button></div></ytd-comment-thread-renderer></div>
    </div></main>`;

    const ids = scanParagraphElements(document, youtubeRule, 'main-content').map((element) => element.id);

    expect(ids).toEqual(['youtube-title', 'youtube-description', 'youtube-comment']);
  });

  it('X 保留推文正文，排除用户元信息、统计和操作按钮', () => {
    document.body.innerHTML = `<main><article>
      <div data-testid="User-Name"><span id="x-user">User Name</span></div>
      <div data-testid="tweetText"><p id="tweet-copy">Tweet body</p></div>
      <time id="tweet-time">10:30</time>
      <div role="group"><button data-testid="reply">Reply</button><span id="tweet-stats">10 likes</span></div>
    </article></main>`;

    const ids = scanParagraphElements(document, xRule, 'main-content').map((element) => element.id);

    expect(ids).toEqual(['tweet-copy']);
  });

  it('Stack Overflow 保留问题、答案和评论正文，排除投票、作者与操作区', () => {
    document.body.innerHTML = `<main id="content"><div id="mainbar">
      <h1 id="so-title">How does this work?</h1>
      <div class="question"><div class="js-voting-container"><button>Up vote</button></div><div class="s-prose"><p id="question-copy">Question body</p><pre><code>const x = 1</code></pre></div><div class="post-signature"><span id="question-author">Author</span></div></div>
      <div class="answer"><div class="s-prose"><p id="answer-copy">Answer body</p></div><div class="js-post-menu"><a>Share</a></div></div>
      <span class="comment-copy" id="comment-copy">Useful comment</span>
    </div></main>`;

    const ids = scanParagraphElements(document, stackoverflowRule, 'main-content').map((element) => element.id);

    expect(ids).toEqual(['so-title', 'question-copy', 'answer-copy', 'comment-copy']);
  });

  it('Substack 保留文章和评论正文，排除订阅、分享与作者元信息', () => {
    document.body.innerHTML = `<main><article>
      <header><h1 id="substack-title">Article title</h1><div class="post-meta"><p id="substack-author">Author · 5 min read</p></div></header>
      <div class="body markup"><p id="substack-copy">Article body</p></div>
      <div class="subscribe-widget"><p id="subscribe">Subscribe now</p></div>
      <div class="post-actions"><button>Share</button></div>
      <div class="comment-body"><p id="substack-comment">Reader comment</p></div>
    </article></main>`;

    const ids = scanParagraphElements(document, substackRule, 'main-content').map((element) => element.id);

    expect(ids).toEqual(['substack-title', 'substack-copy', 'substack-comment']);
  });

  it('1000 个候选仅沿祖先链去重，不做候选两两 contains 比较', { timeout: 15_000 }, () => {
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
