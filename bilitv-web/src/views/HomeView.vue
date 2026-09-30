<script setup>
/**
 * 首页（P9.11 D33 信息架构纠正）：二级菜单 = 推荐 / 关注
 * - 推荐：feed 分页（缓存先行 + 后台增量，D25）
 * - 关注：云端/本地收藏与历史分流（D17/D5/D6）
 * 热门频道已独立为 HotView（#/hot，左侧一级菜单）。
 */
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { getFeedRcmd, getFollowings, getUpArchives } from '../api/bilibili'
import { getFollowDynFeed } from '../api/cloud'
import { auth } from '../stores/auth'
import { settings } from '../stores/app'
import { loadCache, saveCache, mergeCards } from '../stores/cardCache'
import { focusEngine } from '../core/focus'
import { navigate } from '../router'
import VideoCard from '../components/VideoCard.vue'
import StateBlock from '../components/StateBlock.vue'
import { toast, toastError } from '../utils/toast'

/** bvid prop：常规路由为空；#/home/<mid> 时承载 UP 主 mid（直连投稿流，D48） */
const props = defineProps({
  bvid: { type: String, default: '' }
})

/** 首页二级菜单（P9.11 D33） */
const HOME_SUBS = [
  { key: 'rcmd', label: '推荐' },
  { key: 'follow', label: '关注' }
]
const homeSub = ref('rcmd')
const list = ref([])
const state = ref('loading') // loading | ok | error | empty
const errMsg = ref('')
const hasMore = ref(false)
const rcmdKey = ref('') // 推荐流游标（空 = 没有更多）
const loadingMore = ref(false)

/* ---------------- 关注 Tab 状态（D17/D5/D6） ---------------- */
const ups = ref([])
const followView = ref('main')
const followMode = ref('all')
const followLoading = ref(false)

/** 切换二级菜单 */
async function loadSub(sub) {
  homeSub.value = sub
  errMsg.value = ''

  /* 推荐：缓存先行 + 后台增量 */
  if (sub === 'rcmd') {
    state.value = 'loading'
    const cache = loadCache('rcmd')
    if (cache && cache.list.length) {
      list.value = cache.list.slice(0, settings.maxCards)
      rcmdKey.value = cache.cursor || ''
      hasMore.value = !!rcmdKey.value && list.value.length < settings.maxCards
      state.value = 'ok'
      await nextTick()
      focusFirst()
    }
    refreshRcmd() // fire-and-forget：后台增量
    return
  }

  /* 关注 */
  state.value = 'loading'
  try {
    if (!auth.loggedIn) {
      state.value = 'ok'
      followView.value = 'main'
      followMode.value = 'all'
      ups.value = []
      list.value = []
      await nextTick()
      focusFirst()
      return
    }
    const res = await getFollowings(1, 60)
    ups.value = res.list
    followView.value = 'main'
    followMode.value = 'all'
    state.value = 'ok'
    await nextTick()
    focusFirst()
    if (res.list.length) loadAllFeed()
  } catch (err) {
    state.value = 'error'
    errMsg.value = err.message || '加载失败'
  }
}

/** 推荐流后台增量（缓存先行时静默合并） */
async function refreshRcmd() {
  try {
    const res = await getFeedRcmd('')
    rcmdKey.value = res.continueKey
    list.value = mergeCards(res.list, loadCache('rcmd')?.list || [])
    hasMore.value = !!res.continueKey && list.value.length < settings.maxCards
    saveCache('rcmd', { list: list.value.slice(0, settings.maxCards), cursor: rcmdKey.value })
    state.value = list.value.length ? 'ok' : 'empty'
  } catch (err) {
    if (!list.value.length) {
      state.value = 'error'
      errMsg.value = err.message || '加载失败'
    }
  }
}

/** 内容渲染后把焦点放回激活 Tab（或内容首项） */
function focusFirst() {
  if (!focusEngine.current || !document.contains(focusEngine.current)) {
    focusEngine.focusZone('content')
  }
}

