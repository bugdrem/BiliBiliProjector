# BiliTV 项目规则（AI / 新成员必读）

> 完整版：**`docs/05-开发准则-rules.md`**（先读它，再动代码）。
> 这里只列改动时必须遵守的硬约束，用于快速自检。

## 项目定位
面向**极米 Z7X 投影仪**优化的第三方 bilibili TV 客户端（同时兼容通用 Android TV/电视端）：
原生 ExoPlayer 内核 + Capacitor WebView UI，数据全部来自 bilibili **Web 公开接口**，UI 对标 bbll，**性能优先**。

## 六条红线
1. **不在 WebView 内直连 `*.bilibili.com`**：页面 origin（`appassets.androidplatform.net`）不在 WAF 白名单 → 403。所有请求必须走 `src/api/http.js` 的 `apiGet / apiPost / getText / nativeGetJson`。
2. **请求必须带 web 端画像**：桌面 UA + 接口对应 Referer + buvid Cookie（用 `webHeaders()`），不得绕过限频闸门。缺失画像会被判异常 → `-352 / -412`。
3. **播放走原生内核**（`NativePlayerPlugin`，ExoPlayer + TextureView），Z7X 的 WebView 媒体栈会崩溃；`<video>`/MSE 只是降级回退。
4. **层级铁律**：TextureView 在**底**、WebView 在**上且透明**，播放页靠 `body.native-play` 挖洞。渲染层提回上层 = 弹幕被遮。
5. **全屏必须四边到顶**：全屏态 `body.play-fullscreen` 清零外层 padding、`.video-wrap` fixed 铺视口；四周出现页面底色边框算 bug。
6. **一切面向遥控器**：新增 UI 要能被焦点引擎的空间导航命中（带 `data-focus-zone`），不能依赖触摸；未登录必须能浏览/播放/看弹幕。

## 性能预算
- 图片必带图床缩略后缀（封面 `@480w_270h_1c.webp`）+ `loading="lazy" decoding="async"`。
- 列表分页 + 懒加载；弹幕/焦点不每帧读 `getBoundingClientRect`；过渡只用 transform/opacity。
- 不用 `backdrop-filter` / 全屏阴影等重绘特效；暂停或后台停止重绘。
- 功能与性能冲突时默认保性能，并用文案/交互补偿。

## 导航 / 返回栈（P9.53）
- 返回键语义 = **退出当前层回上级菜单**。播放页内的横向跳转（自动连播、选集/合集、相关推荐、UP 投稿）
  一律 `navigate(path, { replace: true })`；列表页进播放页用 push。连播 N 个视频后按一次返回即回菜单。
- **路由切回不得重发首屏请求**：列表状态放模块级 store（首页 `stores/homeFeed.js`、热门页模块标记），
  只有显式再按一次导航项（`router.requestRefresh`）才主动刷新。
- 取证：`logcat` 里 `[BiliTV] route a -> b` / `home mount visited=` / `rcmd fetch #N` 三条追踪。

## 通用性
不写死分辨率/ABI；三档解码策略（hw/sw/webview）共存可降级；列表布局用比例值而非绝对像素。

## 交付纪律
`npm run build` → `cap sync android` → `gradlew assembleRelease`（JAVA_HOME=`.tools/jdk-21`）→ `releases/BiliTV-vX.Y.Z-release.apk`。
**改动必须冒烟**：模拟器「启动→安装→拉起→操作→截图」串在一条命令内（`adb exec-out screencap -p > x.png`，不要替换 CRLF）。视觉类问题用像素判定，别靠肉眼。
接口类改动必须拿到 `code:0`，不能只构建通过。
