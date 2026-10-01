<script setup>
/**
 * 首页（P9.11 D33 信息架构纠正）：二级菜单 = 推荐 / 关注
 * - 推荐：feed 分页（缓存先行 + 后台增量，D25）
 * - 关注：云端/本地收藏与历史分流（D17/D5/D6）
 * 热门频道已独立为 HotView（#/hot，左侧一级菜单）。
 *
 * P9.53 会话态与返回栈治理：
 *  1. 列表/游标/菜单选中态全部落在 stores/homeFeed（模块级响应式）——组件被卸载
 *     后重建（进播放页再返回、侧边栏来回切页）直接按原样渲染，**不重发网络请求**；
 *     只有显式再按一次「推荐 / 关注 / 首页」导航项才 force 刷新。
 *  2. 播放页内换视频一律走 replace（见 router.navigate），返回键直接回上级菜单。
 */
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { getFeedRcmd, getFollowings, getUpArchives } from '../api/bilibili'
import { getFollowDynFeed } from '../api/cloud'
import { auth } from '../stores/auth'
import { settings } from '../stores/app'
import { homeFeed } from '../stores/homeFeed'
import { loadCache, saveCache, mergeCards } from '../stores/cardCache'
import { focusEngine } from '../core/focus'
import { navigate, onRefreshRequest } from '../router'
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

/** 加载翻页锁（非响应式，仅同步并发用） */
const loadingMore = ref(false)

/* ---------------- 关注 Tab 状态（D17/D5/D6） ---------------- */

/** 二次菜单切换：点同一个 tab = 主动刷新（P9.53） */
function onSubClick(key) {
  loadSub(key, homeFeed.sub === key)
}

/**
 * 进入/切换二级菜单
 * @param {'rcmd'|'follow'} sub
 * @param {boolean} [force] true = 用户显式再按一次同一项，强制重新拉流
 */
async function loadSub(sub, force = false) {
  homeFeed.sub = sub
  homeFeed.errMsg = ''

  /* 推荐 */
  if (sub === 'rcmd') {
    // P9.53：路由切回（visited=true）——内存快照/缓存直接渲染，零网络请求
    if (!force && homeFeed.visited) {
      restoreRcmdView()
      return
    }
    homeFeed.visited = true // 已发起过首屏：此后切回首页不再重拉
    // 首次进入：缓存先行（D25），随后后台增量拉新，回来的是新数据而不是转圈
    applyRcmdCache()
    if (homeFeed.state !== 'ok') homeFeed.state = 'loading'
    refreshRcmd() // fire-and-forget
    return
  }

  /* 关注 */
  if (!force && homeFeed.visited && homeFeed.state !== 'loading') {
    // P9.53：本次会话已加载过关注流，回到本页只复原视图
    homeFeed.state = homeFeed.list.length ? 'ok' : 'empty'
    await nextTick()
    focusFirst()
    return
  }
  homeFeed.visited = true
  homeFeed.state = 'loading'
  try {
    if (!auth.loggedIn) {
      homeFeed.state = 'ok'
      homeFeed.followView = 'main'
      homeFeed.followMode = 'all'
      homeFeed.ups = []
      homeFeed.list = []
      homeFeed.followBooted = true
      await nextTick()
      focusFirst()
      return
    }
    // UP 列表只在首次进入关注页时拉（登录态变化时会在 auth 变更处重置）
    if (!homeFeed.upsBooted) {
      const res = await getFollowings(1, 60)
      homeFeed.ups = res.list
      homeFeed.upsBooted = true
    }
    homeFeed.followView = 'main'
    homeFeed.followMode = 'all'
    homeFeed.state = 'ok'
    await nextTick()
    focusFirst()
    if (homeFeed.ups.length) loadAllFeed()
    homeFeed.followBooted = true
  } catch (err) {
    homeFeed.state = 'error'
    homeFeed.errMsg = err.message || '加载失败'
    homeFeed.followBooted = true
  }
}

/** 用本地缓存复原推荐列表；返回 true 表示已渲染 */
function applyRcmdCache() {
  const cache = loadCache('rcmd')
  if (!cache || !cache.list.length) return false
  homeFeed.rcmdKey = cache.cursor || ''
  homeFeed.list = cache.list.slice(0, settings.maxCards)
  homeFeed.hasMore = !!homeFeed.rcmdKey && homeFeed.list.length < settings.maxCards
  homeFeed.state = 'ok'
  nextTick(() => focusFirst())
  return true
}

/** 路由切回收复原视图（纯渲染，不发请求）：内存快照空时退到缓存 */
function restoreRcmdView() {
  if (!homeFeed.list.length) applyRcmdCache()
  homeFeed.state = homeFeed.list.length ? 'ok' : 'empty'
  nextTick(() => focusFirst())
}

