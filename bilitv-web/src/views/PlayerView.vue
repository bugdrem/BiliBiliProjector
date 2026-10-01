<script setup>
/**
 * 播放页（对照 BBLL 播放器交互）
 * - 登录态：DASH+MSE 内核（P8 D18，fnval=16，1080P 上限）；MSE 失败自动回退 durl
 * - 未登录：MP4 durl 直连（720p 上限，免 Referer 实测；匿名 DASH 仅 480P 故不启用）
 * - OSD：方向键唤出，5s 无操作隐藏；隐藏态左右键 = ±10s seek、OK = 播放/暂停
 * - 选集 / 倍速 / 清晰度 / 弹幕设置面板为模态层（焦点引擎 pushLayer/popLayer 管理）
 * - 弹幕 canvas 覆盖层；离开页面记录播放进度（历史续播）+ 15s 心跳（登录态，D20）
 */
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { getView, getPlayUrl, getDashPlayUrl, getRelated, CODEC_OPTIONS } from '../api/bilibili'
import { auth } from '../stores/auth'
import { hasFav, favDeal, getDefaultFolderId, reportHistory, heartBeat } from '../api/cloud'
import { MsePlayer } from '../player/msePlayer'
import {
  nativePlayerAvailable, nativeLoad, nativeLayout, nativePlay, nativePause,
  nativeSeekTo, nativeSetSpeed, nativeGetProgress, nativeGetStats, nativeRelease, nativeOn
} from '../player/nativePlayer'
import { focusEngine } from '../core/focus'
import { settings, histAdd, histGet, toggleFav, isFav, runtimeSession, markLive, isLowPerf } from '../stores/app'
import { toast, toastError } from '../utils/toast'
import { fmtClock, fmtCount } from '../utils/format'
import DanmakuLayer from '../components/DanmakuLayer.vue'
import VideoCard from '../components/VideoCard.vue'
import StateBlock from '../components/StateBlock.vue'
import { navigate, playPath, routeBack, replacePath } from '../router'

const props = defineProps({ bvid: { type: String, default: '' } })

/**
 * P9.53 返回栈治理：播放页内部的所有换视频跳转（自动连播、选集/合集、相关推荐、
 * UP 投稿页）统一 replace——历史里始终只有一条播放记录，按返回键直接回上级菜单，
 * 而不是"退到上一个视频、还是播放页"逐级回退。
 */
function gotoVideo(bvid) {
  replacePath(playPath(bvid))
}

/* ---------------- 状态 ---------------- */
const state = ref('loading')
const errMsg = ref('')
const video = ref(null)
const related = ref([])
const partIdx = ref(0)
const curCid = ref(0)
const videoUrl = ref('')
const partLoading = ref(false)

/* ---------------- MSE 播放内核（P8 D18/D19） ---------------- */
/** true = MSE DASH 模式（src 由 MsePlayer 挂 objectURL，模板不给 video 绑定 :src） */
const mseMode = ref(false)
/** 当前 DASH 数据（getDashPlayUrl 返回，含全档位流字典） */
let dashData = null
/** 当前清晰度档 id（DASH qualities 之一） */
const qualityId = ref(0)
/** 可切换清晰度列表 [{id,label}]；durl 模式为空（不显示清晰度按钮） */
const qualities = ref([])
/** 播放编码（P9.14 D36）：codecPref=播放页覆盖偏好（null=跟随全局 settings.defaultCodec）；
 *  curCodec=当前实际生效的编码族（avc1/hev1/av01）。均不写全局设置——仅当前视频生效 */
const codecPref = ref(null)
const curCodec = ref('')
/** MSE 实例（非响应式：内部有定时器与 SourceBuffer，不进 Vue 代理） */
let msePlayer = null

const videoEl = ref(null)
const dmRef = ref(null)
const playing = ref(false)
const curTime = ref(0)
const duration = ref(0)

const osdVisible = ref(false)
const panel = ref(null) // null | 'episodes' | 'rate' | 'dmset' | 'quality'
/** 倍速（D21 记忆：初始取 settings，setRate 写回） */
const rate = ref(settings.playbackRate || 1)
const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

/* ---------------- 弹幕设置面板（bbll 风格档位，见 docs/03 D15） ---------------- */
/** 值档位行：每行 label + 档位按钮组（选中高亮），get/set 直接映射 settings */
const dmOptRows = [
  {
    key: 'opacity', label: '不透明度',
    values: [{ v: 0.3, name: '30%' }, { v: 0.5, name: '50%' }, { v: 0.7, name: '70%' }, { v: 0.85, name: '85%' }, { v: 1, name: '100%' }],
    get: () => settings.danmakuOpacity, set: (v) => (settings.danmakuOpacity = v)
  },
  {
    key: 'fontSize', label: '字号',
    values: [{ v: 0.8, name: '小' }, { v: 1, name: '标准' }, { v: 1.25, name: '大' }],
    get: () => settings.dmFontSize, set: (v) => (settings.dmFontSize = v)
  },
  {
    key: 'area', label: '显示区域',
    values: [{ v: 0.25, name: '1/4 屏' }, { v: 0.5, name: '半屏' }, { v: 1, name: '全屏' }],
    get: () => settings.dmArea, set: (v) => (settings.dmArea = v)
  },
  {
    key: 'speed', label: '速度',
    values: [{ v: 0.6, name: '慢' }, { v: 1, name: '标准' }, { v: 1.5, name: '快' }],
    get: () => settings.dmSpeed, set: (v) => (settings.dmSpeed = v)
  },
  {
    key: 'density', label: '密度',
    values: [{ v: 0.25, name: '稀疏' }, { v: 0.5, name: '适中' }, { v: 1, name: '全部' }],
    get: () => settings.dmDensity, set: (v) => (settings.dmDensity = v)
  }
]
/** 类型开关行：滚动/顶部/底部 */
const dmSwitchRows = [
  { key: 'scroll', label: '滚动弹幕', get: () => settings.dmScroll, set: (v) => (settings.dmScroll = v) },
  { key: 'top', label: '顶部弹幕', get: () => settings.dmTop, set: (v) => (settings.dmTop = v) },
  { key: 'bottom', label: '底部弹幕', get: () => settings.dmBottom, set: (v) => (settings.dmBottom = v) }
]
/** 关闭弹幕设置面板（与 pickPart/setRate 的弹层收起一致） */
function closeDmSet() {
  panel.value = null
  focusEngine.popLayer()
}

let osdTimer = 0
let removeInterceptor = null
let lastHistSave = 0
let resumeAt = 0

/** 云端收藏态（登录时用；未登录回落本地 isFav） */
const cloudFav = ref(false)
/** 当前清晰度标签（getPlayUrl 返回，如「高清 1080P」） */
const qualityLabel = ref('')
/** 默认收藏夹 id 惰性缓存（本次会话内复用） */
let folderIdCache = 0

/** 收藏态：登录 → 云端查询结果；未登录 → 本地 */
const fav = computed(() => {
  if (!video.value) return false
  return auth.loggedIn ? cloudFav.value : isFav(video.value.bvid)
})
const durText = computed(() => fmtClock(duration.value || (video.value ? video.value.duration : 0)))
const curText = computed(() => fmtClock(curTime.value))
const progressPct = computed(() => (duration.value ? (curTime.value / duration.value) * 100 : 0))

/* ---------------- 数据加载 ---------------- */

async function load() {
  state.value = 'loading'
  try {
    const v = await getView(props.bvid)
    video.value = v
    // 续播：历史记录且进度有意义（>30s 且未接近结尾）
    const h = histGet(props.bvid)
    partIdx.value = 0
    if (h && h.page) {
      const idx = v.pages.findIndex((p) => p.page === h.page)
      if (idx >= 0) partIdx.value = idx
    }
    resumeAt = h && h.progress > 30 ? h.progress : 0

    getRelated(props.bvid)
      .then((list) => (related.value = list))
      .catch(() => (related.value = []))

    // 关键时序：先置 state=ok 让 <video> 渲染出来（v-else 分支），再取播放地址并触发自动播放。
    // 若先 openPart 再置状态，openPart 内 videoEl.value 为 null，play() 不会执行 → 视频停在首帧。
    state.value = 'ok'
    await nextTick()
    await openPart(v.pages[partIdx.value], resumeAt)
    if (resumeAt > 0) toast(`已从 ${fmtClock(resumeAt)} 续播`)

    // 登录态：查询云端收藏态（失败静默，收藏按钮仍可操作）
    if (auth.loggedIn && v.aid) {
      hasFav(v.aid)
        .then((favoured) => (cloudFav.value = favoured))
        .catch(() => {})
    }
  } catch (err) {
    state.value = 'error'
    errMsg.value = err.message || '加载失败'
  }
}

/** 切换分 P 并加载播放地址（三内核路由，P9.4 D27b）：
 *  playCore=auto  → 登录态 DASH+MSE 优先，失败/不支持自动回退 durl
 *  playCore=durl → 兼容模式强制 durl（老投影/老 WebView 播 MSE 闪退时手动切）
 *  playCore=dash → 强制 DASH（调试用，即使 supported() 判否也尝试） */
async function openPart(page, startAt = 0) {
  if (!page) return
  partLoading.value = true
  codecPref.value = null // 新视频/切分 P：编码回全局默认（D36 仅当前视频原则）
  markLive('/play/' + props.bvid) // 存活面包屑（D39 崩溃自愈判定源）
  ended.value = false // P9.33 D49：新分 P 退出结束页回全屏播放
  cancelCountdown()
  nativeFallbackUsed = false // P9.38 D53：新分 P 重置降级轮次
  try {
    destroyMse()
    curCid.value = page.cid
    const core = settings.playCore || 'auto'

    // 原生内核路由（D39）：解码器=hw/sw 时走 ExoPlayer durl 直连，
    // 完全绕开 WebView 媒体栈——老投影（极米 Z7X）WebView 播放崩溃的根治路径
    if (core !== 'dash' && nativeWanted()) {
      try {
        await startNative(startAt, effectiveDecoder())
        partLoading.value = false
        if (dmRef.value) dmRef.value.seekTo(startAt || 0)
        return
      } catch (nativeErr) {
        console.warn('[BiliTV] 原生内核起播失败，回退 WebView durl:', nativeErr && nativeErr.message)
        stopNative()
      }
    }

    if (core !== 'durl' && auth.loggedIn) {
      // DASH 尝试（最多 2 轮）：B 站 playurl 调度的 PCDN 节点存在风控波动
      // （部分节点 403），重拉 playurl 会重新调度到可用节点（P9.7 D29）
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // qn 期望值：max → 请求 116（服务端按权益给最高）；具体档 → 请求期望
          const wantQn = settings.defaultQn === 'max' ? 116 : Number(settings.defaultQn)
          dashData = await getDashPlayUrl(props.bvid, page.cid, wantQn, codecPref.value || settings.defaultCodec)
          if (!filterSupportedQualities(dashData)) {
            throw new Error('WebView 不支持该视频的全部编码，回退 durl')
          }
          await startMse(pickDefaultQuality(dashData), startAt)
          partLoading.value = false
          if (dmRef.value) dmRef.value.seekTo(startAt || 0)
          return
        } catch (dashErr) {
          console.warn(`[BiliTV] DASH 第${attempt + 1}轮失败:`, dashErr && dashErr.message)
          destroyMse()
          if (core === 'dash') throw dashErr // 强制 DASH 模式不回退
          // 间隔 400ms 再拉 playurl 重新调度
          await new Promise((r) => setTimeout(r, 400))
        }
      }
    }
    await startDurl(startAt)
    if (dmRef.value) dmRef.value.seekTo(startAt || 0)
  } catch (err) {
    toastError(err)
  } finally {
    partLoading.value = false
  }
}

