# ijkplayer（debugly fork）迁入评估——Z7X 播放修复专项

> **状态更新（2026-10-02，P9.55）：已迁入并验证。**
> - AAR k0.8.9-beta-260526101841（13.8MB，四 ABI）vendor 到 `android/app/libs/`；
> - 新增第 4 解码档 `decoder=ijk`（IjkMediaPlayer + durl 单流直连，与 hw/sw 同一条 URL——
>   **原生档本就不播 DASH，§3 的双流硬伤对原生档不存在**，POC-2 免除）；
> - 模拟器走 FFmpeg 纯软解（mediacodec=0，避绿帧），真机开 ijk 自封装 mediacodec；
> - 降级链扩为 hw → sw → ijk → WebView；设置页新增「原生·ijk 兜底」；
> - AVD 冒烟通过：`ijkmp_prepare_async()=0` → h264 720p+AAC 探测 → 首帧渲染 →
>   `perf: ijk:ffmpeg · 1280×720 · 丢帧 0/0` 连续打点；
> - **关键坑**：`setDataSource(url)` 必须在 prepareAsync 之前（漏掉时 `ijkmp_prepare_async()=-3`
>   EINVAL，SurfaceView 打 "Exception configuring surface" 且静默无画面）；
> - media3 同步 1.4.1 → 1.9.4（1.10+/1.11 要求 compileSdk 36，本项目 AGP 8.7.2+SDK35 上限 1.9.4）；
> - 真机 Z7X 验证待做（POC-1 的真机软解性能项仍未覆盖）。

> 背景：Z7X 上视频几乎无法正常播放（P9.46 三内核全闪退已做对策但仍不稳）。本文评估 debugly 维护的 ijkplayer fork
> 能否作为新的解码档迁入，与 WebViewUpgrade（docs/06，修的是 UI/web 层）互为正交。
> 日期：2026-10-02
>
> **约束修订（2026-10-02）**：产品约束 = 纯 App 内完成，无 root、无用户手动升级。ijkplayer AAR 属于
> **完全合规的原生依赖**（随 APK 分发、零用户操作），是当前约束下的**第一优先方案**；
> 本评估其余结论不变。

---

## 1. debugly/ijkplayer 现状核实

| 维度 | 事实 |
|---|---|
| 上游 | bilibili/ijkplayer 官方确认**无维护计划**（issue #5618），为 2013 年起的经典 TV 盒子播放内核 |
| debugly fork | **个人维护 3 年+，已发 25+ 个版本**，自称"每年至少升一次副版本号"；2026 年仍在合并 Android 相关 PR（2026-05 合并 android_nativewindow 32-bit RGB 渲染支持） |
| FFmpeg | k0.12.0 升到 **6.1.2**（⚠️ 该版标注平台为 iOS/tvOS/macOS）；**Android 端 FFmpeg 具体版本需 POC 时核实** |
| Android 产物 | **预编译 AAR**（ijkplayer-cmake-release.aar，k0.8.9-beta 起随 Release 发布）：CMake 重构、合并 JNI 缩减 so 数、ffmpeg/openssl 全静态库、NDK r27c |
| ABI | armv7a / arm64 / x86 / x86_64 —— Z7X 无论 32/64 位都覆盖 |
| 配置 | ffmpeg 用 module-lite.sh（砍体积保常用解码器），支持 rtsp |
| License | LGPL-2.1 系（ffmpeg 可配）——商用闭源可用，注意保留版权声明与动静态链接义务 |
| 配套 | 作者另有商业升级版 fsplayer（不采用，仅说明维护方有持续投入动力） |

**结论：可用且算稳定**——ijkplayer 本体是 b 站亿级设备验证过的内核，TV 盒子场景的"容错播放"是它的主场；
debugly fork 是目前事实上的社区延续，预编译 AAR 让我们**无需 NDK 自编译**即可接入。风险集中在"单作者 fork"与
"Android 端组件版本滞后于 Apple 端"两点上。

## 2. 迁入的架构落点（与现有三档解码的关系）

现有原生内核 = **media3 ExoPlayer 1.4.1**（P9.19 D39 引入，替代随 jcenter 停服的 ijkplayer 预编译）：

```
NativePlayerPlugin（media3）
  decoder=hw  → 厂商硬解（MediaCodecSelector 自查全系统，硬解在前+软解追尾）
  decoder=sw  → 系统软解（OMX.google / c2.android，softwareOnly 过滤）
  （失败上报 JS → WebView 档）
```

迁入方案 = **新增第 4 档 `decoder=ijk`**，插在 sw 与 webview 之间（或作为 sw 的替代档）：

```
hw（ExoPlayer+厂商硬解） → sw（ExoPlayer+系统软解） → ijk（FFmpeg 软解/自管硬解） → webview
```

