<script setup>
/**
 * 弹幕渲染层（canvas）
 * - 拉取 /x/v1/dm/list.so?cid= 全量 XML 弹幕池并解析
 * - 每帧按视频 currentTime 调度：滚动弹幕从右向左匀速移动；
 *   顶部/底部弹幕驻留 5 秒
 * - 泳道分配：新弹幕仅在目标泳道上一条已完全进入屏幕时启用，避免重叠
 *
 * P9.25 电视适配优化：
 * - 时间源双通道：WebView（video.currentTime，60fps 平滑）/ 原生内核（轮询 curTime
 *   + performance.now 插值补偿到帧粒度）
 * - fitCanvas 不再每帧调用（getBoundingClientRect 强制布局是弱 GPU 卡顿源）：
 *   挂载 + resize 时计算，滚动帧内每 64 帧低频校验
 * - 暂停/页面隐藏时跳过重绘（保留当前帧，省算力与功耗）
 */
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { getDanmakuXml } from '../api/bilibili'
import { isLowPerf } from '../stores/app'

/**
 * 省资源档（P9.48，针对 2GB/4 核这类弱设备，播放页卡死的主因是全屏 canvas 的
 * 软渲染填充 + 每帧描边/填充双绘）。降档项：
 *  - 画布渲染分辨率降到 55%（像素填充量约为原来的 1/3，CSS 拉伸回全屏）
 *  - 同屏滚动弹幕 30 → 12
 *  - 去掉描边（strokeText 与 fillText 各画一遍，直接省一半绘制）
 *  - 30fps（每 2 帧渲染一次）
 *  - 弹幕池截断到 2500 条（热门视频上万条时数组遍历与调度也吃 CPU）
 */
const lowPerf = computed(() => isLowPerf())
const CANVAS_SCALE = computed(() => (lowPerf.value ? 0.55 : 1))
const MAX_ACTIVE = computed(() => (lowPerf.value ? 12 : 30))
const POOL_CAP = computed(() => (lowPerf.value ? 2500 : Infinity))
/** 帧计数（省资源档跳帧用） */
let frameCount = 0

const props = defineProps({
  /** WebView 模式的 <video> 元素（原生内核模式下为 null） */
  videoEl: { type: Object, default: null },
  /** 原生内核模式（P9.19）：时间源来自轮询回填的 curTime */
  nativeMode: { type: Boolean, default: false },
  /** 原生内核当前播放秒数（轮询回填） */
  nativeTime: { type: Number, default: 0 },
  /** 原生内核是否播放中 */
  nativePlaying: { type: Boolean, default: false },
  cid: { type: Number, default: 0 },
  enabled: { type: Boolean, default: true },
  /** 不透明度 0~1 */
  opacity: { type: Number, default: 0.85 },
  /** 字号乘数（settings.dmFontSize） */
  fontSizeScale: { type: Number, default: 1 },
  /** 滚动弹幕显示区域（占画布高度比例，settings.dmArea） */
  area: { type: Number, default: 1 },
  /** 速度乘数（settings.dmSpeed，越大越快） */
  speedScale: { type: Number, default: 1 },
  /** 密度（settings.dmDensity，0~1 按概率保留） */
  density: { type: Number, default: 1 },
  /** 显示滚动弹幕 */
  showScroll: { type: Boolean, default: true },
  /** 显示顶部驻留弹幕 */
  showTop: { type: Boolean, default: true },
  /** 显示底部驻留弹幕 */
  showBottom: { type: Boolean, default: true }
})

const canvasRef = ref(null)
const ctxRef = ref(null)
/** 解析后的弹幕列表（按时间升序） */
let comments = []
/** 下一条待发射弹幕指针 */
let spawnIdx = 0
/** 各泳道上一条滚动弹幕的状态 */
const lanes = []
/** 驻留型（顶部/底部）激活列表 */
const pinned = []
/** 滚动弹幕活动列表 */
const activeScroll = []
let rafId = 0

