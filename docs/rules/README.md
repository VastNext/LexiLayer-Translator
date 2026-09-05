# 站点翻译规则维护指南

本文档说明站点规则放在哪里、如何执行，以及新增或修改规则时应如何验证。

## 目录结构

```text
src/rules/
├── general.ts          # 未命中站点规则时使用的通用规则
├── types.ts            # 规则类型定义
├── catalog.ts          # URL 与站点规则的匹配目录
└── sites/
    ├── bing-search.ts
    ├── github.ts
    ├── google-search.ts
    ├── reddit.ts
    ├── stackoverflow.ts
    ├── substack.ts
    ├── x.ts
    └── youtube.ts
```

每个站点的源规则维护在 `src/rules/sites/*.ts`。不要直接编辑 `dist/rules/*.json`，这些文件由构建自动生成。

## 规则结构

当前规则类型定义在 `src/rules/types.ts`：

```ts
interface SiteRule {
  id: string;
  mainContentSelectors?: string[];
  includeSelectors?: string[];
  excludeSelectors?: string[];
}
```

### `id`

站点规则的唯一标识。它必须与 `catalog.ts` 中的 `id` 和构建输出文件名一致。

例如：

```ts
id: 'github'
```

构建后对应：

```text
dist/rules/github.json
```

### `mainContentSelectors`

定义页面正文扫描根节点。扫描器只会在这些根节点内寻找候选文本。

优先顺序：

1. 稳定的语义节点，例如 `main`、`article`、`[role="main"]`。
2. 稳定的站点属性，例如 `data-testid`、`aria-label`。
3. 站点明确的内容容器，例如 GitHub 的 `#readme`、Stack Overflow 的 `#mainbar`。

不要一开始就把整个 `body` 作为正文根，也不要依赖带哈希的 CSS Modules class。

### `includeSelectors`

用于纳入不一定属于标准段落元素、但确实是用户正文的节点。

例如：

```ts
includeSelectors: ['article', '[data-testid="comment"]']
```

它适合覆盖：

- Reddit 帖子和评论
- X 的 Tweet 容器
- YouTube 描述和评论区域
- Stack Overflow 的问题、答案和评论

`includeSelectors` 不是“强制翻译整个子树”。节点仍会经过直接文本检查和排除规则。

### `excludeSelectors`

用于排除站点特有的非正文区域。命中后，该节点及其后代都不会进入扫描。

优先排除这些类别：

- 导航和面包屑
- 仓库名、作者名、时间、统计等元数据
- 投票、分享、回复、收藏等操作区
- 图标按钮和 tooltip
- 广告、推荐、侧栏和分页
- 代码块、代码行和文件列表
- 屏幕阅读器标题或站点内部辅助文案

推荐优先使用稳定属性和语义结构：

```ts
excludeSelectors: [
  '[data-testid="latest-commit"]',
  '[aria-label="Repository files"]',
  'relative-time',
  'button',
]
```

对于你确认稳定的结构，可以使用结构选择器。例如 GitHub 的 Repository files navigation 标题：

```ts
'[itemscope][itemtype="https://schema.org/abstract"] > h2:first-child'
```

不要依赖类似下面这种可能随构建变化的完整 class：

```text
prc-src-InternalVisuallyHidden-2YaI6
```

如果 class 的语义稳定但后缀会变化，可以在通用扫描器中使用受控的前缀匹配；只有确认它是所有站点都适用的行为时，才放入 `dom-scanner.ts`。

## URL 匹配

文件：

```text
src/rules/catalog.ts
```

`catalog.ts` 只负责判断当前 URL 使用哪个规则，不负责描述页面内部 DOM。

```ts
{
  id: 'github',
  hostnames: ['github.com'],
  excludePathPrefixes: ['/settings', '/login', '/signup'],
  load: () => loadRule('github'),
}
```

支持：

- `hostnames`：精确主机名。
- `hostnameSuffixes`：子域名匹配。
- `pathPrefixes`：只匹配指定路径前缀。
- `excludePathPrefixes`：命中时回退通用规则。

同一站点不同页面类型如果需要完全不同的规则，应优先在这里拆分 URL 目录项，而不是把所有页面条件都堆到一个规则文件里。

## 执行流程

页面翻译由 `src/content/index.ts` 启动，核心流程如下：

```text
用户主动发起页面翻译
        ↓
matchSiteRule(new URL(location.href))
        ↓
src/rules/catalog.ts 找到 URL 目录项
        ↓
按需加载 dist/rules/<id>.json
        ↓
scanParagraphElements(document, rule, scope)
        ↓
选择正文根节点
        ↓
收集语义段落和可见文本叶
        ↓
应用通用排除 + 站点排除
        ↓
父子候选去重
        ↓
返回待翻译 HTMLElement
```

### 1. 选择扫描根

`src/content/dom-scanner.ts` 的 `queryRoots()` 会读取 `mainContentSelectors` 和 `includeSelectors`。

如果当前 URL 没有站点规则，则使用 `src/rules/general.ts`。

### 2. 收集标准候选

默认语义候选包括：

```text
h1, h2, h3, h4, h5, h6
p
li
blockquote
figcaption
td, th
```

