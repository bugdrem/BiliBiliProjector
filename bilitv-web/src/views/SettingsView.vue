<script setup>
/**
 * 设置页：账号 / 弹幕开关 / 弹幕透明度 / 自动连播 / 清除数据 / 关于
 * 行内开关 Enter 切换；清除数据与退出登录带确认模态。
 * 账号行：未登录 → 跳我的页扫码；已登录 → 确认退出。
 */
import { ref, computed, nextTick, onUnmounted } from 'vue'
import { settings, histClear, runtimeSession } from '../stores/app'
import { CODEC_OPTIONS } from '../api/bilibili'
import { auth, logout as authLogout } from '../stores/auth'
import { focusEngine } from '../core/focus'
import { navigate } from '../router'
import { toast } from '../utils/toast'
import { previewThemeSound } from '../utils/sounds'
import { probeDeviceInfo, runCpuBenchmark, analyzeDevice, probeAppVersion } from '../utils/deviceProbe'

/** 弹幕透明度档位 */
const OPACITY_STEPS = [0.5, 0.7, 0.85, 1]

/**
 * 省资源模式（P9.48）：三态循环 自动 → 开 → 关 → 自动。
 * 生效范围：弹幕降分辨率/降帧/降密度/去描边 + 进度轮询降频（下次进播放页生效）。
 */
const lowPerfText = computed(() => {
  if (settings.lowPerf === true) return '强制开启'
  if (settings.lowPerf === false) return '强制关闭'
  return runtimeSession.lowPerf ? '自动：已开启（弱设备）' : '自动：未开启'
})

function toggleLowPerf() {
  if (settings.lowPerf === null) settings.lowPerf = true
  else if (settings.lowPerf === true) settings.lowPerf = false
  else settings.lowPerf = null
  toast(lowPerfText.value, { duration: 2400 })
}

/**
 * 底栏版本信息（P9.44）：形如 `BiliTV-v1.3.21-release`
 * 原底栏写死 "BiliTV-Web v0.2.0"（多版本前的残留），与实际交付包完全对不上，
 * 排查设备问题时无法确认装的是哪个包。现在从原生 PackageManager + BuildConfig 取真实值。
 */
const appVersion = ref('BiliTV')
probeAppVersion().then((v) => {
  if (v && v.versionName && v.versionName !== 'dev') {
    appVersion.value = `BiliTV-v${v.versionName}-${v.buildType || 'release'}`
  } else {
    appVersion.value = 'BiliTV（Web 预览）'
  }
})

/** 账号行展示（P9.0：等级/硬币/大会员，nav 字段修复后自动刷新） */
const accountText = computed(() => {
  if (!auth.loggedIn) return '未登录 · 去扫码'
  const parts = [auth.uname, `Lv${auth.level}`, `硬币 ${auth.coins}`]
  if (auth.vipStatus) parts.push('大会员')
  return parts.join(' · ')
})

/** 每模块卡片上限档位（P9.0 D23） */
const MAX_CARDS_STEPS = [50, 100, 200, 500]

const confirmClear = ref(false)
const confirmLogout = ref(false)

/** 播放内核档位（D27b：老投影/老 WebView 闪退时切兼容模式） */
const PLAY_CORE_STEPS = [
  { v: 'auto', name: '自动（1080P 优先）' },
  { v: 'durl', name: '兼容模式（720P 稳定）' },
  { v: 'dash', name: 'DASH 强制' }
]
const playCoreName = computed(() => {
  const s = PLAY_CORE_STEPS.find((x) => x.v === settings.playCore)
  return s ? s.name : settings.playCore
})

/** 音效主题（P9.6 D28，Kenney Interface Sounds CC0） */
const SOUND_THEME_STEPS = [
  { v: 'tick', name: '滴答' },
  { v: 'drop', name: '水滴' },
  { v: 'click', name: '清脆' },
  { v: 'glass', name: '玻璃' }
]
const soundThemeName = computed(() => {
  const s = SOUND_THEME_STEPS.find((x) => x.v === settings.soundTheme)
  return s ? s.name : settings.soundTheme
})