/**
 * MSE 编码能力过滤（P9.38 D53，防绿屏）：DASH 候选档按 MediaSource.isTypeSupported
 * 过滤——WebView 解不动的编码（典型：无 HEVC/AV1 支持的设备收到 hev1/av01 流）
 * 直接剔除，避免"能播但画面全绿"；全不支持时返回 false → 上层回退 durl（avc1）。
 */
function filterSupportedQualities(d) {
  try {
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported) return true
    const vids = (d.dash && d.dash.video) || []
    const ok = new Set()
    for (const v of vids) {
      const mime = 'video/mp4; codecs="' + v.codecs + '"'
      try {
        if (MediaSource.isTypeSupported(mime)) ok.add(v.id)
      } catch (_) { /* 单个探测失败忽略 */ }
    }
    if (!ok.size) return false
    if (d.qualities) d.qualities = d.qualities.filter((q) => ok.has(q.id))
    return true
  } catch (_) {
    return true
  }
}

/**
 * 默认档选择（P9.7 D29）：期望优先 + 支持的最高兜底。
 * avail = 实发 avc1 档位降序；want = max ? 最高 : 期望档；
 * 取 ≤want 的最高档；无（实发全部 > want，异常场景）取实发最高。
 */
function pickDefaultQuality(d) {
  const avail = (d.qualities || []).map((q) => q.id).sort((a, b) => b - a)
  if (!avail.length) return 0
  const want = settings.defaultQn === 'max' ? avail[0] : Number(settings.defaultQn)
  const fit = avail.filter((id) => id <= want)
  return fit.length ? fit[0] : avail[0]
}

/** 启动 MSE 内核（DASH）：挂 src、等 onReady 后自动续播 */
async function startMse(qid, startAt) {
  mseMode.value = true
  videoUrl.value = '' // 模板侧 mseMode 分支不绑 :src，清掉避免残留
  await nextTick() // v-if="mseMode" 分支的 <video> 此刻才渲染，先等 ref 就绪
  const el = videoEl.value
  if (!el) throw new Error('video 元素未就绪')
  qualityId.value = qid
  qualities.value = dashData.qualities || []
  qualityLabel.value =
    (dashData.qualities.find((q) => q.id === qid) || {}).label ||
    dashData.qualityLabel || ''
  curCodec.value = dashData.codec || 'avc1' // 实际生效编码族（可能因回退 ≠ 请求偏好）

  // startAt 交给内核：HAVE_NOTHING 阶段外部设 currentTime 不触发 seeking（P8 实测）
  msePlayer = new MsePlayer(el, dashData, qid, {
    startAt,
    onFatal: (err) => {
      // 内核不可恢复错误（拉流连续失败/MSE 异常）：降级 durl，从当前位置续播
      console.warn('[BiliTV] MSE fatal，降级 durl:', err && err.message)
      const at = el.currentTime || startAt || 0
      destroyMse()
      startDurl(at).catch((e) => toastError(e))
    },
    onReady: () => {
      el.playbackRate = rate.value
      el.play().catch(() => showOsd())
      startHeartbeat()
    }
  })
  await msePlayer.start()
}

/** durl 兜底路径（原 getPlayUrl 直连，未登录固定走此路）。
 *  P9.8 D30：durl 也提供清晰度面板（accept ∩ ≤720P 两档），与 DASH 面板共用 UI */
async function startDurl(startAt = 0, wantQn = 0) {
  const play = await getPlayUrl(props.bvid, curCid.value, wantQn)
  mseMode.value = false
  videoUrl.value = play.url
  qualityId.value = play.quality
  qualities.value = play.qualities || [] // durl 可切档（720P/360P）
  qualityLabel.value = play.qualityLabel || ''
  curCodec.value = '' // durl 单一 MP4，无编码概念（隐藏编码按钮）
  console.log('[BiliTV] playurl resolved:', play.url, 'quality=', play.qualityLabel)
  await nextTick()
  const el = videoEl.value
  if (el) {
    el.playbackRate = rate.value
    if (startAt > 0) el.currentTime = startAt
    try {
      await el.play()
    } catch (playErr) {
      // 播放被拒（策略/解码）：唤出 OSD 并聚焦播放键，用户按一次 OK 即可开播
      console.warn('[BiliTV] play() rejected:', playErr && playErr.name, playErr && playErr.message)
      showOsd()
    }
  }
  startHeartbeat()
}

/**
 * durl 模式清晰度切换（P9.8 D30）：重新 getPlayUrl(qn) 换 src，记录 currentTime
 * 续播；仅改当前视频局部状态，不写全局设置。
 */
async function pickDurlQuality(qn) {
  panel.value = null
  focusEngine.popLayer()
  if (qn === qualityId.value) return
  const at = curTime.value || 0
  partLoading.value = true
  try {
    const play = await getPlayUrl(props.bvid, curCid.value, qn)
    videoUrl.value = play.url
    qualityId.value = play.quality
    qualityLabel.value = play.qualityLabel || ''
    await nextTick()
    const el = videoEl.value
    if (el) {
      el.playbackRate = rate.value
      el.currentTime = at
      el.play().catch(() => showOsd())
    }
    toast(`已切换 ${qualityLabel.value}`)
  } catch (err) {
    toastError(new Error(`清晰度切换失败：${err.message}`))
  } finally {
    partLoading.value = false
  }
}

/** 清晰度面板统一入口：DASH 走切码流，原生走换直连重载，durl 走换直连 */
function onQualityPick(id) {
  if (mseMode.value) pickQuality(id)
  else if (nativeMode.value) pickNativeQuality(id)
  else pickDurlQuality(id)
}

/**
 * 原生内核清晰度切换（D39）：重拉 getPlayUrl(qn) → nativeLoad(startSec=当前进度)，
 * 原生管线整个重建（TextureView 复用），进度不丢；仅当前视频局部状态。
 */
async function pickNativeQuality(qn) {
  panel.value = null
  focusEngine.popLayer()
  if (qn === qualityId.value) return
  const at = curTime.value || 0
  const eff = effectiveDecoder()
  const dec = eff === 'sw' || eff === 'ijk' ? eff : 'hw'
  partLoading.value = true
  try {
    const play = await getPlayUrl(props.bvid, curCid.value, qn)
    await nativeLoad({
      url: play.url,
      decoder: dec,
      render: settings.renderType,
      startSec: at,
      rect: (() => {
        const box = document.querySelector('.native-video-box')
        if (!box) return null
        const r = box.getBoundingClientRect()
        return { x: r.left, y: r.top, w: r.width, h: r.height }
      })()
    })
    qualityId.value = play.quality
    qualityLabel.value = play.qualityLabel || ''
    await nextTick()
    toast(`已切换 ${qualityLabel.value}`)
  } catch (err) {
    toastError(new Error(`清晰度切换失败：${err.message}`))
  } finally {
    partLoading.value = false
  }
}

/**
 * 销毁 MSE 实例（切分 P / 降级 / 离开页面均调用）。
 * 不动 mseMode：清晰度切换时 video 元素不能卸载（卸载会导致 ref 变 null、
 * 播放中断——P8 V3 实测）；mseMode 的收口只在 startDurl（真正离开 DASH）时发生。
 */
function destroyMse() {
  stopHeartbeat()
  if (msePlayer) {
    msePlayer.destroy()
    msePlayer = null
  }
}

/**
 * 清晰度切换（D19，仅 DASH 模式）：同 cid 换码流，记录 currentTime 无缝续播。
 * 重建 MsePlayer（新 SourceBuffer），弹幕不重载（cid 未变）。
 */
/**
 * 清晰度切换（D19 + P9.9 D31）：优先「原地切档」——复用 SourceBuffer、audio 轨
 * 不动、MediaSource 不重建（对齐 bilibili web 播放器，秒级切换）；原地失败
 * （编码不支持/track 配置冲突）自动降级走「重建内核」路径。
 */
async function pickQuality(id) {
  panel.value = null
  focusEngine.popLayer()
  if (!dashData || !msePlayer || id === qualityId.value) return
  const at = curTime.value || 0
  partLoading.value = true
  try {
    // 路径一：原地切档（web 端同款，快）
    try {
      await msePlayer.switchQuality(id)
      qualityId.value = id
      qualityLabel.value = (dashData.qualities.find((q) => q.id === id) || {}).label || ''
      toast(`已切换 ${qualityLabel.value}`)
      return
    } catch (inplaceErr) {
      console.warn('[BiliTV] 原地切档失败，走重建:', inplaceErr && inplaceErr.message)
    }
    // 路径二：重建内核（startAt=at 由内核在 readyState≥1 后补真实 seek）
    try {
      destroyMse()
      msePlayer = new MsePlayer(videoEl.value, dashData, id, {
        startAt: at,
        onFatal: (err) => {
          console.warn('[BiliTV] 切清晰度后 MSE fatal:', err && err.message)
          const fallbackAt = videoEl.value ? videoEl.value.currentTime : at
          destroyMse()
          startDurl(fallbackAt).catch((e) => toastError(e))
        },
        onReady: () => {
          const el = videoEl.value
          el.playbackRate = rate.value
          el.play().catch(() => showOsd())
          startHeartbeat()
        }
      })
      await msePlayer.start()
      qualityId.value = id
      qualityLabel.value = (dashData.qualities.find((q) => q.id === id) || {}).label || ''
      toast(`已切换 ${qualityLabel.value}`)
    } catch (rebuildErr) {
      // 重建也失败（目标档节点被 B 站风控，P9.7 已知）：回退 durl 当前档保播放
      console.warn('[BiliTV] 重建切档失败，回退 durl:', rebuildErr && rebuildErr.message)
      await startDurl(at)
      toast('该清晰度暂不可用，已回退 720P')
    }
  } catch (err) {
    toastError(new Error(`清晰度切换失败：${err.message}`))
  } finally {
    partLoading.value = false
  }
}

