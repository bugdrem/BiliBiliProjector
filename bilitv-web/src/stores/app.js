/**
 * 应用状态：设置 / 收藏 / 历史（reactive + localStorage 持久化）
 *
 * v1 不做登录，收藏与历史均为本地数据；登录体系为 P4+ 议题。
 */
import { reactive, watch } from 'vue'
import { isEmulatorDevice } from '../player/nativePlayer'
import { toast } from '../utils/toast'

const ls =
  typeof localStorage !== 'undefined'
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }

/** 安全读取 JSON */
function loadLS(key, fallback) {
  try {
    const v = JSON.parse(ls.getItem(key) || 'null')
    return v === null || v === undefined ? fallback : v
  } catch (_) {
    return fallback
  }
}

/* ---------------- 设置 ---------------- */

export const settings = reactive({
  /** 弹幕总开关 */
  danmaku: loadLS('bilitv.set.danmaku', true),
  /** 弹幕不透明度 0~1（OSD 档位循环：0.3/0.5/0.7/0.85/1） */
  danmakuOpacity: loadLS('bilitv.set.dmopacity', 0.85),
  /** 自动连播（播放结束自动播相关推荐第一条） */
  autoNext: loadLS('bilitv.set.autonext', true),
  /** 连播等待秒数（P9.33 D49）：播完后在结束页倒计时，到点播下一个；0=立即 */
  autoNextDelay: loadLS('bilitv.set.autonextdelay', 5),
  /** 视频适应模式（P9.34 D50）：full=全屏自适应(等比居中) / stretch=全屏拉伸 /
   *  window=窗口兼容（16:9 窗口+页面双栏，老设备渲染层几何异常时的回退） */
  videoFit: loadLS('bilitv.set.videofit', 'full'),
  /* ------- 弹幕基础配置（bbll 风格档位，见 docs/03 D15） ------- */
  /** 字号乘数：0.8 小 / 1.0 标准 / 1.25 大 */
  dmFontSize: loadLS('bilitv.set.dmfontsize', 1),
  /** 滚动弹幕显示区域（占视频高度比例）：1 全屏 / 0.5 半屏 / 0.25 四分之一屏 */
  dmArea: loadLS('bilitv.set.dmarea', 1),
  /** 速度乘数：0.6 慢 / 1.0 标准 / 1.5 快（越大越快） */
  dmSpeed: loadLS('bilitv.set.dmspeed', 1),
  /** 密度：1 全部 / 0.5 适中 / 0.25 稀疏（发射时按此概率保留） */
  dmDensity: loadLS('bilitv.set.dmdensity', 1),
  /** 显示滚动弹幕 */
  dmScroll: loadLS('bilitv.set.dmscroll', true),
  /** 显示顶部驻留弹幕 */
  dmTop: loadLS('bilitv.set.dmtop', true),
  /** 显示底部驻留弹幕 */
  dmBottom: loadLS('bilitv.set.dmbottom', true),
  /** 播放倍速记忆（P8 D21）：0.5/0.75/1/1.25/1.5/2.0，openPart 与 setRate 双向同步 */
  playbackRate: loadLS('bilitv.set.rate', 1),
  /** 每模块视频卡片上限（P9.0 D23）：懒加载到此停止，档位 50/100/200/500 */
  maxCards: loadLS('bilitv.set.maxcards', 100),
  /** 播放内核（P9.4 D27b）：auto=DASH优先失败回退 / dash=强制MSE / durl=兼容模式（老设备） */
  playCore: loadLS('bilitv.set.playcore', 'auto'),
  /** 导航音效开关（P9.6 D28，默认开） */
  soundOn: loadLS('bilitv.set.soundon', true),
  /** 音效主题：tick 滴答 / drop 水滴 / click 清脆 / glass 玻璃 */
  soundTheme: loadLS('bilitv.set.soundtheme', 'tick'),
  /** 默认分辨率（P9.7 D29）：max=支持的最高 / 116 / 80 / 64 / 32；达不到时取≤期望的最高档 */
  defaultQn: loadLS('bilitv.set.defaultqn', 'max'),
  /** 播放编码（P9.14 D36）：default=跟随默认(avc1优先)/avc1/hev1/av01；播放页可仅当前视频覆盖 */
  defaultCodec: loadLS('bilitv.set.defaultcodec', 'default'),
  /** 解码器（P9.19 D39）：webview=WebView 内核（默认）/hw=原生硬解码/sw=原生软解码
   *  /ijk=ijkplayer 档（P9.55，FFmpeg+mediacodec，绕开 ExoPlayer 管线，厂商解码 bug 兜底）。
   *  旧值 auto 归一化为 webview；原生内核 = 绕开 WebView 媒体栈（老投影崩溃根治） */
  decoder: (() => {
    const v = loadLS('bilitv.set.decoder', 'webview')
    return v === 'hw' || v === 'sw' || v === 'ijk' ? v : 'webview'
  })(),
  /** 省资源模式（P9.48）：null=跟随设备画像自动 / true=强制开 / false=强制关。
   *  开启后弹幕降分辨率+降帧+降密度、进度轮询降频——2GB/4 核这类弱设备防卡死的兜底档 */
  lowPerf: loadLS('bilitv.set.lowperf', null),
  /** 渲染层类型（P9.50）：surface=SurfaceView（默认）/ texture=TextureView。
   *  Z7X 上 SurfaceView 挖洞若被 ROM 特殊处理导致黑屏，切 texture 对照 */
  renderType: loadLS('bilitv.set.rendertype', 'surface'),
  /** 渲染诊断（P9.50）：true 时把 body 背景强制标红——播放黑屏时若视频区变红，
   *  说明 WebView 不透明挡住了视频；仍黑则说明渲染层本身没显示 */
  diagMark: loadLS('bilitv.set.diagmark', false)
})

