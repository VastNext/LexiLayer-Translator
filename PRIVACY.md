# Vast Translator 隐私说明

生效版本：0.4.2

## 数据处理原则

Vast Translator 不运营翻译服务器，不创建用户账号，也不收集分析数据。扩展仅在用户主动发起页面翻译、划词翻译或连接测试时处理必要数据。

## 会处理的数据

- 用户填写的一个或多个 OpenAI 兼容 API Base URL、模型名称和 API Key
- 目标语言、显示模式、译文位置、翻译范围和有限上下文偏好
- 用户主动要求翻译的网页文本或选区文本
- 用户填写的自定义翻译要求
- 为消歧而附带的有限邻近文本（仅在该选项开启时）
- 翻译结果及其缓存键

## 数据流向

Google 是默认引擎，请求发送到 `https://translate.googleapis.com/translate_a/t`。Bing 是备用引擎，请求发送到 `https://edge.microsoft.com/translate/translatetext`。两者会收到待翻译文本和语言参数，不会收到自定义 AI 的 API Key、模型或自定义翻译要求。

自定义 AI 请求直接从扩展的 service worker 发送到用户配置 Base URL 的 `/chat/completions` 端点。请求可能包含待翻译文本、有限上下文、语言、模型和自定义翻译要求。API Key 仅用于所选实例请求的授权头。Options 中的连接测试只向选定的内置端点或候选自定义 AI 端点发送固定探测文本；它不是网页可调用的通用网络代理。

Vast Translator 不会将 API Key 返回给网页或 content script，也不会把 API Key 写入配置导出文件、翻译缓存或错误消息。

第三方 API 服务可能按照自己的条款记录请求和网络元数据。用户应自行评估并接受该服务的隐私政策、数据保留规则和费用规则。

## 本地存储

- v2 配置与每个自定义实例的 API Key：保存在 `chrome.storage.local`。安全 Options 数据只返回逐实例 `hasApiKey`，不返回密钥值。
- 翻译缓存：保存在扩展 IndexedDB 中，默认保留 30 天，最多 5000 条，并按最近访问时间淘汰。
- 页面进度：按标签页与 frame 保存在 `chrome.storage.session`，仅保留于当前浏览器会话，不写入 `chrome.storage.sync` 或 `chrome.storage.local`。

用户可以在 Options 中清理翻译缓存；卸载扩展会由 Chrome 清除扩展本地数据。

配置导出包含 v2 阅读偏好、内置项和自定义实例元数据，但不含任何 API Key 或 `hasApiKey`。导入会拒绝任何层级的 API Key、重复 ID 和保留 ID 伪装；只有 ID 与 Origin 均相同的本地自定义实例才会沿用本机密钥。旧版单实例配置会在本地迁移为 v2 自定义实例。

## 不会进行的处理

- 不出售、出租或交换用户数据
- 不投放广告或进行跨站追踪
- 不提供网页可调用的通用 fetch 代理
- 不把 API Key 注入网页 DOM
- 不在未触发翻译时扫描整页正文

## 用户责任与安全建议

请勿翻译密码、访问令牌、支付信息、医疗记录、身份证件或其他敏感内容。建议使用权限和额度受限的 API Key，并定期轮换。远程 API 必须使用 HTTPS；HTTP 仅允许本机回环服务。

Google 可能返回 `429` 限流错误，此时可稍后重试或切换到 Bing。Google 与 Bing 为非流式能力；自定义 AI 划词翻译可使用流式能力。各服务可能记录请求和网络元数据，具体以各自隐私政策为准。

## 联系与变更

本项目当前处于 MVP 阶段。隐私行为发生变化时，应同步更新本文件和版本说明。问题可通过项目仓库的问题跟踪渠道反馈。