/** 默认分辨率档位（P9.7 D29：达不到时自动取支持的最高档） */
const QN_STEPS = [
  { v: 'max', name: '自动（支持的最高）' },
  { v: 116, name: '1080P60' },
  { v: 80, name: '1080P' },
  { v: 64, name: '720P' },
  { v: 32, name: '480P' }
]
const qnName = computed(() => {
  const s = QN_STEPS.find((x) => x.v === settings.defaultQn)
  return s ? s.name : settings.defaultQn
})

const codecName = computed(() => {
  const s = CODEC_OPTIONS.find((x) => x.key === settings.defaultCodec)
  return s ? s.label : settings.defaultCodec
})

/** 解码器档位（P9.19 D39：原生内核 = ExoPlayer，绕开 WebView 媒体栈） */
const DECODER_STEPS = [
  { v: 'webview', name: 'WebView 内核' },
  { v: 'hw', name: '原生·硬解码' },
  { v: 'sw', name: '原生·软解码' }
]
const decoderName = computed(() => {
  const s = DECODER_STEPS.find((x) => x.v === settings.decoder)
  return s ? s.name : settings.decoder
})

/** 视频适应模式展示（P9.34 D50） */
const VIDEO_FIT_STEPS = { full: '全屏自适应', stretch: '全屏拉伸', window: '窗口兼容' }
const videoFitName = computed(() => VIDEO_FIT_STEPS[settings.videoFit] || settings.videoFit)

/* ---------------- 硬件检测面板展示（P9.27 D43） ---------------- */

/** 入口行右侧摘要：检测过则显示上次档位（存内存，不持久化） */
const probeDoneText = computed(() => {
  if (probeBench.value) return `${probeBench.score} 分（${probeBench.tierName}）`
  return '检测'
})

const deviceLine = computed(() => {
  const i = probeInfo.value
  if (!i) return ''
  const name = [i.manufacturer, i.model].filter(Boolean).join(' ') || '未知设备'
  const os = i.androidVersion ? `Android ${i.androidVersion}（API ${i.apiLevel}）` : '非安卓环境'
  return `${name} · ${os}${i.isEmulator ? ' · 模拟器' : ''}`
})

const platformLine = computed(() => {
  const i = probeInfo.value
  if (!i) return ''
  const parts = []
  if (i.soc || i.board) parts.push(i.soc || i.board)
  if (i.abi) parts.push(i.abi)
  if (i.cores) parts.push(`${i.cores} 核`)
  if (i.memGB) parts.push(`内存 ${i.memGB}GB`)
  if (i.glEs) parts.push(`GLES ${i.glEs}`)
  return parts.join(' · ') || '未知'
})

/* ---------------- 级联菜单（P9.21 D40：多选项行右侧展开枚举项直选） ---------------- */