理由：
- Z7X 的病灶在**厂商 MediaCodec**（闪退/黑帧）。现有 sw 档用的是**系统软解仍走 MediaCodec 路径**，
  而 ijkplayer 的 FFmpeg 软解完全绕开 MediaCodec 解码环节（渲染走自己的 ANativeWindow），
  对厂商解码器 bug 的免疫程度是量级差异——这正是 TV 盒子圈用 ijk 兜底的传统原因。
- ExoPlayer 管线（进度/字幕/错误上报探针）全部保留，ijk 只作为独立档挂进 NativePlayerPlugin，
  JS 侧 `nativePlayer.js` 加一个 tier 值即可，复用现有降级链与设置锁档（decoderTouched）机制。

## 3. ⚠️ 结构性硬伤：b 站 DASH 是双流

ijkplayer 是**单 URL 播放器**，而 b 站 DASH 播放 = `video.m4s + audio.m4s` 两路独立流。
ExoPlayer 天生支持合流，ijkplayer 不支持。可选解法（都需 POC）：

1. **FFmpeg dashdec**：本地生成 .mpd 清单（baseURL 指向两路远端流），FFmpeg 的 DASH demuxer 理论上可取
   video+audio 两个 adaptation set。debugly k0.12.0 明确"支持 dash 解复用器"（但该特性标注在 Apple 端，
   Android 端 FFmpeg 版本是否含 dashdec 需确认）。
2. **本地 HTTP mux 代理**：App 内起 localhost 代理把两路流按 ts/fmp4 交织后喂给 ijk（b 站第三方播放器常用方案）。
   工程量中等，但顺带解决 header/风控注入。
3. **ijk 只做兜底单流**：仅音/视频单流场景（如部分低清 mp4 直链）走 ijk 档，DASH 主场景不依赖它。

**这是 go/no-go 级别的 POC 项**：dashdec/本地代理任一跑通，ijk 档才有产品价值；跑不通则 ijk 只剩窄用途。

## 4. 集成成本清单

| 项 | 说明 |
|---|---|
| 依赖引入 | 无 Maven 发布（jcenter 已死）→ AAR 直接 vendor 进 `android/app/libs/`（预计 20~40MB，**体积偏大需评估是否入库**，可改为构建脚本从自托管下载） |
| 插件改造 | NativePlayerPlugin 加 `load(..., decoder="ijk")` 分支：IjkMediaPlayer + setOption（mediacodec/software 解码开关）、headers 注入（UA/Referer 风控要求）、进度/完成/错误事件对齐现有 JS 契约 |
| 探针 | logcat 对齐 `原生内核起播 decoder=` 体系，加 `ijk 起播 codec=` |
| 设置页 | 解码档列表加「ijk（FFmpeg）」项，沿用 decoderTouched 锁档 |
| 体积影响 | release APK 预计 +10~25MB（按裁剪后单 ABI 算），Z7X 存储可接受但要实测 |
| 验证 | A9 AVD（x86_64 包）冒烟 + 真机 Z7X：ijk 档起播率、连播、seek、CPU/内存（FFmpeg 软解在 4 核 A55 上 1080p h264 可行，h265 软解大概率吃紧——优先验证） |

## 5. 对比：另一条"FFmpeg 软解"路——media3-ffmpeg 扩展自编译

Google 官方 media3 有 ffmpeg extension（可把 FFmpeg 软解接进 ExoPlayer 渲染管线，**保留 DASH 合流能力**），
但从未发布到 Maven（D54 评估 AV1 扩展时已确认）——需要自己编译 ffmpeg + extension，工程量显著大于
"vendor 现成 AAR"。若 §3 的 DASH POC 跑不通、而确实需要 FFmpeg 软解，这条是 Plan B。

## 6. 结论

1. **稳定性**：ijkplayer 本体久经 TV 场景验证；debugly fork 活跃（3 年 25+ 版本、Android AAR 预编译、
   2026 年仍在修 Android 问题）——**可以作为生产依赖**，但要接受单作者 fork 的维护风险并锁版本升级节奏。
2. **可迁入性**：架构上顺滑（新增一档解码，复用现有降级链/探针/设置体系），**但 DASH 双流是必须先验证的
   go/no-go 硬伤**。
3. **建议动作（按序）**：
   - POC-1：下载最新含 Android 的 AAR，真机 Z7X 直接用官方 demo 播 mp4/h265 单流，验证软解性能与稳定性（半天）；
   - POC-2：DASH 双流方案验证（本地 .mpd → dashdec 优先，不通再评估本地 mux 代理，1~2 天）；
   - 两个 POC 都过 → 按 §4 清单集成 `decoder=ijk` 档，v1.3.30 起灰度；
   - POC-2 失败 → 回到 media3-ffmpeg 自编译（Plan B）或维持"修厂商解码器"路线。
4. 与 WebViewUpgrade 的关系：**互不替代**。ijk 修"解码/播放"，WebViewUpgrade 修"UI/web 层与 webview 播放档"，
   可分别独立推进。
