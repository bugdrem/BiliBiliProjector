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

/** 应用路由解析结果（含订阅通知：fn(next, prev)） */
function apply() {
  const next = parseHash()
  const changed = next.name !== route.name || next.param !== route.param
  const prev = { name: route.name, param: route.param }
  route.name = next.name
  route.param = next.param
  if (changed) listeners.forEach((fn) => fn(route, prev))
}

/** 编程式导航 */
export function navigate(path) {
  const target = '#/' + String(path).replace(/^\/+/, '')
  if (window.location.hash === target) return
  window.location.hash = target
}

/** 路由回退（浏览器历史；播放页 → 来源页） */
export function routeBack() {
  window.history.back()
}

/** 生成播放页路径 */
export const playPath = (bvid) => `play/${bvid}`

window.addEventListener('hashchange', apply)
apply()