/** 行键 → 枚举定义（title/options/set；set 内含副作用如音效试听） */
const CASCADE_DEFS = {
  opacity: {
    title: '弹幕不透明度',
    get: () => settings.danmakuOpacity,
    options: OPACITY_STEPS.map((v) => ({ v, label: Math.round(v * 100) + '%' })),
    set: (v) => (settings.danmakuOpacity = v)
  },
  maxcards: {
    title: '每模块卡片上限',
    get: () => settings.maxCards,
    options: MAX_CARDS_STEPS.map((v) => ({ v, label: v + ' 个' })),
    set: (v) => (settings.maxCards = v)
  },
  playcore: {
    title: '播放内核',
    get: () => settings.playCore,
    options: PLAY_CORE_STEPS.map((s) => ({ v: s.v, label: s.name })),
    set: (v) => (settings.playCore = v)
  },
  autonextdelay: {
    title: '连播等待秒数',
    get: () => settings.autoNextDelay,
    options: [0, 3, 5, 10, 15].map((v) => ({ v, label: v === 0 ? '立即播放' : v + ' 秒' })),
    set: (v) => (settings.autoNextDelay = v)
  },
  videofit: {
    title: '视频适应模式',
    get: () => settings.videoFit,
    options: [
      { v: 'full', label: '全屏自适应（等比居中）' },
      { v: 'stretch', label: '全屏拉伸（铺满）' },
      { v: 'window', label: '窗口兼容（16:9 双栏）' }
    ],
    set: (v) => (settings.videoFit = v)
  },
  soundtheme: {
    title: '音效主题',
    get: () => settings.soundTheme,
    options: SOUND_THEME_STEPS.map((s) => ({ v: s.v, label: s.name })),
    set: (v) => {
      settings.soundTheme = v
      previewThemeSound() // 选完立即试听
    }
  },
  defaultqn: {
    title: '默认分辨率',
    get: () => settings.defaultQn,
    options: QN_STEPS.map((s) => ({ v: s.v, label: s.name })),
    set: (v) => (settings.defaultQn = v)
  },
  defaultcodec: {
    title: '播放编码',
    get: () => settings.defaultCodec,
    options: CODEC_OPTIONS.map((s) => ({ v: s.key, label: s.label })),
    set: (v) => (settings.defaultCodec = v)
  },
  decoder: {
    title: '解码器',
    get: () => settings.decoder,
    options: DECODER_STEPS.map((s) => ({ v: s.v, label: s.name })),
    set: (v) => {
      settings.decoder = v
      // P9.26 D42：用户显式选过解码器后，模拟器自动软解策略不再覆盖其选择
      try { localStorage.setItem('bilitv.set.decoderTouched', '1') } catch (_) { /* 忽略 */ }
    }
  }
}

/** 打开的级联面板状态：{ key,title,options,current,style,anchorEl }；null=关闭 */
const cascade = ref(null)
let cascadeRemoveInterceptor = null

/** 行点击 → 打开级联：面板锚定到行右侧，焦点进入面板当前项 */
function openCascade(key, e) {
  const def = CASCADE_DEFS[key]
  if (!def || cascade.value) return
  const anchorEl = e && e.currentTarget ? e.currentTarget : null
  let style = { left: '60%', top: '120px' }
  if (anchorEl) {
    const r = anchorEl.getBoundingClientRect()
    style = {
      left: Math.min(r.right + 14, window.innerWidth - 310) + 'px',
      top: Math.max(10, Math.min(r.top - 6, window.innerHeight - 320)) + 'px'
    }
  }
  cascade.value = {
    key,
    title: def.title,
    options: def.options,
    current: def.get(),
    style,
    anchorEl
  }
  nextTick(() => {
    // P9.44：pushLayer 补 onClose——任何关闭路径都复位 cascade 并摘除拦截器。
    // 原先只在 closeCascade() 里摘，若通过硬件返回/切路由关闭，拦截器会永久留在
    // focusEngine 里并闭包持有已卸载组件（幽灵拦截）。
    focusEngine.pushLayer('cascade', null, () => {
      cascade.value = null
      if (cascadeRemoveInterceptor) {
        cascadeRemoveInterceptor()
        cascadeRemoveInterceptor = null
      }
    })
    const cur = document.querySelector('.cascade-item.cur') || document.querySelector('.cascade-item')
    if (cur) focusEngine.focus(cur)
  })
  // 拦截器：Esc/← 关闭级联（优先于引擎 back；↑↓ 交给引擎在面板内导航）
  cascadeRemoveInterceptor = focusEngine.addInterceptor((k) => {
    if (k === 'Escape' || k === 'ArrowLeft') {
      closeCascade()
      return true
    }
    return false
  })
}

/** 关闭级联：弹层 + 焦点归还锚定行 */
function closeCascade() {
  const c = cascade.value
  cascade.value = null
  if (cascadeRemoveInterceptor) {
    cascadeRemoveInterceptor()
    cascadeRemoveInterceptor = null
  }
  focusEngine.popLayer()
  if (c && c.anchorEl && document.contains(c.anchorEl)) focusEngine.focus(c.anchorEl)
}

