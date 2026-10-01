/**
 * 自写 hash 路由（约 70 行，替代 vue-router）
 *
 * 形态：#/home · #/search · #/play/BV1xxx · #/mine · #/settings
 * 页面仅 5 个，hash 路由同时规避 WebView 直接访问子路径 404 的问题。
 */
import { reactive } from 'vue'

import HomeView from './views/HomeView.vue'
import HotView from './views/HotView.vue'
import SearchView from './views/SearchView.vue'
import PlayerView from './views/PlayerView.vue'
import MineView from './views/MineView.vue'
import SettingsView from './views/SettingsView.vue'

/** 路由表：name -> 组件（PlayerView 通过 props 接收 bvid 参数） */
const ROUTES = {
  home: { component: HomeView },
  hot: { component: HotView },
  search: { component: SearchView },
  play: { component: PlayerView },
  mine: { component: MineView },
  settings: { component: SettingsView }
}

/** 解析当前 hash → { name, param } */
function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '')
  const segs = h.split('/').filter(Boolean)
  const name = segs[0] || 'home'
  return {
    name: ROUTES[name] ? name : 'home',
    param: segs[1] || ''
  }
}

/** 全局响应式路由对象 */
export const route = reactive({
  name: 'home',
  param: ''
})

/** 订阅者（App.vue 用于在路由切换时处理焦点记忆） */
const listeners = new Set()

export function onRouteChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/* ---------------- 主动刷新（P9.53：遥控器再按一次同一导航项） ----------------
 * 语义：路由没变（hash 相同，navigate 不会触发 hashchange）时，用「再点一次
 * 当前导航项 = 刷新当前页」替代无效点击。页面订阅该事件后在已有内容上重新拉流。 */
const refreshListeners = new Set()

/** 订阅当前页「主动刷新」请求 */
export function onRefreshRequest(fn) {
  refreshListeners.add(fn)
  return () => refreshListeners.delete(fn)
}

/** 发出主动刷新请求（SideBar 点击当前导航项时调用） */
export function requestRefresh() {
  refreshListeners.forEach((fn) => {
    try {
      fn(route)
    } catch (_) {
      /* 单个订阅异常不阻断其他订阅 */
    }
  })
}

/** 应用路由解析结果（含订阅通知：fn(next, prev)） */
function apply() {
  const next = parseHash()
  const changed = next.name !== route.name || next.param !== route.param
  const prev = { name: route.name, param: route.param }
  route.name = next.name
  route.param = next.param
  if (changed) {
    // P9.53 路由追踪：TV 端靠 logcat 取证（返回栈 / 连播是否污染历史），
    // 形如 `route home -> play/BV1xxx`；换页时会连出两行（前进 + 回退）。
    const show = (r) => r.name + (r.param ? '/' + r.param : '')
    console.log(`[BiliTV] route ${show(prev)} -> ${show(next)}`)
    listeners.forEach((fn) => fn(route, prev))
  }
}

/** 拼装 hash 目标（统一入口，避免各页面自己拼 #/ 导致漏写） */
const hashOf = (path) => '#/' + String(path).replace(/^\/+/, '')

/**
 * 编程式导航
 * @param {string} path 目标路径，如 'home' / 'play/BV1xxx' / 'home/12345'
 * @param {{replace?: boolean}} [opts]
 *   replace=true 用 location.replace **替换当前历史项**，而不是新开一条。
 *   P9.53 返回栈治理：播放页内换视频（自动连播 / 选集 / 相关推荐 / UP 投稿）
 *   若逐条 push，观看 3 个视频后连按返回要退 3 次才回到菜单，且中途每一次
 *   都停在同一个播放页上——TV 遥控器的返回语义是「退出当前层回上级菜单」。
 *   故播放页内到播放页的横向跳转一律 replace，历史里始终只保留一条播放记录。
 */
export function navigate(path, opts) {
  const target = hashOf(path)
  if (window.location.hash === target) return
  if (opts && opts.replace) window.location.replace(target)
  else window.location.hash = target
}

/** 替换当前历史项（等价于 navigate(path, { replace: true })） */
export function replacePath(path) {
  navigate(path, { replace: true })
}

/**
 * 路由回退（浏览器历史；播放页 → 来源页）
 * 兜底：首屏直接落在播放页（深链 / 任务恢复）时 history.back() 无处可退，
 * 此时按返回应回到首页而不是"按了没反应"。
 */
export function routeBack() {
  try {
    if (window.history.length > 1) {
      window.history.back()
      return
    }
  } catch (_) {
    /* 老 WebView 可能不支持 history.length：走兜底 */
  }
  replacePath('home')
}

/** 生成播放页路径 */
export const playPath = (bvid) => `play/${bvid}`

window.addEventListener('hashchange', apply)
apply()