/** 焦点接近列表尾部 → 加载下一页（推荐流 + 关注动态流，上限 maxCards） */
function onFocusChange(e) {
  if (loadingMore.value) return
  const el = e.detail
  if (!el.classList.contains('video-card')) return
  // 关注-全部：动态流 offset 翻页
  if (homeSub.value === 'follow' && followMode.value === 'all' && followHasMore) {
    const cards = Array.from(el.parentElement.querySelectorAll('.video-card'))
    const idx = cards.indexOf(el)
    if (idx >= cards.length - 6) loadMoreDyn()
    return
  }
  // 推荐：feed 游标翻页
  if (homeSub.value === 'rcmd' && hasMore.value) {
    const cards = Array.from(el.parentElement.querySelectorAll('.video-card'))
    const idx = cards.indexOf(el)
    if (idx >= cards.length - 6) loadMore()
  }
}

async function loadMore() {
  if (loadingMore.value) return
  if (list.value.length >= settings.maxCards) {
    hasMore.value = false
    return
  }
  loadingMore.value = true
  try {
    if (!rcmdKey.value) {
      hasMore.value = false
      return
    }
    const res = await getFeedRcmd(rcmdKey.value)
    rcmdKey.value = res.continueKey
    list.value = mergeCards(res.list, list.value)
    hasMore.value = !!res.continueKey && list.value.length < settings.maxCards
    saveCache('rcmd', { list: list.value.slice(0, settings.maxCards), cursor: rcmdKey.value })
  } catch (err) {
    toastError(err)
  } finally {
    loadingMore.value = false
  }
}

/* ---------------- 关注 Tab 交互（D17/D5/D6 + P9.12 D35 动态流） ----------------
 * 「全部」/「单 UP」均走动态视频流接口（1 个请求替代逐 UP searchAll，
 * <1 秒出内容、真实时间序、覆盖全部关注 UP）；offset 触底懒加载。 */

/** 动态流分页游标与是否还有下一页 */
let followOffset = ''
let followHasMore = false

/**
 * 「全部」：关注 UP 的最新视频动态流（缓存先行 + 后台增量）
 */
function loadAllFeed() {
  const cache = loadCache('followAll')
  if (cache && cache.list.length) {
    list.value = cache.list
    followOffset = cache.cursor || ''
    followHasMore = cache.hasMore !== false
    refreshAllFeed() // 后台静默刷新
  } else {
    list.value = []
    refreshAllFeed() // 无缓存：前台转圈
  }
}

async function refreshAllFeed() {
  followLoading.value = !list.value.length
  try {
    const res = await getFollowDynFeed(0, '')
    list.value = mergeCards(res.list, loadCache('followAll')?.list || [])
    followOffset = res.offset
    followHasMore = res.hasMore
    saveCache('followAll', {
      list: list.value.slice(0, settings.maxCards),
      cursor: followOffset,
      hasMore: followHasMore
    })
  } catch (err) {
    if (!list.value.length) toastError(err) // 有缓存内容时静默保旧
  } finally {
    followLoading.value = false
  }
}

/** 焦点触底 → 动态流 offset 翻页（仅「全部」模式） */
async function loadMoreDyn() {
  if (loadingMore.value || !followHasMore || !followOffset) return
  if (list.value.length >= settings.maxCards) {
    followHasMore = false
    return
  }
  loadingMore.value = true
  try {
    const res = await getFollowDynFeed(0, followOffset)
    list.value = mergeCards(res.list, list.value)
    followOffset = res.offset
    followHasMore = res.hasMore
    saveCache('followAll', {
      list: list.value.slice(0, settings.maxCards),
      cursor: followOffset,
      hasMore: followHasMore
    })
  } catch (err) {
    toastError(err)
  } finally {
    loadingMore.value = false
  }
}

/** 点击「全部」 */
function openAll() {
  followMode.value = 'all'
  loadAllFeed()
}

/** 点击 UP 主：该 UP 的最新视频动态（host_mid 筛选，按时间序；D25 缓存同模式） */
function openUp(up) {
  followMode.value = up
  const key = `follow-${up.mid}`
  const cache = loadCache(key)
  if (cache && cache.list.length) {
    list.value = cache.list
    refreshUpVideos(up, key)
  } else {
    list.value = []
    refreshUpVideos(up, key)
  }
}

