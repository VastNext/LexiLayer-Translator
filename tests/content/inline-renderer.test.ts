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

  it('挂载后内部被深克隆/替换导致缓存 sourceWrapper 脱离：renderTranslation 重新校验并拒绝或更新挂载，不向脱离节点渲染', () => {
    const paragraph = store.getOrCreate(source);
    const token = renderer.beginTask(paragraph);
    renderer.renderLoading(paragraph);

    const initialSourceWrapper = paragraph.sourceWrapper!;
    expect(initialSourceWrapper.isConnected).toBe(true);

    // 模拟页面框架（如 React/Vue）对 source 内部进行深克隆重置
    const clonedChildren = Array.from(source.childNodes).map((node) => node.cloneNode(true));
    source.replaceChildren(...clonedChildren);

    // 此时旧的 sourceWrapper 已经脱离 DOM
    expect(initialSourceWrapper.isConnected).toBe(false);

    // 渲染翻译结果：旧 sourceWrapper 脱离，renderTranslation 严格拒绝旧结果
    const accepted = renderer.renderTranslation(paragraph, '你好世界', {
      mode: 'bilingual',
      placement: 'after',
      ...token,
    });

    expect(accepted).toBe(false);
  });

  it('深克隆产生多余无主 [data-vast-source] 和 [data-vast-translator] 时，restore 安全解包还原并保留当前节点身份与事件', () => {
    document.body.innerHTML = '<main><h2 id="heading"><span class="title">Title</span></h2></main>';
    const heading = document.getElementById('heading') as HTMLElement;

    const paragraph = store.getOrCreate(heading);
    renderer.renderLoading(paragraph);

    // 模拟框架 deepclone 并替换
    const cloned = heading.cloneNode(true) as HTMLElement;
    heading.replaceWith(cloned);
    const newParagraph = store.getOrCreate(cloned);

    // 在当前克隆真实节点上绑定事件（模拟业务框架重渲染或组件挂载）
    const clonedTitle = cloned.querySelector('.title') as HTMLElement;
    let clicked = false;
    clonedTitle.addEventListener('click', () => { clicked = true; });

    renderer.restore(newParagraph);

    // 关键断言：无损解包后，保留了当前节点的真实 DOM 身份与事件监听器
    expect(cloned.querySelector('.title')).toBe(clonedTitle);
    clonedTitle.click();
    expect(clicked).toBe(true);

    expect(cloned.querySelector('[data-vast-translator]')).toBeNull();
    expect(cloned.querySelector('[data-vast-source]')).toBeNull();
    expect(cloned.hasAttribute('data-vast-inline')).toBe(false);
  });

  it('外层宿主仍连接但内部下钻 target/source 脱离时，迟到结果严格拒绝（返回 false）', () => {
    document.body.innerHTML = `
      <main>
        <h2 id="h2-host">
          <a id="link-target" href="/doc">
            <span id="text-leaf">Documentation</span>
          </a>
        </h2>
      </main>`;
    const h2 = document.getElementById('h2-host') as HTMLElement;
    const link = document.getElementById('link-target') as HTMLElement;
    const paragraph = store.getOrCreate(h2);
    const token = renderer.beginTask(paragraph);
    renderer.renderLoading(paragraph);

    expect(paragraph.targetElement).toBe(document.getElementById('text-leaf'));

    // 外层 h2 仍连在 DOM 中，但内部的链接被页面替换/破坏成不安全结构（例如变成多链接）
    link.replaceWith(
      Object.assign(document.createElement('a'), { href: '/1', textContent: 'Doc 1' }),
      ' and ',
      Object.assign(document.createElement('a'), { href: '/2', textContent: 'Doc 2' }),
    );
    expect(h2.isConnected).toBe(true);

    // 迟到请求到达：内部 target 脱离且宿主已不安全，renderTranslation 必须拒绝返回 false
    const accepted = renderer.renderTranslation(paragraph, '文档', {
      mode: 'bilingual',
      placement: 'after',
      ...token,
    });
    expect(accepted).toBe(false);
  });

  it('仅译文模式下发生 deepclone：restore 安全清除克隆 hidden 属性，当前节点完全可见且解包保留身份与事件', () => {
    document.body.innerHTML = '<main><p id="p-host"><span class="label">Clickable</span></p></main>';
    const p = document.getElementById('p-host') as HTMLElement;

    const paragraph = store.getOrCreate(p);
    const token = renderer.beginTask(paragraph);
    renderer.renderTranslation(paragraph, '可点击', {
      mode: 'translation-only',
      placement: 'after',
      ...token,
    });

    // 验证在仅译文模式下，原始 source 确实被 hidden
    expect(p.querySelector('[data-vast-source]')).toHaveProperty('hidden', true);

    // 模拟框架 deepclone
    const cloned = p.cloneNode(true) as HTMLElement;
    p.replaceWith(cloned);
    const clonedParagraph = store.getOrCreate(cloned);

    // 在当前克隆节点上注册监听器
    const clonedLabel = cloned.querySelector('.label') as HTMLElement;
    let clickCount = 0;
    clonedLabel.addEventListener('click', () => { clickCount += 1; });

    // restore 克隆节点
    renderer.restore(clonedParagraph);

    // 关键断言：克隆出来的 hidden 状态必须被彻底清理，解包保留当前节点身份与事件
    expect(cloned.querySelector('[data-vast-translator]')).toBeNull();
    expect(cloned.querySelector('[data-vast-source]')).toBeNull();
    expect(cloned.hidden).toBe(false);
    expect(cloned.textContent).toBe('Clickable');

    expect(cloned.querySelector('.label')).toBe(clonedLabel);
    clonedLabel.click();
    expect(clickCount).toBe(1);
  });

  it('error 状态下发生 deepclone：restore 安全移除克隆的重试按钮与 error 容器', () => {
    document.body.innerHTML = '<main><h3 id="h3-err">Error Text</h3></main>';
    const h3 = document.getElementById('h3-err') as HTMLElement;
    const paragraph = store.getOrCreate(h3);
    renderer.renderError(paragraph, '翻译失败');

    expect(h3.querySelector('[data-vast-retry-all]')).not.toBeNull();

    // 模拟 deepclone
    const cloned = h3.cloneNode(true) as HTMLElement;
    h3.replaceWith(cloned);
    const clonedParagraph = store.getOrCreate(cloned);

    renderer.restore(clonedParagraph);

    expect(cloned.querySelector('[data-vast-retry-all]')).toBeNull();
    expect(cloned.querySelector('[data-vast-translator]')).toBeNull();
    expect(cloned.textContent).toBe('Error Text');
  });

  it('source 内嵌真实 p 与 phrasing 块级结构：deepclone 还原完整保留语义 p 标签与解包节点身份事件', () => {
    document.body.innerHTML = `
      <main>
        <div id="div-host">
          <p id="inner-p" class="content">Paragraph in div <strong id="inner-strong">bold</strong></p>
        </div>
      </main>`;
    const div = document.getElementById('div-host') as HTMLElement;

    const paragraph = store.getOrCreate(div);
    const token = renderer.beginTask(paragraph);
    renderer.renderTranslation(paragraph, 'div 中的段落', {
      mode: 'bilingual',
      placement: 'after',
      ...token,
    });

    // 模拟 deepclone
    const cloned = div.cloneNode(true) as HTMLElement;
    div.replaceWith(cloned);
    const clonedParagraph = store.getOrCreate(cloned);

    // 在当前克隆节点上注册监听器
    const clonedStrong = cloned.querySelector('#inner-strong') as HTMLElement;
    let strongClicked = false;
    clonedStrong.addEventListener('click', () => { strongClicked = true; });

    renderer.restore(clonedParagraph);

    // 验证：语义 p 标签完好无损，strong 节点身份与监听器完好保留（replaceWith 无损解包）
    expect(cloned.querySelector('#inner-p')).not.toBeNull();
    expect(cloned.querySelector('#inner-strong')).toBe(clonedStrong);
    clonedStrong.click();
    expect(strongClicked).toBe(true);
  });

  it('sourceWrapper 内部动态插入 input/button 时，resolveInlineMountTarget 严格检查并判定不安全', () => {
    document.body.innerHTML = '<main><p id="source-host"><span>Text</span></p></main>';
    const host = document.getElementById('source-host') as HTMLElement;
    const paragraph = store.getOrCreate(host);
    renderer.renderLoading(paragraph);

    const sourceWrapper = paragraph.sourceWrapper!;
    expect(sourceWrapper).not.toBeNull();
    expect(isUnsafeInlineElement(host)).toBe(false);

    // 页面向 sourceWrapper 内部动态插入表单控件
    sourceWrapper.append(document.createElement('input'));

    // 安全检查绝不能忽略 sourceWrapper 内部，必须识别出不安全
    expect(isUnsafeInlineElement(host)).toBe(true);
    expect(renderer.isUnsafe(host)).toBe(true);
  });

  it('renderTranslation 在已挂载 source 脱离 DOM 时不自动重建包装写旧结果，直接返回 false', () => {
    const paragraph = store.getOrCreate(source);
    const token = renderer.beginTask(paragraph);
    renderer.renderLoading(paragraph);

    const oldSourceWrapper = paragraph.sourceWrapper!;
    // 模拟脱离
    oldSourceWrapper.remove();

    // renderTranslation 不做自动修复写旧结果，直接拒绝
    const accepted = renderer.renderTranslation(paragraph, '旧译文', {
      mode: 'bilingual',
      placement: 'after',
      ...token,
    });
    expect(accepted).toBe(false);
  });

  it('restore 面对旧 record 且下钻 target 被克隆替换的场景，必须干净清理 DOM 里的 live target 与克隆标记', () => {
    document.body.innerHTML = `
      <main>
        <h2 id="drill-h2">
          <a id="drill-link" href="/releases">
            <span id="drill-title">Releases</span>
          </a>
        </h2>
      </main>`;
    const h2 = document.getElementById('drill-h2') as HTMLElement;
    const link = document.getElementById('drill-link') as HTMLElement;
    const titleSpan = document.getElementById('drill-title') as HTMLElement;

    const oldRecord = store.getOrCreate(h2);
    const token = renderer.beginTask(oldRecord);
    renderer.renderTranslation(oldRecord, '发布版本', {
      mode: 'bilingual',
      placement: 'after',
      ...token,
    });

    // 此时下钻挂载在 titleSpan
    expect(oldRecord.targetElement).toBe(titleSpan);
    expect(titleSpan.querySelector('[data-vast-translator]')).not.toBeNull();

    // 模拟框架仅对内部 link/titleSpan 进行了 deepclone 替换，旧 targetElement 脱离但 oldRecord 仍保留其旧引用
    const clonedLink = link.cloneNode(true) as HTMLElement;
    link.replaceWith(clonedLink);

    expect(oldRecord.targetElement?.isConnected).toBe(false);
    expect(h2.querySelector('[data-vast-translator]')).not.toBeNull();

    // 直接对持有旧 detached targetElement 引用的 oldRecord 调用 restore
    renderer.restore(oldRecord);

    // 关键断言：当前留在 DOM 里的 live target 内部克隆标记必须被彻底清理还原
    expect(h2.querySelector('[data-vast-translator]')).toBeNull();
    expect(h2.querySelector('[data-vast-source]')).toBeNull();
    expect(h2.hasAttribute('data-vast-inline')).toBe(false);
    expect(h2.textContent?.trim()).toBe('Releases');
  });

  it('cleanupUnownedPluginNodes 限定在直接子级，内部嵌套的其他合法段落 record 绝不被误解包或误删', () => {
    document.body.innerHTML = `
      <main>
        <div id="parent-host">
          <p id="child-para">Child text</p>
        </div>
      </main>`;
    const parent = document.getElementById('parent-host') as HTMLElement;
    const child = document.getElementById('child-para') as HTMLElement;

    // 先为子段落建立合法内联挂载
    const childRecord = store.getOrCreate(child);
    const childToken = renderer.beginTask(childRecord);
    renderer.renderTranslation(childRecord, '子段落译文', {
      mode: 'bilingual',
      placement: 'after',
      ...childToken,
    });

    expect(child.querySelector('[data-vast-translator]')).not.toBeNull();
    expect(child.querySelector('[data-vast-source]')).not.toBeNull();

    // 为父容器建立段落并进行挂载/清理
    const parentRecord = store.getOrCreate(parent);
    renderer.renderLoading(parentRecord);

    // 关键断言：父级的 cleanupUnownedPluginNodes 仅作用于直接子级，子段落合法的 [data-vast-source] 与译文必须完好无损！
    expect(child.querySelector('[data-vast-translator]')?.textContent).toBe('子段落译文');
    expect(child.querySelector('[data-vast-source]')?.textContent).toBe('Child text');

    // 恢复父级时同样不得误伤子段落
    renderer.restore(parentRecord);
    expect(child.querySelector('[data-vast-translator]')?.textContent).toBe('子段落译文');
    expect(child.querySelector('[data-vast-source]')?.textContent).toBe('Child text');
  });

  it('computedStyle flex 单子级状态链 loading -> translated / error 正常流转，业务多子级与动态新增多子级坚决判定 unsafe', () => {
    document.body.innerHTML = `
      <main>
        <div id="flex-single" style="display: flex;">
          <span>Single item</span>
        </div>
        <div id="flex-multi" style="display: flex;">
          <span>First item</span>
          <span>Second item</span>
        </div>
      </main>`;
    const single = document.getElementById('flex-single') as HTMLElement;
    const multi = document.getElementById('flex-multi') as HTMLElement;

    // 1. 业务多子级：初始即判定为 unsafe
    expect(isUnsafeInlineElement(multi)).toBe(true);
    expect(renderer.isUnsafe(multi)).toBe(true);

    // 2. flex 单子级：初始判定为 safe
    expect(isUnsafeInlineElement(single)).toBe(false);
    expect(renderer.isUnsafe(single)).toBe(false);

    // 3. loading 阶段安装 [data-vast-source] 与 [data-vast-translator]，不因插件自身多子级而误判 unsafe
    const paragraph = store.getOrCreate(single);
    renderer.renderLoading(paragraph);
    expect(renderer.isUnsafe(single)).toBe(false);
    expect(single.querySelector('[data-vast-state="loading"]')).not.toBeNull();

    // 4. 成功流转到 translated 状态
    const token = renderer.beginTask(paragraph);
    const accepted = renderer.renderTranslation(paragraph, '单项译文', {
      mode: 'bilingual',
      placement: 'after',
      ...token,
    });
    expect(accepted).toBe(true);
    expect(single.querySelector('[data-vast-translator]')?.textContent).toBe('单项译文');
    expect(renderer.isUnsafe(single)).toBe(false);

    // 5. error 状态（包含重试按钮）也不改变判定
    renderer.renderError(paragraph, '失败');
    expect(single.querySelector('[data-vast-state="error"]')).not.toBeNull();
    expect(renderer.isUnsafe(single)).toBe(false);

    // 6. 恢复干净
    renderer.restore(paragraph);
    expect(renderer.isUnsafe(single)).toBe(false);

    // 7. 关键回归：若在 sourceWrapper 内部动态新增业务多子级，必须立刻精准判定为 unsafe！
    renderer.renderLoading(paragraph);
    const sourceWrapper = paragraph.sourceWrapper!;
    sourceWrapper.append(document.createElement('span')); // 动态注入第二个业务子级
    expect(renderer.isUnsafe(single)).toBe(true);
    expect(isUnsafeInlineElement(single)).toBe(true);
  });
});