/**
 * 编码族显示名（D36）
 */
const CODEC_FAMILY_LABEL = { avc1: 'H.264', hev1: 'H.265', av01: 'AV1' }
const codecName = computed(() => CODEC_FAMILY_LABEL[curCodec.value] || '')
/** 编码面板选项：default（跟随全局）+ 服务端实际下发的编码族 */
const codecOptions = computed(() => {
  const fams = (dashData && dashData.codecFamilies) || []
  return [
    { key: 'default', label: '跟随默认', avail: true },
    ...CODEC_OPTIONS.filter((o) => o.key !== 'default').map((o) => ({
      key: o.key,
      label: o.label,
      avail: fams.includes(o.key)
    }))
  ]
})
/** 面板当前选中 key：偏好未设 = default；已设但实际族因回退不同，仍显示偏好 */
const curCodecKey = computed(() => codecPref.value || 'default')

/**
 * 编码切换（D36，仅当前视频）：重拉 playurl（新偏好筛选变体）+ 重建内核 + 续播。
 * 切编码必须重建 SourceBuffer（mime 变化），不适用原地切档；不写全局设置。
 */
async function pickCodec(key) {
  panel.value = null
  focusEngine.popLayer()
  if (!mseMode.value) {
    toast('兼容模式（durl）不支持编码切换')
    return
  }
  if (key !== 'default' && key === curCodec.value) return
  const at = curTime.value || 0
  const keepQid = qualityId.value || 0
  partLoading.value = true
  try {
    const wantQn = settings.defaultQn === 'max' ? 116 : Number(settings.defaultQn)
    const newDash = await getDashPlayUrl(
      props.bvid,
      curCid.value,
      wantQn,
      key === 'default' ? settings.defaultCodec : key
    )
    // 保持当前清晰度（新数据无该档时回默认选档）
    const qid = newDash.qualities.some((q) => q.id === keepQid)
      ? keepQid
      : pickDefaultQuality(newDash)
    destroyMse()
    dashData = newDash
    codecPref.value = key
    await startMse(qid, at)
    toast(`已切换 ${CODEC_FAMILY_LABEL[curCodec.value] || '默认编码'}`)
  } catch (err) {
    toastError(new Error(`编码切换失败：${err.message}`))
    // 切换失败回滚：按原偏好重拉
    try {
      dashData = await getDashPlayUrl(props.bvid, curCid.value, wantQn, codecPref.value || settings.defaultCodec)
      await startMse(pickDefaultQuality(dashData), at)
    } catch (reErr) {
      startDurl(at).catch((e) => toastError(e))
    }
  } finally {
    partLoading.value = false
  }
}

/* ---------------- 原生播放内核（P9.19 D39：ExoPlayer，老投影 WebView 媒体栈崩溃根治） ---------------- */

const nativeMode = ref(false) // 原生内核生效中（渲染层为 TextureView，<video> 不参与）
let nativePollTimer = 0
let nativeListeners = []

/** 解码器路由：会话覆写（崩溃自愈）优先于全局设置 */
function effectiveDecoder() {
  return runtimeSession.decoder || settings.decoder
}

/** 当前是否走原生内核 */
function nativeWanted() {
  const dec = effectiveDecoder()
  return (dec === 'hw' || dec === 'sw' || dec === 'ijk') && nativePlayerAvailable()
}

/** 渲染层几何同步：量取占位盒（CSS px）→ 插件乘 dpr 定位 TextureView */
function syncNativeLayout() {
  if (!nativeMode.value) return
  const box = document.querySelector('.native-video-box')
  if (!box) return
  const r = box.getBoundingClientRect()
  nativeLayout({ x: r.left, y: r.top, w: r.width, h: r.height, stretch: settings.videoFit === 'stretch' }).catch(() => {})
}

/** 适应模式切换 / 布局稳定后重同步渲染层几何（老设备首测可能取到过渡态尺寸） */
watch(() => settings.videoFit, () => nextTick(() => syncNativeLayout()))

/** 原生播放态「挖洞」（P9.41 D55 层级翻转）：渲染层 TextureView 改挂在 WebView 之下，
 *  页面 body 背景需转透明，视频画面才能从下层透出、WebView 里的弹幕浮在画面之上。
 *  播完（ended）保留挖洞：定格画面继续透出；信息区自带 var(--bg) 底色，不会串画面。
 *  离场（退出播放页 / 回落到 WebView 播放）必须摘掉，否则其它页面会透明露出窗口黑底。 */
watch(
  () => nativeMode.value,
  (on) => {
    if (typeof document === 'undefined') return
    if (on) document.body.classList.add('native-play')
    else document.body.classList.remove('native-play')
  }
)

/** 兜底清理：组件卸载时移除挖洞 class（避免残留全局 body，影响首页等后续页面） */
function releaseHole() {
  if (typeof document === 'undefined') return
  document.body.classList.remove('native-play')
  document.body.classList.remove('play-fullscreen')
}

/** 打开模态面板（P9.30 D46）：统一挂 onClose——硬件返回键 back() 弹层时
 *  同步清 panel 状态，修复"返回只弹层、弹框一直在" */
function openPanel(p) {
  panel.value = p
  nextTick(() => focusEngine.pushLayer('panel', null, () => { panel.value = null }))
}

/** 关闭模态面板：清状态 + 弹层（onClose 幂等） */
function closePanel() {
  panel.value = null
  focusEngine.popLayer()
}

/** UP主跳转（P9.32 D48）：#/home/<mid> → 首页关注流直连该 UP 投稿（复用关注页） */
function gotoUp() {
  const mid = video.value && video.value.owner ? video.value.owner.mid : 0
  if (!mid) {
    toast('暂无 UP 主信息')
    return
  }
  replacePath('home/' + mid) // P9.53：由播放页跳投稿页，返回应回上级菜单而非回到播放页
}

/** 视频信息弹窗内 UP 行 → 关面板后跳投稿页 */
function gotoUpFromInfo() {
  closePanel()
  gotoUp()
}

/** 解码器选项（P9.36 D52） */
const DECODER_OPTS = [
  { v: 'webview', label: 'WebView 内核' },
  { v: 'hw', label: '原生·硬解码' },
  { v: 'sw', label: '原生·软解码' }
]
const decoderShortName = computed(() => {
  const d = DECODER_OPTS.find((x) => x.v === settings.decoder)
  return d ? d.label.replace('原生·', '') : ''
})

/** 切换解码器：写设置 + 标记显式选择 + 从当前进度重载当前分 P */
function applyDecoder(v) {
  if (settings.decoder === v) {
    closePanel()
    return
  }
  settings.decoder = v
  try { localStorage.setItem('bilitv.set.decoderTouched', '1') } catch (_) { /* 忽略 */ }
  closePanel()
  const page = video.value && video.value.pages ? video.value.pages[partIdx.value] : null
  toast('解码器已切换，正在重载…')
  openPart(page, curTime.value || 0)
}

/** 发布日期（视频信息面板用） */
/**
 * 性能快照文案（P9.49）：打开视频信息面板时取样一次。
 * 例：「硬解 OMX.amlogic.avc.decoder · 1920×1080 · 丢帧 12/840 · 可用内存 610MB」
 * 软解 + 高丢帧 = 解码跟不上；硬解 + 高丢帧 + 低内存 = 合成/UI 层拖垮（WebView 税负）
 */
const perf = ref(null)
const perfText = computed(() => {
  const s = perf.value
  if (!s) return ''
  const dec = s.decoder ? `${s.software ? '软解' : '硬解'} ${s.decoder}` : '解码器未就绪'
  const res = s.videoW && s.videoH ? `${s.videoW}×${s.videoH}` : ''
  const drop = `丢帧 ${s.dropped}/${s.rendered}`
  const mem = s.availMemMB ? `可用内存 ${s.availMemMB}MB${s.lowMemory ? '（紧张）' : ''}` : ''
  return [dec, res, drop, mem].filter(Boolean).join(' · ')
})
watch(
  () => panel.value,
  async (p) => {
    if (p !== 'info' || !nativeMode.value) return
    perf.value = await nativeGetStats()
  }
)

const pubDateText = computed(() => {
  const pd = video.value && video.value.pubdate
  if (!pd) return ''
  try {
    return new Date(pd * 1000).toLocaleDateString('zh-CN')
  } catch (_) {
    return ''
  }
})

/**
 * 原生内核进度轮询：驱动 timeupdate 语义（500ms；P9.48 省资源档降为 1s——
 * 每次回调都会触发 Vue 响应式更新与进度落库，弱设备上要减少主线程抖动）
 */
/** 性能采样计数（P9.49）：每 10 次轮询（约 10s/20s）打一次日志，供 adb 直接取数 */
let perfTick = 0

function startNativePoll() {
  stopNativePoll()
  perfTick = 0
  nativePollTimer = setInterval(async () => {
    try {
      const p = await nativeGetProgress()
      curTime.value = p.positionSec
      if (p.durationSec > 0) duration.value = p.durationSec
      playing.value = p.playing
      // P9.49：性能快照同步打到 logcat（Z7X 上无需遥控器点面板即可取数）
      if (perfTick++ % 10 === 0) {
        const s = await nativeGetStats()
        if (s) {
          perf.value = s
          console.warn(
            `[BiliTV] perf: ${s.software ? '软解' : '硬解'} ${s.decoder || '-'} · ${s.videoW}×${s.videoH} · 丢帧 ${s.dropped}/${s.rendered} · 可用内存 ${s.availMemMB}MB${s.lowMemory ? '(紧张)' : ''}`
          )
        }
      }
      // 每 5 秒存一次进度（与 WebView 路径 onTimeUpdate 同节奏）
      if (p.positionSec - lastHistSave > 5 || p.positionSec < lastHistSave) {
        lastHistSave = p.positionSec
        saveProgress()
        markLive('/play/' + props.bvid) // 存活面包屑（崩溃自愈判定源）
      }
    } catch (_) {
      /* 轮询失败静默（插件可能已释放） */
    }
  }, isLowPerf() ? 1000 : 500)
}

function stopNativePoll() {
  clearInterval(nativePollTimer)
  nativePollTimer = 0
}

/** 原生内核事件接线（prepared/ended/error/stateChanged） */
async function attachNativeListeners() {
  nativeListeners.push(await nativeOn('prepared', (d) => {
    if (d.duration > 0) duration.value = d.duration / 1000
  }))
  nativeListeners.push(await nativeOn('stateChanged', (d) => {
    playing.value = !!d.playing
  }))
  nativeListeners.push(await nativeOn('ended', () => onEnded()))
  nativeListeners.push(await nativeOn('error', (d) => {
    handleNativeError(d)
  }))
}