watch(
  () => ({ ...settings }),
  (s) => {
    ls.setItem('bilitv.set.danmaku', JSON.stringify(s.danmaku))
    ls.setItem('bilitv.set.dmopacity', JSON.stringify(s.danmakuOpacity))
    ls.setItem('bilitv.set.autonext', JSON.stringify(s.autoNext))
    ls.setItem('bilitv.set.autonextdelay', JSON.stringify(s.autoNextDelay))
    ls.setItem('bilitv.set.videofit', JSON.stringify(s.videoFit))
    ls.setItem('bilitv.set.dmfontsize', JSON.stringify(s.dmFontSize))
    ls.setItem('bilitv.set.dmarea', JSON.stringify(s.dmArea))
    ls.setItem('bilitv.set.dmspeed', JSON.stringify(s.dmSpeed))
    ls.setItem('bilitv.set.dmdensity', JSON.stringify(s.dmDensity))
    ls.setItem('bilitv.set.dmscroll', JSON.stringify(s.dmScroll))
    ls.setItem('bilitv.set.dmtop', JSON.stringify(s.dmTop))
    ls.setItem('bilitv.set.dmbottom', JSON.stringify(s.dmBottom))
    ls.setItem('bilitv.set.rate', JSON.stringify(s.playbackRate))
    ls.setItem('bilitv.set.maxcards', JSON.stringify(s.maxCards))
    ls.setItem('bilitv.set.playcore', JSON.stringify(s.playCore))
    ls.setItem('bilitv.set.soundon', JSON.stringify(s.soundOn))
    ls.setItem('bilitv.set.soundtheme', JSON.stringify(s.soundTheme))
    ls.setItem('bilitv.set.defaultqn', JSON.stringify(s.defaultQn))
    ls.setItem('bilitv.set.defaultcodec', JSON.stringify(s.defaultCodec))
    ls.setItem('bilitv.set.decoder', JSON.stringify(s.decoder))
    ls.setItem('bilitv.set.lowperf', JSON.stringify(s.lowPerf))
    ls.setItem('bilitv.set.rendertype', JSON.stringify(s.renderType))
    ls.setItem('bilitv.set.diagmark', JSON.stringify(s.diagMark))
  }
)

/* ---------------- 收藏（本地） ---------------- */

/* ---------------- 运行时会话（P9.19 D39 崩溃自愈） ---------------- */

/** 会话级解码器覆写（崩溃自愈用，不持久化）：null=跟随 settings.decoder，否则 'hw'|'sw'。
 *  emulator：模拟器环境标记（P9.26 D42），启动时由 applyDeviceProfile 判定 */
export const runtimeSession = { decoder: null, crashDetected: false, emulator: false, lowPerf: false }

/**
 * 是否走省资源档（P9.48）
 * 用户显式选过（settings.lowPerf 非 null）以用户为准，否则按设备画像自动判定：
 * 内存 ≤ 2.5GB 或 核数 ≤ 2 视为弱设备（极米 Z7X：2GB/4 核 → 命中）。
 */
export function isLowPerf() {
  if (settings.lowPerf === true) return true
  if (settings.lowPerf === false) return false
  return !!runtimeSession.lowPerf
}

/**
 * 设备画像（P9.26 D42）：模拟器环境自动切换原生软解内核。
 * 背景：MuMu/AVD 等 PC 模拟器的视频解码走 GPU 转译，WebView 内核与硬件解码器
 * 输出常见纯绿帧（色彩格式不兼容），软件解码器（c2.android/OMX.google）路径稳定。
 * 优先级：模拟器 > 崩溃自愈 > 用户设置；用户在设置页显式选过解码器（decoderTouched）则尊重其选择。
 * 在 main.js 启动时（崩溃自愈判定之后）调用，覆写其 'hw' 会话值。
 */
