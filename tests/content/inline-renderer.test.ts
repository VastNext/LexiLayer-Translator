import { beforeEach, describe, expect, it } from 'vitest';

import { InlineRenderer, isUnsafeInlineElement } from '../../src/content/inline-renderer';
import { ParagraphStore } from '../../src/content/paragraph-store';

describe('InlineRenderer', () => {
  let source: HTMLElement;
  let store: ParagraphStore;
  let renderer: InlineRenderer;

  beforeEach(() => {
    document.body.innerHTML = '<main><p id="source">Hello <strong>world</strong></p></main>';
    source = document.querySelector('#source')!;
    store = new ParagraphStore();
    renderer = new InlineRenderer();
  });

  it('安全判定：受限标签、交互元素与交互子树均不安全，普通段落安全', () => {
    document.body.innerHTML = `
      <p id="safe">Plain paragraph</p>
      <img id="image" alt="x">
      <a id="link" href="/x">Link text</a>
      <button id="button">Button text</button>
      <div id="with-link">Text <a href="/y">inner link</a></div>
      <select id="select"><option>1</option></select>
      <table><tbody><tr id="row"><td>cell</td></tr></tbody></table>`;
    const byId = (id: string) => document.getElementById(id) as HTMLElement;
    expect(isUnsafeInlineElement(byId('safe'))).toBe(false);
    expect(isUnsafeInlineElement(byId('image'))).toBe(true);
    expect(isUnsafeInlineElement(byId('link'))).toBe(false);
    expect(isUnsafeInlineElement(byId('button'))).toBe(true);
    expect(isUnsafeInlineElement(byId('with-link'))).toBe(true);
    expect(isUnsafeInlineElement(byId('select'))).toBe(true);
    expect(isUnsafeInlineElement(byId('row'))).toBe(true);
    expect(renderer.isUnsafe(byId('safe'))).toBe(false);
    expect(renderer.isUnsafe(byId('with-link'))).toBe(true);
    expect(renderer.isUnsafe(byId('link'))).toBe(false);
  });

  it('安全判定补强：flex/grid 多子项、自定义元素与表单子树保守回退', () => {
    document.body.innerHTML = `
      <div id="flex-many" style="display:flex"><span>a</span><span>b</span></div>
      <div id="flex-one" style="display:flex"><span>a</span></div>
      <div id="grid-many" style="display:grid"><span>a</span><span>b</span></div>
      <div id="grid-one" style="display:grid"><span>a</span></div>
      <my-widget id="custom">Custom widget</my-widget>
      <p id="has-custom">Text <my-chip>chip</my-chip></p>
      <form id="form"><p>Form text</p></form>
      <p id="has-input"><input placeholder="x"></p>
      <fieldset id="fieldset"><legend>Legend</legend></fieldset>
      <output id="output">result</output>
      <p id="safe">Plain text</p>`;
    const byId = (id: string) => document.getElementById(id) as HTMLElement;
    // flex/grid 多子项：折叠子项会改变布局。
    expect(isUnsafeInlineElement(byId('flex-many'))).toBe(true);
    expect(isUnsafeInlineElement(byId('grid-many'))).toBe(true);
    // 单子项 flex/grid 布局保持一个子项，允许包装。
    expect(isUnsafeInlineElement(byId('flex-one'))).toBe(false);
    expect(isUnsafeInlineElement(byId('grid-one'))).toBe(false);
    // 自定义元素（自身与后代）结构未知，保守回退。
    expect(isUnsafeInlineElement(byId('custom'))).toBe(true);
    expect(isUnsafeInlineElement(byId('has-custom'))).toBe(true);
    // 表单控件子树回退。
    expect(isUnsafeInlineElement(byId('form'))).toBe(true);
    expect(isUnsafeInlineElement(byId('has-input'))).toBe(true);
    expect(isUnsafeInlineElement(byId('fieldset'))).toBe(true);
    expect(isUnsafeInlineElement(byId('output'))).toBe(true);
    expect(isUnsafeInlineElement(byId('safe'))).toBe(false);
    expect(renderer.isUnsafe(byId('flex-many'))).toBe(true);
    expect(renderer.isUnsafe(byId('has-input'))).toBe(true);
  });

  it('loading 状态先安装 source 包装，原文文本读取保持稳定（观察器不会自循环）', () => {
    const paragraph = store.getOrCreate(source);
    renderer.renderLoading(paragraph);

    const sourceWrapper = source.querySelector(':scope > [data-vast-source]');
    expect(sourceWrapper?.textContent).toBe('Hello world');
    // 关键回归断言：装载与状态追加之后 refresh 不得再递增版本，否则动态观察器会无限重翻。
    const version = paragraph.version;
    expect(store.refresh(source).version).toBe(version);
    expect(document.querySelector('[data-vast-state="loading"]')?.textContent).toBe('翻译中…');
  });

  it('error 状态同样稳定，且不改变版本计数', () => {
    const paragraph = store.getOrCreate(source);
    renderer.renderError(paragraph, '翻译失败，请重试');

    expect(store.refresh(source).version).toBe(paragraph.version);
    expect(document.querySelector('[data-vast-state="error"]')?.textContent).toContain('翻译失败');
    expect(document.querySelector('[data-vast-retry-all]')).not.toBeNull();
  });

  it('双语译文在段落内部渲染，p 宿主使用合法的块级 span 容器', () => {
    const paragraph = store.getOrCreate(source);
    const token = renderer.beginTask(paragraph);
    expect(renderer.renderTranslation(paragraph, '<img src=x onerror=alert(1)>', {
      mode: 'bilingual', placement: 'after', ...token,
    })).toBe(true);

    const wrapper = source.querySelector(':scope > [data-vast-translator]')!;
    expect(wrapper).not.toBeNull();
    // 安全渲染：HTML 按纯文本处理，绝不解析为节点。
    expect(wrapper.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(wrapper.querySelector('img')).toBeNull();
    // DOM 合法性：p 的内容模型只接受 phrasing content，容器必须是 span 且标记块级。
    expect(wrapper.tagName).toBe('SPAN');
    expect(wrapper).toHaveAttribute('data-vast-block');
    expect(source.querySelector('div')).toBeNull();
    // 不向父级容器新增子项（flex/grid 布局保持不变）。
    expect(wrapper.parentElement).toBe(source);
    expect(source.textContent).toContain('Hello world');
    expect(source.hidden).toBe(false);
  });

  it('div/li/td 宿主使用 div 容器，span 等行内宿主使用行内 span', () => {
    document.body.innerHTML = `
      <ul><li id="list-item">List text</li></ul>
      <div id="block-host">Block text</div>
      <p><span id="inline-host">Inline text</span></p>
      <h1 id="heading">Heading text</h1>`;
    const byId = (id: string) => document.getElementById(id) as HTMLElement;
    const localStore = new ParagraphStore();

    for (const [id, tag, block] of [
      ['list-item', 'DIV', false], ['block-host', 'DIV', false],
      ['inline-host', 'SPAN', false], ['heading', 'SPAN', true],
    ] as const) {
      const host = byId(id);
      const paragraph = localStore.getOrCreate(host);
      const token = renderer.beginTask(paragraph);
      renderer.renderTranslation(paragraph, '译文', { mode: 'bilingual', placement: 'after', ...token });
      const wrapper = host.querySelector(':scope > [data-vast-translator]')!;
      expect(wrapper.tagName).toBe(tag);
      expect(wrapper.hasAttribute('data-vast-block')).toBe(block);
    }
  });

  it('仅译文模式隐藏内部原文，恢复后完整还原 childNodes、事件与行内样式', () => {
    const paragraph = store.getOrCreate(source);
    const strong = source.querySelector('strong')!;
    strong.style.color = 'rgb(255, 0, 0)';
    let clicks = 0;
    strong.addEventListener('click', () => { clicks += 1; });
    const originalHtml = source.innerHTML;
    const token = renderer.beginTask(paragraph);

    renderer.renderTranslation(paragraph, '你好，世界', { mode: 'translation-only', placement: 'after', ...token });
    expect(source.querySelector(':scope > [data-vast-source]')).toHaveProperty('hidden', true);
    expect(source.hidden).toBe(false);

    renderer.restore(paragraph);
    expect(source.innerHTML).toBe(originalHtml);
    expect(source.querySelector('[data-vast-translator]')).toBeNull();
    expect(source.querySelector('[data-vast-source]')).toBeNull();
    expect(source.hasAttribute('data-vast-inline')).toBe(false);
    // 移动而非克隆：行内样式与事件监听器全部保留。
    expect((source.querySelector('strong') as HTMLElement).style.color).toBe('rgb(255, 0, 0)');
    source.querySelector('strong')!.click();
    expect(clicks).toBe(1);
    expect(paragraph.wrapper).toBeUndefined();
    expect(paragraph.sourceWrapper).toBeUndefined();
  });

  it('恢复时还原段落自身的 hidden 初始状态', () => {
    document.body.innerHTML = '<main><p id="originally-hidden" hidden>Secret</p><p id="visible">Visible</p></main>';
    const hiddenParagraph = store.getOrCreate(document.querySelector('#originally-hidden') as HTMLElement);
    const visibleParagraph = store.getOrCreate(document.querySelector('#visible') as HTMLElement);
    renderer.renderLoading(hiddenParagraph);
    renderer.renderLoading(visibleParagraph);
    renderer.restore(hiddenParagraph);
    renderer.restore(visibleParagraph);
    expect((document.querySelector('#originally-hidden') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('#visible') as HTMLElement).hidden).toBe(false);
  });

  it('译文位置支持 before，原文在前译文在后顺序正确', () => {
    const paragraph = store.getOrCreate(source);
    const token = renderer.beginTask(paragraph);
    renderer.renderTranslation(paragraph, '译文', { mode: 'bilingual', placement: 'before', ...token });
    expect(source.firstElementChild).toBe(source.querySelector('[data-vast-translator]'));
    expect(source.lastElementChild?.hasAttribute('data-vast-source')).toBe(true);
  });

  it('源文本变化后丢弃迟到结果，不改变当前 DOM', () => {
    const paragraph = store.getOrCreate(source);
    const token = renderer.beginTask(paragraph);
    renderer.renderTranslation(paragraph, '旧译文', { mode: 'bilingual', placement: 'after', ...token });
    const staleVersion = token.expectedVersion;

    // 页面局部更新原文（inline 译文容器与其并存，不受影响）。
    (source.querySelector('strong') as HTMLElement).textContent = 'Changed';
    store.refresh(source);
    expect(paragraph.version).toBe(staleVersion + 1);

    expect(renderer.renderTranslation(paragraph, '迟到的译文', {
      mode: 'bilingual', placement: 'after', expectedVersion: staleVersion, taskId: token.taskId,
    })).toBe(false);
    expect(document.querySelector('[data-vast-translator]')?.textContent).toBe('旧译文');
  });

  it('新任务开始后旧任务的迟到结果不得覆盖新译文', () => {
    const paragraph = store.getOrCreate(source);
    const oldToken = renderer.beginTask(paragraph);
    const newToken = renderer.beginTask(paragraph);
    expect(renderer.renderTranslation(paragraph, '新译文', { mode: 'bilingual', placement: 'after', ...newToken })).toBe(true);
    expect(renderer.renderTranslation(paragraph, '旧译文', { mode: 'bilingual', placement: 'after', ...oldToken })).toBe(false);
    expect(document.querySelector('[data-vast-state="translated"]')?.textContent).toBe('新译文');
  });

  it('元素脱离文档后拒绝渲染', () => {
    const paragraph = store.getOrCreate(source);
    const token = renderer.beginTask(paragraph);
    source.remove();
    expect(renderer.renderTranslation(paragraph, '译文', { mode: 'bilingual', placement: 'after', ...token })).toBe(false);
    expect(document.querySelector('[data-vast-translator]')).toBeNull();
  });

  it('loading → error → translated 状态链安全收敛，最终恢复干净', () => {
    const paragraph = store.getOrCreate(source);
    const token = renderer.beginTask(paragraph);
    renderer.renderLoading(paragraph);
    renderer.renderError(paragraph, '翻译失败');
    expect(renderer.renderTranslation(paragraph, '译文', { mode: 'bilingual', placement: 'after', ...token })).toBe(true);
    expect(source.querySelectorAll('[data-vast-translator]')).toHaveLength(1);
    expect(source.querySelector('[data-vast-state="translated"]')?.textContent).toBe('译文');
    expect(source.querySelector('[data-vast-state="error"]')).toBeNull();

    renderer.restore(paragraph);
    expect(source.innerHTML).toBe('Hello <strong>world</strong>');
  });

  it('ensureSourceWrapper 跳过已是插件节点的子节点，重复调用返回同一包装', () => {
    const paragraph = store.getOrCreate(source);
    renderer.renderLoading(paragraph);
    const first = paragraph.sourceWrapper!;
    // 再次渲染（状态更新）不得重复包裹原文。
    renderer.renderError(paragraph, '失败');
    expect(paragraph.sourceWrapper).toBe(first);
    expect(source.querySelectorAll('[data-vast-source]')).toHaveLength(1);
    expect(first.textContent).toBe('Hello world');
  });

  it('已渲染宿主被页面追加节点后 refresh 检测变化，重渲染包含追加内容且恢复干净', () => {
    const paragraph = store.getOrCreate(source);
    const token = renderer.beginTask(paragraph);
    renderer.renderTranslation(paragraph, '译文', { mode: 'bilingual', placement: 'after', ...token });
    expect(source.querySelectorAll('[data-vast-translator]')).toHaveLength(1);

    // 页面在已渲染宿主上追加文本节点（动态内容加载），游离子节点必须计入原文。
    source.append(' appended');
    const refreshed = store.refresh(source);
    expect(refreshed.version).toBe(token.expectedVersion + 1);

    // 控制器 invalidate 流程：restore 解包 → 重新 loading 包裹 → 重新翻译。
    renderer.restore(paragraph);
    const newToken = renderer.beginTask(paragraph);
    renderer.renderLoading(paragraph);
    expect(source.querySelector(':scope > [data-vast-source]')?.textContent).toContain('appended');
    renderer.renderTranslation(paragraph, '原文追加译文', { mode: 'bilingual', placement: 'after', ...newToken });
    expect(source.querySelector(':scope > [data-vast-translator]')?.textContent).toBe('原文追加译文');

    // 恢复完整还原：追加节点与原文一起放回，无插件节点残留。
    renderer.restore(paragraph);
    expect(source.textContent).toBe('Hello world appended');
    expect(source.querySelector('[data-vast-translator]')).toBeNull();
    expect(source.querySelector('[data-vast-source]')).toBeNull();
    expect(source.hasAttribute('data-vast-inline')).toBe(false);
  });

  it('单链接标题下钻：h2>span>a>span Releases 在原 a 内部安全渲染，h2/a 节点与监听器不换不隐藏', () => {
    document.body.innerHTML = `
      <h2 id="release-h2" class="heading-class" style="font-size: 20px;">
        <span class="wrapper-span">
          <a id="release-link" href="/tt-a1i/hive/releases" class="link-class">
            <span id="release-title" class="title-class">Releases</span>
          </a>
        </span>
      </h2>`;
    const h2 = document.getElementById('release-h2') as HTMLElement;
    const link = document.getElementById('release-link') as HTMLAnchorElement;
    const titleSpan = document.getElementById('release-title') as HTMLElement;
    let linkClicked = false;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      linkClicked = true;
    });

    // 安全判定：单链接且所有可翻译文本在链接内时，可作为安全内联元素
    expect(isUnsafeInlineElement(h2)).toBe(false);
    expect(renderer.isUnsafe(h2)).toBe(false);

    const paragraph = store.getOrCreate(h2);
    const token = renderer.beginTask(paragraph);
    renderer.renderLoading(paragraph);

    // loading 状态在 a 内部渲染，不隐藏 h2，h2 外部无相邻 wrapper
    expect(h2.hidden).toBe(false);
    expect(h2.parentElement?.querySelector(':scope > [data-vast-translator]')).toBeNull();
    expect(link.querySelector('[data-vast-state="loading"]')).not.toBeNull();

    // 渲染双语译文（after 模式）
    expect(renderer.renderTranslation(paragraph, '发布版本', {
      mode: 'bilingual',
      placement: 'after',
      ...token,
    })).toBe(true);

    // 译文留原 a 内，h2 不 hidden，无外部相邻译文
    expect(h2.hidden).toBe(false);
    expect(h2.classList.contains('heading-class')).toBe(true);
    expect(h2.style.fontSize).toBe('20px');
    expect(link.classList.contains('link-class')).toBe(true);
    expect(link.getAttribute('href')).toBe('/tt-a1i/hive/releases');
    expect(titleSpan.classList.contains('title-class')).toBe(true);

    const translationWrapper = link.querySelector('[data-vast-translator]') as HTMLElement;
    expect(translationWrapper).not.toBeNull();
    expect(translationWrapper.textContent).toBe('发布版本');
    expect(translationWrapper.closest('a')).toBe(link);
    expect(h2.querySelector(':scope > [data-vast-translator]')).toBeNull();

    // 点击事件通过 a 正常触发
    translationWrapper.click();
    expect(linkClicked).toBe(true);

    // 动态观察器刷新时不自循环
    const version = paragraph.version;
    expect(store.refresh(h2).version).toBe(version);

    // 仅译文模式（translation-only）：原文隐藏但 a 与 h2 保持可见且可点击
    renderer.renderTranslation(paragraph, '仅译文发布', {
      mode: 'translation-only',
      placement: 'after',
      ...token,
    });
    expect(h2.hidden).toBe(false);
    expect(link.hidden).toBe(false);
    expect(link.querySelector('[data-vast-source]')).toHaveProperty('hidden', true);
    expect(link.querySelector('[data-vast-translator]')?.textContent).toBe('仅译文发布');

    // 译文 before 模式
    renderer.renderTranslation(paragraph, '前置发布', {
      mode: 'bilingual',
      placement: 'before',
      ...token,
    });
    const sourceWrapper = link.querySelector('[data-vast-source]') as HTMLElement;
    const currentWrapper = link.querySelector('[data-vast-translator]') as HTMLElement;
    expect(currentWrapper.textContent).toBe('前置发布');
    expect(currentWrapper.compareDocumentPosition(sourceWrapper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 恢复测试：完整还原所有节点、class、style 与事件监听器
    renderer.restore(paragraph);
    expect(h2.querySelector('[data-vast-translator]')).toBeNull();
    expect(h2.querySelector('[data-vast-source]')).toBeNull();
    expect(h2.hidden).toBe(false);
    expect(link.getAttribute('href')).toBe('/tt-a1i/hive/releases');
    expect(h2.textContent?.trim()).toBe('Releases');

    linkClicked = false;
    titleSpan.click();
    expect(linkClicked).toBe(true);
  });

  it('单链接+Badge/SVG/aria-hidden 辅助文本排除：不混进译文且下钻成功', () => {
    document.body.innerHTML = `
      <h2 id="gh-heading" class="d-flex flex-items-center">
        <span class="mr-2">
          <a id="badge-link" href="/releases">
            <span class="text-bold">Releases</span>
          </a>
          <span class="Counter" aria-hidden="true">12</span>
          <svg aria-hidden="true" class="octicon"><path d="M1 1"></path></svg>
          <span class="sr-only">12 releases</span>
        </span>
      </h2>`;
    const h2 = document.getElementById('gh-heading') as HTMLElement;
    const link = document.getElementById('badge-link') as HTMLAnchorElement;

    expect(isUnsafeInlineElement(h2)).toBe(false);
    const paragraph = store.getOrCreate(h2);
    const token = renderer.beginTask(paragraph);

    expect(renderer.renderTranslation(paragraph, '发布列表', {
      mode: 'bilingual',
      placement: 'after',
      ...token,
    })).toBe(true);

    // 译文只在 a 内，Counter 与 svg 保持原样在 a 外部
    expect(link.querySelector('[data-vast-translator]')?.textContent).toBe('发布列表');
    const counter = h2.querySelector('.Counter') as HTMLElement;
    expect(counter.textContent).toBe('12');
    expect(counter.closest('[data-vast-translator]')).toBeNull();
    expect(h2.querySelector('.sr-only')?.textContent).toBe('12 releases');

    renderer.restore(paragraph);
    expect(h2.querySelector('.Counter')?.textContent).toBe('12');
    expect(h2.querySelector('[data-vast-translator]')).toBeNull();
  });

  it('混合复合句子链接（非单链接正文）保守回退 legacy，不扩大为富文本', () => {
    document.body.innerHTML = `
      <p id="mixed-sentence">Please check the <a href="/docs">documentation</a> for details.</p>
      <h2 id="multi-links"><a href="/1">Part 1</a> and <a href="/2">Part 2</a></h2>
      <h2 id="with-input"><a href="/x">Title</a> <input type="text"></h2>
      <h2 id="with-custom"><a href="/x">Title</a> <my-component>badge</my-component></h2>
    `;
    const byId = (id: string) => document.getElementById(id) as HTMLElement;
    expect(isUnsafeInlineElement(byId('mixed-sentence'))).toBe(true);
    expect(isUnsafeInlineElement(byId('multi-links'))).toBe(true);
    expect(isUnsafeInlineElement(byId('with-input'))).toBe(true);
    expect(isUnsafeInlineElement(byId('with-custom'))).toBe(true);
  });

  it('手风琴折叠按钮文本容器 span(display:flex) 内部安全挂载，保持 button/aria/事件且 svg 不隐藏', () => {
    document.body.innerHTML = `
      <h3 id="europe-h3">
        <button id="europe-btn" aria-controls="europe-region" aria-expanded="false">
          <span id="europe-label" style="display:flex">
            <span id="europe-text" data-vast-text-leaf>Europe</span>
            <span class="icon"><svg><path d="M0 0" /></svg></span>
          </span>
        </button>
      </h3>
      <div id="europe-region" role="region" inert style="height:0">
        <label><input type="checkbox" name="city" value="paris"> <span data-vast-text-leaf>Paris</span></label>
      </div>`;

    const h3 = document.getElementById('europe-h3') as HTMLElement;
    const button = document.getElementById('europe-btn') as HTMLButtonElement;
    const textLeaf = document.getElementById('europe-text') as HTMLElement;
    const labelSpan = document.getElementById('europe-label') as HTMLElement;
    const region = document.getElementById('europe-region') as HTMLElement;

    let buttonClicks = 0;
    button.addEventListener('click', () => {
      buttonClicks += 1;
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      if (!expanded) {
        region.removeAttribute('inert');
        region.style.height = 'auto';
      } else {
        region.setAttribute('inert', '');
        region.style.height = '0';
      }
    });

    // 安全判定：文本叶为安全容器
    expect(isUnsafeInlineElement(textLeaf)).toBe(false);
    expect(renderer.isUnsafe(textLeaf)).toBe(false);

    const paragraph = store.getOrCreate(textLeaf);
    const token = renderer.beginTask(paragraph);

    // 1. Loading 状态渲染
    renderer.renderLoading(paragraph);
    expect(h3.hidden).toBe(false);
    expect(button.hidden).toBe(false);
    expect(textLeaf.querySelector('[data-vast-state="loading"]')).not.toBeNull();
    // 兄弟折叠区不应该出现任何插件节点
    expect(region.querySelector('[data-vast-translator]')).toBeNull();

    // 2. 双语翻译渲染
    expect(renderer.renderTranslation(paragraph, '欧洲', {
      mode: 'bilingual',
      placement: 'after',
      ...token,
    })).toBe(true);

    // h3/button 未被隐藏，svg 图标保留
    expect(h3.hidden).toBe(false);
    expect(button.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(labelSpan.querySelector('svg')).not.toBeNull();

    const translation = textLeaf.querySelector('[data-vast-translator]') as HTMLElement;
    expect(translation).not.toBeNull();
    expect(translation.textContent).toBe('欧洲');

    // 3. 点击译文正常冒泡触发 button click 事件，改变 aria-expanded 并展开折叠区
    translation.click();
    expect(buttonClicks).toBe(1);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(region.hasAttribute('inert')).toBe(false);

    // 再次点击折叠
    translation.click();
    expect(buttonClicks).toBe(2);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(region.hasAttribute('inert')).toBe(true);

    // 4. 仅译文模式：原文隐藏，但同级 svg 必须保持可见！
    renderer.renderTranslation(paragraph, '欧洲仅译文', {
      mode: 'translation-only',
      placement: 'after',
      ...token,
    });
    expect(h3.hidden).toBe(false);
    expect(button.hidden).toBe(false);
    expect(textLeaf.querySelector('[data-vast-source]')).toHaveProperty('hidden', true);
    expect(textLeaf.querySelector('[data-vast-translator]')?.textContent).toBe('欧洲仅译文');
    expect(labelSpan.querySelector('svg')).not.toBeNull();
    expect(labelSpan.querySelector('svg')?.closest('[data-vast-source]')).toBeNull();
    expect(labelSpan.querySelector('.icon')?.closest('[data-vast-source]')).toBeNull();

    // 5. 恢复原文
    renderer.restore(paragraph);
    expect(textLeaf.querySelector('[data-vast-translator]')).toBeNull();
    expect(textLeaf.querySelector('[data-vast-source]')).toBeNull();
    expect(textLeaf.textContent?.trim()).toBe('Europe');
    expect(h3.hidden).toBe(false);
    expect(button.hidden).toBe(false);

    // 恢复后按钮事件仍有效
    button.click();
    expect(buttonClicks).toBe(3);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});
