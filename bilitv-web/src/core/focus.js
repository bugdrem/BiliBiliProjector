/**
 * FocusEngine —— 遥控器焦点引擎（全局单例）
 *
 * 职责（对应 docs/01-开发文档.md 第五章）：
 *  1. 分区（zone）管理：data-focus-zone 标记容器，空间导航只在当前 zone 内找候选；
 *     data-zone-exit-left/right/up/down 声明分区出口（如 侧边栏 ↔ 内容区）。
 *  2. 空间导航：方向过滤 + 主轴间隙 / 交叉轴偏移评分，边界处停住。
 *  3. 模态层栈：OSD / 面板 / 确认框 pushLayer / popLayer，返回键永远先弹栈，
 *     关闭后焦点归还触发元素。
 *  4. 每页焦点记忆：remember(pageId) 在路由离开前调用，restore(pageId) 在页面
 *     挂载后调用，修复"返回后焦点丢失"（BBLL 曾反复出现的 bug）。
 *  5. 按键拦截器：页面可注册 keyInterceptor(key) => boolean，优先于空间导航
 *     （播放页 OSD 隐藏态下左右键 = 快退/快进，上键唤出 OSD）。
 *  6. 返回键层级：弹层栈 → onBack（路由回退）→ onExit（应用退出确认）。
 *
 * 按键约定：方向键 Arrow*、确认 Enter、返回 Esc（浏览器调试）；
 * Android 端由 Capacitor App.backButton 事件桥接到 engine.back()（见 main.js）。
 */

const DIRS = ['up', 'down', 'left', 'right']

// 循环依赖规避：sounds.js 只 import stores/app，本模块延迟 import 由调用点处理——
// 直接顶层 import（sounds → app → 无回边，无环）
import { playNavSound } from '../utils/sounds'

class FocusEngine {
  constructor() {
    /** 当前聚焦元素 */
    this.current = null
    /** 模态层栈：[{ zone: string, trigger: Element|null }] */
    this.layerStack = []
    /** 每页焦点记忆：pageId -> focusKey 字符串 */
    this.pageMemory = new Map()
    /** 路由回退钩子（App 注入） */
    this.onBack = null
    /** 应用退出请求钩子（栈空且无法回退时调用） */
    this.onExitRequest = null
    /** 按键拦截器集合：fn(key) => true 表示消费该按键 */
    this.interceptors = new Set()
    /** 是否响应按键 */
    this.enabled = true
    /** 调试日志 */
    this.debug = false
  }

  // ================= 初始化 =================

  /** 在 window 上捕获阶段监听键盘事件（浏览器调试通道） */
  init() {
    window.addEventListener('keydown', (e) => this.handleKey(e), true)
  }

  // ================= 注册与标记 =================

  /** Vue 指令已通过 data-focusable 属性标记元素，这里无需额外注册表，按需实时查询 */

  // ================= 聚焦控制 =================

  /**
   * 聚焦指定元素
   * @param {Element} el
   */
  focus(el) {
    if (!el || !document.contains(el)) return
    if (this.current && this.current !== el) {
      this.current.classList.remove('tv-focused')
    }
    this.current = el
    el.classList.add('tv-focused')
    this.scrollFollow(el)
    // 广播焦点变更（页面监听实现触底加载等联动）
    window.dispatchEvent(new CustomEvent('tvfocuschange', { detail: el }))
  }

  /** 聚焦某分区的入口元素：优先 data-autofocus，其次第一个可聚焦元素 */
  focusZone(zone) {
    const root = document.querySelector(`[data-focus-zone="${zone}"]`)
    if (!root) return
    const auto = root.querySelector('[data-autofocus]:not([disabled])')
    const el = auto && isVisible(auto) ? auto : this.focusables(zone)[0]
    this.focus(el)
  }

  /** 收集某分区（默认当前层）内所有可见的可聚焦元素 */
  focusables(zone) {
    const root = zone ? document.querySelector(`[data-focus-zone="${zone}"]`) : document
    if (!root) return []
    return Array.from(root.querySelectorAll('[data-focusable]')).filter(isVisible)
  }

