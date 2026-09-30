# 04 - 功能路线图：bbll（B 站 TV 版）对标

> 生成于 P7.7（2026-09-28）。以 B 站 TV 端（云视听小电视 / bbll，社区常用称谓）为功能参照，
> 对照 BiliTV 现状盘点差距，按优先级分期排布。接口风险统一记录在各期小节。

## 1. 功能矩阵（现状对照）

| 功能域 | bbll 能力 | BiliTV 现状 | 差距/备注 |
|---|---|---|---|
| 首页 | 推荐/热门/关注/排行/分区/直播 | 推荐/热门/排行/关注 四 Tab | 缺分区、直播 |
| 播放器 | 清晰度切换、倍速、选集、小窗、投屏 | 倍速✓ 选集✓ 倍速不记忆；清晰度固定 720P（durl 上限） | DASH+MSE 后做清晰度切换（P8） |
| 弹幕 | 开关/字号/透明度/区域/速度/密度/类型屏蔽/屏蔽词 | 开关+字号+透明度+区域+速度+密度+类型屏蔽（P7.7） | 缺屏蔽词、高级弹幕 |
| 搜索 | 历史、热词、联想、筛选 | 基础聚合搜索 | 缺历史/热词/联想/筛选 |
| 收藏 | 云端多夹切换、默认夹 | 默认夹 deal ✓；has/fav 下线 → 角标初始态失准 | 角标恢复方案待定（spec D14） |
| 历史 | 云端续播、增删、稍后再看 | 云端续播✓ 本地增删✓ | 缺稍后再看 |
| 登录 | 扫码、多用户、凭据刷新 | 扫码✓ 单用户 | 缺 refresh_token 刷新（凭据过期需重扫） |
| 用户中心 | 主页/粉丝/动态 | 我的页基础卡 | 低优先级 |
| 直播 | 直播流/弹幕/礼物 | 无 | 独立协议族，后排 |
| 番剧影视 | season/ep 播放 | 无 | epid 体系独立，后排 |
| 设置 | 播放/弹幕/网络/关于 | 弹幕开关+自动连播+账号 | P8 补弹幕设置页（当前在播放页 OSD） |

## 2. P8：播放内核升级 ✅（2026-09-28 完成）

- **D18 DASH+MSE ✅**：`/x/player/wbi/playurl`（wbi 签名，fnval=16）→ sidx 索引 → MSE 双
  SourceBuffer 合流。登录态 1080P 实测（1920×1080 rs=4），未登录保持 durl 720P
  （匿名 DASH 仅 480P，见 docs/03 D18 实测修订）
- **清晰度切换面板 ✅**：DASH accept_quality 档位（1080P/720P/480P/360P），同 cid 切码流
  无缝续播实测通过
- **heartbeat 心跳 ✅**：`/x/click-interface/web/heartbeat` 15s 间隔 code 0（V5 探针确认）
- **倍速记忆 ✅**：settings.playbackRate 持久化
- **refresh_token ⏸**：降级方案（need_refresh 检测端点已封装 cloud.js），完整 RSA correspond
  流程移 P9；UI 接入提示引导待做
- 内核实战三坑（HAVE_NOTHING 设 currentTime / resetTo 竞态 / seeking 死锁兜底）全记录于
  docs/03 D18 实测修订——**后续做直播流（P10）会复用这套 MSE 内核**

## 3. P9：搜索与内容运营

- 搜索历史（本地持久化，去重，上限 10）
- 热搜榜：`/x/web-interface/search/square?limit=10`（wbi）
- 搜索联想：`/x/web-interface/wbi/search/sug`（wbi，输入防抖 300ms）
- 结果筛选：分区/时长/排序参数透传
- **稍后再看**：`/x/v2/history/toview/add|del|list`（csrftoken 同 deal 模式）

## 4. P10：直播与番剧（独立协议族）

- 直播：`/xlive/web-room/v2/index/getRoomPlayInfo`（FLV/HLS 流）+ 直播弹幕（WebSocket 协议，
  与视频弹幕完全不同）
- 番剧：`pgc/player/web/playurl`（epid/season 体系）+ season 卡片流
- 风险：直播弹幕 WS 需要长连接管理；两者 UI 复用播放器但数据链路独立，建议独立分支开发
- **ijk 原生播放内核集成**（P9.15 D37 设置项先行）：`tv.ijk.player:ijkplayer-java:0.8.8`
  （B 站官方开源，github.com/bilibili/ijkplayer，LGPL2.1+，FFmpeg n4.0）+ ffmpeg .so
  （~8MB/ABI）→ Capacitor 插件桥接 + TextureView 原生渲染层 + durl 直连管线。
  解码器选项映射：软解码 `mediacodec=0` / 硬解码 `mediacodec=1`（settings.decoder 已落库）。
  注意：直播 FLV 流天然适合 ijk；MSE DASH 管线保持 WebView 内核不动

## 5. 长期 / 低优先

- 分区浏览（`/x/web-interface/dynamic/region`）
- 用户中心（space/acc/info wbi 版）
- 消息中心（需登录回复等写接口，风控强）
- 屏蔽词管理（弹幕正则过滤）
- 大会员清晰度（4K/HDR 依赖账号权益）
- 多用户切换

## 6. 技术债（随版本清理）

- `window.__dmDebug` / `__qrDebug` / `__mseDebug` / `__hbDebug` 探针：保留（P9 继续用），
  稳定版加 debug 开关默认关闭
- has/fav 替代方案（spec D14）：候选「默认夹 resource/list 分页比对」或「deal 幂等探测」
- 弹幕配置目前只在播放页 OSD，设置页应复用同一 dmOptRows（抽成共享组件/配置模块）
- MsePlayer 的音频拉取可以更省（audio 比特率低，可加大 AHEAD 或整段预取）
- 清晰度切换当前重建整个内核（SourceBuffer 重建），Chromium 支持
  changeType() 可做真正的无缝换流（WebView 版本依赖，P10 评估）
