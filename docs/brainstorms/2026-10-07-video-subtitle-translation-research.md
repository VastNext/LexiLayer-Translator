---
date: 2026-10-07
topic: video-subtitle-translation-research
origin: 用户需求「视频字幕翻译」+ 三路并行调研（竞品全景 / YouTube 技术深挖 / B站与Netflix 技术方案）
---

# 视频字幕翻译调研

本文件留档 2026-10-07 的三路调研结论，作为「视频字幕翻译」功能的依据。实现计划见
`docs/plans/2026-10-07-001-feat-youtube-subtitles-plan.md`。

## 一、竞品格局（三层）

| 层级 | 代表 | 模式 | 能力要点 |
|---|---|---|---|
| 商业头部 | 沉浸式翻译（Chrome 100 万+）、Trancy（约 30 万）、Language Reactor（约 200 万） | 免费 + 订阅（约 ¥69/月、$8.99/月、€5/月） | 双语字幕 + 点词词典 + 生词/Anki + AI 总结；无字幕视频走 ASR 且锁付费档 |
| 免费工具层 | Dualsub（约 10 万）、SubTrans、Subtitles for Language Learning 等 | 纯客户端、Google 免费端点 | 只做双语字幕显示，无学习功能，同质化红海 |
| 平台官方 | B 站 AI 字幕 + 「AI 原声翻译」（IndexTTS2 音色克隆）；Edge Live Video Translation（2025-09 起） | 平台自带 | AI 字幕 + 配音正在成为原生能力，第三方窗口收窄 |

关键事实：

- 沉浸式翻译与本项目架构最像：支持用户自带 OpenAI 兼容 Key，规避自营服务端；视频双语字幕是 Pro 核心卖点。
- Trancy 学习闭环最完整（点词 → AI 解析 → 闪卡）；Language Reactor 是赛道开创者（点词、生词导出 Anki、逐句暂停/回退）。
- 全行业收敛为「传统引擎（微软/Google/DeepL）免费或低价 + AI 按额度订阅」；一次性买断消失。
- 无字幕视频的 ASR 翻译是付费分水岭；配音/音色克隆只有平台方与头部玩家做得动。
- 有道/百度桌面端均无在线视频实时字幕能力；国内视频翻译被站内能力（如 B 站）收编。

主要来源：沉浸式翻译官网/定价页、Trancy 官网/定价页、Language Reactor 商店页、chrome-stats（Dualsub/SubTrans 用户数）、B 站官方「AI 原声翻译」上线报道（IT之家/pchome）、Edge Live Video Translation 报道（cnBeta）、Greasyfork B 站字幕脚本。

## 二、YouTube：pot 门禁与「捕获-重放」