  /** 获得元素所在分区名：沿祖先链找 data-focus-zone */
  currentZone() {
    let el = this.current
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute('data-focus-zone')) {
        return el.getAttribute('data-focus-zone')
      }
      el = el.parentElement
    }
    return this.layerStack.length ? this.layerStack[this.layerStack.length - 1].zone : 'content'
  }

  // ================= 模态层栈 =================

  /**
   * 压入一层模态（OSD / 面板 / 确认框）
   * @param {string} zone 模态层分区名
   * @param {Element} [trigger] 触发元素（关闭后焦点归还给它）
   * @param {Function} [onClose] 弹出本层时的回调（无论何种关闭路径都会执行，
   *   用于组件清理定时器/收起 v-if，规避"硬件返回键弹栈但弹窗残留"）
   */
  pushLayer(zone, trigger, onClose) {
    this.layerStack.push({ zone, trigger: trigger || this.current, onClose })
    this.focusZone(zone)
  }

  /** 弹出最上层模态并把焦点归还触发元素；返回被弹出的层（可能为 undefined） */
  popLayer() {
    const layer = this.layerStack.pop()
    if (layer && typeof layer.onClose === 'function') {
      try {
        layer.onClose()
      } catch (_) {
        /* 回调异常不阻断弹栈 */
      }
    }
    if (layer && layer.trigger && document.contains(layer.trigger)) {
      this.focus(layer.trigger)
    }
    return layer
  }

  /** 清空全部模态层（路由切换时调用）：onClose 逐层回调，兜住"跨页残留弹窗" */
  resetLayers() {
    while (this.layerStack.length) this.popLayer()
  }

  /** 是否处于模态层中 */
  get inLayer() {
    return this.layerStack.length > 0
  }

  // ================= 按键拦截器 =================

  /**
   * 注册按键拦截器（页面级）。fn(key) 返回 true 表示已消费，引擎不再处理。
   * 典型用途：播放页 OSD 隐藏态接管方向键实现 seek。
   * @param {Function} fn
   * @returns {Function} 取消注册函数
   */
  addInterceptor(fn) {
    this.interceptors.add(fn)
    return () => this.interceptors.delete(fn)
  }

  // ================= 空间导航 =================

  /**
   * 按方向移动焦点
   * @param {'up'|'down'|'left'|'right'} dir
   */
  move(dir) {
    // 焦点丢失兜底：元素被 v-if 卸载等情况，聚焦当前层第一个
    if (!this.current || !document.contains(this.current)) {
      const zone = this.currentZone()
      const list = this.focusables(zone)
      if (list.length) this.focus(list[0])
      return
    }

    const zone = this.currentZone()
    const rect = this.current.getBoundingClientRect()
    const cands = this.focusables(zone).filter((el) => el !== this.current)
    const best = pickSpatial(cands, rect, dir)

    if (best) {
      this.focus(best)
      playNavSound('move') // P9.6 D28 导航音
      return
    }

    // 当前分区无候选：沿祖先链查找分区出口（D27a 修复——出口属性可声明在 zone
    // 容器或其任意祖先；App.vue 的 data-zone-exit-left 声明在 content-area main 上，
    // 原实现只查 zone 容器导致出口永远读不到、内容区焦点出不了）
    let exiter = this.current
    while (exiter && exiter !== document.body) {
      if (exiter.getAttribute && exiter.getAttribute(`data-zone-exit-${dir}`)) break
      exiter = exiter.parentElement
    }
    if (exiter && exiter !== document.body) {
      const exit = exiter.getAttribute(`data-zone-exit-${dir}`)
      const target = this.focusables(exit)
      // 出口分区可聚焦时，优先恢复到上次离开时的位置附近（取第一个）
      if (target.length) {
        this.focus(target[0])
        playNavSound('move')
      }
    }
    // 无出口或出口为空：停住（边界行为）
  }

  /**
   * 空间候选评分：主轴间隙为主，交叉轴中心距为辅
   */
  // eslint-disable-next-line no-unused-vars
  pick = pickSpatial

  // ================= 确认与返回 =================

  /** 确认键：模拟点击当前元素（Vue @click 即可响应） */
  enter() {
    if (this.current && document.contains(this.current)) {
      playNavSound('confirm') // P9.6 D28 确认音
      this.current.click()
    }
  }

  /**
   * 返回键：层级裁决 —— 拦截器 > 模态层栈 > 路由回退 > 退出确认
   * P9.30 D46：拦截器提到 back() 内部——硬件返回键（Capacitor backButton → back()）
   * 与 Esc 键盘路径同权，页面拦截器（如关闭级联/OSD）在真机遥控器上同样生效，
   * 修复"返回只弹层不关 UI、弹框一直在"。
   * @returns {boolean} 是否已消费
   */
  back() {
    for (const fn of this.interceptors) {
      try {
        if (fn('Escape', null) === true) return true
      } catch (_) {
        /* 拦截器异常不阻断返回链 */
      }
    }
    if (this.layerStack.length) {
      playNavSound('back') // P9.6 D28 返回音
      this.popLayer()
      return true
    }
    if (typeof this.onBack === 'function' && this.onBack() === true) {
      return true
    }
    if (typeof this.onExitRequest === 'function') {
      this.onExitRequest()
      return true
    }
    return false
  }

  // ================= 焦点记忆 =================

  /**
   * 记录当前页焦点（路由离开前调用）
   * @param {string} pageId 页面标识（路由名）
   */
  remember(pageId) {
    if (this.current && document.contains(this.current)) {
      const key = this.current.getAttribute('data-focus-key')
      if (key) this.pageMemory.set(pageId, key)
    }
  }

  /**
   * 恢复页面焦点（挂载后调用）。优先按记忆的 data-focus-key 还原，
   * 否则回退到分区入口元素。
   * @param {string} pageId
   */
  restore(pageId) {
    const key = this.pageMemory.get(pageId)
    if (key) {
      const el = document.querySelector(`[data-focus-zone][data-focus-key="${cssEscape(key)}"], [data-focus-key="${cssEscape(key)}"]`)
      if (el && isVisible(el)) {
        this.focus(el)
        return true
      }
    }
    this.focusZone('content')
    return false
  }

  // ================= 事件分发 =================

  /** @param {KeyboardEvent} e */
  handleKey(e) {
    if (!this.enabled) return
    let key = e.key

    // 遥控器按键兼容（D27a）：老 WebView / 特殊遥控器发非标准 key 名或仅 keyCode
    // 可用时，用 keyCode / 常见别名兜底映射（DPAD 37-40、CENTER 13）
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Enter' && key !== 'Escape') {
      const byCode = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter' }
      const byName = {
        Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown',
        Select: 'Enter', Center: 'Enter', OK: 'Enter',
        DPadLeft: 'ArrowLeft', DPadRight: 'ArrowRight', DPadUp: 'ArrowUp', DPadDown: 'ArrowDown',
        DPadCenter: 'Enter'
      }
      const mapped = byName[key] || byCode[e.keyCode]
      if (mapped) {
        key = mapped
        e.preventDefault()
      }
    }

    // 1. Esc/返回键统一走 back()（内部先跑拦截器，避免拦截器被键盘/hardware 双路径重复执行）
    if (key === 'Escape') {
      e.preventDefault()
      this.back()
      return
    }

    // 2. 拦截器优先（页面级特殊行为）
    for (const fn of this.interceptors) {
      // 第二参传原始 KeyboardEvent（D38）：连进 seek 需要 e.repeat 区分长按，向后兼容
      if (fn(key, e) === true) {
        e.preventDefault()
        return
      }
    }

    if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault()
      this.move(key.slice(5).toLowerCase())
    } else if (key === 'Enter') {
      e.preventDefault()
      this.enter()
    }
    // 其余按键（含媒体键）不拦截，交给播放器等组件自行监听
  }

  // ================= 滚动跟随 =================

  /** 让聚焦元素始终可见（边缘 padding 由 CSS scroll-padding 处理） */
  scrollFollow(el) {
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' })
    } catch (_) {
      // 老 WebView 不支持 options 形式时退化为直接调用
      el.scrollIntoView()
    }
  }
}