/**
 * 原生内核错误自动降级（P9.38 D53 / P9.55 扩展）：绿屏/花屏/解码失败的自动止损链——
 * 硬解失败 → 软解重试 → ijkplayer 兜底 → WebView 内核重试；每视频限一轮，防循环。
 * （Z7X 上 WebView 崩溃由既有崩溃自愈接管）
 */
let nativeFallbackUsed = false
function handleNativeError(d) {
  console.warn('[BiliTV] 原生播放错误:', d && d.message)
  if (nativeFallbackUsed) {
    toastError(new Error('原生播放错误：' + (d.message || 'unknown')))
    showOsd()
    return
  }
  const dec = effectiveDecoder()
  // P9.46（Z7X 闪退对策）：WebView 内核在 Z7X 上必崩（MSE/DURL 原生崩溃），且上一次
  // 会话检测到异常退出（crashDetected）时，降级链里不能再进 WebView——否则
  // 「原生失败 → 降级 WebView → 闪退 → 下次强制原生 → 再失败」死循环。
  // 高危会话下原生失败就停住并提示，让用户手动切解码器。
  const webviewAllowed = !runtimeSession.crashDetected && !runtimeSession.emulator
  // P9.55：降级链加入 ijk 档（hw → sw → ijk → WebView；ijk=FFmpeg/ijkplayer 内核，
  // 完全绕开 ExoPlayer/MediaCodec 管线，对厂商解码器 bug 免疫度最高）
  const chain =
    dec === 'hw'
      ? ['sw', 'ijk', ...(webviewAllowed ? ['webview'] : [])]
      : dec === 'sw'
        ? ['ijk', ...(webviewAllowed ? ['webview'] : [])]
        : dec === 'ijk'
          ? webviewAllowed ? ['webview'] : []
          : []
  const next = chain[0]
  if (!next) {
    toastError(new Error('原生播放错误：' + (d.message || 'unknown') + '（可到设置页切换解码器重试）'))
    showOsd()
    return
  }
  nativeFallbackUsed = true
  runtimeSession.decoder = next
  const nextToast =
    next === 'sw'
      ? '解码异常，已自动切换软解码重试'
      : next === 'ijk'
        ? '软解异常，已切换 ijkplayer 兜底解码重试'
        : '已切换 WebView 内核重试'
  toast(nextToast)
  const page = video.value && video.value.pages ? video.value.pages[partIdx.value] : null
  openPart(page, curTime.value || 0)
}

function detachNativeListeners() {
  for (const h of nativeListeners) {
    try { h.remove() } catch (_) { /* 忽略 */ }
  }
  nativeListeners = []
}

/** 原生内核起播（durl 直连）：极米等老投影的 WebView 崩溃根治路径 */
async function startNative(startAt = 0, dec = 'hw') {
  stopNative()
  const play = await getPlayUrl(props.bvid, curCid.value)
  mseMode.value = false
  videoUrl.value = ''
  nativeMode.value = true
  qualityId.value = play.quality
  qualities.value = play.qualities || []
  qualityLabel.value = play.qualityLabel || ''
  curCodec.value = ''
  await nextTick()
  syncNativeLayout()
  setTimeout(() => syncNativeLayout(), 400) // P9.34 D50：布局过渡态兜底重同步
  await nativeLoad({
    url: play.url,
    decoder: dec,
    render: settings.renderType,
    startSec: startAt,
    rect: (() => {
      const box = document.querySelector('.native-video-box')
      if (!box) return null
      const r = box.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height, stretch: settings.videoFit === 'stretch' }
    })()
  })
  attachNativeListeners()
  playing.value = true
  lastHistSave = 0
  startNativePoll()
  startHeartbeat()
  markLive('/play/' + props.bvid)
  console.log('[BiliTV] 原生内核起播 decoder=', dec, 'quality=', play.qualityLabel)
}

/** 离开原生内核：释放播放器、摘除渲染层、清轮询与事件 */
function stopNative() {
  stopNativePoll()
  detachNativeListeners()
  if (nativeMode.value) {
    nativeRelease()
    nativeMode.value = false
  }
}

/* ---------------- 「接下来播放」横向卡片流（P9.32 D48：菜单后 ↓ 唤出，固定最底部一行） ---------------- */

const nextVisible = ref(false)
let nextLayerPushed = false
/** 懒渲染窗口（P9.32 D48）：卡片分批渲染，焦点右移接近尾部再扩一批，避免一次性渲染全部 */
const nextCount = ref(8)

/** ↓ 唤出：底部横向卡片流，焦点进入首卡；菜单让位（固定最底部一行），↑/Esc 返回菜单 */
function openNextStrip() {
  if (!related.value.length) {
    toast('暂无接下来的播放推荐')
    return
  }
  panel.value = null // 与选集/编码等面板互斥
  nextVisible.value = true
  if (osdVisible.value) hideOsd() // 横条固定最底部，菜单让位；关闭横条时 showOsd 还原
  if (!nextLayerPushed) {
    focusEngine.pushLayer('next')
    nextLayerPushed = true
  }
  nextTick(() => {
    const first = document.querySelector('.next-strip .video-card')
    if (first) focusEngine.focus(first)
  })
}

/** 关闭横条：弹层并唤出菜单接管后续操作 */
function closeNextStrip() {
  nextVisible.value = false
  if (nextLayerPushed) {
    focusEngine.popLayer()
    nextLayerPushed = false
  }
  showOsd()
}

/** 懒加载扩批（P9.32 D48）：焦点进入横条尾部 3 张内 → 再渲染 4 张 */
function onNextFocus(e) {
  const el = e.detail
  if (!el.classList || !el.classList.contains('next-card')) return
  const cards = Array.from(document.querySelectorAll('.next-strip .video-card'))
  const idx = cards.indexOf(el)
  if (idx >= nextCount.value - 3) {
    nextCount.value = Math.min(nextCount.value + 4, related.value.length)
  }
}

// 面板与横条互斥：打开任一面板时收起「接下来播放」
watch(panel, (p) => {
  if (p && nextVisible.value) {
    nextVisible.value = false
    if (nextLayerPushed) {
      focusEngine.popLayer()
      nextLayerPushed = false
    }
  }
})

/* ---------------- 心跳上报（D20：登录态 15s，观看时长真实化） ---------------- */let hbTimer = 0
let hbLastAt = 0 // 上次心跳时刻（秒级 ts，etime 计算）

function startHeartbeat() {
  stopHeartbeat()
  if (!auth.loggedIn || !video.value || !video.value.aid) return
  hbLastAt = Math.floor(Date.now() / 1000)
  hbTimer = setInterval(() => {
    // P9.44：原生内核下没有 <video> 元素，暂停判定改看 playing / nativeMode
    if (nativeMode.value ? !playing.value || !curTime.value : true) {
      const el = videoEl.value
      if (!el || el.paused || !curTime.value) return // 暂停/未起播不发（避免 played_time 回退）
    }
    const now = Math.floor(Date.now() / 1000)
    const interval = now - hbLastAt
    if (interval < 10) return // tick 抖动保护
    hbLastAt = now
    heartBeat(video.value.aid, curCid.value, el.currentTime, interval, 0, 1)
      .then(() => hbProbe(`ok aid=${video.value.aid} t=${Math.floor(el.currentTime)}`))
      .catch((err) => hbProbe(`fail ${err.code || ''} ${err.message}`))
  }, 15000)
}

/** heartbeat 探针（CDP 验证用） */
function hbProbe(msg) {
  try {
    if (!Array.isArray(window.__hbDebug)) window.__hbDebug = []
    window.__hbDebug.push(`${Math.floor(Date.now() / 1000)} ${msg}`)
    if (window.__hbDebug.length > 30) window.__hbDebug.shift()
  } catch (_) { /* 忽略 */ }
}

function stopHeartbeat() {
  if (hbTimer) {
    clearInterval(hbTimer)
    hbTimer = 0
    // 结束信号（best-effort，静默）
    if (auth.loggedIn && video.value && video.value.aid && curTime.value) {
      const now = Math.floor(Date.now() / 1000)
      heartBeat(video.value.aid, curCid.value, curTime.value, Math.max(1, now - hbLastAt), 0, 2).catch(() => {})
    }
  }
}

/** <video> 媒体错误：把错误码可视化（1 中断 / 2 网络 / 3 解码 / 4 格式不支持） */
function onVideoError() {
  // MSE 模式：src 生命周期由 MsePlayer 管（destroy 时 removeAttribute+load 必触发 error），
  // 降级逻辑走 onFatal 回调，此处直接忽略避免误报
  if (mseMode.value) return
  const el = videoEl.value
  // 空 src guard：<video src=""> 初始渲染必然触发 code 4（空串被当作页面自身 URL），
  // 非真实错误（见 docs/03 D16）——否则每次打开视频都会误弹「格式不支持」
  if (!el || !el.src || el.src === location.href || el.src.endsWith('/')) return
  const err = el && el.error
  const map = { 1: '加载中断', 2: '网络错误', 3: '解码失败', 4: '格式或地址不支持' }
  const text = err ? `${map[err.code] || '未知错误'}(${err.code})` : '未知错误'
  console.error('[BiliTV] video error:', text, 'src=', el && el.src)
  toastError(new Error(`视频加载失败：${text}`))
  showOsd()
}

/** 媒体事件跟踪：输出到 logcat 便于诊断 WebView 播放链路（loadstart/canplay/playing 等） */
function traceEvt(e) {
  const el = videoEl.value
  console.log(
    '[BiliTV] video event:', e.type,
    'readyState=', el && el.readyState,
    'networkState=', el && el.networkState
  )
}

/** 元数据就绪：同步时长/当前时间（duration 不赋值会导致进度条 progressPct 恒为 0） */
function onLoadedMetadata() {
  const el = videoEl.value
  if (!el) return
  if (el.duration && isFinite(el.duration)) duration.value = el.duration
  curTime.value = el.currentTime
  console.log('[BiliTV] loadedmetadata: duration=', el.duration)
}

/* ---------------- 播放控制 ---------------- */

function togglePlay() {
  if (nativeMode.value) {
    // 原生内核：playing 由 stateChanged 事件/轮询同步
    if (playing.value) nativePause().catch(() => {})
    else nativePlay().catch(() => {})
    return
  }
  const el = videoEl.value
  if (!el) return
  if (el.paused) el.play().catch(() => {})
  else el.pause()
}