/** P9.44：卸载兜底——级联开着直接切路由时摘掉拦截器，避免幽灵拦截后续页面 */
onUnmounted(() => {
  if (cascadeRemoveInterceptor) {
    cascadeRemoveInterceptor()
    cascadeRemoveInterceptor = null
  }
})

/** 选项直选 */
function pickCascade(opt) {
  if (!cascade.value) return
  const def = CASCADE_DEFS[cascade.value.key]
  def.set(opt.v)
  closeCascade()
}

/** 账号行点击：未登录去我的页扫码；已登录弹退出确认 */
function onAccount() {
  if (auth.loggedIn) {
    confirmLogout.value = true
    nextTick(() => focusEngine.pushLayer('panel', null, () => { confirmLogout.value = false }))
  } else {
    navigate('mine')
  }
}

async function doLogout() {
  confirmLogout.value = false
  focusEngine.popLayer()
  await authLogout()
  toast('已退出登录')
}

function cancelLogout() {
  confirmLogout.value = false
  focusEngine.popLayer()
}

function askClear() {
  confirmClear.value = true
  nextTick(() => focusEngine.pushLayer('panel', null, () => { confirmClear.value = false }))
}

/* ---------------- 硬件检测与跑分（P9.27 D43） ---------------- */

const probePanel = ref(false)
const probeInfo = ref(null) // 设备信息（probeDeviceInfo 结果）
const probeBench = ref(null) // { score, tierName }
const probeRec = ref(null) // analyzeDevice 推荐
const probeError = ref(null) // 检测失败信息（面板内可见，不再"无反应"）

/** 打开检测面板：设备信息 → 跑分（约 1.5s）→ 出推荐，逐段渲染。
 *  P9.31 D47：失败保持面板打开并显示错误（原生失败自动回退 Web/JS 探测） */
async function openProbe() {
  if (probePanel.value) return
  probePanel.value = true
  probeInfo.value = null
  probeBench.value = null
  probeRec.value = null
  probeError.value = null
  nextTick(() => focusEngine.pushLayer('panel', null, closeProbeUi))
  try {
    probeInfo.value = await probeDeviceInfo()
    const { score } = await runCpuBenchmark()
    const rec = analyzeDevice(probeInfo.value, score)
    probeBench.value = { score: rec.score, tierName: rec.tierName }
    probeRec.value = rec
  } catch (e) {
    probeError.value = (e && e.message) || '未知错误'
  }
}

function closeProbe() {
  focusEngine.popLayer() // onClose（closeProbeUi）负责状态复位
}

/** onClose 回调：弹层状态复位（硬件返回/按钮双路径复用） */
function closeProbeUi() {
  probePanel.value = false
  probeInfo.value = null
  probeBench.value = null
  probeRec.value = null
  probeError.value = null
  const row = document.querySelector('[data-focus-key="set-probe"]')
  if (row) focusEngine.focus(row)
}

/** 面板内重试：复位状态后重新检测 */
function retryProbe() {
  probeInfo.value = null
  probeBench.value = null
  probeRec.value = null
  probeError.value = null
  openProbe()
}

/** 应用推荐：写解码器 + 编码（同时标记 decoderTouched，尊重用户显式选择） */
function applyProbe() {
  if (!probeRec.value) return
  const rec = probeRec.value
  settings.decoder = rec.decoder
  try { localStorage.setItem('bilitv.set.decoderTouched', '1') } catch (_) { /* 忽略 */ }
  settings.defaultCodec = rec.codec
  toast(`已应用推荐：${rec.decoderName} · ${rec.codecName}`)
  closeProbe()
}

function doClear() {
  histClear()
  toast('播放历史已清除')
  confirmClear.value = false
  focusEngine.popLayer()
}

function cancelClear() {
  confirmClear.value = false
  focusEngine.popLayer()
}
</script>