/** 泳道高度（px，随画布尺寸缩放） */
const LANE_H = 42
/** 滚动弹幕通过全屏的时长（秒） */
const SCROLL_DUR = 9
/** 驻留弹幕显示时长（秒） */
const PIN_DUR = 5

/** 原生时间插值锚点：轮询回填时刻与数值 */
let nativeSyncAt = 0
let nativeSyncVal = 0

/** XML 实体反转义（弹幕文本可能含 &amp; &lt; 等） */
const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

/**
 * 解析 B 站弹幕 XML：d@p = time,mode,size,color,...
 * 用正则而非 DOMParser：弹幕文本混入控制字符时 parseFromString 会产生
 * parsererror 文档（querySelectorAll('d') 得 0 条且无异常抛出），正则解析不受影响
 */
function parseXml(xmlText) {
  const out = []
  const re = /<d\s+p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(xmlText)) !== null) {
    const p = m[1].split(',')
    if (p.length < 5) continue
    const t = parseFloat(p[0])
    const mode = parseInt(p[1], 10)
    const sizeP = parseInt(p[2], 10)
    const color = parseInt(p[3], 10)
    if (!isFinite(t)) continue
    if (mode === 8 || mode === 7 || mode === 9) continue // 代码/高级弹幕跳过
    out.push({
      t,
      /** 1~3 滚动，4 底部，5 顶部 */
      mode: mode === 4 ? 'bottom' : mode === 5 ? 'top' : 'scroll',
      size: sizeP >= 36 ? 1.25 : sizeP <= 18 ? 0.8 : 1,
      color: '#' + (color >>> 0).toString(16).padStart(6, '0'),
      text: unescapeXml(m[2])
    })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/** 拉取并解析弹幕池 */
async function load(cid) {
  comments = []
  spawnIdx = 0
  pinned.length = 0
  lanes.length = 0
  if (!cid) return
  try {
    const xml = await getDanmakuXml(cid)
    comments = parseXml(xml)
    // P9.48：省资源档截断弹幕池（热门视频上万条时数组与调度都吃资源）
    if (comments.length > POOL_CAP.value) comments.length = POOL_CAP.value
    ;(window.__dmDebug = window.__dmDebug || []).push(
      `layer cid=${cid} xml=${xml.length} comments=${comments.length}`
    )
  } catch (err) {
    ;(window.__dmDebug = window.__dmDebug || []).push(`layer-err cid=${cid} ${err && err.message}`)
    /* 弹幕拉取失败不阻塞播放 */
  }
}

/** 计算画布尺寸（跟随父容器；仅挂载/resize/低频校验时调用，避免每帧强制布局） */
function fitCanvas() {
  const cvs = canvasRef.value
  if (!cvs || !cvs.parentElement) return
  const r = cvs.parentElement.getBoundingClientRect()
  // P9.48：省资源档下按 0.55 倍渲染再拉伸（canvas 内存位图与每帧填充同步下降）
  const bw = Math.floor(r.width * CANVAS_SCALE.value)
  const bh = Math.floor(r.height * CANVAS_SCALE.value)
  if (r.width > 0 && (cvs.width !== bw || cvs.height !== bh)) {
    cvs.width = bw
    cvs.height = bh
  }
}

/** 请求一条空闲泳道；无空闲返回 -1。泳道总数受显示区域（area）限制 */
function takeLane(text, w, now) {
  const h = canvasRef.value ? canvasRef.value.height : 360
  // 显示区域：泳道只分布在画布上部 area 比例内（驻留型弹幕不受限）
  const usableH = h * Math.min(1, Math.max(0.1, props.area))
  const laneCount = Math.max(1, Math.floor(usableH / (LANE_H * CANVAS_SCALE.value)) - 1)
  // 动态补齐（area 档位变大时泳道数增加）；缩小时多余泳道自然不被选中
  while (lanes.length < laneCount) lanes.push({ lastText: '', lastW: 0, lastT: -99 })
  for (let i = 0; i < laneCount; i++) {
    const lane = lanes[i]
    // 上一条已完全进入屏幕（其右端越过屏内），则此泳道可用
    const elapsed = now - lane.lastT
    if ((elapsed * (w + 120)) / scrollDuration() > lane.lastW + 24) {
      lane.lastText = text
      lane.lastW = w
      lane.lastT = now
      return i
    }
  }
  return -1
}

/** 滚动弹幕通过全屏的时长（秒）——速度档位越高时长越短 */
function scrollDuration() {
  return SCROLL_DUR / Math.min(3, Math.max(0.2, props.speedScale))
}

/** 当前调度时间（秒）：WebView 读 video；原生用轮询值 + 播放插值补偿到帧粒度 */
function currentTime() {
  if (props.nativeMode) {
    const elapsed = props.nativePlaying ? (performance.now() - nativeSyncAt) / 1000 : 0
    return nativeSyncVal + elapsed
  }
  return props.videoEl ? props.videoEl.currentTime : 0
}

/** 是否暂停/隐藏（暂停与切后台时跳过重绘，保留当前帧） */
function isIdle() {
  if (document.hidden) return true
  if (props.nativeMode) return !props.nativePlaying
  return props.videoEl ? props.videoEl.paused : true
}

/**
 * P9.44 长播功耗/性能：原先 rAF **永不停止**——暂停、切后台、弹幕关闭时仍在 60fps 空转
 * （每帧一次 requestAnimationFrame 回调，投影仪上一夜能白烧掉大量 CPU 周期）。
 * 现在空闲时取消 rAF 循环，恢复播放/回到前台再重启。
 */
function stopLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

function startLoop() {
  if (rafId) return
  rafId = requestAnimationFrame(frame)
}

/** 每帧渲染 */
function frame(ts) {
  const cvs = canvasRef.value
  const ctx = ctxRef.value
  if (!cvs || !ctx || !props.enabled) {
    // 弹幕关闭或无画布：停止循环，避免空转
    stopLoop()
    return
  }
  if (isIdle()) {
    stopLoop() // 保留当前帧，停止调度
    return
  }
  rafId = requestAnimationFrame(frame)

  // P9.48：省资源档 30fps（隔帧绘制）——弱设备上弹幕是最大的 CPU 占用之一
  if (lowPerf.value && (frameCount++ & 1)) return

  // 尺寸校验：每 64 帧一次（约 1 秒），替代每帧 getBoundingClientRect
  if ((rafId & 63) === 0) fitCanvas()
  if (!cvs.width) fitCanvas()

  const now = currentTime()
  const w = cvs.width
  const h = cvs.height
  // P9.48：省资源档画布是降分辨率渲染再拉伸，字号/泳道/边距都要同步缩放，
  // 否则画布变小后文字反而被放大、泳道数变少（视觉错乱）
  const scale = CANVAS_SCALE.value
  const laneH = LANE_H * scale
  ctx.clearRect(0, 0, w, h)
  ctx.globalAlpha = props.opacity
  ctx.textBaseline = 'middle'
  ctx.strokeStyle = 'rgba(0,0,0,0.75)'
  ctx.lineWidth = 2.6

  // 发射新弹幕
  while (spawnIdx < comments.length && comments[spawnIdx].t <= now) {
    const c = comments[spawnIdx++]
    if (now - c.t > 1.2) continue // 追帧/seek 后过期弹幕直接丢弃
    // 类型开关过滤（bbll：滚动/顶部/底部可独立关闭）
    if (c.mode === 'scroll' && !props.showScroll) continue
    if (c.mode === 'top' && !props.showTop) continue
    if (c.mode === 'bottom' && !props.showBottom) continue
    // 密度控制：按档位概率保留（全量=1 时不过滤，避免随机数开销）
    if (props.density < 1 && Math.random() > props.density) continue
    if (c.mode === 'scroll') {
      // P9.44：同屏上限保护——密度=全量时某些热门视频会同时挂数百条，
      // 每帧 measureText + 描边/填充双绘，Z7X 直接掉帧
      if (activeScroll.length >= MAX_ACTIVE) continue
      const fontSize = 22 * c.size * props.fontSizeScale * scale
      ctx.font = `bold ${fontSize}px sans-serif`
      const tw = ctx.measureText(c.text).width
      const lane = takeLane(c.text, tw, now)
      if (lane >= 0) c._lane = lane
      else continue // 泳道占满则丢弃（密度控制）
      c._t0 = now
      activeScroll.push(c)
    } else {
      pinned.push({ ...c, _t0: now })
      if (pinned.length > 8) pinned.shift()
    }
  }

  // 渲染滚动弹幕
  const speedBase = (w + 160) / scrollDuration()
  for (let i = activeScroll.length - 1; i >= 0; i--) {
    const c = activeScroll[i]
    const dt = now - c._t0
    const fontSize = 22 * c.size * props.fontSizeScale
    ctx.font = `bold ${fontSize}px sans-serif`
    const tw = ctx.measureText(c.text).width
    const x = w - dt * speedBase
    if (x + tw < -20) {
      activeScroll.splice(i, 1)
      continue
    }
    const y = c._lane * laneH + laneH / 2 + 8 * scale
    if (!lowPerf.value) ctx.strokeText(c.text, x, y) // P9.48：省资源档省掉描边这一遍绘制
    ctx.fillStyle = c.color
    ctx.fillText(c.text, x, y)
  }

  // 渲染顶部/底部驻留弹幕
  for (let i = pinned.length - 1; i >= 0; i--) {
    const c = pinned[i]
    if (now - c._t0 > PIN_DUR) {
      pinned.splice(i, 1)
      continue
    }
    const fontSize = 22 * c.size * props.fontSizeScale * scale
    ctx.font = `bold ${fontSize}px sans-serif`
    const tw = ctx.measureText(c.text).width
    const x = (w - tw) / 2
    const y = c.mode === 'top' ? 40 * scale : h - 56 * scale
    if (!lowPerf.value) ctx.strokeText(c.text, x, y) // P9.48：同上
    ctx.fillStyle = c.color
    ctx.fillText(c.text, x, y)
  }
}

/** 外部 seek 后同步指针（丢弃跳过区间的弹幕） */
function seekTo(t) {
  spawnIdx = 0
  activeScroll.length = 0
  pinned.length = 0
  while (spawnIdx < comments.length && comments[spawnIdx].t < t) spawnIdx++
  // seek 后重置原生插值锚点，避免插值跳变
  nativeSyncAt = performance.now()
  nativeSyncVal = t
}

watch(
  () => props.cid,
  (cid) => load(cid)
)

// 原生时间轮询回填时刷新插值锚点（nativeSyncVal + 播放中 elapsed = 平滑时间）
watch(
  () => props.nativeTime,
  (v) => {
    nativeSyncAt = performance.now()
    nativeSyncVal = v
  }
)

function onWinResize() {
  fitCanvas()
}

/** P9.44：回到前台/重新播放时重启渲染循环（空闲时循环已被 stopLoop 摘掉） */
function kick() {
  fitCanvas()
  if (props.enabled && !isIdle()) startLoop()
}

function onVisibility() {
  if (document.hidden) stopLoop()
  else kick()
}

onMounted(() => {
  ctxRef.value = canvasRef.value ? canvasRef.value.getContext('2d') : null
  fitCanvas()
  startLoop()
  window.addEventListener('resize', onWinResize)
  document.addEventListener('visibilitychange', onVisibility)
  if (props.cid) load(props.cid)
})

// 播放状态回升（暂停→播放）时重启循环；暂停由 frame() 内的 stopLoop 处理
watch(
  () => [props.nativeMode, props.nativePlaying, props.enabled],
  () => kick()
)

onUnmounted(() => {
  stopLoop()
  window.removeEventListener('resize', onWinResize)
  document.removeEventListener('visibilitychange', onVisibility)
  comments = [] // P9.44：释放弹幕池（长播切多集时的大数组）
})

defineExpose({ seekTo })
</script>

<template>
  <canvas ref="canvasRef" class="danmaku-canvas" :style="{ display: enabled ? 'block' : 'none' }"></canvas>
</template>

<style scoped>
.danmaku-canvas {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;  /* P9.51: inset 在 Android 9 Chromium 69 无效 */
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 5;
}
</style>