function seek(delta) {
  if (nativeMode.value) {
    // 原生内核：经插件 seekTo，进度由轮询回填（此处同步估算给 HUD/弹幕即时反馈）
    const target = Math.max(0, Math.min(curTime.value + delta, duration.value || Number.MAX_SAFE_INTEGER))
    nativeSeekTo(target).catch(() => {})
    curTime.value = target
    if (dmRef.value) dmRef.value.seekTo(target)
    return
  }
  const el = videoEl.value
  if (!el) return
  const t = Math.min(Math.max(0, el.currentTime + delta), el.duration || 0)
  el.currentTime = t
  curTime.value = t
  if (dmRef.value) dmRef.value.seekTo(t)
}

function setRate(r) {
  rate.value = r
  settings.playbackRate = r // D21 倍速记忆：持久化，下次播放沿用
  if (nativeMode.value) {
    nativeSetSpeed(r).catch(() => {})
    return
  }
  if (videoEl.value) videoEl.value.playbackRate = r
  panel.value = null
  focusEngine.popLayer()
}

async function pickPart(i) {
  panel.value = null
  focusEngine.popLayer()
  if (i === partIdx.value) return
  partIdx.value = i
  resumeAt = 0
  await openPart(video.value.pages[i], 0)
}

/** 收藏切换（双模式）：登录 → 云端 deal 接口（默认收藏夹）；未登录 → 本地 localStorage */
async function onFav() {
  const v = video.value
  if (!v) return
  if (auth.loggedIn) {
    if (!v.aid) {
      toastError(new Error('缺少稿件信息，无法云端收藏'))
      return
    }
    try {
      if (!folderIdCache) folderIdCache = await getDefaultFolderId()
      if (cloudFav.value) {
        await favDeal(v.aid, null, folderIdCache)
        cloudFav.value = false
        toast('已取消收藏')
      } else {
        await favDeal(v.aid, folderIdCache, null)
        cloudFav.value = true
        toast('已加入云端收藏')
      }
    } catch (err) {
      toastError(err)
    }
    return
  }
  const added = toggleFav({ bvid: v.bvid, title: v.title, pic: v.pic, owner: v.owner, duration: v.duration })
  toast(added ? '已加入收藏' : '已取消收藏')
}

/** 自动连播：播放结束 → 结束页（P9.33 D49）；开连播则倒计时后播下一个 */
const ended = ref(false)
const countdown = ref(0) // 倒计时秒数；0 = 未在倒计时
let cdTimer = 0

/** 全屏播放态（P9.42）：清零外层容器 padding，视频才能真正铺满屏幕（否则四周露灰边）。
 *  P9.44 修正：此块原先放在 setup 前段（ended 定义之前），watch 创建即求值 getter，
 *  触发 `Cannot access 'ended' before initialization`（TDZ），起播链路直接中断降级。 */
const fullscreen = computed(() => !ended.value && settings.videoFit !== 'window')
watch(
  () => fullscreen.value,
  (on) => {
    if (typeof document === 'undefined') return
    document.body.classList.toggle('play-fullscreen', !!on)
  },
  { immediate: true }
)

watch(
  () => settings.diagMark,
  (on) => {
    // P9.50 诊断：黑屏时把 body 背景强制标红——播放页视频区若变红 = WebView 不透明
    // 挡住了渲染层；仍黑 = 渲染层自身没显示（挖洞/合成问题），两个假设一次分辨
    if (typeof document === 'undefined') return
    document.body.style.background = on ? '#ff0000' : ''
  },
  { immediate: true }
)

/** 播完回到双栏后重同步渲染层几何：定格画面要跟着回到新的视频区位置 */
watch(
  () => ended.value,
  (v) => {
    if (v) nextTick(() => syncNativeLayout())
  }
)

function startCountdown() {
  clearInterval(cdTimer)
  countdown.value = settings.autoNextDelay || 5
  cdTimer = setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) playNext()
  }, 1000)
}

function cancelCountdown() {
  clearInterval(cdTimer)
  countdown.value = 0
}

function playNext() {
  cancelCountdown()
  const next = related.value[0]
  if (next) gotoVideo(next.bvid) // P9.53：连播不污染返回栈
}

function onEnded() {
  saveProgress()
  stopHeartbeat() // 心跳发 play_type=2 结束信号
  // P9.33 D49：结束页——相关推荐/视频信息出现；连播开则倒计时
  ended.value = true
  nextTick(() => syncNativeLayout()) // 布局切换（全屏→结束页）后同步渲染层几何
  if (settings.autoNext && related.value.length) {
    startCountdown()
  } else {
    nextTick(() => {
      const first = document.querySelector('.side-column .video-card')
      if (first) focusEngine.focus(first)
    })
  }
}

/** 结束态按键：倒计时中 OK=立即播下一个、BACK=取消并聚焦相关推荐首卡；无倒计时走正常导航 */
function endedKeyHandler(key) {
  if (countdown.value > 0) {
    if (key === 'Escape') {
      cancelCountdown()
      nextTick(() => {
        const f = document.querySelector('.side-column .video-card')
        if (f) focusEngine.focus(f)
      })
      return true
    }
    if (key === 'Enter') {
      playNext()
      return true
    }
  }
  return false
}

// 恢复播放（重播）→ 退出结束页回全屏
watch(playing, (p) => {
  if (p && ended.value) {
    ended.value = false
    cancelCountdown()
    nextTick(() => syncNativeLayout())
  }
})

/* ---------------- OSD ---------------- */

/**
 * P9.44：判断焦点是否已在 OSD 的最后一行（下方没有同分区可聚焦元素）。
 * 用于把「↓ 唤出接下来播放」限制在最后一行触发，避免抢走 OSD 内部的空间导航。
 */
function isOsdLastRow() {
  const cur = focusEngine.current
  if (!cur || !cur.getBoundingClientRect) return true
  const cr = cur.getBoundingClientRect()
  let maxBottom = cr.bottom
  document.querySelectorAll('[data-focus-zone="osd"] [data-focusable], [data-focus-zone="osd"] [v-focusable]').forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.bottom > maxBottom) maxBottom = r.bottom
  })
  return cr.bottom >= maxBottom - 8
}

function showOsd() {
  if (osdVisible.value) return
  osdVisible.value = true
  nextTick(() => {
    // P9.44：pushLayer 补 onClose——任何关闭路径（硬件返回/UI/Esc）都同步清状态，
    // 避免 osd 层残留导致返回键要按多次才退出播放页
    focusEngine.pushLayer('osd', null, () => { osdVisible.value = false })
  })
  armOsdTimer()
}

/**
 * P9.44：关闭 OSD——只弹**当前栈顶确为 osd 层**的那层，避免误弹上层面板/弹窗
 * （原实现无条件 popLayer，会把别的层弹掉，焦点与层级错位）
 */
function closeOsdLayer() {
  const stack = focusEngine.layerStack
  const top = stack && stack.length ? stack[stack.length - 1] : null
  if (!top || top.zone !== 'osd') return false
  focusEngine.popLayer()
  return true
}

function hideOsd() {
  // 若焦点在 OSD 内先解除，避免 popLayer 归还焦点到即将隐藏的元素
  if (focusEngine.current && focusEngine.current.closest && focusEngine.current.closest('[data-focus-zone="osd"]')) {
    focusEngine.current.classList.remove('tv-focused')
    focusEngine.current = null
  }
  const stack = focusEngine.layerStack
  const top = stack[stack.length - 1]
  if (top && top.trigger && top.trigger.closest && top.trigger.closest('[data-focus-zone="osd"]')) {
    top.trigger = null
  }
  closeOsdLayer() // P9.44：栈顶校验，避免误弹其它层
  osdVisible.value = false
}

function armOsdTimer() {
  clearTimeout(osdTimer)
  osdTimer = setTimeout(() => {
    // P9.32 D48：暂停态菜单常驻（用户点暂停即为了操作菜单）；播放中才自动隐藏
    if (osdVisible.value && !panel.value && playing.value) hideOsd()
  }, 5000)
}

/* ---------------- 鼠标 / 键盘直接操作（调试与应急输入通道） ---------------- */

/** 音量步进（元素音量 0~1，与系统媒体音量独立） */
function changeVolume(delta) {
  const el = videoEl.value
  if (!el) return
  el.muted = false
  el.volume = Math.min(1, Math.max(0, Math.round((el.volume + delta) * 100) / 100))
  toast(`音量 ${Math.round(el.volume * 100)}%`)
}

/** 静音切换 */
function toggleMute() {
  const el = videoEl.value
  if (!el) return
  el.muted = !el.muted
  toast(el.muted ? '已静音' : '取消静音')
}

/** 鼠标移动/触屏滑动：唤出 OSD 并续期自动隐藏（面板打开时不抢焦点层） */
function onPointerMove() {
  if (panel.value) return
  if (!osdVisible.value) showOsd()
  else armOsdTimer()
}

/**
 * 按下即出菜单（P9.28 D44）：touchstart（模拟器把鼠标映射为触摸）+ mousedown
 * （真鼠标但不发 mousemove 的环境）双通道，按下瞬间给"菜单弹出"的即时反馈；
 * 随后合成的 click 走 OK 键语义（暂停+续期菜单）。重复触发幂等无副作用。
 */
function onPointerDown() {
  if (panel.value) return
  if (osdVisible.value) armOsdTimer()
  else showOsd()
}

/**
 * 点击视频区（P9.28 D44）：同遥控器 OK 键——暂停/继续，同时弹出播放控制菜单。
 * （P9.26 只做了暂停，MuMu 实测"没任何反馈"的感知 = 暂停无菜单可操作，补齐弹菜单）
 * 菜单唤出走 mousemove（真鼠标）/ pointerdown 家族（模拟器触摸）通道；
 * 点击落在 .osd/.part-loading 内的由按钮自身 @click 处理，此处跳过。
 */
function onVideoClick(e) {
  if (e.target && e.target.closest && e.target.closest('.osd, .part-loading')) return
  togglePlay()
  if (osdVisible.value) armOsdTimer()
  else showOsd()
}

/** 点击进度条：seek 到对应位置 */
function onTrackClick(e) {
  const el = videoEl.value
  if (!el || !el.duration || !isFinite(el.duration)) return
  const rect = e.currentTarget.getBoundingClientRect()
  const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  const t = pct * el.duration
  el.currentTime = t
  curTime.value = t
  if (dmRef.value) dmRef.value.seekTo(t)
  armOsdTimer()
}

/* ---------------- 长按连进 seek（D38，bbll 式） ---------------- */

/**
 * 短按/长按状态机：
 *  - keydown 首次（e.repeat=false）：立即 ±10s（短按即时反馈）+ 启动 450ms 长按判定
 *  - 450ms 无 keyup：进入连进（220ms/次，步长 30s 起逐次 +30s、封顶 120s，越按越快）
 *  - keyup 任何时刻结束连进；e.repeat=true 的 keydown 忽略（步进由自有定时器驱动，
 *    不依赖系统 repeat 速率——遥控器与键盘 repeat 不可控）
 */
