# Chrome Web Store 发布与更新检查清单

## 一、账号与发布者

- [ ] 使用长期持有的 Google 账号注册开发者账号
- [ ] 支付一次性开发者注册费
- [ ] 填写稳定的 Publisher Name
- [ ] 验证联系邮箱并启用发布、拒绝和下架通知
- [ ] 准确声明 Trader 或 Non-Trader
- [ ] 如果属于 Trader，确认可公开显示的法定名称、地址、电话和邮箱
- [ ] 如使用团队发布，确认个人 Publisher 或 Group Publisher 的归属
- [ ] 可选：在 Google Search Console 验证官方域名

发布身份决策记录：

```text
Publisher account:
Publisher type: Individual / Group
Declared status: Trader / Non-Trader
Decision owner:
Decision basis:
Google Payments profile ready:
Public legal name reviewed:
Public postal address reviewed:
Public phone reviewed and SMS-capable:
Verification completed by:
Verification date:
```

## 二、产品与政策审计

- [ ] Single Purpose 保持为“网页与划词翻译”
- [ ] `storage`、`contextMenus`、`scripting` 均有当前功能用途
- [ ] `<all_urls>` 理由已写入商店后台和商店长描述
- [ ] 不申请尚未使用的权限
- [ ] 无远程 JavaScript、`eval`、远程 WASM 或远程执行逻辑
- [ ] 所有可执行逻辑均包含在上传 ZIP 中
- [ ] 页面文本只在用户主动发起翻译后处理
- [ ] 不保存浏览历史、不跨站追踪、不建立用户画像
- [ ] 自定义 AI 不构成网页可调用的通用网络代理
- [ ] Google/Bing 端点的公开分发许可已经确认
- [ ] 不暗示与 Google、Microsoft 或其他第三方存在背书关系
- [ ] Dashboard 的 Remote Code 选择为 No，并说明远端只返回翻译数据
- [ ] 已决定商店版本是否允许携带 API Key 的本机 HTTP 回环请求

## 三、隐私与公开页面

- [ ] 产品主页已通过 HTTPS 公开访问
- [ ] 隐私政策已通过 HTTPS 公开访问
- [ ] 支持页面或 Issue Tracker 已公开访问
- [ ] 支持邮箱可长期接收邮件
- [ ] 隐私政策准确列出 Google、Bing、自定义 AI 数据流
- [ ] 隐私政策说明 API Key 的本地存储与发送范围
- [ ] 隐私政策说明 IndexedDB 30 天、5000 条缓存
- [ ] 隐私政策说明 `chrome.storage.session` 页面进度
- [ ] 隐私政策加入 Limited Use 中英文声明
- [ ] Privacy Practices 勾选项与实际代码、隐私政策一致
- [ ] 明确说明开发者当前没有接收翻译内容的自营后端

## 四、商店素材

### 必需

- [ ] 128×128 PNG 商店图标
- [ ] 至少一张 1280×800 或 640×400 截图
- [ ] 440×280 PNG/JPEG 小型宣传图

### 推荐截图，共五张

- [ ] 普通文章双语翻译
- [ ] 复杂 SPA/管理后台菜单翻译
- [ ] 划词翻译面板
- [ ] Popup 引擎、语言和显示模式
- [ ] Options 多自定义 AI 配置

建议素材目录：

```text
docs/chrome-web-store/assets/
  global/
    icon-128.png
    promo-small-440x280.png
    promo-marquee-1400x560.png
  zh_CN/
    screenshot-01-page-1280x800.png
    screenshot-02-selection-1280x800.png
    screenshot-03-popup-1280x800.png
    screenshot-04-options-1280x800.png
    screenshot-05-spa-1280x800.png
  en/
    screenshot-01-page-1280x800.png
    screenshot-02-selection-1280x800.png
    screenshot-03-popup-1280x800.png
    screenshot-04-options-1280x800.png
    screenshot-05-spa-1280x800.png
```

每张素材应记录扩展版本、截图页面、界面语言、主题和生成日期。

### 图片要求

- [ ] 截图展示真实最新版本
- [ ] 截图使用直角、无额外留白、全出血
- [ ] 没有泄露 API Key、账号、邮箱或私人网页数据
- [ ] 没有浏览器调试工具、错误提示或本地文件路径
- [ ] 宣传图不是简单缩放的截图
- [ ] 宣传图中的文字少且可读
- [ ] 可选：准备 1400×560 Marquee 图片
- [ ] 可选：准备 30～60 秒 YouTube 演示视频

## 五、版本与构建

- [ ] `package.json` 版本与 `src/manifest.ts` 版本一致
- [ ] 新上传版本号高于商店现有版本
- [ ] 更新 README、PRIVACY 和变更说明中的版本
- [ ] 使用干净工作区和锁定依赖构建