/* ---------------- 工具函数 ---------------- */

/** 元素是否可见（渲染在文档中且有面积）
 * P9.5 性能：先 getBoundingClientRect 快筛（弱设备上逐候选 getComputedStyle
 * 强制样式计算是焦点移动卡顿源之一），零面积直接剔除，通过者才查样式 */
function isVisible(el) {
  if (!el || !document.contains(el)) return false
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  const style = window.getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}

/**
 * 空间候选挑选：按方向过滤后取「主轴间隙 + 0.35 × 交叉轴中心距」最小者
 * @param {Element[]} cands
 * @param {DOMRect} from 当前元素矩形
 * @param {string} dir
 * @returns {Element|null}
 */
function pickSpatial(cands, from, dir) {
  let best = null
  let bestScore = Infinity
  const fromCY = from.top + from.height / 2
  const fromCX = from.left + from.width / 2

  for (const el of cands) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue

    let gap // 主轴间隙（必须为正才视为该方向候选）
    let cross // 交叉轴中心距
    let overlap // 交叉轴投影是否重叠（行/列跳转时优先）
    switch (dir) {
      case 'right':
        gap = r.left - from.right
        cross = Math.abs(r.top + r.height / 2 - fromCY)
        overlap = r.top < from.bottom && r.bottom > from.top
        break
      case 'left':
        gap = from.left - r.right
        cross = Math.abs(r.top + r.height / 2 - fromCY)
        overlap = r.top < from.bottom && r.bottom > from.top
        break
      case 'down':
        gap = r.top - from.bottom
        cross = Math.abs(r.left + r.width / 2 - fromCX)
        overlap = r.left < from.right && r.right > from.left
        break
      case 'up':
        gap = from.top - r.bottom
        cross = Math.abs(r.left + r.width / 2 - fromCX)
        overlap = r.left < from.right && r.right > from.left
        break
      default:
        continue
    }

    // 不在该方向的候选
    if (gap < -8) continue
    const effGap = Math.max(gap, 0)
    // 完全同位（左右都无间隙）不算候选
    if (effGap === 0 && cross > Math.max(from.height, r.height)) continue
    // 评分：间隙为主，交叉轴偏移为辅；交叉轴重叠时加大奖励（保持行内直线移动）
    const score = effGap + cross * 0.35 - (overlap ? Math.min(cross, 40) * 0.3 : 0)
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  return best
}

/** 简易 CSS 选择器转义（focusKey 通常为 bvid，安全字符，兜底处理） */
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s)
  return String(s).replace(/["\\]/g, '\\$&')
}

/** 全局单例 */
export const focusEngine = new FocusEngine()