const seekHud = ref(null) // { dir: -1|1, step: number, t: number } 连进/短按反馈浮层
let hpDir = 0 // 当前按住方向（0=无）
let hpDelayTimer = 0
let hpRepeatTimer = 0
let hpSteps = 0
let hudFadeTimer = 0
const HP_DELAY = 450
const HP_INTERVAL = 220
const HUD_FADE = 1200

/** 连进模式单次步进 */
function holdSeekStep() {
  const step = Math.min(30 * hpSteps, 120)
  seek(hpDir * step)
  hpSteps++
  showSeekHud(hpDir, step)
}

/** 启动按住快进/快退 */
function startHoldSeek(dir) {
  stopHoldSeek() // 防重入（换向快速连按场景）
  hpDir = dir
  seek(dir * 10) // 首次立即 ±10s
  showSeekHud(dir, 10)
  hpDelayTimer = setTimeout(() => {
    hpSteps = 1
    holdSeekStep()
    hpRepeatTimer = setInterval(holdSeekStep, HP_INTERVAL)
  }, HP_DELAY)
}

/** 结束按住（keyup / 换向 / 面板打开） */
function stopHoldSeek() {
  clearTimeout(hpDelayTimer)
  clearInterval(hpRepeatTimer)
  hpDelayTimer = 0
  hpRepeatTimer = 0
  hpDir = 0
  hpSteps = 0
}

/** Seek HUD：显示后 1.2s 无操作淡出；连进期间持续刷新重置计时 */
function showSeekHud(dir, step) {
  // 原生内核下 videoEl 为 null，目标时间取 curTime（seek() 已同步估算/轮询回填）
  const t = nativeMode.value ? curTime.value : (videoEl.value ? videoEl.value.currentTime : 0)
  seekHud.value = { dir, step, t: Math.max(0, t) }
  clearTimeout(hudFadeTimer)
  hudFadeTimer = setTimeout(() => (seekHud.value = null), HUD_FADE)
}

/* ---------------- 按键拦截（OSD 隐藏态接管方向键） ---------------- */

function playerKeyHandler(key, e) {
  // P9.33 D49：结束态——倒计时中 OK=立即播下一个、BACK=取消；其余交给结束页导航
  if (ended.value && endedKeyHandler(key) === true) return true
  if (panel.value) {
    stopHoldSeek()
    // P9.30 D46：面板打开时 Esc/返回键关闭面板（硬件返回路径 back() → 拦截器同样生效）
    if (key === 'Escape') {
      closePanel()
      return true
    }
    return false // 其余按键交给引擎在面板分区导航
  }

  // 全局播放键（OSD 开/关态均生效）：空格 = 播放/暂停、M = 静音、音量键 = ±5%
  // （键盘/鼠标为调试与应急输入通道；焦点引擎不消费这些键，此处优先接管）
  const k = key.length === 1 ? key.toLowerCase() : key
  if (k === ' ') {
    togglePlay()
    return true
  }
  if (k === 'm') {
    toggleMute()
    return true
  }
  if (key === 'VolumeUp') {
    changeVolume(0.05)
    return true
  }
  if (key === 'VolumeDown') {
    changeVolume(-0.05)
    return true
  }

  if (osdVisible.value) {
    armOsdTimer()
    if (key === 'Escape') {
      // 返回键关闭 OSD（面板打开时走上面分支由引擎弹栈）
      hideOsd()
      return true
    }
    if (key === 'ArrowDown') {
      // P9.32 D48：菜单显示态 ↓ → 底部弹出「接下来播放」横条（菜单让位）
      // P9.44 修正（阻塞）：原先无条件拦截 ↓，OSD 内**永远拿不到向下导航**——
      // .osd-controls 在 720p/窗口模式下换行成两行时，第二行按钮（选集/倍速/弹幕/连播）
      // 遥控器根本选不中。现在只有焦点已在 OSD 最后一行（下方无可聚焦元素）才唤出横条。
      if (!isOsdLastRow()) return false
      openNextStrip()
      return true
    }
    return false // OSD 显示：引擎在 osd 分区导航
  }

  // 「接下来播放」横条（P9.32 D48）：打开时优先接管按键——Esc/↑/↓ 关闭还原菜单，
  // ←/→/OK 交给引擎在卡片间横移/选卡（必须先于下方 seek 分支，否则左右键被快进吃掉）
  if (nextVisible.value) {
    if (key === 'Escape' || key === 'ArrowUp' || key === 'ArrowDown') {
      closeNextStrip()
      return true
    }
    return false
  }

  // P9.44 修正（阻塞）：结束页/相关推荐下方向键必须交给空间导航。
  // 原逻辑把 ←/→ 一律当 ±10s 快进，于是焦点在「相关推荐」纵向列表时按左右键
  // 不是移动焦点而是快进已结束的视频并弹 HUD（倒计时期间同样）。
  if (ended.value) return false

  // OSD 隐藏态：bbll 式 seek 语义优先于焦点空间导航——
  // ←/→ 短按 ±10s、长按连进（450ms 判定，越按越快）；e.repeat 的自动重复一律忽略
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (e && e.repeat) return true // 系统自动重复：吃掉，步进由自有定时器驱动
      startHoldSeek(key === 'ArrowRight' ? 1 : -1)
      return true
    }
    case 'MediaTrackNext':
      seek(30)
      return true
    case 'MediaTrackPrevious':
      seek(-30)
      return true
  }

  // 焦点在相关推荐卡片上：上下键在卡片间移动、OK 打开卡片，交给引擎空间导航
  const cur = focusEngine.current
  if (cur && cur.closest && cur.closest('.side-column')) return false

  switch (key) {
    case 'ArrowUp':
    case 'ArrowDown':
      // P9.32 D48：隐藏态 ↑/↓ 统一先唤出底部菜单；↓ 再按一次弹出「接下来播放」横条
      showOsd()
      return true
    case 'Enter':
      // P9.30 D46：OK = 暂停/继续 + 弹出控制菜单（bbll 式；纯暂停无菜单被感知为"没反应"）
      togglePlay()
      showOsd()
      return true
    case 'MediaPlayPause':
      togglePlay()
      return true
    default:
      return false // Escape 等 → 引擎 back() → 路由回退
  }
}

/* ---------------- 视频事件与历史 ---------------- */

function onTimeUpdate() {
  const el = videoEl.value
  if (!el) return
  // 兜底：loadedmetadata 早于页面挂载时 duration 可能漏记，timeupdate 阶段补齐
  if (!duration.value && el.duration && isFinite(el.duration)) duration.value = el.duration
  curTime.value = el.currentTime
  // 每 5 秒保存一次进度
  if (el.currentTime - lastHistSave > 5 || el.currentTime < lastHistSave) {
    lastHistSave = el.currentTime
    saveProgress()
    markLive('/play/' + props.bvid) // 存活面包屑（D39 崩溃自愈判定源）
  }
}

function saveProgress() {
  const v = video.value
  // P9.44 修复（阻塞）：原生内核是 Z7X 的主路径，此时 <video> 不渲染、videoEl 恒为 null，
  // 原 `!el` 判断导致进度**永不落历史**（退出后无法续播）。原生模式改用轮询回填的 curTime。
  const t = nativeMode.value ? curTime.value : videoEl.value ? videoEl.value.currentTime : 0
  if (!v || !t) return
  histAdd(
    { bvid: v.bvid, title: v.title, pic: v.pic, owner: v.owner, duration: v.duration },
    curCid.value,
    v.pages[partIdx.value] ? v.pages[partIdx.value].page : 1,
    t
  )
  // 登录态：同步上报云端观看历史（静默失败，不干扰本地记录）
  if (auth.loggedIn && v.aid) {
    reportHistory(v.aid, curCid.value, Math.floor(t)).catch(() => {})
  }
}

/* ---------------- 生命周期 ---------------- */

/** keyup：结束长按连进（引擎只监听 keydown，keyup 由本页直接接管） */
function onKeyUp(e) {
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && hpDir) stopHoldSeek()
}

/** 窗口尺寸变化：原生渲染层几何同步 */
function onWinResize() {
  syncNativeLayout()
}

onMounted(() => {
  load()
  removeInterceptor = focusEngine.addInterceptor(playerKeyHandler)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('resize', onWinResize)
  window.addEventListener('tvfocuschange', onNextFocus) // 横条懒加载扩批
  // CDP 调试探针（P9.26）：自动化验证/远程诊断读取播放状态
  window.__tvDebug = {
    get playing() { return playing.value },
    get nativeMode() { return nativeMode.value },
    get t() { return curTime.value },
    get dur() { return duration.value },
    get ended() { return ended.value },
    seek(s) { seek(s) }
  }
})

onUnmounted(() => {
  saveProgress()
  stopNative()
  destroyMse()
  stopHoldSeek()
  cancelCountdown() // P9.33 D49：离页清倒计时
  clearTimeout(hudFadeTimer)
  if (removeInterceptor) removeInterceptor()
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('resize', onWinResize)
  window.removeEventListener('tvfocuschange', onNextFocus)
  clearTimeout(osdTimer)
  releaseHole() // P9.41 D55：摘除原生播放「挖洞」，恢复其它页面的不透明背景
  delete window.__tvDebug
})
</script>

