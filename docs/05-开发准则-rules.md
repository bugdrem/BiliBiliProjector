# 05 - BiliTV 开发准则（Rules）

> 面向开发者与 AI 助手的项目级强制约定。新入任何需求前先读这份，再动代码。
> 事实依据：`docs/00` 需求、`docs/01` 架构与 P0 风控实测、`docs/03` D-series 变更规格、
> `docs/04` bbll 对标，以及 P9 各轮真机/模拟器实测结论。
> 生效版本：v1.3.21（2026-09-30）

---

## 0. 项目定位（一句话）

**面向极米 Z7X 投影仪优化的第三方 bilibili TV 客户端**：原生 ExoPlayer 内核 + Capacitor WebView UI，
全部数据来自 bilibili **Web 公开接口**，UI/交互对标 bbll，性能优先。

---

## 1. 目标平台

### 1.1 首要目标：极米 Z7X（Android TV，遥控器操作）

Z7X 是**最紧的约束**，任何改动先问「Z7X 上会不会退化」：

| 约束 | 实测结论 | 对策（强制） |
|---|---|---|
| WebView 媒体栈崩溃 | 极米 Z7X 的 WebView 跑 MSE/DURL 都触发原生崩溃 | 播放**必须走原生内核** `NativePlayerPlugin`（ExoPlayer + TextureView），`<video>`/MSE 只作降级回退 |
| WebView 版本偏旧 | 老 Chromium 对部分新 CSS/JS 支持不齐 | 用新语法时必须给 fallback：`aspect-ratio` 配 `@supports not` 兜底；不用 `:has()` 承载关键布局；esbuild target `es2018` |
| 解码器输出异常 | 部分软/硬解码组合出纯绿帧 | 解码器 hw/sw 可切换 + 模拟器自动判软解（`isEmulator`）；失败降级链：原生 hw → 原生 sw → 原生 ijk → WebView |
| 内存/GPU 弱 | 大图、全屏重绘、模糊特效都会卡 | 封面强制走图床缩略后缀（`@480w_270h_1c.webp`）；避免大面积 `backdrop-filter` / 全屏阴影动画 |
| 输入方式 | 遥控器（DPAD + OK + 返回 + 媒体键），无触摸 | 所有可点元素必须可被 `focus.js` 的空间导航命中；新增 UI 要带 `data-focus-zone` |
| 显示距离 | 3 米观看 | 字号 ≥ 20px、热区 ≥ 60px、焦点态要有明确描边+缩放反馈 |

### 1.2 通用性底线（不能只为 Z7X 写死）

- 不可写死分辨率/比例/ABI：布局用 flex + 比例值，不能用 `1920px` 之类的常量。
- 检测分支要**可回退**：设备特征检测（`isEmulator`、`deviceProbe`）失败时不能锁死在最差档。
- 解码/渲染策略四档共存（hw / sw / ijk / webview），任一档被证明可用就不能删除另一档。
  ijk 档（P9.55）= debugly/ijkplayer AAR（`android/app/libs/`，升级只能换文件），IjkMediaPlayer 的
  `setDataSource` 必须在 `prepareAsync` 之前（否则 EINVAL 静默无画面）；模拟器 ijk 走 FFmpeg 纯软解。
- `AndroidManifest` 保持 `leanback required=false` + `touchscreen required=false`：手机/平板/电视都能装。
- minSdk 23 及以上，UI 不能依赖单一厂商 ROM 特性。

---

## 2. 接口与风控（Red Line）

> **这是项目生存线。任何绕过本节的做法都会导致接口被封，视为阻塞问题。**

### 2.1 绝对禁止

1. **禁止在 WebView 内直接 `fetch`/`XHR` 到 `*.bilibili.com`**。
   页面 origin 是 `appassets.androidplatform.net`，不在 B 站 WAF Origin 白名单里 → 整体 403（P0 实测）。
2. **禁止不带 web 端画像的请求**。缺失 Referer/UA 的请求会被判为异常客户端，返回 `-352`（风控校验失败）/ `-412`（请求被拦截）。
3. **禁止在 API 层之外自行发起 HTTP**（包括组件里直接 `fetch` 封面/页面）。所有数据流必须经 `src/api/`。
4. **禁止绕过限频闸门**。原生 `CapacitorHttp` 直调也必须过 `gate()`（≥300ms 串行间隔）——P9.43 前 `nativeGet` 绕过限频，属已修隐患。
5. **不要发非必要请求**：同一数据不重复拉；轮询类（扫码状态、心跳）按既有间隔，不擅自加密 key。