<template>
  <div class="settings-page" data-focus-zone="content">
    <div class="page-title">设置</div>

    <!-- 账号（独立于分组，置顶高频项） -->
    <div v-focusable class="setting-row" data-focus-key="set-account" data-autofocus @click="onAccount">
      <span>账号</span>
      <span class="value">
        {{ accountText }}
      </span>
    </div>

    <!-- 播放 -->
    <div class="group-title">播放</div>
    <div v-focusable class="setting-row" data-focus-key="set-playcore" @click="openCascade('playcore', $event)">
      <span>播放内核</span>
      <span class="value">{{ playCoreName }} ›</span>
    </div>
    <div v-focusable class="setting-row" data-focus-key="set-defaultqn" @click="openCascade('defaultqn', $event)">
      <span>默认分辨率</span>
      <span class="value">{{ qnName }} ›</span>
    </div>
    <div v-focusable class="setting-row" data-focus-key="set-defaultcodec" @click="openCascade('defaultcodec', $event)">
      <span>播放编码</span>
      <span class="value">{{ codecName }} ›</span>
    </div>
    <div v-focusable class="setting-row" data-focus-key="set-decoder" @click="openCascade('decoder', $event)">
      <span>解码器</span>
      <span class="value">{{ decoderName }} ›</span>
    </div>
    <div class="setting-hint">原生内核（ExoPlayer）绕开 WebView 播放崩溃，老投影选硬/软解码；软解兼容性最强</div>
    <div v-focusable class="setting-row" data-focus-key="set-videofit" @click="openCascade('videofit', $event)">
      <span>视频适应模式</span>
      <span class="value">{{ videoFitName }} ›</span>
    </div>
    <div class="setting-hint">播放画面铺满异常（如只显示左上角小窗）时，切换「窗口兼容」模式</div>
    <div v-focusable class="setting-row" data-focus-key="set-probe" @click="openProbe">
      <span>硬件检测与跑分</span>
      <span class="value">{{ probeDoneText }} ›</span>
    </div>
    <div class="setting-hint">检测设备环境与解码能力，跑分后自动匹配最适合的播放编码与解码器</div>

    <!-- 弹幕 -->
    <div class="group-title">弹幕</div>
    <div v-focusable class="setting-row" data-focus-key="set-danmaku" @click="settings.danmaku = !settings.danmaku">
      <span>弹幕显示</span>
      <span class="switch-dot" :class="{ on: settings.danmaku }"></span>
    </div>
    <div v-focusable class="setting-row" data-focus-key="set-opacity" @click="openCascade('opacity', $event)">
      <span>弹幕不透明度</span>
      <span class="value">{{ Math.round(settings.danmakuOpacity * 100) }}% ›</span>
    </div>

    <!-- 通用 -->
    <div class="group-title">通用</div>
    <div
      v-focusable
      class="setting-row"
      data-focus-key="set-lowperf"
      @click="toggleLowPerf"
    >
      <span>省资源模式（弱设备防卡死）</span>
      <span class="value">{{ lowPerfText }} ›</span>
    </div>

    <div v-focusable class="setting-row" data-focus-key="set-autonext" @click="settings.autoNext = !settings.autoNext">
      <span>自动连播（播完播相关推荐）</span>
      <span class="switch-dot" :class="{ on: settings.autoNext }"></span>
    </div>
    <div v-focusable class="setting-row" data-focus-key="set-autonextdelay" @click="openCascade('autonextdelay', $event)">
      <span>连播等待秒数</span>
      <span class="value">{{ settings.autoNextDelay === 0 ? '立即播放' : settings.autoNextDelay + ' 秒' }} ›</span>
    </div>
    <div v-focusable class="setting-row" data-focus-key="set-maxcards" @click="openCascade('maxcards', $event)">
      <span>每模块卡片上限</span>
      <span class="value">{{ settings.maxCards }} 个 ›</span>
    </div>
    <div v-focusable class="setting-row" data-focus-key="set-soundon" @click="settings.soundOn = !settings.soundOn">
      <span>导航音效</span>
      <span class="switch-dot" :class="{ on: settings.soundOn }"></span>
    </div>
    <div v-focusable class="setting-row" data-focus-key="set-soundtheme" @click="openCascade('soundtheme', $event)">
      <span>音效主题</span>
      <span class="value">{{ soundThemeName }} ›</span>
    </div>

    <!-- 数据 -->
    <div class="group-title">数据</div>
    <div v-focusable class="setting-row" data-focus-key="set-clear" @click="askClear">
      <span>清除播放历史</span>
      <span class="value danger">清除</span>
    </div>

    <div class="about">
      <div class="about-line">{{ appVersion }}</div>
      <div class="about-line dim">
        基于 B 站 Web 公开接口 · 数据来源 bilibili.com · 登录凭据仅保存在本机
      </div>
      <div class="about-line dim">导航音效：Kenney Interface Sounds（CC0）</div>
      <div class="about-line dim">操作提示：方向键移动焦点 · OK 确认 · 返回键逐级退出 · 鼠标/键盘可直接操作播放器</div>
    </div>

    <!-- 硬件检测与跑分面板（P9.27 D43） -->
    <div v-if="probePanel" class="modal-mask">
      <div class="modal-panel probe-panel" data-focus-zone="panel">
        <div class="modal-title">系统环境与硬件检测</div>

        <div v-if="probeError" class="probe-error">检测失败：{{ probeError }}（已回退基础探测）</div>
        <div v-if="!probeInfo" class="probe-loading">正在读取设备信息…</div>
        <template v-else>
          <div class="probe-grid">
            <div class="probe-row"><span class="k">设备</span><span class="v">{{ deviceLine }}</span></div>
            <div class="probe-row"><span class="k">平台</span><span class="v">{{ platformLine }}</span></div>
            <div class="probe-row">
              <span class="k">硬解支持</span>
              <span class="v">
                <template v-if="probeInfo.hwUnknown">未知（已回退基础探测）</template>
                <template v-else>
                  <span class="hw-tag" :class="{ ok: probeInfo.hwAvc }">AVC {{ probeInfo.hwAvc ? '✓' : '✗' }}</span>
                  <span class="hw-tag" :class="{ ok: probeInfo.hwHevc }">HEVC {{ probeInfo.hwHevc ? '✓' : '✗' }}</span>
                  <span class="hw-tag" :class="{ ok: probeInfo.hwAv1 }">AV1 {{ probeInfo.hwAv1 ? '✓' : '✗' }}</span>
                </template>
              </span>
            </div>
            <div class="probe-row">
              <span class="k">CPU 跑分</span>
              <span class="v">
                <template v-if="probeBench">{{ probeBench.score }} 分（{{ probeBench.tierName }}）</template>
                <template v-else>跑分中，约 1.5 秒…</template>
              </span>
            </div>
          </div>

          <div v-if="probeRec" class="probe-rec">
            <div class="probe-rec-title">推荐配置</div>
            <div class="probe-rec-main">解码器 = {{ probeRec.decoderName }} · 编码 = {{ probeRec.codecName }}</div>
            <div class="probe-rec-reason">{{ probeRec.reason }}；{{ probeRec.qnAdvice }}</div>
            <div class="probe-rec-cur">当前：{{ decoderName }} · {{ codecName }}</div>
          </div>
        </template>

        <div class="confirm-row">
          <button v-if="probeError" v-focusable class="tab-item" @click="retryProbe">重试</button>
          <button v-if="probeRec" v-focusable class="tab-item" @click="applyProbe">应用推荐设置</button>
          <button v-focusable class="tab-item" data-autofocus @click="closeProbe">关闭</button>
        </div>
      </div>
    </div>

    <!-- 级联菜单（P9.21 D40）：锚定行右侧弹出，枚举项直选，Esc/← 关闭 -->
    <div v-if="cascade" class="cascade-panel" data-focus-zone="cascade" :style="cascade.style">
      <div class="cascade-title">{{ cascade.title }}</div>
      <div
        v-for="opt in cascade.options"
        :key="String(opt.v)"
        v-focusable
        class="cascade-item"
        :class="{ cur: opt.v === cascade.current }"
        :data-autofocus="opt.v === cascade.current ? '' : undefined"
        @click="pickCascade(opt)"
      >
        <span>{{ opt.label }}</span>
        <span v-if="opt.v === cascade.current" class="ck">✓</span>
      </div>
    </div>

    <!-- 清除确认（模态层） -->
    <div v-if="confirmClear" class="modal-mask">
      <div class="modal-panel" data-focus-zone="panel">
        <div class="modal-title">确认清除全部播放历史？</div>
        <div class="confirm-row">
          <button v-focusable class="tab-item danger" @click="doClear">确认清除</button>
          <button v-focusable class="tab-item" data-autofocus @click="cancelClear">取消</button>
        </div>
      </div>
    </div>

    <!-- 退出登录确认（模态层） -->
    <div v-if="confirmLogout" class="modal-mask">
      <div class="modal-panel" data-focus-zone="panel">
        <div class="modal-title">退出当前账号？</div>
        <div class="confirm-row">
          <button v-focusable class="tab-item danger" @click="doLogout">退出登录</button>
          <button v-focusable class="tab-item" data-autofocus @click="cancelLogout">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.value {
  color: var(--text-dim);
  font-size: 21px;
}