<template>
  <div class="player-page" data-focus-zone="content">
    <StateBlock v-if="state === 'loading'" state="loading" />
    <StateBlock v-else-if="state === 'error'" state="error" :message="errMsg" @retry="load" />

    <div
      v-else
      class="player-layout"
      :class="{ 'play-full': !ended && settings.videoFit !== 'window', 'play-stretch': !ended && settings.videoFit === 'stretch' }"
    >
      <!-- 左：播放器 + 信息（播放中仅视频全屏；结束后出现信息区与相关推荐） -->
      <div class="video-column">
        <div
          class="video-wrap"
          @mousemove="onPointerMove"
          @touchstart.passive="onPointerDown"
          @mousedown.passive="onPointerDown"
          @click="onVideoClick"
        >
          <video
            v-if="videoUrl || mseMode"
            ref="videoEl"
            class="video-el"
            v-bind="videoUrl ? { src: videoUrl } : {}"
            playsinline
            @error="onVideoError"
            @loadstart="traceEvt"
            @loadedmetadata="onLoadedMetadata"
            @canplay="traceEvt"
            @playing="traceEvt"
            @stalled="traceEvt"
            @timeupdate="onTimeUpdate"
            @play="playing = true"
            @pause="playing = false"
            @ended="onEnded"
          ></video>

          <DanmakuLayer
            v-if="videoUrl || mseMode || nativeMode"
            ref="dmRef"
            :video-el="videoEl"
            :native-mode="nativeMode"
            :native-time="curTime"
            :native-playing="playing"
            :cid="curCid"
            :enabled="settings.danmaku"
            :opacity="settings.danmakuOpacity"
            :font-size-scale="settings.dmFontSize"
            :area="settings.dmArea"
            :speed-scale="settings.dmSpeed"
            :density="settings.dmDensity"
            :show-scroll="settings.dmScroll"
            :show-top="settings.dmTop"
            :show-bottom="settings.dmBottom"
          />

          <!-- 原生渲染占位盒（D39）：TextureView 精确覆盖此区域 -->
          <div v-if="nativeMode" class="native-video-box"></div>

          <!-- 结束页倒计时条（P9.33 D49）：连播开启时播完显示；BACK 取消、OK 立即播下一个 -->
          <div v-if="ended && countdown > 0 && related.length" class="end-countdown">
            <span class="cd-num">{{ countdown }}s</span> 后播放：{{ related[0].title }}
            <span class="cd-hint">返回键取消 · OK 立即播放</span>
          </div>

          <!-- 「接下来播放」横向卡片流（P9.32 D48，↓ 唤出）：卡片分批懒渲染 -->
          <div v-if="nextVisible && related.length" class="next-strip" data-focus-zone="next">
            <div class="next-title">接下来播放</div>
            <div class="next-scroll">
              <VideoCard v-for="item in related.slice(0, nextCount)" :key="item.bvid" :item="item" class="next-card" replace />
            </div>
          </div>

          <!-- Seek HUD（D38 长按连进/短按反馈） -->
          <div v-if="seekHud" class="seek-hud">
            <span class="hud-arrows">{{ seekHud.dir > 0 ? '»»' : '««' }}</span>
            <span class="hud-step">{{ seekHud.step }}s</span>
            <span class="hud-time">→ {{ fmtClock(seekHud.t) }}</span>
          </div>

          <!-- OSD 覆盖层 -->
          <div v-if="osdVisible" class="osd" data-focus-zone="osd">
            <div class="osd-top">
              <button v-focusable class="osd-back" @click="routeBack">← 返回</button>
              <span class="osd-title">{{ video.title }}</span>
              <span v-if="qualityLabel" class="osd-quality">{{ qualityLabel }}</span>
            </div>
            <div class="osd-bottom">
              <div class="progress-track" @click.stop="onTrackClick">
                <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
              </div>
              <div class="osd-time">{{ curText }} / {{ durText }}</div>
              <div class="osd-controls">
                <!-- P9.44：默认焦点落在「播放/暂停」而非左上角返回键
                     （原默认取分区首个可聚焦元素 = 返回，误按两次 OK 就退出播放页） -->
                <button v-focusable class="osd-btn" data-autofocus @click="togglePlay">
                  {{ playing ? '⏸ 暂停' : '▶ 播放' }}
                </button>
                <button v-focusable class="osd-btn" @click="openPanel('info')">ℹ 视频信息</button>
                <button
                  v-if="qualities.length > 1"
                  v-focusable
                  class="osd-btn"
                  @click="openPanel('quality')"
                >
                  {{ qualityLabel || '清晰度' }}
                </button>
                <button
                  v-focusable
                  class="osd-btn"
                  @click="openPanel('codec')"
                >
                  编码{{ codecName ? ' · ' + codecName : '' }}
                </button>
                <button v-focusable class="osd-btn" @click="openPanel('decoder')">
                  解码器{{ decoderShortName ? ' · ' + decoderShortName : '' }}
                </button>
                <button v-focusable class="osd-btn" @click="navigate('settings')">⚙ 设置</button>
                <button v-focusable class="osd-btn" @click="openPanel('episodes')">
                  选集
                </button>
                <button v-focusable class="osd-btn" @click="openPanel('rate')">
                  {{ rate }}x
                </button>
                <button
                  v-focusable
                  class="osd-btn"
                  :class="{ on: settings.danmaku }"
                  @click="settings.danmaku = !settings.danmaku"
                >
                  弹幕 {{ settings.danmaku ? '开' : '关' }}
                </button>
                <button
                  v-focusable
                  class="osd-btn"
                  @click="openPanel('dmset')"
                >
                  弹幕设置
                </button>
                <button
                  v-focusable
                  class="osd-btn"
                  :class="{ on: settings.autoNext }"
                  @click="settings.autoNext = !settings.autoNext"
                >
                  连播 {{ settings.autoNext ? '开' : '关' }}
                </button>
              </div>
            </div>
          </div>

          <!-- 加载分 P 提示 -->
          <div v-if="partLoading" class="part-loading"><div class="spinner"></div></div>
        </div>

        <!-- 视频信息（P9.33 D49：仅结束页显示，播放中隐藏） -->
        <div class="video-info" v-if="ended">
          <div class="info-main">
            <div class="info-title">{{ video.title }}</div>
            <div class="info-meta">
              <span>{{ video.owner.name }}</span>
              <span>{{ fmtCount(video.stat.view) }} 播放</span>
              <span>{{ fmtCount(video.stat.danmaku) }} 弹幕</span>
              <span v-if="qualityLabel">{{ qualityLabel }}</span>
            </div>
          </div>
          <div class="info-actions">
            <button v-focusable class="info-btn" @click="routeBack">← 返回</button>
            <button v-focusable class="info-btn" :class="{ on: fav }" data-autofocus @click="onFav">
              {{ fav ? '★ 已收藏' : '☆ 收藏' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 右：相关推荐（P9.33 D49：仅结束页显示） -->
      <div class="side-column" v-if="ended && related.length">
        <div class="side-title">相关推荐</div>
        <div class="side-list">
          <VideoCard v-for="item in related.slice(0, 20)" :key="item.bvid" :item="item" class="side-card" replace />
        </div>
      </div>
    </div>

    <!-- 选集面板（模态层） -->
    <div v-if="panel === 'episodes'" class="modal-mask">
      <div class="modal-panel" data-focus-zone="panel">
        <!-- 合集模式（P9.24 D41）：显示 ugc_season 全部分集，点击跳转对应视频 -->
        <template v-if="video.season">
          <div class="modal-title">合集 · {{ video.season.title }}（共 {{ video.season.eps.length }} 集）</div>
          <div class="ep-list">
            <div
              v-for="(ep, i) in video.season.eps"
              :key="ep.bvid + '-' + i"
              v-focusable
              class="ep-item"
              :class="{ cur: ep.bvid === props.bvid }"
              :data-autofocus="ep.bvid === props.bvid ? '' : undefined"
              @click="gotoVideo(ep.bvid)"
            >
              {{ i + 1 }}. {{ ep.title }}
            </div>
          </div>
        </template>
        <!-- 分 P 模式：单视频多分 P -->
        <template v-else>
          <div class="modal-title">选集（共 {{ video.pages.length }}P）</div>
          <div class="ep-list">
            <div
              v-for="(p, i) in video.pages"
              :key="p.cid"
              v-focusable
              class="ep-item"
              :class="{ cur: i === partIdx }"
              :data-autofocus="i === partIdx ? '' : undefined"
              @click="pickPart(i)"
            >
              {{ p.part }}
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 清晰度面板（模态层，P8 D19：仅 DASH 模式，切码流无缝续播） -->
    <div v-if="panel === 'quality'" class="modal-mask">
      <div class="modal-panel" data-focus-zone="panel">
        <div class="modal-title">播放清晰度</div>
        <div class="rate-list">
          <div
            v-for="q in qualities"
            :key="q.id"
            v-focusable
            class="rate-item"
            :class="{ cur: q.id === qualityId }"
            :data-autofocus="q.id === qualityId ? '' : undefined"
            @click="onQualityPick(q.id)"
          >
            {{ q.label }}
          </div>
        </div>
      </div>
    </div>

    <!-- 编码面板（模态层，D36 仅当前视频） -->
    <div v-if="panel === 'codec'" class="modal-mask">
      <div class="modal-panel" data-focus-zone="panel">
        <div class="modal-title">播放编码（仅当前视频）</div>
        <div class="rate-list">
          <div
            v-for="c in codecOptions"
            :key="c.key"
            v-focusable
            class="rate-item"
            :class="{ cur: c.key === curCodecKey, dim: !c.avail }"
            :data-autofocus="c.key === curCodecKey ? '' : undefined"
            @click="c.avail && pickCodec(c.key)"
          >
            {{ c.label }}{{ !c.avail ? '（本视频未提供）' : '' }}
          </div>
        </div>
      </div>
    </div>

    <!-- 倍速面板（模态层） -->
    <div v-if="panel === 'rate'" class="modal-mask">
      <div class="modal-panel" data-focus-zone="panel">
        <div class="modal-title">播放倍速</div>
        <div class="rate-list">
          <div
            v-for="r in RATES"
            :key="r"
            v-focusable
            class="rate-item"
            :class="{ cur: rate === r }"
            :data-autofocus="rate === r ? '' : undefined"
            @click="setRate(r)"
          >
            {{ r }}x
          </div>
        </div>
      </div>
    </div>

    <!-- 解码器面板（P9.36 D52）：切换后从当前进度重新加载 -->
    <div v-if="panel === 'decoder'" class="modal-mask">
      <div class="modal-panel" data-focus-zone="panel">
        <div class="modal-title">解码器（切换后从当前进度重载）</div>
        <div class="rate-list">
          <div
            v-for="d in DECODER_OPTS"
            :key="d.v"
            v-focusable
            class="rate-item"
            :class="{ cur: settings.decoder === d.v }"
            :data-autofocus="settings.decoder === d.v ? '' : undefined"
            @click="applyDecoder(d.v)"
          >
            {{ d.label }}
          </div>
        </div>
      </div>
    </div>

    <!-- 视频信息面板（P9.32 D48） -->
    <div v-if="panel === 'info'" class="modal-mask">
      <div class="modal-panel info-panel" data-focus-zone="panel">
        <div class="modal-title">视频信息</div>
        <div v-if="video" class="info-list">
          <div class="info-line title">{{ video.title }}</div>
          <div class="info-line">
            UP主：
            <span v-focusable class="info-up" @click="gotoUpFromInfo">{{ video.owner.name }} ›</span>
            <span class="dim">（ID {{ video.owner.mid }}，点击看投稿）</span>
          </div>
          <div class="info-line">
            发布：{{ pubDateText }}
            <template v-if="video.duration"> · 时长 {{ fmtClock(video.duration) }}</template>
          </div>
          <div class="info-line">
            {{ fmtCount(video.stat.view) }} 播放 · {{ fmtCount(video.stat.danmaku) }} 弹幕<template v-if="video.stat.like"> · {{ fmtCount(video.stat.like) }} 点赞</template>
          </div>
          <div class="info-line" v-if="video.pages && video.pages.length > 1">共 {{ video.pages.length }} 个分P</div>
          <!-- P9.49 性能探针：判定「解码跟不上」还是「合成/内存被吃掉」 -->
          <div class="info-line" v-if="perfText">播放状态：{{ perfText }}</div>
          <div class="info-line" v-if="video.season">合集：{{ video.season.title }}（共 {{ video.season.eps.length }} 集）</div>
          <div class="info-line desc" v-if="video.desc">简介：{{ video.desc }}</div>
        </div>
        <div class="confirm-row">
          <button v-focusable class="tab-item" data-autofocus @click="closePanel">关闭</button>
        </div>
      </div>
    </div>

    <!-- 弹幕设置面板（模态层，bbll 风格档位，见 docs/03 D15） -->
    <div v-if="panel === 'dmset'" class="modal-mask">
      <div class="modal-panel dm-panel" data-focus-zone="panel">
        <div class="modal-title">弹幕设置</div>
        <div class="dm-opts">
          <div v-for="row in dmOptRows" :key="row.key" class="dm-row">
            <span class="dm-label">{{ row.label }}</span>
            <div class="dm-vals">
              <div
                v-for="v in row.values"
                :key="v.v"
                v-focusable
                class="dm-val"
                :class="{ cur: row.get() === v.v }"
                :data-autofocus="row.get() === v.v ? '' : undefined"
                @click="row.set(v.v)"
              >
                {{ v.name }}
              </div>
            </div>
          </div>
          <div v-for="row in dmSwitchRows" :key="row.key" class="dm-row">
            <span class="dm-label">{{ row.label }}</span>
            <div class="dm-vals">
              <div
                v-for="b in [true, false]"
                :key="String(b)"
                v-focusable
                class="dm-val"
                :class="{ cur: row.get() === b }"
                :data-autofocus="row.get() === b ? '' : undefined"
                @click="row.set(b)"
              >
                {{ b ? '开' : '关' }}
              </div>
            </div>
          </div>
        </div>
        <button v-focusable class="dm-done" data-autofocus @click="closeDmSet">完成</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.player-page {
  height: 100%;
}

.player-layout {
  display: flex;
  gap: 26px;
  height: 100%;
}

/* 全屏播放态（P9.33 D49）：隐藏信息区与相关推荐，视频铺满整屏；结束后恢复双栏 */
.player-layout.play-full {
  gap: 0;
}

/* 全屏播放态（P9.42 修订）：脱离 flex 流贴死视口四边，
   只写 height:100vh 会被外层 content-area 的 padding 挤出一圈页面底色 */
.play-full .video-wrap {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;  /* P9.51: inset 在 Android 9 Chromium 69 无效 */
  width: 100vw;
  height: 100vh;
  max-height: none;
  aspect-ratio: auto;
  border-radius: 0;
  overflow: hidden;
  z-index: 1;
}

.play-full .video-info,
.play-full .side-column {
  display: none;
}

/* 窗口兼容模式（P9.34 D50）：16:9 窗口 + 双栏页面（老设备渲染层异常回退），
   video-wrap 高度由 aspect-ratio 决定，渲染层几何按实测同步 */
.player-layout.play-stretch .video-wrap {
  aspect-ratio: auto;
}

/* 结束页倒计时条（P9.33 D49）：视频区顶部，配合原生层调暗可见 */
.end-countdown {
  position: absolute;
  top: 4%;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  background: rgba(0, 0, 0, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  padding: 12px 20px;
  font-size: 20px;
  color: var(--text);
  white-space: nowrap;
  max-width: 90%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.end-countdown .cd-num {
  color: var(--accent);
  font-weight: 700;
  font-size: 24px;
}

.end-countdown .cd-hint {
  margin-left: 14px;
  font-size: 15px;
  color: var(--text-dim);
}

.video-column {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.video-wrap {
  position: relative;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
  max-height: 72vh;
  /* P9.51：Android 9（Chromium 69）不支持 aspect-ratio → 视频区高度塌陷成 0/异常，
     先以 padding-top: 56.25% 撑出 16:9（内部元素均为 absolute 四边定位，铺满 padding box
     即为正确区域）；支持 aspect-ratio 的环境再切回原生属性并清掉 padding */
  height: 0;
  padding-top: 56.25%;
}

@supports (aspect-ratio: 16 / 9) {
  .video-wrap {
    height: auto;
    padding-top: 0;
    aspect-ratio: 16 / 9;
  }
}

.video-el {
  width: 100%;
  height: 100%;
  display: block;
  background: #000;
  /* P9.44：结束态下 aspect-ratio 与 max-height 同时生效时画面被拉伸变形 */
  object-fit: contain;
}

/* 原生渲染占位盒（D39 / D55 层级翻转）：TextureView 覆盖此区域。
   D55 起渲染层沉到 WebView 之下，占位盒必须透明，视频画面才能透出来；
   非原生（MSE/WebView 播放）路径下 video 元素自带黑底，不受影响。 */
.native-video-box {
  width: 100%;
  height: 100%;
  background: #000;
}

/* 原生播放态「挖洞」：body 透明后视频区不能有任何底色，否则会盖住下层渲染画面。
   play-full 时视频铺满整屏，信息区本就 display:none，这里补底色兜底结束页双栏。 */
body.native-play .native-video-box,
body.native-play .video-wrap,
body.native-play .video-el {
  background: transparent;
}

body.native-play .video-info,
body.native-play .side-column {
  background: var(--bg);
}

/* 「接下来播放」横向卡片流（P9.23）：视频底部覆盖层，←/→ 引擎横向导航卡片 */
.next-strip {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 15;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.88) 34%);
  padding: 30px 20px 16px;
}

.next-strip .next-title {
  color: #fff;
  font-size: 21px;
  font-weight: 700;
  margin-bottom: 12px;
}

.next-strip .next-scroll {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 4px;
}

.next-strip .next-card {
  flex: 0 0 300px;
}

.part-loading {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;  /* P9.51: inset 在 Android 9 Chromium 69 无效 */
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}

/* ---------- OSD ---------- */

/* Seek HUD（D38）：中下胶囊浮层，连进时持续刷新 */
.seek-hud {
  position: absolute;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.78);
  border-radius: 34px;
  padding: 12px 26px;
  display: flex;
  align-items: center;
  gap: 12px;
  z-index: 20;
  pointer-events: none;
}

.seek-hud .hud-arrows {
  color: var(--accent);
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 2px;
}

.seek-hud .hud-step {
  color: #fff;
  font-size: 22px;
  font-weight: 600;
}

.seek-hud .hud-time {
  color: rgba(255, 255, 255, 0.75);
  font-size: 19px;
}

.osd {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;  /* P9.51: inset 在 Android 9 Chromium 69 无效 */
  z-index: 20;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.55), transparent 30%, transparent 60%, rgba(0, 0, 0, 0.72));
  padding: 20px 24px;
}

