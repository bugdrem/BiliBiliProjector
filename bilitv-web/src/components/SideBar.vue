<script setup>
/**
 * 左侧常驻导航栏（对照 BBLL）
 * 分区名 sidebar；右键经 data-zone-exit-right 切入内容区。
 * 当前路由项高亮；点击切换路由。
 */
import { route, navigate, requestRefresh } from '../router'

/** 导航项配置（P9.11 D33：热门为一级菜单，位于首页下方） */
const NAV_ITEMS = [
  { key: 'search', label: '搜索', icon: 'search' },
  { key: 'home', label: '首页', icon: 'home' },
  { key: 'hot', label: '热门', icon: 'fire' },
  { key: 'mine', label: '我的', icon: 'star' },
  { key: 'settings', label: '设置', icon: 'gear' }
]

/**
 * P9.53：再按一次当前导航项 = 主动刷新当前页（hash 没变，navigate 不会触发
 * hashchange，原实现是"按了没反应"）。返回键的语义始终是"回上级菜单"，
 * 主动刷新只认这一条显式入口。
 */
function go(key) {
  if (route.name === key) {
    requestRefresh()
    return
  }
  navigate(key)
}
</script>

<template>
  <aside class="sidebar" data-focus-zone="sidebar" data-zone-exit-right="content">
    <div class="brand">
      <span class="brand-tv">TV</span>
      <span class="brand-name">BiliTV</span>
    </div>

    <nav class="nav-list">
      <div
        v-for="item in NAV_ITEMS"
        :key="item.key"
        v-focusable
        class="nav-item"
        :class="{ active: route.name === item.key }"
        :data-focus-key="'nav-' + item.key"
        :data-autofocus="route.name === item.key ? '' : undefined"
        @click="go(item.key)"
      >
        <span class="nav-icon" aria-hidden="true">
          <!-- 内联 SVG 图标，避免外部依赖 -->
          <svg v-if="item.icon === 'search'" viewBox="0 0 24 24" width="26" height="26">
            <path
              d="M10.5 3a7.5 7.5 0 1 1 0 15c-1.8 0-3.5-.6-4.8-1.7l-3 3a1 1 0 0 1-1.4-1.4l3-3A7.5 7.5 0 0 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"
              fill="currentColor"
            />
          </svg>
          <svg v-else-if="item.icon === 'home'" viewBox="0 0 24 24" width="26" height="26">
            <path
              d="M12 3.2 21 10v9a2 2 0 0 1-2 2h-4.5v-6h-5v6H5a2 2 0 0 1-2-2v-9l9-6.8z"
              fill="currentColor"
            />
          </svg>
          <svg v-else-if="item.icon === 'fire'" viewBox="0 0 24 24" width="26" height="26">
            <!-- 火焰（热门频道，Tabler flame 风格） -->
            <path
              d="M12 12c2-2.96 0-5-1-5.71 0 4.71-4 5.71-4 9.21A5 5 0 0 0 12 21a5 5 0 0 0 5-8.5c-.86-1.72-2.2-2.53-2.2-2.53 0 2.13-.8 2.53-.8 2.53z"
              fill="currentColor"
            />
            <path
              d="M12 21c-2.76 0-5-2.24-5-4.5 0-1.9 1.5-2.93 2.6-4.4-.15 2.4 1.4 2.9 1.4 2.9 0-2.9 2.4-4.5 2.4-6.5 2.5 2.2 3.6 5 3.6 8a5 5 0 0 1-5 5z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
          <svg v-else-if="item.icon === 'star'" viewBox="0 0 24 24" width="26" height="26">
            <path
              d="m12 3.6 2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8L12 3.6z"
              fill="currentColor"
            />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="26" height="26">
            <path
              d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm8.6 3.5c0-.6-.1-1.2-.2-1.7l2-1.6-2-3.4-2.4 1a8.7 8.7 0 0 0-3-1.7L14.6 2H9.4l-.4 2.6a8.7 8.7 0 0 0-3 1.7l-2.4-1-2 3.4 2 1.6a8.9 8.9 0 0 0 0 3.4l-2 1.6 2 3.4 2.4-1a8.7 8.7 0 0 0 3 1.7l.4 2.6h5.2l.4-2.6a8.7 8.7 0 0 0 3-1.7l2.4 1 2-3.4-2-1.6c.1-.5.2-1.1.2-1.7z"
              fill="currentColor"
            />
          </svg>
        </span>
        <span class="nav-label">{{ item.label }}</span>
      </div>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  height: 100%;
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 26px 24px 22px;
}

.brand-tv {
  background: var(--accent-pink);
  color: #fff;
  font-weight: 800;
  font-size: 18px;
  border-radius: 8px;
  padding: 4px 10px;
}

.brand-name {
  font-size: 24px;
  font-weight: 700;
}

.nav-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 6px 16px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 18px;
  border-radius: 12px;
  color: var(--text-dim);
  min-height: 64px;
}

.nav-icon {
  display: flex;
  align-items: center;
}

.nav-label {
  font-size: 23px;
}

.nav-item.active {
  color: var(--accent);
  background: rgba(0, 161, 214, 0.12);
}
</style>