扫描器还会遍历可见 Text Node，把复杂 SPA 中的直接文本叶提取出来，例如：

- 面包屑中的文本链接
- Angular 管理页面中的菜单文本
- GitHub 或 Reddit 的复杂组件文本

### 3. 应用通用排除

通用排除位于 `dom-scanner.ts`，包括：

- `script`、`style`、`template`
- `pre`、`code`
- `form`、输入框和选择框
- `svg`、`canvas`、图标字体
- `role="img"`、tooltip
- `hidden`、`aria-hidden`
- `.sr-only`、`.visually-hidden`
- 屏幕阅读器标题
- `relative-time`
- 扩展自身生成的翻译节点

通用排除必须谨慎修改，因为它会影响所有站点。修改后至少运行普通文章、SPA、按钮、图标、父子去重和 1000 节点性能测试。

### 4. 应用站点排除

站点规则的 `excludeSelectors` 会和通用排除合并。扫描器通过 `element.closest(selector)` 判断候选自身或祖先是否命中排除选择器。

因此：

```ts
excludeSelectors: ['[data-testid="latest-commit"]']
```

会排除 `latest-commit` 内的所有文本。

如果只需要排除父节点的一个标题、但保留其余正文，应使用更精确的结构选择器，例如：

```ts
'[itemscope][itemtype="https://schema.org/abstract"] > h2:first-child'
```

不要为了排除一个标题而排除整个正文容器。

### 5. 父子候选去重

扫描器会对候选进行文本标准化，并沿祖先链移除与子节点文本完全相同的冗余候选。

这可以避免同时翻译：

```text
外层 article
└── 内层 p
```

但它不会自动判断“外层是元信息、内层是正文”。这类语义边界必须通过站点规则明确排除。

## 大站规则标准

Google、Reddit、GitHub、YouTube、X、Bing、Stack Overflow、Substack 都遵循同一维护原则：

### 保留

- 用户真正阅读的标题
- 正文段落
- Markdown 正文
- 帖子和评论正文
- Issue / Pull Request 正文
- 视频描述和评论正文

### 排除

- 页面导航
- 面包屑
- 作者、时间、数量、统计和提交信息
- 投票、点赞、分享、回复、收藏按钮
- 图片、图标、tooltip 和无障碍辅助文案
- 广告、推荐、侧栏和分页
- 代码块、代码行、文件列表和数据表格

### 选择器优先级

按以下优先级选择：

1. `data-testid`
2. `aria-label`、`role`、`itemprop` 等语义属性
3. 稳定的站点语义元素
4. 稳定的结构关系，例如父节点和 `:first-child`
5. 普通 class
6. 带哈希的 CSS Modules class，只能作为最后手段，不应直接写入规则

## 修改规则的步骤

### 步骤一：记录真实 DOM

从浏览器开发者工具复制最小必要 DOM，不要直接复制整个页面。

需要保留：

- 包含问题文本的父节点
- 目标正文节点
- 相邻的导航、元数据或操作节点
- 能够区分它们的稳定属性

### 步骤二：先写回归测试

测试文件：

```text
tests/content/dom-scanner.test.ts
tests/content/rule-matcher.test.ts
```

每个问题至少写两个断言：

```text
非正文节点不在候选结果中
真正正文节点仍然在候选结果中
```

必须覆盖的类别：

- 正文保留
- 元数据排除
- 操作区排除
- 图标和辅助文案排除
- 动态组件结构
- URL 路径排除

### 步骤三：修改最小规则

优先修改对应的：

```text
src/rules/sites/<site>.ts
```

只有以下情况才修改 `src/content/dom-scanner.ts`：

- 该排除行为适用于所有站点。
- 当前规则字段无法表达需求。
- 通用扫描器存在明确逻辑错误。

### 步骤四：验证构建输出

规则源文件会在构建时生成：

```text
dist/rules/<site>.json
```

确认：

- `id` 正确。
- 选择器已经进入 JSON。
- Manifest 仍公开正确的规则文件。
- 规则详情没有重新内联到 content script。

## 常见错误

### 错误一：只排除 `nav`

GitHub 的 `Repository files navigation` 标题是 `nav` 的兄弟节点，不是 `nav` 的子节点。只排除 `nav` 不够，需要排除稳定的父级结构或标题本身。

### 错误二：依赖完整动态 class

类似 `prc-src-InternalVisuallyHidden-2YaI6` 的 class 可能随构建版本变化。优先使用：

- 父级 `itemscope` / `itemtype`
- `data-testid`
- `aria-label`
- 稳定的元素关系

### 错误三：排除过大的正文容器

直接排除整个 `.markdown-body` 会误伤 Issue、PR 或 README 正文。规则目标是排除 `.markdown-body` 周围的工具栏和元信息，而不是排除 Markdown 正文。

### 错误四：只测试“没有误翻”，不测试“正文仍可翻译”

每条排除规则都要同时验证正向和反向结果，否则很容易把整个页面内容误杀。

## 相关文件

```text
src/rules/types.ts
src/rules/catalog.ts
src/rules/general.ts
src/content/rule-matcher.ts
src/content/dom-scanner.ts
src/content/index.ts
tests/content/dom-scanner.test.ts
tests/content/rule-matcher.test.ts
vite.config.ts
```