推荐门禁：

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run e2e
npm audit --audit-level=low
```

如果需要独立外网验证：

```bash
VAST_E2E_PROXY=http://127.0.0.1:7890 npm run e2e:network
```

测试代理仅用于本地验证，不得写入商店包或用户配置。

## 六、ZIP 打包

上传 ZIP 的第一层必须直接包含：

```text
manifest.json
background.js
content.js
popup.html
options.html
icons/
_locales/
assets/
rules/
```

不能多套一层 `dist/`。

Git Bash 示例：

```bash
cd dist
zip -r ../vast-translator-0.4.0.zip .
```

正式 GitHub Release 使用 `.github/workflows/release.yml`：推送与 `package.json` 一致的 `vX.Y.Z` 标签后，Action 会从干净检出运行测试、类型检查和构建，生成 ZIP、SHA-256 和 GitHub Release。`workflow_dispatch` 只构建 Artifact，不创建 Release，可用于发布前验证。

上传前检查 ZIP：

- [ ] 根目录直接存在 `manifest.json`
- [ ] 不包含 `src/`
- [ ] 不包含 `tests/` 或 `test-results/`
- [ ] 不包含 `node_modules/`
- [ ] 不包含 `.git/`
- [ ] 不包含 `research/`
- [ ] 不包含 `error.log`
- [ ] 不包含 `.env`、密钥或代理配置
- [ ] 不包含不必要的 Source Map
- [ ] Manifest 引用的文件全部存在
- [ ] 解压后可通过“加载已解压的扩展程序”正常加载
- [ ] 记录 ZIP 的 SHA-256、Git commit、构建时间和文件名

## 七、Developer Dashboard

### Store Listing

- [ ] 名称和简短说明
- [ ] 中英文长描述
- [ ] 分类和默认语言
- [ ] 图标、截图和宣传图
- [ ] Homepage URL
- [ ] Support URL
- [ ] 可选官方 URL
- [ ] 无关键词堆砌或第三方品牌误导

### Privacy

- [ ] Single Purpose
- [ ] 权限理由
- [ ] Website content 披露
- [ ] Authentication information 披露
- [ ] Web activity 的有限用途说明
- [ ] 数据用途与转移对象
- [ ] Limited Use Certification
- [ ] Privacy Policy URL
- [ ] Remote Code：No

### Distribution

- [ ] 明确首轮发布策略：Private + Trusted Testers、Unlisted 或 Public
- [ ] 确认发布国家和地区
- [ ] 确认免费或付费状态
- [ ] 审核通过后优先选择手动发布

可见性差异：

- Private + Trusted Testers：只允许指定 Google 账号安装，适合内部封闭测试；
- Unlisted：任何获得链接的人都可安装，但不会通过普通商店搜索发现；
- Public：公开搜索和安装；
- 从测试可见性改为 Public 可能需要重新提交审核，应预留时间；
- 如需长期并行维护 Beta，建议建立独立商店项目，而不是频繁切换正式项目可见性。

### Test instructions

- [ ] 填入 `privacy-and-review.md` 中的英文步骤
- [ ] 说明内置流程无需账号和测试凭据
- [ ] 说明自定义 AI 为可选能力
- [ ] 确认审核网络环境可访问默认翻译端点
- [ ] 使用发布者控制的公开 HTTPS 审核测试页
- [ ] 测试步骤覆盖安装前已打开标签页，以实际触发 `scripting`

## 八、提交审核后

- [ ] 保存上传 ZIP、版本号和提交日期
- [ ] 监控开发者邮箱和 Dashboard 状态
- [ ] 如发现错误，在审核结束前使用 Cancel review，修复并提升版本后重新提交
- [ ] 保存审核拒绝原文，不凭猜测修改
- [ ] 按具体政策条款逐项回复和整改
- [ ] 如果不立即上线，使用 Defer publish 或手动发布

## 九、审核通过后的商店实测

- [ ] 从 Chrome Web Store 安装，而不是加载本地 `dist/`
- [ ] 检查安装权限提示是否符合预期
- [ ] 检查首次启动默认 Google 和 Bing
- [ ] 测试普通文章主要内容翻译
- [ ] 测试整个页面和现代 SPA 菜单翻译
- [ ] 测试划词悬浮按钮和右键菜单
- [ ] 测试恢复原文、重试和动态内容
- [ ] 测试 Options 配置保存、导入导出和缓存清理
- [ ] 确认 API Key 不出现在网页 DOM、日志和导出文件中
- [ ] 检查 `chrome://extensions` 无新增错误
- [ ] 验证更新版本可通过商店自动更新

## 十、每次更新

- [ ] 提升版本号
- [ ] 更新用户可见变更说明
- [ ] 复核新增权限和数据流
- [ ] 如果数据实践变化，先更新隐私披露并获得必要同意
- [ ] 更新截图，使其与最新功能一致
- [ ] 重新运行完整门禁
- [ ] 生成新 ZIP 并保留发布归档
- [ ] 上传后检查 Dashboard 自动分析警告
- [ ] 提交审核并监控结果