export async function applyDeviceProfile() {
  try {
    const emu = await isEmulatorDevice()
    runtimeSession.emulator = emu

    // P9.48：弱设备画像 → 省资源档（2GB/4 核这类设备播放页会卡死，必须降档）
    const info = await probeDeviceInfo()
    const memGB = Number(info && info.memGB) || 0
    const cores = Number(info && info.cores) || 0
    runtimeSession.lowPerf = (memGB > 0 && memGB <= 2.5) || (cores > 0 && cores <= 2)
    if (runtimeSession.lowPerf) {
      console.warn(`[BiliTV] 弱设备画像（${cores}核/${memGB}GB），本次会话启用省资源模式`)
    }

    if (!emu) return false
    const touched = loadLS('bilitv.set.decoderTouched', false)
    if (!touched && runtimeSession.decoder !== 'sw') {
      runtimeSession.decoder = 'sw'
      toast('模拟器环境：已自动切换原生软解内核', { duration: 3600 })
      console.warn('[BiliTV] 模拟器环境，本次会话自动切换原生软解内核')
      return true
    }
  } catch (_) {
    /* 检测失败不阻塞启动 */
  }
  return false
}

/** 播放存活标记（面包屑）：上次播放时间/路由落在 localStorage，异常退出后可判定 */
export function markLive(route) {
  try {
    ls.setItem('bilitv.runtime.live', JSON.stringify({ ts: Date.now(), route }))
  } catch (_) {
    /* 忽略 */
  }
}

/**
 * 启动时崩溃检测：上次「播放存活标记」晚于「正常退出标记」且在 5 分钟内 → 判定播放中崩溃，
 * 本次会话强制原生内核（老投影 WebView 媒体栈崩溃的自愈路径）
 */
export function detectCrashAndHeal() {
  try {
    const live = JSON.parse(ls.getItem('bilitv.runtime.live') || 'null')
    const clean = Number(ls.getItem('bilitv.runtime.clean') || '0')
    if (
      live &&
      live.ts > clean &&
      Date.now() - live.ts < 5 * 60 * 1000 &&
      String(live.route || '').startsWith('/play')
    ) {
      runtimeSession.decoder = 'hw'
      runtimeSession.crashDetected = true
      return true
    }
  } catch (_) {
    /* 忽略 */
  }
  return false
}

/** 正常退出标记（pagehide/切后台时调用） */
export function markCleanExit() {
  try {
    ls.setItem('bilitv.runtime.clean', String(Date.now()))
  } catch (_) {
    /* 忽略 */
  }
}

/* ---------------- 收藏（本地） ---------------- */

export const favorites = reactive({
  list: loadLS('bilitv.favs', [])
})
watch(() => favorites.list, (v) => ls.setItem('bilitv.favs', JSON.stringify(v)), { deep: true })

/** 是否已收藏 */
export const isFav = (bvid) => favorites.list.some((x) => x.bvid === bvid)

/**
 * 切换收藏状态
 * @returns {boolean} 切换后是否为已收藏
 */
export function toggleFav(card) {
  const idx = favorites.list.findIndex((x) => x.bvid === card.bvid)
  if (idx >= 0) {
    favorites.list.splice(idx, 1)
    return false
  }
  favorites.list.unshift({ ...card, savedAt: Date.now() })
  return true
}

/* ---------------- 历史（本地，含播放进度） ---------------- */

const HIST_MAX = 100

export const history = reactive({
  list: loadLS('bilitv.hist', [])
})
watch(() => history.list, (v) => ls.setItem('bilitv.hist', JSON.stringify(v)), { deep: true })

/**
 * 记录/更新历史（进入或离开播放页时调用）
 * @param {object} card 卡片信息
 * @param {number} cid 当前分 P cid
 * @param {number} page 分 P 页码
 * @param {number} progress 已播放秒数
 */
export function histAdd(card, cid, page, progress) {
  if (!card || !card.bvid) return
  const idx = history.list.findIndex((x) => x.bvid === card.bvid)
  if (idx >= 0) history.list.splice(idx, 1)
  history.list.unshift({
    bvid: card.bvid,
    title: card.title,
    pic: card.pic,
    owner: card.owner,
    duration: card.duration,
    cid,
    page,
    /** 已播放秒数（用于续播） */
    progress: Math.floor(progress || 0),
    viewAt: Date.now()
  })
  if (history.list.length > HIST_MAX) history.list.length = HIST_MAX
}

/** 删除单条历史 */
export function histRemove(bvid) {
  const idx = history.list.findIndex((x) => x.bvid === bvid)
  if (idx >= 0) history.list.splice(idx, 1)
}

/** 查询某视频的续播信息 */
export function histGet(bvid) {
  return history.list.find((x) => x.bvid === bvid) || null
}

/** 清空历史 */
export function histClear() {
  history.list.splice(0)
}