### 2.2 强制做法

- **统一入口**：`src/api/http.js` 的 `apiGet / apiPost / getText / nativeGetJson`。新增任何接口都必须落在这里或它调用的下游。
- **统一画像**：`webHeaders(path)` 负责桌面 Chrome UA（`WEB_UA`）+ 按接口推导的 Referer（`refererFor`）+ buvid Cookie。新增接口若需专属 Referer，在 `REFERER_RULES` 里加规则，不要就地手写。
- **设备会话**：`ensureSession()` 取 `/x/frontend/finger/spi` 的 buvid3/4 并缓存；所有请求自动附带，模拟真实浏览器会话。
- **传输选型**：原生环境一律 `CapacitorHttp` 直调（headers 全透传，不受 forbidden headers 剥离）；开发期走 Vite 代理 `/bapi`。二者无需业务层判断流分支，`http.js` 的 `transmit()` 已完成。
- **wbi 签名**：走 `wbi.js` 的 `signedQuery`，密钥缓存 24h，不得自己拼 md5。
- **风控码语义**：`-412 / -352` →「请求被风控拦截，请稍后再试」，禁止当作普通失败静默重试（会放大风控）。业务错误不重试，仅网络/5xx 退避 600ms 重试 1 次。
- **字段容错**：B 站接口非公开契约，取值一律可选链 + 默认值，单接口变更不得让页面白屏。

### 2.3 新增接口检查清单

- [ ] 端点属于 bilibili **Web 公开接口**（不能用 app 端独有权重）
- [ ] 匿名可用，或已确认登录态带 Cookie（`setLoginCookies` 白名单下发）
- [ ] 通过 `apiGet`/`nativeGetJson` 发送，不是裸 fetch
- [ ] 已在 `REFERER_RULES` 配好对应页面 Referer（若接口有 Referer 校验）
- [ ] 已在 `bilibili.js` 做字段整形，视图层不直接吃原始结构
- [ ] 真机或模拟器冒烟返回 `code:0`

---

## 3. 播放内核

- 首选 **原生 ExoPlayer**（`NativePlayerPlugin`）：DASH/MP4 均走这里，durl + Referer 由插件携带。
- 层级铁律（D55）：**渲染层 TextureView 在底、WebView 在上且透明**，页面靠 `body.native-play` 挖洞。
  任何把渲染层提回 WebView 之上的改动都会让弹幕被遮回去。
- 几何同步：任何影响视频区尺寸的变化（路由、布局、适应模式切换、播完转双栏）都要触发 `syncNativeLayout()`。
- 降级链：`原生 hw → 原生 sw → WebView/MSE`，任一步失败必须继续往下走并 toast 告知。
- 画质/清晰度：未登录上限受限于 getCurrentQuality（匿名 DASH 480P / durl 720P），不要假设一定有高码率。

---

## 4. UI / 交互基准（对标 bbll）

- 骨架：**左侧 200px 导航 + 右侧内容区**，全局暗黑（`--bg #121218` / `--bg-card #1c1c26` / 主色 `#00a1d6` / 辅助粉 `#fb7299`）。
- 关注态：3px 主色描边 + `scale(1.06)` + 辉光，180ms 过渡；焦点不能跳到视口外的元素。
- 播放页：全屏态必须**四边到顶**（`body.play-fullscreen` 清零外层 padding + `.video-wrap` fixed 铺视口），
  不允许四周出现页面底色边框。
- 播放器 OSD/菜单：返回键置左上角；信息类内容进「视频信息」弹窗；底部栏包含播放、视频信息、
  编码器/解码器、设置（跳转设置页后直接回播放页）。
- 卡片：封面 + 标题（两行截断）+ UP 主·时间；统计用 bilibili web 同款小图标，不用文字；图片必须 `loading="lazy" decoding="async"` 且带缩略后缀。
- 登录是可选的：未登录必须能浏览/播放/看弹幕，任何路径不得强制登录。
- **返回栈（P9.53）**：返回键 = 退出当前层回上级菜单。播放页内换视频（自动连播、选集/合集、
  相关推荐、UP 投稿）统一 `navigate(path, { replace: true })`——历史里只留一条播放记录，
  连播 N 个后按一次返回即回菜单；列表页（首页/热门/搜索）进播放页保持 push，返回才回得到列表。
