# 内容脚本与渲染器维护文档

本页说明语层翻译内容脚本的三脚本拆分、注入顺序、累计体积预算与渲染器能力边界。修改 `src/content/` 下的脚本结构时，必须同步更新本页与相关契约测试。

## 三脚本常驻与职责

Manifest `content_scripts` 声明**单条** `<all_urls>` 条目，`js` 数组顺序即注入顺序（Chrome 不保证多个条目之间的先后，必须合并在同一条目内才能锁定顺序），三者常驻于所有页面（不按站点按需注入）：

| 脚本 | 构建入口 | 职责 | 全局接口 |
| --- | --- | --- | --- |
| `content.js` | `src/content/index.ts` | 纯控制器库：页面翻译状态机、批次调度、重试、进度上报。不接触 DOM 渲染实现，保持预算稳定。同包产出 `content.css`（legacy 渲染器与划词节点样式）。 | 暴露 `LexiLayerContent.createContentController(dependencies)`（iife 全局） |
| `content-inline.js` | `src/content/inline-renderer.ts` | 内联渲染器：段落内部安全容器渲染译文与状态、`isUnsafe` 安全判定、恢复。同包产出 `content-inline.css`。 | 注册 `globalThis.__vastInlineRenderer` 单例 |
| `content-main.js` | `src/content/main.ts` | 装配层：渲染器实例、DOM 扫描、动态观察器、可见性调度、划词控制器与启动路由。 | 读取上面两个全局接口并组装运行时 |

## 顺序依赖

单条目内 `js` 数组按声明顺序执行，顺序不可调整，`content-main.js` 启动时依赖前两个脚本已就绪；`css` 数组的两套样式（`content.css` 与 `content-inline.css`）在脚本之前注入：

1. `content.js` 先执行，把控制器工厂挂到隔离世界全局；
2. `content-inline.js` 注册内联渲染器单例（缺失时装配层整体回退兼容模式）；
3. `content-main.js` 读取 `LexiLayerContent` 与 `__vastInlineRenderer`，创建运行时依赖并注册消息监听。

Popup 的按需注入（`src/popup/api.ts` 中接收端不存在时的 `chrome.scripting.insertCSS` + `chrome.scripting.executeScript`）必须与 manifest 顺序一致：先注入两套样式 `['content.css', 'content-inline.css']`，再按序注入三个脚本 `['content.js', 'content-inline.js', 'content-main.js']`。漏注入任一脚本都会导致渲染器或装配层未就绪，漏注入样式会导致译文与划词节点无排版。

## 累计体积预算

三个脚本常驻于每个网页的同一个隔离世界，真实累计成本是 JS 总量之和，不是单个文件的最大值。契约测试 `tests/build/bundle-budget.test.ts` 同时约束：

- 单文件预算：`content.js` 与 `content-main.js` 各 ≤ 38KiB，`content-inline.js` ≤ 8KiB，`background.js` ≤ 32KiB；
- 累计预算：三个 content 脚本合计 ≤ 48KiB，防止拆分掩盖总量膨胀；
- `content.css`（当前约 0.6KiB）与 `content-inline.css`（当前约 1.0KiB）为独立样式注入，不计入 JS 预算，但新增样式仍需克制。

新增功能时优先复用现有模块；确需新增常驻脚本时，必须同步更新 manifest、`tests/build/manifest.test.ts`、Popup 按需注入列表、体积预算测试与本页文档。

## 渲染器能力边界

### 内联模式（inline）

- 译文与状态容器只追加在段落内部原文之后，不向父级 flex/grid 容器新增子项；
- 原文节点整体移入 `[data-vast-source]` 包装（移动而非克隆），监听器、行内样式与 hidden 状态保留，恢复时原样放回；
- 单链接标题下钻：当段落为普通非编辑单链接且所有可翻译正文均在其内时（如 `h2 > span > a > span Releases`，伴随 badge/svg/aria-hidden/sr-only 辅助节点），自动下钻到该链接内部的最内安全文本容器挂载，外层标题与链接节点/样式/监听器不换不隐藏，译文保留在链接内部；
- 已渲染宿主被页面追加新节点（动态内容）时，`ParagraphStore.refresh` 会把包装外的游离子节点一并计入原文文本，触发重新翻译并重新包裹；追加的段落元素与宿主同时翻译时与兼容模式行为一致；
- 以下结构保守回退兼容模式，避免破坏页面交互或布局：
  - 受限内容 / 空元素标签（img、br、select、textarea、table 行类等）；
  - 多个链接、混合句子中的链接（链接外有正文）、按钮及 `role=button` 自身与子树；
  - 表单控件子树（form、fieldset、input、select、textarea、output、progress、meter 等）；
  - 自定义元素（宿主或后代标签名含 `-`，其内部结构与布局未知）；
  - flex/grid 容器且已有多个子项（折叠子项会改变子项数量与布局）。

### 兼容模式（legacy）

保持 0.7.x 的外部包装行为：译文容器是段落的兄弟节点；链接、按钮等宿主在内部包装以保留可点击性。

### 不夸大 CSS 保真

内联模式的目标是“不破坏页面布局”，不是“像素级视觉一致”：

- 不保证译文容器与原文视觉完全一致；译文继承宿主部分排版属性，但段落样式（间距、对齐、字体族等）仍由页面 CSS 决定；
- `content.css` 承载 legacy 渲染器与划词节点的基础排版（pre-wrap、选区浮层、内部包装等）；
- `content-inline.css` 只提供内联模式最基础的状态排版（loading/error/translated），不试图复刻或覆盖站点样式；
- 页面自身样式依赖子项数量或子元素标签的 flex/grid 布局，一律通过安全判定回退兼容模式处理，而不是用 CSS 修补。

## 归属与恢复

- 段落首次选用渲染器（loading 渲染）时确定归属并记录在 `paragraph.rendererKind`，直至 `restore` 清除；
- 会话内不再重新判定 `isUnsafe`：内联错误提示里的重试按钮等插件自身节点不会触发归属翻转；
- 恢复时由实际渲染该段落的渲染器执行，并统一清理 `data-vast-inline` 标记。