.value.danger {
  color: #ff8bab;
}

.about {
  margin-top: 34px;
  padding: 24px 28px;
  background: var(--bg-card);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.about-line {
  font-size: 21px;
}

.about-line.dim {
  color: var(--text-dim);
  font-size: 18px;
}

.confirm-row {
  display: flex;
  gap: 16px;
}

.tab-item.danger {
  background: rgba(251, 114, 153, 0.16);
  color: #ff8bab;
}
.setting-hint {
  font-size: 16px;
  color: var(--text-dim);
  padding: 0 6px;
  margin: -8px 0 10px;
  line-height: 1.5;
}

/* 级联菜单（P9.21 D40）：锚定行右侧弹出 */
.cascade-panel {
  position: fixed;
  z-index: 90;
  min-width: 264px;
  background: var(--bg-card);
  border: 2px solid var(--bg-card-hover);
  border-radius: 16px;
  padding: 10px;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
}

.cascade-title {
  font-size: 17px;
  color: var(--text-dim);
  padding: 6px 14px 10px;
}

.cascade-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  border-radius: 10px;
  font-size: 21px;
  color: var(--text);
  white-space: nowrap;
}

.cascade-item.cur {
  color: var(--accent);
}

.cascade-item.cur .ck {
  color: var(--accent);
  font-weight: 700;
}