- **不重复拉流（P9.53）**：返回首页/热门（路由切回）直接渲染模块级快照，零网络请求；
  主动刷新只认「再按一次导航项」（`router.requestRefresh`）。
- 首屏追踪（logcat 取证）：`[BiliTV] route x -> y`、`home mount visited=/fetches=`、`rcmd fetch #N`。

---

## 5. 性能预算（Z7X 为准）

| 项 | 规则 |
|---|---|
| 图片 | 必须带图床缩略后缀；卡片封面 `@480w_270h_1c.webp`，头像 `@96w_96h_1c.webp`；`http→https` |
| 列表 | 分页拉取 + 焦点触底懒加载；卡片分批渲染，禁止一次性插入上百个 DOM |
| 每帧计算 | 弹幕/焦点导航不每帧 `getBoundingClientRect`；低频校验（弹幕每 64 帧、焦点按按键触发） |
| 布局抖动 | 不在动画里改会触发 reflow 的属性；过渡只用 transform/opacity |
| 暂停/后台 | 停止不必要的 rAF 绘制（`document.hidden`、暂停即跳过重绘） |
| 网络 | ≥300ms 限频；相同数据不重复请求；必要时 localStorage 短缓存 |
| 包体 | 不引入重依赖（无 UI 框架、无 dash.js 常态依赖）；新增依赖要在 PR 里说明体积代价 |

**性能优先 = 功能与性能的二选一时，默认选性能，并在文案/交互上补偿**。

---

## 6. 工程约定

- 构建链：`npm run build` → `npx cap sync android` → `gradlew assembleDebug/assembleRelease`（`JAVA_HOME` 指向 `.tools/jdk-21`）。
- 版本：改动涉及功能/修复时递增 `versionCode` / `versionName`（`android/app/build.gradle`），交付到 `releases/BiliTV-vX.Y.Z-release.apk`。
- 提交：一个逻辑改动一个 commit，信息写清「动了什么 / 为什么」（含 D 编号便于回溯 `docs/03`）。
  push 到 GitHub 本机较慢（分钟级），不要因 `status` 仍显示 ahead 就重复推。
- `android/` 平台目录由 cap sync 生成：直接改过 `res/`（图标、styles）后重跑 sync 可能被还原，
  图标类资源走 `scripts/generate-logo.py` 一键重生成。
- 不入库：`.tools/`、`node_modules/`、`dist/`、`build/`、APK、`.workbuddy/`、`local.properties`。

---

## 7. 验证纪律

改动必须验证，不允许「应该没问题」：

- **模拟器**：放行启动→安装→拉起→操作→截图必须串在**同一条命令**里（模拟器在命令结束时被回收）。
  截图用 `adb exec-out screencap -p > x.png`（不要做 CRLF 替换，会破坏 PNG 二进制）。
- **层级/全屏类视觉问题**：用像素法判定不要靠肉眼——simulator 截图后用 PIL 统计边缘色：
  `(18,18,24)`=页面底色未铺满、`(0,0,0)`=视频 letterbox、`(10,13,22)`=窗口底色（挖洞生效）。
- **播放相关**：必须验证 Z7X 目标路径（原生内核），至少验证「能起播 + 弹幕在画面之上 + 四边到顶」。
- **接口相关**：必须真机/模拟器冒烟拿到 `code:0`，不能只构建通过。

---

## 8. 禁止清单（速查）

| 不做 | 原因 |
|---|---|
| WebView 内直连 B 站接口 | WAF Origin 白名单 → 403 |
| 不带 Referer/UA 的请求 | -352 / -412 风控 |
| 绕过 `http.js` 自己发请求 | 失去限频/重试/风控翻译保护 |
| 把 TextureView 提回 WebView 之上 | 弹幕被视频遮住 |
| 在 TV 上假设触摸可用 | Z7X 只有遥控器 |
| 为 Z7X 写死分辨率/ABI | 失去通用性，且换设备即崩 |
| 引入重依赖、新增全屏模糊/阴影特效 | 弱 GPU 卡顿 |
| 动research 后不做真机/模拟器冒烟 | 历史教训：多起「构建通过但设备不可用」 |