/* ---------------- UP 主直连模式（P9.32 D48：播放页 UP主按钮 → #/home/<mid>） ---------------- */
const upDirect = ref(null) // { mid } 非关注 UP 也可看投稿

function openUpDirect(mid) {
  upDirect.value = { mid: Number(mid) }
  homeSub.value = 'follow'
  followView.value = 'main'
  followMode.value = { mid: Number(mid) }
  // P9.36 D52：未登录也可见投稿——wbi space 接口匿名可用（仅复用关注 UI，不走关注业务）
  if (!auth.loggedIn) {
    loadUpArchivesDirect(Number(mid))
    return
  }
  state.value = 'loading'
  refreshUpVideos({ mid: Number(mid) }, `follow-${mid}`)
}

/** 未登录直连：space 投稿列表（匿名 wbi 签名） */
async function loadUpArchivesDirect(mid) {
  state.value = 'loading'
  followLoading.value = true
  try {
    const res = await getUpArchives(mid)
    list.value = res.list
    state.value = 'ok'
  } catch (err) {
    state.value = 'error'
    errMsg.value = err.message || '加载失败'
  } finally {
    followLoading.value = false
  }
}

function exitUpDirect() {
  upDirect.value = null
  loadSub('follow')
}

async function refreshUpVideos(up, cacheKey) {
  followLoading.value = !list.value.length
  try {
    const res = await getFollowDynFeed(up.mid, '')
    const videos = res.list.slice(0, Math.min(30, settings.maxCards))
    list.value = videos
    followOffset = res.offset
    followHasMore = res.hasMore
    saveCache(cacheKey, { list: videos })
    state.value = 'ok' // P9.32 D48：直连模式 / UP 模式共用
  } catch (err) {
    if (!list.value.length) {
      state.value = 'error'
      errMsg.value = err.message || '加载失败'
    } else {
      toastError(err)
    }
  } finally {
    followLoading.value = false
  }
}

/** 展开 / 收起 UP 主网格 */
function toggleGrid() {
  followView.value = followView.value === 'main' ? 'grid' : 'main'
  nextTick(() => focusEngine.focusZone('content'))
}

function retry() {
  loadSub(homeSub.value)
}

onMounted(() => {
  // P9.32 D48：#/home/<mid> 直连该 UP 投稿流（播放页「UP主」按钮入口）
  if (props.bvid && /^\d+$/.test(String(props.bvid))) {
    openUpDirect(props.bvid)
  } else {
    loadSub(homeSub.value)
  }
  window.addEventListener('tvfocuschange', onFocusChange)
})
onUnmounted(() => {
  window.removeEventListener('tvfocuschange', onFocusChange)
})
</script>