/**
 * P9.53 探针：记录推荐流拉取次数，打进 logcat。
 * 取证用途——「从播放页返回 / 侧边栏切页不应重拉推荐流」，验证时数这一行即可；
 * 只有显式再按一次「推荐 / 首页」导航项才会出现 #2。
 */
function probeRcmd() {
  homeFeed.fetches += 1
  try {
    window.__rcmdFetches = homeFeed.fetches
    console.log('[BiliTV] rcmd fetch #' + homeFeed.fetches)
  } catch (_) {
    /* 老 WebView 无 console 也无所谓 */
  }
}

/** 推荐流后台增量（缓存先行时静默合并） */
async function refreshRcmd() {
  probeRcmd()
  try {
    const res = await getFeedRcmd('')
    homeFeed.rcmdKey = res.continueKey
    homeFeed.list = mergeCards(res.list, loadCache('rcmd')?.list || [])
    homeFeed.hasMore = !!res.continueKey && homeFeed.list.length < settings.maxCards
    saveCache('rcmd', { list: homeFeed.list.slice(0, settings.maxCards), cursor: homeFeed.rcmdKey })
    homeFeed.state = homeFeed.list.length ? 'ok' : 'empty'
  } catch (err) {
    if (!homeFeed.list.length) {
      homeFeed.state = 'error'
      homeFeed.errMsg = err.message || '加载失败'
    }
  } finally {
    homeFeed.rcmdBooted = true
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
  if (homeFeed.sub === 'follow' && homeFeed.followMode === 'all' && homeFeed.followHasMore) {
    const cards = Array.from(el.parentElement.querySelectorAll('.video-card'))
    const idx = cards.indexOf(el)
    if (idx >= cards.length - 6) loadMoreDyn()
    return
  }
  // 推荐：feed 游标翻页
  if (homeFeed.sub === 'rcmd' && homeFeed.hasMore) {
    const cards = Array.from(el.parentElement.querySelectorAll('.video-card'))
    const idx = cards.indexOf(el)
    if (idx >= cards.length - 6) loadMore()
  }
}

async function loadMore() {
  if (loadingMore.value) return
  if (homeFeed.list.length >= settings.maxCards) {
    homeFeed.hasMore = false
    return
  }
  loadingMore.value = true
  try {
    if (!homeFeed.rcmdKey) {
      homeFeed.hasMore = false
      return
    }
    const res = await getFeedRcmd(homeFeed.rcmdKey)
    homeFeed.rcmdKey = res.continueKey
    homeFeed.list = mergeCards(res.list, homeFeed.list)
    homeFeed.hasMore = !!res.continueKey && homeFeed.list.length < settings.maxCards
    saveCache('rcmd', { list: homeFeed.list.slice(0, settings.maxCards), cursor: homeFeed.rcmdKey })
  } catch (err) {
    toastError(err)
  } finally {
    loadingMore.value = false
  }
}

/* ---------------- 关注 Tab 交互（D17/D5/D6 + P9.12 D35 动态流） ----------------
 * 「全部」/「单 UP」均走动态视频流接口（1 个请求替代逐 UP searchAll，
 * <1 秒出内容、真实时间序、覆盖全部关注 UP）；offset 触底懒加载。 */

/** 「全部」：关注 UP 的最新视频动态流（缓存先行 + 后台增量） */
function loadAllFeed() {
  const cache = loadCache('followAll')
  if (cache && cache.list.length) {
    homeFeed.list = cache.list
    homeFeed.followOffset = cache.cursor || ''
    homeFeed.followHasMore = cache.hasMore !== false
    refreshAllFeed() // 后台静默刷新
  } else {
    homeFeed.list = []
    refreshAllFeed() // 无缓存：前台转圈
  }
}

async function refreshAllFeed() {
  homeFeed.followLoading = !homeFeed.list.length
  try {
    const res = await getFollowDynFeed(0, '')
    homeFeed.list = mergeCards(res.list, loadCache('followAll')?.list || [])
    homeFeed.followOffset = res.offset
    homeFeed.followHasMore = res.hasMore
    saveCache('followAll', {
      list: homeFeed.list.slice(0, settings.maxCards),
      cursor: homeFeed.followOffset,
      hasMore: homeFeed.followHasMore
    })
  } catch (err) {
    if (!homeFeed.list.length) toastError(err) // 有缓存内容时静默保旧
  } finally {
    homeFeed.followLoading = false
  }
}

/** 焦点触底 → 动态流 offset 翻页（仅「全部」模式） */
async function loadMoreDyn() {
  if (loadingMore.value || !homeFeed.followHasMore || !homeFeed.followOffset) return
  if (homeFeed.list.length >= settings.maxCards) {
    homeFeed.followHasMore = false
    return
  }
  loadingMore.value = true
  try {
    const res = await getFollowDynFeed(0, homeFeed.followOffset)
    homeFeed.list = mergeCards(res.list, homeFeed.list)
    homeFeed.followOffset = res.offset
    homeFeed.followHasMore = res.hasMore
    saveCache('followAll', {
      list: homeFeed.list.slice(0, settings.maxCards),
      cursor: homeFeed.followOffset,
      hasMore: homeFeed.followHasMore
    })
  } catch (err) {
    toastError(err)
  } finally {
    loadingMore.value = false
  }
}

/** 点击「全部」 */
function openAll() {
  homeFeed.followMode = 'all'
  loadAllFeed()
}

/** 点击 UP 主：该 UP 的最新视频动态（host_mid 筛选，按时间序；D25 缓存同模式） */
function openUp(up) {
  homeFeed.followMode = up
  const key = `follow-${up.mid}`
  const cache = loadCache(key)
  if (cache && cache.list.length) {
    homeFeed.list = cache.list
    refreshUpVideos(up, key)
  } else {
    homeFeed.list = []
    refreshUpVideos(up, key)
  }
}

/* ---------------- UP 主直连模式（P9.32 D48：播放页 UP主按钮 → #/home/<mid>） ---------------- */
function openUpDirect(mid) {
  homeFeed.upDirect = { mid: Number(mid) }
  homeFeed.sub = 'follow'
  homeFeed.followView = 'main'
  homeFeed.followMode = { mid: Number(mid) }
  // P9.36 D52：未登录也可见投稿——wbi space 接口匿名可用（仅复用关注 UI，不走关注业务）
  if (!auth.loggedIn) {
    loadUpArchivesDirect(Number(mid))
    return
  }
  homeFeed.followBooted = true // 直连页不是"关注首屏"，走下面的直连加载
  refreshUpVideos({ mid: Number(mid) }, `follow-${mid}`)
}

/** 未登录直连：space 投稿列表（匿名 wbi 签名） */
async function loadUpArchivesDirect(mid) {
  homeFeed.state = 'loading'
  homeFeed.followLoading = true
  try {
    const res = await getUpArchives(mid)
    homeFeed.list = res.list
    homeFeed.state = 'ok'
  } catch (err) {
    homeFeed.state = 'error'
    homeFeed.errMsg = err.message || '加载失败'
  } finally {
    homeFeed.followLoading = false
  }
}

function exitUpDirect() {
  homeFeed.upDirect = null
  homeFeed.followMode = 'all' // 退出直连后回到关注「全部」，否则 UP 横排仍高亮上一个 UP
  loadSub('follow')
}

async function refreshUpVideos(up, cacheKey) {
  homeFeed.followLoading = !homeFeed.list.length
  try {
    const res = await getFollowDynFeed(up.mid, '')
    const videos = res.list.slice(0, Math.min(30, settings.maxCards))
    homeFeed.list = videos
    homeFeed.followOffset = res.offset
    homeFeed.followHasMore = res.hasMore
    saveCache(cacheKey, { list: videos })
    homeFeed.state = 'ok' // P9.32 D48：直连模式 / UP 模式共用
  } catch (err) {
    if (!homeFeed.list.length) {
      homeFeed.state = 'error'
      homeFeed.errMsg = err.message || '加载失败'
    } else {
      toastError(err)
    }
  } finally {
    homeFeed.followLoading = false
  }
}

/** 展开 / 收起 UP 主网格 */
function toggleGrid() {
  homeFeed.followView = homeFeed.followView === 'main' ? 'grid' : 'main'
  nextTick(() => focusEngine.focusZone('content'))
}

/** 失败重试：强制重新拉流（P9.53：retry 必须真的发请求） */
function retry() {
  loadSub(homeFeed.sub, true)
}

/** 侧边栏/导航项「再按一次」主动刷新（P9.53） */
function onRefresh() {
  loadSub(homeFeed.sub, true)
}

let removeRefresh = null

onMounted(() => {
  window.addEventListener('tvfocuschange', onFocusChange)
  removeRefresh = onRefreshRequest(onRefresh)
  // P9.53 追踪：证明"路由切回首页不重拉推荐流"——返回后这一行会再次出现，
  // 但下面不会出新的 rcmd fetch #N（N 不变）。
  console.log(
    `[BiliTV] home mount visited=${homeFeed.visited} state=${homeFeed.state} fetches=${homeFeed.fetches}`
  )
  // P9.32 D48：#/home/<mid> 直连该 UP 投稿流（播放页「UP主」按钮入口）
  if (props.bvid && /^\d+$/.test(String(props.bvid))) {
    homeFeed.visited = true // 直连模式走单独加载路径，不再触发推荐首屏
    openUpDirect(props.bvid)
    return
  }
  // P9.53：路由切回（播放页返回 / 侧边栏切页）——快照已在内存里，直接渲染，零网络请求。
  // 只有"首次进入"或上次没拿到内容（loading/empty/error）才真正拉流。
  if (!homeFeed.visited || homeFeed.state !== 'ok') loadSub(homeFeed.sub)
})
onUnmounted(() => {
  window.removeEventListener('tvfocuschange', onFocusChange)
  if (removeRefresh) removeRefresh()
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
          :class="{ active: homeFeed.sub === s.key }"
          :data-autofocus="homeFeed.sub === s.key ? '' : undefined"
          @click="onSubClick(s.key)"
        >
          {{ s.label }}
        </div>
      </div>

      <!-- UP 直连模式（D48）：返回 + 标题行 -->
      <div v-if="homeFeed.sub === 'follow' && homeFeed.upDirect" class="menu-row">
        <div class="menu-scroll">
          <div v-focusable class="up-card small" data-autofocus @click="exitUpDirect">
            <div class="up-face all-face">←</div>
            <div class="up-name">返回</div>
          </div>
        </div>
        <div class="up-direct-name">UP 主（ID {{ homeFeed.upDirect.mid }}）的投稿</div>
      </div>

      <!-- 关注：UP 横排（三级菜单，横向滚动 + 展开钮） -->
      <div v-if="homeFeed.sub === 'follow' && auth.loggedIn && homeFeed.followView === 'main' && homeFeed.state === 'ok' && !homeFeed.upDirect" class="menu-row">
        <div class="menu-scroll">
          <div
            v-focusable
            class="up-card small"
            :class="{ active: homeFeed.followMode === 'all' }"
            data-autofocus
            @click="openAll"
          >
            <div class="up-face all-face">☰</div>
            <div class="up-name">全部</div>
          </div>
          <div
            v-for="up in homeFeed.ups"
            :key="up.mid"
            v-focusable
            class="up-card small"
            :class="{ active: homeFeed.followMode !== 'all' && homeFeed.followMode.mid === up.mid }"
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
    <div v-if="homeFeed.sub === 'follow' && !auth.loggedIn" class="login-guide">
      <div class="guide-title">登录后查看我的关注</div>
      <div class="guide-sub">扫码登录与手机端同一账号</div>
      <button v-focusable class="tab-item primary" @click="navigate('mine')">去扫码登录</button>
    </div>

    <!-- 关注：加载失败（D48 补：直连模式未登录/接口失败也有可见反馈） -->
    <template v-else-if="homeFeed.sub === 'follow' && homeFeed.state === 'error'">
      <StateBlock state="error" :message="homeFeed.errMsg" @retry="retry" />
    </template>

    <!-- 关注 主视图：视频区（UP 横排已上移进吸顶容器） -->
    <template v-else-if="homeFeed.sub === 'follow' && homeFeed.followView === 'main' && homeFeed.state === 'ok'">
      <StateBlock v-if="homeFeed.followLoading" state="loading" />
      <StateBlock v-else-if="!homeFeed.list.length" state="empty" />
      <div v-else class="card-grid">
        <VideoCard v-for="item in homeFeed.list" :key="item.bvid" :item="item" />
      </div>
    </template>

    <!-- 关注：展开的 UP 主网格 -->
    <template v-else-if="homeFeed.sub === 'follow' && homeFeed.followView === 'grid' && homeFeed.state === 'ok'">
      <div class="up-bar">
        <button v-focusable class="tab-item" @click="toggleGrid">▴ 收起</button>
        <span class="up-bar-name">共 {{ homeFeed.ups.length }} 位 UP 主</span>
      </div>
      <div class="up-grid">
        <div
          v-for="up in homeFeed.ups"
          :key="up.mid"
          v-focusable
          class="up-card"
          :data-focus-key="'up-' + up.mid"
          @click="openUp(up); homeFeed.followView = 'main'"
        >
          <img class="up-face" :src="up.face" :alt="up.name" loading="lazy" />
          <div class="up-name">{{ up.name }}</div>
        </div>
      </div>
    </template>

    <!-- 推荐：通用列表 -->
    <template v-else-if="homeFeed.sub === 'rcmd'">
      <StateBlock v-if="homeFeed.state === 'loading'" state="loading" />
      <StateBlock v-else-if="homeFeed.state === 'error'" state="error" :message="homeFeed.errMsg" @retry="retry" />
      <StateBlock v-else-if="homeFeed.state === 'empty'" state="empty" />

      <div v-else class="card-grid">
        <VideoCard v-for="item in homeFeed.list" :key="item.bvid" :item="item" />
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
