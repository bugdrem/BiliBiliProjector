/**
 * 导航音效（P9.6 D28，见 docs/03 第 11 节）
 *
 * 音源：Kenney Interface Sounds（CC0，无需署名），12 个短 wav 嵌入 public/sounds/
 * 实现：AudioContext 惰性初始化 + decodeAudioData 预解码缓存，BufferSource 每次
 * 新建可自由叠加；50ms 节流防遥控器连按爆音；settings.soundOn=false 时静默。
 */

import { settings } from '../stores/app'

const SOUND_BASE = import.meta.env.DEV ? '/sounds' : './sounds'

/** 主题 → 事件音文件映射（move=焦点移动 confirm=确认 back=返回） */
const THEMES = {
  tick: { move: 'tick_001.wav', confirm: 'switch_002.wav', back: 'back_001.wav' },
  drop: { move: 'drop_002.wav', confirm: 'confirmation_002.wav', back: 'close_001.wav' },
  click: { move: 'click_002.wav', confirm: 'select_002.wav', back: 'close_002.wav' },
  glass: { move: 'glass_002.wav', confirm: 'maximize_004.wav', back: 'close_003.wav' }
}

let ctx = null
/** 文件名 → AudioBuffer 预解码缓存（跨主题共享，如 close_* 被多主题复用） */
const buffers = {}
let lastPlayAt = 0

/** AudioContext 惰性创建；TV 上首次按键即用户手势，自动播放策略放行 */
function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    try {
      ctx = new AC()
    } catch (_) {
      return null
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

/** 惰性预解码：首次请求时发起 fetch，完成后入缓存（未就绪的本次静默） */
function loadBuf(file) {
  const c = ensureCtx()
  if (!c) return null
  if (buffers[file]) return buffers[file]
  if (!buffers[file] && buffers[file] !== null) {
    buffers[file] = null // 占位防重复 fetch
    fetch(`${SOUND_BASE}/${file}`)
      .then((r) => r.arrayBuffer())
      .then((ab) => c.decodeAudioData(ab))
      .then((buf) => {
        buffers[file] = buf
      })
      .catch(() => {
        delete buffers[file]
      })
  }
  return buffers[file]
}

/**
 * 播放一类导航音效
 * @param {'move'|'confirm'|'back'} kind
 */
export function playNavSound(kind) {
  if (!settings.soundOn) return
  const now = performance.now()
  if (now - lastPlayAt < 50) return // 连按节流
  lastPlayAt = now

  const theme = THEMES[settings.soundTheme] || THEMES.tick
  const file = theme[kind]
  if (!file) return

  const c = ensureCtx()
  if (!c) return
  const buf = loadBuf(file)
  if (!buf) return // 解码未完成，本次静默（下一键即有音）

  try {
    const src = c.createBufferSource()
    src.buffer = buf
    const gain = c.createGain()
    gain.gain.value = kind === 'move' ? 0.35 : 0.5
    src.connect(gain)
    gain.connect(c.destination)
    src.start()
  } catch (_) {
    /* 播放失败不影响主流程 */
  }
}

/** 主题键列表（设置页用） */
export const SOUND_THEMES = Object.keys(THEMES)

/**
 * 设置页切主题预览（P9.16）：立即播放当前主题的移动音。
 * 绕过 50ms 节流（切档的 confirm 音刚播过，会被节流吞掉）；
 * 该主题音效首次使用尚未解码完成时，解码好后自动补播一次。
 */
export function previewThemeSound() {
  lastPlayAt = 0
  playNavSound('move')
  const theme = THEMES[settings.soundTheme] || THEMES.tick
  const file = theme.move
  if (!file) return
  // 预解码未就绪（buffers[file] === null 占位中）：轮询等解码完成后补播，3s 超时放弃
  if (buffers[file] === null) {
    const t0 = Date.now()
    const poll = setInterval(() => {
      if (buffers[file]) {
        clearInterval(poll)
        lastPlayAt = 0
        playNavSound('move')
      } else if (Date.now() - t0 > 3000) {
        clearInterval(poll)
      }
    }, 120)
  }
}
