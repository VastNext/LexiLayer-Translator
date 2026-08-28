const themes = {
  pearl: { number: '01', name: 'Pearl Reader', subtitle: '安静、轻盈、原生阅读工具', note: 'Apple × Notion × Airbnb' },
  command: { number: '02', name: 'Command Translator', subtitle: '深色、快速、键盘优先', note: 'Raycast × Linear × Superhuman' },
  sage: { number: '03', name: 'Sage Global', subtitle: '温暖、友好、国际化', note: 'Wise × Airbnb × Apple' },
  editorial: { number: '04', name: 'Editorial Lingua', subtitle: '编辑感、文化感、内容优先', note: 'Notion × Clay × Stripe' },
  precision: { number: '05', name: 'Precision Blue', subtitle: '理性、可靠、结构清晰', note: 'IBM Carbon × Linear × Stripe' },
};

const theme = document.body.dataset.theme;
const meta = themes[theme];
const logo = `<svg class="vastnext-logo" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path class="logo-horizon" d="M5 35.5C15 39.5 29 39.5 43 34"/><path class="logo-route" d="M8 11L20.5 32L27 20L40 8V31"/><circle class="logo-beacon" cx="40" cy="8" r="3"/></svg>`;

document.querySelector('#app').innerHTML = `
  <header class="preview-header">
    <a href="index.html" class="back-link">← 返回总览</a>
    <div><span class="preview-number">${meta.number}</span><h1>${meta.name}</h1><p>${meta.subtitle}</p></div>
    <span class="inspiration">${meta.note}</span>
  </header>

  <main class="preview-stage">
    <section class="popup-column" aria-label="Popup 预览">
      <p class="stage-label">CHROME POPUP · 360px</p>
      <article class="translator-popup">
        <header class="popup-head">
          <div class="brand"><span class="brand-icon">${logo}</span><span class="brand-name">Vast Translator</span></div>
          <button class="icon-button" aria-label="设置">⚙</button>
        </header>

        <div class="language-control">
          <label><span>源语言</span><select><option>自动检测</option><option>English</option><option>简体中文</option></select></label>
          <span class="direction">→</span>
          <label><span>目标语言</span><select><option>简体中文</option><option>English</option><option>日本語</option></select></label>
        </div>

        <label class="engine-control"><span class="engine-label">翻译引擎</span><select><option>Google · 默认免费</option><option>Bing · 备用</option><option>OpenRouter · AI</option></select></label>

        <div class="translation-status"><span class="status-dot"></span><span class="status-copy">准备翻译当前网页</span></div>
        <div class="primary-actions"><button class="mode-toggle" aria-label="双语模式" title="切换双语 / 仅译文"><span class="mode-bilingual">◫</span><span class="mode-translation">▣</span></button><button class="translate-button">翻译</button></div>
        <footer class="popup-footer"><span>Shift</span><b>+</b><span>Alt</span><b>+</b><span>A</span></footer>
      </article>
    </section>

    <section class="options-column" aria-label="设置页预览">
      <p class="stage-label">OPTIONS · DESKTOP</p>
      <article class="options-shell">
        <aside class="options-nav">
          <div class="options-brand"><span class="brand-icon">${logo}</span><strong>Vast</strong></div>
          <nav><button class="active">翻译引擎</button><button>自定义 AI</button><button>阅读偏好</button><button>外观主题</button><button>数据与隐私</button></nav>
          <small>v0.2.0</small>
        </aside>
        <div class="options-content">
          <header class="content-head"><div><p class="eyebrow">翻译引擎</p><h2>选择默认服务</h2><p>Google 默认可用，也可以切换 Bing 或自定义 AI。</p></div><button class="quiet-button">导入配置</button></header>

          <div class="builtin-engines">
            <button class="engine-choice selected"><span class="provider-logo google">G</span><span><strong>Google</strong><small>免费 · 默认引擎</small></span><i>✓</i></button>
            <button class="engine-choice"><span class="provider-logo bing">B</span><span><strong>Bing</strong><small>免费 · 备用引擎</small></span><i></i></button>
          </div>

          <section class="settings-section">
            <div class="section-title"><div><h3>自定义 AI</h3><p>管理 OpenAI 兼容接口，每个实例独立保存连接和密钥。</p></div><button class="add-button">＋ 添加引擎</button></div>
            <div class="engine-list">
              <button class="engine-list-row"><span class="provider-logo ai">AI</span><span><strong>OpenRouter</strong><small>gpt-4.1-mini · 已配置</small></span><em>默认</em><b>›</b></button>
              <button class="engine-list-row"><span class="provider-logo local">L</span><span><strong>Local Qwen</strong><small>qwen3 · 本机服务</small></span><b>›</b></button>
            </div>
          </section>

          <section class="settings-section reading-section">
            <div class="section-title"><div><h3>阅读偏好</h3><p>控制网页的默认显示方式。</p></div></div>
            <div class="preference-grid">
              <label><span>目标语言</span><select><option>简体中文</option></select></label>
              <label><span>页面范围</span><select><option>整个页面</option></select></label>
              <label><span>译文位置</span><select><option>原文之后</option></select></label>
              <label><span>显示方式</span><select><option>双语对照</option></select></label>
            </div>
          </section>

          <section class="settings-section theme-section">
            <div class="section-title"><div><h3>外观主题</h3><p>5 套主题共享相同功能结构，可随时切换。</p></div><span class="theme-saved">自动保存</span></div>
            <div class="theme-grid">
              ${Object.entries(themes).map(([key, item]) => `<button class="theme-choice ${key === theme ? 'selected' : ''}" data-preview-theme="${key}"><span class="theme-swatch swatch-${key}"></span><span><strong>${item.name}</strong><small>${key === 'pearl' ? '默认主题' : item.subtitle}</small></span><i>${key === theme ? '✓' : ''}</i></button>`).join('')}
            </div>
          </section>
        </div>
      </article>
    </section>
  </main>
`;

const modeButton = document.querySelector('.mode-toggle');
modeButton.addEventListener('click', () => {
  const translationOnly = modeButton.classList.toggle('translation-only');
  modeButton.setAttribute('aria-label', translationOnly ? '仅译文模式' : '双语模式');
});

const translateButton = document.querySelector('.translate-button');
translateButton.addEventListener('click', () => {
  const translated = translateButton.classList.toggle('translated');
  translateButton.textContent = translated ? '显示原文' : '翻译';
  document.querySelector('.status-copy').textContent = translated ? '已翻译 26 个段落' : '准备翻译当前网页';
  document.querySelector('.translation-status').classList.toggle('done', translated);
});

for (const button of document.querySelectorAll('.engine-choice')) {
  button.addEventListener('click', () => {
    document.querySelector('.engine-choice.selected')?.classList.remove('selected');
    button.classList.add('selected');
  });
}

for (const button of document.querySelectorAll('.theme-choice')) {
  button.addEventListener('click', () => {
    document.querySelector('.theme-choice.selected')?.classList.remove('selected');
    button.classList.add('selected');
    document.querySelectorAll('.theme-choice i').forEach((icon) => { icon.textContent = ''; });
    button.querySelector('i').textContent = '✓';
  });
}