.osd-title {
  font-size: 24px;
  color: #fff;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.osd-top {
  display: flex;
  align-items: center;
  gap: 14px;
}

.osd-quality {
  padding: 3px 12px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 16px;
  flex-shrink: 0;
}

.osd-bottom {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.progress-track {
  height: 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  overflow: hidden;
  cursor: pointer;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
}

.osd-time {
  color: rgba(255, 255, 255, 0.85);
  font-size: 19px;
}

.osd-controls {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}

.osd-btn {
  min-height: 58px;
  padding: 0 26px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 21px;
  display: inline-flex;
  align-items: center;
}

.osd-btn.on {
  background: var(--accent);
}

/* ---------- 信息区 ---------- */

.video-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 26px;
  padding: 20px 4px 0;
}

.info-title {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.4;
}

.info-meta {
  margin-top: 10px;
  display: flex;
  gap: 22px;
  color: var(--text-dim);
  font-size: 19px;
}

.info-btn {
  min-height: 60px;
  padding: 0 34px;
  border-radius: 10px;
  background: var(--bg-card);
  color: var(--text-dim);
  font-size: 22px;
  flex-shrink: 0;
}

.info-btn.on {
  color: var(--accent-pink);
  background: rgba(251, 114, 153, 0.12);
}

/* ---------- 相关推荐 ---------- */

.side-column {
  width: 360px;
  flex-shrink: 0;
  overflow-y: auto;
  height: 100%;
}

.side-title {
  font-size: 23px;
  font-weight: 700;
  margin-bottom: 16px;
  color: var(--text-dim);
}

.side-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 选集 / 倍速面板 */
.ep-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ep-item {
  padding: 16px 22px;
  border-radius: 10px;
  background: var(--bg-panel);
  font-size: 22px;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ep-item.cur {
  color: var(--accent);
}

.rate-list {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}

.rate-item {
  padding: 16px 30px;
  border-radius: 10px;
  background: var(--bg-panel);
  font-size: 22px;
}

.rate-item.cur {
  color: var(--accent);
}

/* 弹幕设置面板（bbll 风格档位行） */
.dm-panel {
  min-width: 640px;
  max-height: 82%;
  overflow-y: auto;
}

.dm-opts {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 6px 0 18px;
}

.dm-row {
  display: flex;
  align-items: center;
  gap: 18px;
}

.dm-label {
  width: 120px;
  flex-shrink: 0;
  font-size: 21px;
  color: var(--text-dim);
  text-align: right;
}

.dm-vals {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.dm-val {
  padding: 10px 22px;
  border-radius: 10px;
  background: var(--bg-panel);
  font-size: 21px;
}

.dm-val.cur {
  color: var(--accent);
  background: var(--bg-hover);
}

.dm-done {
  align-self: center;
  padding: 12px 52px;
  border-radius: 10px;
  background: #fb7299;
  color: #fff;
  font-size: 22px;
}


/* 左上角返回（P9.36 D52） */
/* P9.44：原热区约 34px、字号 18px，低于 TV 基准（≥60px / ≥20px），
   且它曾是 OSD 默认焦点，误触直接退出播放页 → 同步放大并加粗描边 */
.osd-back {
  flex-shrink: 0;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 10px;
  color: var(--text);
  font-size: 20px;
  min-height: 60px;
  padding: 10px 20px;
  margin-right: 14px;
}

/* 信息面板 UP 行可点击（P9.36 D52） */
.info-up {
  color: var(--accent);
  cursor: pointer;
}

.info-line .dim {
  font-size: 16px;
  color: var(--text-dim);
}

/* 视频信息面板（P9.32 D48） */
.info-panel {
  width: min(640px, 88vw);
}

.info-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 52vh;
  overflow-y: auto;
}

.info-line {
  font-size: 20px;
  color: var(--text);
  line-height: 1.5;
}

.info-line.title {
  font-size: 24px;
  font-weight: 700;
}

.info-line.desc {
  font-size: 18px;
  color: var(--text-dim);
  white-space: pre-wrap;
}
</style>