- 2024-08 起 YouTube 对部分视频的 timedtext 加 pot（proof-of-origin token）门禁：baseUrl 带 `exp=xpe` 标记时，不带 `pot=` 的请求返回 **HTTP 200 + 空 body（静默失败）**。pot 由播放器 JS 内 BotGuard 铸造，不在页面 HTML、不在 `ytInitialPlayerResponse`、Cookie 不能替代（youtube-transcript-api issue #592；prepublish.ai 实测）。
- 唯一稳妥的扩展方案：**MAIN world content script（document_start）hook fetch/XHR + PerformanceObserver 兜底**，捕获播放器自己发出的带 pot 的 `/api/timedtext` 请求，用捕获 URL 重放（强制 `fmt=json3`），派生原文轨与 `tlang` 翻译轨。**不要直接 fetch `ytInitialPlayerResponse` 里的 baseUrl**（reza-nzri/yt-dual-sub 是反例，自己 README 承认偶发空 body）。
- 参考项目：Gythiro/yt-dual-subs（MV3，2026 活跃，工程化最高）、bakapiano/Youtube-TwinCue（用播放器 setOption 触发轨道加载 + 捕获匹配）、rxliuli/bilingualtube（WXT + IndexedDB 缓存 + ASR 标点恢复）、CoinkWang/Y2BDoubleSubs（改写 timedtext 响应体拼双行，pot 时代已不稳）。
- 解析 JSON3：丢弃 `aAppend===1`（ASR 滚动追加事件）、拼 `segs[].utf8`、剥 `>>` 说话人标记；`tStartMs/dDurationMs` → start/end；ASR 逐词 `tOffsetMs` 需按停顿/标点重组句子，否则翻译质量崩坏。
- 渲染：CSS 隐藏原生字幕层（`.ytp-caption-window-container{opacity:0}`，保留 DOM 供降级），自绘 overlay 挂 `.html5-video-player` 内；控制栏遮挡用 `.ytp-autohide` 与 `--yt-delhi-bottom-controls-height` CSS 变量；全屏/theater 由 DOM 包含关系天然解决。
- 同步：约 120ms 轮询 currentTime + 二分查找 + render-key 去重；`ad-showing` 期间停画（广告共用 media 元素时钟）；无人用 4Hz `timeupdate`。
- SPA：监听 `yt-navigate-finish` + videoId 变化双保险；异步回调带 generation 戳防竞态。
- 翻译管线：`tlang` 全轨优先（YouTube 免费，一次请求返回整轨），降级 Google 免费端点逐句（1.2s 车道限速 + 429 指数退避），AI 引擎批量（numbered-lines 协议）；全链路显式检测 200-空-body/429/空串。
- 其他：需要时替用户点 CC 按钮（`.ytp-subtitles-button`，处理冷启动 `aria-disabled`），记录「扩展开的」以便还原；auto-dub 视频用 `audioTracks` 修轨；live 不支持（增量 timedtext 模型不同）。

## 三、Bilibili：页内 API 直取

- 字幕列表：`GET api.bilibili.com/x/player/wbi/v2?aid=&cid=` → `data.subtitle.subtitles[].subtitle_url`（指向 aisubtitle.hdslb.com/i0.hdslb.com 的 JSON，URL 已由 B 站签好 auth_key）；字幕 JSON 为 `{body:[{from,to,content}]}`。
- **AI 字幕必须登录**：未登录返回空 subtitles + `need_login_subtitle: true`；扩展不能代管凭据。
- **WBI 签名目前半强制**：Bilibili-Evolved、IndieKKY/bilibili-subtitle、RSSHub 三个独立证据表明页内带 Cookie 的 fetch 不签名也可用；外部上下文会 403。应预留签名模块。
- 渲染：译文注入 `.bpx-player-subtitle-panel-wrap`，全屏天然可见；字幕开关读 close-switch 的 `bpx-state-active`；播放器有标准 video 元素可轮询 currentTime。
- 先例：IndieKKY/bilibili-subtitle（MIT，最小路径验证）、Bilibili-Evolved（DOM 抽象权威参考）、LazyScar/BiliBili-To-English（纯 DOM 观察路线，拿不到整片字幕）。
- **法律风险**：2026-01 B 站向 bilibili-API-collect 发律师函，该 20k star 仓库关停。依赖 B 站非公开接口的功能**不应在公开仓库文档化调用细节**；不做批量拉取/全片缓存字幕。

## 四、Netflix：不做

无官方通道；社区做法是 MAIN world patch JSON.parse/XHR/fetch 拦播放器 manifest（`textTracks[].ttDownloadables` → CDN TTML/dfxp，字幕文件不经 Widevine 加密）。明确违反 ToS，私有播放器管线改版即失效，「读取播放器网络数据」与产品边界（用户主动发起、最小处理）和商店审核相悖。Language Reactor 未被执法只是「暂未发生」。

## 五、对语层翻译的结论

- 做 **YouTube（先行）+ Bilibili（第二阶段）**；不做 Netflix/Disney+ 等强版权平台。
- 免费层：YouTube `tlang` 全轨机翻 + B 站站内 AI 字幕翻译；差异化层：接现有 OpenAI 兼容 AI 引擎做高质量批量翻译（用户自带 Key 路线）；学习闭环：点词 + 生词本/Anki 联动（复用 0.14.0 生词本管线）为第三阶段。
- v1 明确不做：ASR 转写、配音、直播、导出 srt。
- 站点适配做成独立站点级模块，符合「站点规则只做排除/例外」哲学；B 站调用细节不在公开仓库文档化。
