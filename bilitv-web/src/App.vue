<script setup>
/**
 * 根组件：左侧导航 + 右侧内容区（对照 BBLL 布局）
 * - 播放页全屏（隐藏侧边栏）
 * - 路由切换时：记忆旧页焦点 → 新页挂载后恢复焦点（或聚焦分区入口）
 */
import { computed, nextTick, onMounted } from 'vue'
import { route, onRouteChange } from './router'
import { focusEngine } from './core/focus'
import { runtimeSession } from './stores/app'
import { toast } from './utils/toast'
import SideBar from './components/SideBar.vue'
import Toast from './components/Toast.vue'
import HomeView from './views/HomeView.vue'
import HotView from './views/HotView.vue'
import SearchView from './views/SearchView.vue'
import PlayerView from './views/PlayerView.vue'
import MineView from './views/MineView.vue'
import SettingsView from './views/SettingsView.vue'

/** 路由组件映射 */
const routeMap = {
  home: HomeView,
  hot: HotView,
  search: SearchView,
  play: PlayerView,
  mine: MineView,
  settings: SettingsView
}

/** 播放页为全屏布局 */
const isPlayer = computed(() => route.name === 'play')

/** 内容区是否允许左键切回侧边栏（播放页无侧边栏） */
const contentExitLeft = computed(() => (isPlayer.value ? null : 'sidebar'))

// 路由切换：记忆旧页焦点位置（供返回时还原）
onRouteChange((next, prev) => {
  focusEngine.remember(prev.name)
  // P9.30 D46：收起系统键盘（搜索页 input 聚焦状态下切页，IME 会滞留到新页面）
  const active = document.activeElement
  if (active && typeof active.blur === 'function') active.blur()
  // P9.30 D46：清空模态层栈（onClose 逐层回调），兜住"跨页残留弹窗/键盘层"
  focusEngine.resetLayers()
})

// 等新页面 DOM 挂载完成后恢复/初始化焦点
onRouteChange(async () => {
  // 立即清掉旧焦点视觉，避免新页面闪现旧高亮
  if (focusEngine.current) focusEngine.current.classList.remove('tv-focused')
  focusEngine.current = null

  await nextTick()
  await nextTick()
  focusEngine.restore(route.name)
})

// 崩溃自愈提示（P9.19 D39）：上次播放中异常退出，本次会话已强制原生内核
onMounted(() => {
  if (runtimeSession.crashDetected) {
    toast('检测到上次播放异常退出，已自动切换原生播放内核')
  }
})
</script>

<template>
  <div class="app-layout">
    <!-- 左侧常驻导航（播放页隐藏） -->
    <SideBar v-if="!isPlayer" />

    <!-- 右侧内容区：每个页面自带 data-focus-zone="content" 的容器 -->
    <main class="content-area" :data-zone-exit-left="contentExitLeft">
      <component :is="routeMap[route.name]" :bvid="route.param" :key="route.name + '-' + route.param" />
    </main>

    <Toast />
  </div>
</template>