<template>
  <!-- data-focus-zone="content"：App.vue 契约——每页自带内容分区，缺失会导致引擎找不到候选、按键全部失效 -->
  <div data-focus-zone="content">
    <!-- 二级+三级菜单吸顶容器（P9.20）：滚动卡片时菜单固定不参与滚动 -->
    <div class="menus-sticky">
      <!-- 二级菜单横排：推荐 / 关注（P9.11 D33） -->
      <div class="menu-row">
        <div
          v-for="s in HOME_SUBS"
          :key="s.key"
          v-focusable
          class="menu-pill"
          :class="{ active: homeSub === s.key }"
          :data-autofocus="homeSub === s.key ? '' : undefined"
          @click="loadSub(s.key)"
        >
          {{ s.label }}
        </div>
      </div>

      <!-- UP 直连模式（D48）：返回 + 标题行 -->
      <div v-if="homeSub === 'follow' && upDirect" class="menu-row">
        <div class="menu-scroll">
          <div v-focusable class="up-card small" data-autofocus @click="exitUpDirect">
            <div class="up-face all-face">←</div>
            <div class="up-name">返回</div>
          </div>
        </div>
        <div class="up-direct-name">UP 主（ID {{ upDirect.mid }}）的投稿</div>
      </div>

      <!-- 关注：UP 横排（三级菜单，横向滚动 + 展开钮） -->
      <div v-if="homeSub === 'follow' && auth.loggedIn && followView === 'main' && state === 'ok' && !upDirect" class="menu-row">
        <div class="menu-scroll">
          <div
            v-focusable
            class="up-card small"
            :class="{ active: followMode === 'all' }"
            data-autofocus
            @click="openAll"
          >
            <div class="up-face all-face">☰</div>
            <div class="up-name">全部</div>
          </div>
          <div
            v-for="up in ups"
            :key="up.mid"
            v-focusable
            class="up-card small"
            :class="{ active: followMode !== 'all' && followMode.mid === up.mid }"
            @click="openUp(up)"
          >
            <img class="up-face" :src="up.face" :alt="up.name" loading="lazy" />
            <div class="up-name">{{ up.name }}</div>
          </div>
        </div>
        <button v-focusable class="up-expand" @click="toggleGrid">展开 ▾</button>
      </div>
    </div>

    <!-- 关注：未登录引导 -->
    <div v-if="homeSub === 'follow' && !auth.loggedIn" class="login-guide">
      <div class="guide-title">登录后查看我的关注</div>
      <div class="guide-sub">扫码登录与手机端同一账号</div>
      <button v-focusable class="tab-item primary" @click="navigate('mine')">去扫码登录</button>
    </div>

    <!-- 关注：加载失败（D48 补：直连模式未登录/接口失败也有可见反馈） -->
    <template v-else-if="homeSub === 'follow' && state === 'error'">
      <StateBlock state="error" :message="errMsg" @retry="retry" />
    </template>

    <!-- 关注 主视图：视频区（UP 横排已上移进吸顶容器） -->
    <template v-else-if="homeSub === 'follow' && followView === 'main' && state === 'ok'">
      <StateBlock v-if="followLoading" state="loading" />
      <StateBlock v-else-if="!list.length" state="empty" />
      <div v-else class="card-grid">
        <VideoCard v-for="item in list" :key="item.bvid" :item="item" />
      </div>
    </template>

    <!-- 关注：展开的 UP 主网格 -->
    <template v-else-if="homeSub === 'follow' && followView === 'grid' && state === 'ok'">
      <div class="up-bar">
        <button v-focusable class="tab-item" @click="toggleGrid">▴ 收起</button>
        <span class="up-bar-name">共 {{ ups.length }} 位 UP 主</span>
      </div>
      <div class="up-grid">
        <div
          v-for="up in ups"
          :key="up.mid"
          v-focusable
          class="up-card"
          :data-focus-key="'up-' + up.mid"
          @click="openUp(up); followView = 'main'"
        >
          <img class="up-face" :src="up.face" :alt="up.name" loading="lazy" />
          <div class="up-name">{{ up.name }}</div>
        </div>
      </div>
    </template>

    <!-- 推荐：通用列表 -->
    <template v-else-if="homeSub === 'rcmd'">
      <StateBlock v-if="state === 'loading'" state="loading" />
      <StateBlock v-else-if="state === 'error'" state="error" :message="errMsg" @retry="retry" />
      <StateBlock v-else-if="state === 'empty'" state="empty" />

      <div v-else class="card-grid">
        <VideoCard v-for="item in list" :key="item.bvid" :item="item" />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 关注引导卡 */
.login-guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 70px 30px;
  background: var(--bg-card);
  border-radius: var(--radius);
}

.guide-title {
  font-size: 26px;
  font-weight: 700;
}

.guide-sub {
  color: var(--text-dim);
  font-size: 19px;
}

.tab-item.primary {
  background: var(--accent);
  color: #fff;
  padding: 14px 40px;
  border-radius: 10px;
}

/* 菜单与 UP 卡基础样式已提升到 global.css（P9.20 首页/热门共用） */

.up-expand {
  flex-shrink: 0;
  padding: 0 20px;
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--text);
  font-size: 19px;
  align-self: stretch;
}

/* UP 主网格（展开态） */
.up-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 22px;
}

/* UP 主视频条 */
.up-bar {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 20px;
}

.up-bar-name {
  color: var(--text-dim);
  font-size: 21px;
}

/* UP 直连模式标题（D48） */
.up-direct-name {
  font-size: 18px;
  color: var(--text-dim);
  white-space: nowrap;
  align-self: center;
  padding-right: 12px;
}
</style>