/* 硬件检测与跑分面板（P9.27 D43） */
.probe-panel {
  width: min(560px, 86vw);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.probe-loading {
  color: var(--text-dim);
  font-size: 20px;
  padding: 18px 0;
}

/* 分组标题（P9.31 D47） */
.group-title {
  font-size: 17px;
  color: var(--accent);
  opacity: 0.85;
  padding: 22px 6px 8px;
  letter-spacing: 2px;
}

.probe-error {
  font-size: 18px;
  color: #ffb86b;
  background: rgba(255, 184, 107, 0.1);
  border-radius: 10px;
  padding: 10px 14px;
}

.probe-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.probe-row {
  display: flex;
  gap: 16px;
  align-items: baseline;
  font-size: 20px;
}

.probe-row .k {
  flex: 0 0 88px;
  color: var(--text-dim);
  font-size: 18px;
}

.probe-row .v {
  color: var(--text);
}

.hw-tag {
  display: inline-block;
  margin-right: 8px;
  padding: 2px 10px;
  border-radius: 8px;
  font-size: 17px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-dim);
}

.hw-tag.ok {
  background: rgba(76, 217, 144, 0.14);
  color: #5fd899;
}

.probe-rec {
  background: rgba(120, 160, 255, 0.08);
  border: 1px solid rgba(120, 160, 255, 0.25);
  border-radius: 12px;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.probe-rec-title {
  font-size: 16px;
  color: var(--text-dim);
}

.probe-rec-main {
  font-size: 22px;
  font-weight: 700;
  color: var(--accent);
}

.probe-rec-reason {
  font-size: 17px;
  color: var(--text);
  line-height: 1.5;
}

.probe-rec-cur {
  font-size: 16px;
  color: var(--text-dim);
}
</style>
