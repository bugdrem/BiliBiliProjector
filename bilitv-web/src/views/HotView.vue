<script setup>
/**
 * 热门频道（#/hot，P9.11 D33：左侧一级菜单，首页下方）
 * 二级菜单对齐 web 端 /v/popular：全部 / 每周必看 / 入站必刷 / 排行榜 / 音乐榜
 * 全部沿用 D25 缓存先行模式；排行榜子菜单含分区二级横排（D26）。
 */
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import {
  getPopular, getRanking, getWeeklySeriesList, getWeeklyOne,
  RANK_CATEGORIES, getPrecious
} from '../api/bilibili'
import { settings } from '../stores/app'
import { loadCache, saveCache, mergeCards } from '../stores/cardCache'
import { focusEngine } from '../core/focus'
import VideoCard from '../components/VideoCard.vue'
import StateBlock from '../components/StateBlock.vue'
import { toast, toastError } from '../utils/toast'

/** 热门子菜单（web /v/popular/all|weekly|history|rank|music 同源） */
const HOT_SUBS = [
  { key: 'all', label: '全部' },
  { key: 'weekly', label: '每周必看' },
  { key: 'precious', label: '入站必刷' },
  { key: 'rank', label: '排行榜' },
  { key: 'music', label: '音乐榜' }
]
const hotSub = ref('all')
const list = ref([])
const state = ref('loading') // loading | ok | error | empty
const errMsg = ref('')
const hasMore = ref(false)
const popPage = ref(1) // 综合热门页码
const loadingMore = ref(false)

/* ---------------- 每周必看 / 排行榜子菜单状态（D26） ---------------- */
const weeklyNums = ref([])
const weeklyNum = ref(0)
const rankCat = ref('all')
const rankCats = [{ name: '全部', rid: 0 }, ...RANK_CATEGORIES]
const subLoading = ref(false)

/** 切换热门子菜单（D25 缓存先行模式） */
async function switchHot(sub) {
  hotSub.value = sub
  hasMore.value = false
  errMsg.value = ''
  try {
    if (sub === 'all') {
      state.value = 'loading'
      const cache = loadCache('hot-all')
      if (cache && cache.list.length) {
        list.value = cache.list.slice(0, settings.maxCards)
        popPage.value = cache.page || 1
        hasMore.value = list.value.length < settings.maxCards
        state.value = 'ok'
        await nextTick()
        focusFirst()
      }
      refreshHotAll(cache)
      return
    }
    if (sub === 'weekly') {
      state.value = 'ok'
      list.value = []
      const cached = loadCache('weeklyList')
      if (cached && cached.list.length) {
        weeklyNums.value = cached.list
      } else {
        weeklyNums.value = await getWeeklySeriesList()
        saveCache('weeklyList', { list: weeklyNums.value })
      }
      if (!weeklyNum.value) {
        weeklyNum.value = (weeklyNums.value[0] && weeklyNums.value[0].number) || 0
      }
      if (weeklyNum.value) await switchWeekly(weeklyNum.value)
      else state.value = 'empty'
      return
    }
    if (sub === 'precious') {
      state.value = 'loading'
      list.value = []
      const cache = loadCache('precious')
      if (cache && cache.list.length) {
        list.value = cache.list.slice(0, settings.maxCards)
        state.value = 'ok'
        await nextTick()
        focusFirst()
        return
      }
      const res = await getPrecious()
      list.value = res.slice(0, settings.maxCards)
      saveCache('precious', { list: list.value })
      state.value = list.value.length ? 'ok' : 'empty'
      await nextTick()
      focusFirst()
      return
    }
    if (sub === 'rank') {
      state.value = 'ok'
      await nextTick()
      focusFirst()
      await loadRank(rankCat.value || 'all')
      return
    }
    if (sub === 'music') {
      state.value = 'loading'
      list.value = []
      const cache = loadCache('music')
      if (cache && cache.list.length) {
        list.value = cache.list.slice(0, settings.maxCards)
        state.value = 'ok'
        await nextTick()
        focusFirst()
      }
      try {
        const full = await getRanking(3)
        list.value = mergeCards(full, cache ? cache.list : []).slice(0, settings.maxCards)
        saveCache('music', { list: list.value })
        state.value = list.value.length ? 'ok' : 'empty'
      } catch (err) {
        if (!list.value.length) {
          state.value = 'error'
          errMsg.value = err.message || '加载失败'
        }
      }
      return
    }
  } catch (err) {
    if (!list.value.length) {
      state.value = 'error'
      errMsg.value = err.message || '加载失败'
    }
  }
}

/** 综合热门后台增量（缓存先行时静默合并） */
async function refreshHotAll(cache) {
  try {
    const res = await getPopular(1, 24)
    popPage.value = 1
    list.value = mergeCards(res.list, cache ? cache.list : [])
    hasMore.value = res.hasMore && list.value.length < settings.maxCards
    saveCache('hot-all', { list: list.value.slice(0, settings.maxCards), page: 1 })
    state.value = list.value.length ? 'ok' : 'empty'
  } catch (err) {
    if (!list.value.length) {
      state.value = 'error'
      errMsg.value = err.message || '加载失败'
    }
  }
}

/** 切换排行榜分区（D25 缓存先行 + 后台增量；rid=null 的分区提示不可用） */
async function loadRank(name) {
  const cat = rankCats.find((c) => c.name === name)
  // 仅拦截显式 rid=null 的 PGC 分区（番剧/国创/综艺/鬼畜）；
  // 「全部」rid=0 是合法值——旧判断 !cat.rid 把它一起拦了（P9.22 修复）
  if (cat && cat.rid === null) {
    toast('该分区排行暂不支持（番剧/国创/综艺/鬼畜属 PGC 体系）')
    return
  }
  rankCat.value = name
  const rid = cat ? cat.rid || 0 : 0
  const key = `rank-${rid}`
  hasMore.value = false
  const cache = loadCache(key)
  if (cache && cache.list.length) {
    list.value = cache.list.slice(0, settings.maxCards)
    state.value = 'ok'
  } else {
    list.value = []
    subLoading.value = true
  }
  try {
    const res = await getRanking(rid)
    list.value = mergeCards(res, cache ? cache.list : []).slice(0, settings.maxCards)
    saveCache(key, { list: list.value })
    state.value = list.value.length ? 'ok' : 'empty'
  } catch (err) {
    if (!list.value.length) {
      state.value = 'error'
      errMsg.value = err.message || '加载失败'
    }
  } finally {
    subLoading.value = false
  }
}

/** 切换每周必看期数（D25 缓存先行：周更内容 7 天 TTL 天然匹配） */
async function switchWeekly(number) {
  weeklyNum.value = number
  const key = `weekly-${number}`
  hasMore.value = false
  const cache = loadCache(key)
  if (cache && cache.list.length) {
    list.value = cache.list.slice(0, settings.maxCards)
    state.value = 'ok'
    await nextTick()
    focusFirst()
    return
  }
  list.value = []
  subLoading.value = true
  try {
    const res = await getWeeklyOne(number)
    list.value = res.slice(0, settings.maxCards)
    saveCache(key, { list: list.value })
    state.value = list.value.length ? 'ok' : 'empty'
    await nextTick()
    focusFirst()
  } catch (err) {
    state.value = 'error'
    errMsg.value = err.message || '加载失败'
  } finally {
    subLoading.value = false
  }
}

/** 内容渲染后把焦点放回内容首项 */
function focusFirst() {
  if (!focusEngine.current || !document.contains(focusEngine.current)) {
    focusEngine.focusZone('content')
  }
}

/** 焦点接近列表尾部 → 加载下一页（仅综合热门有分页） */
function onFocusChange(e) {
  if (loadingMore.value) return
  if (hotSub.value !== 'all' || !hasMore.value) return
  const el = e.detail
  if (!el.classList.contains('video-card')) return
  const cards = Array.from(el.parentElement.querySelectorAll('.video-card'))
  const idx = cards.indexOf(el)
  if (idx >= cards.length - 6) loadMore()
}

async function loadMore() {
  if (loadingMore.value) return
  if (list.value.length >= settings.maxCards) {
    hasMore.value = false
    return
  }
  loadingMore.value = true
  try {
    const res = await getPopular(popPage.value + 1, 24)
    popPage.value += 1
    list.value = mergeCards(res.list, list.value)
    hasMore.value = res.hasMore && list.value.length < settings.maxCards
    saveCache('hot-all', { list: list.value.slice(0, settings.maxCards), page: popPage.value })
  } catch (err) {
    toastError(err)
  } finally {
    loadingMore.value = false
  }
}

/**
 * P9.53：路由切回热门页（播放页返回 / 侧边栏切页）不得重跑首屏网络请求。
 * booted 必须是模块级标记——组件会被整体卸载重建，放在组件内会被重置回 false。
 */
let booted = false

function retry() {
  booted = false // 重试必须真的重发请求
  switchHot(hotSub.value)
}

onMounted(() => {
  // 只有首次进入、或上次首屏被打断（仍在 loading）才拉流
  if (!booted || state.value === 'loading') {
    booted = true
    switchHot(hotSub.value)
  }
  window.addEventListener('tvfocuschange', onFocusChange)
})
onUnmounted(() => {
  window.removeEventListener('tvfocuschange', onFocusChange)
})
</script>

<template>
  <!-- data-focus-zone="content"：App.vue 契约 -->
  <div data-focus-zone="content">
    <!-- 二级+三级菜单吸顶容器（P9.20）：滚动卡片时菜单固定不参与滚动 -->
    <div class="menus-sticky">
      <!-- 二级菜单：全部/每周必看/入站必刷/排行榜/音乐榜 -->
      <div class="menu-row">
        <div
          v-for="s in HOT_SUBS"
          :key="s.key"
          v-focusable
          class="menu-pill"
          :class="{ active: hotSub === s.key }"
          :data-autofocus="hotSub === s.key ? '' : undefined"
          @click="switchHot(s.key)"
        >
          {{ s.label }}
        </div>
      </div>

      <!-- 三级：每周必看期数横排（最新在前） -->
      <div v-if="hotSub === 'weekly'" class="menu-row">
        <div class="menu-scroll">
          <div
            v-for="s in weeklyNums"
            :key="s.number"
            v-focusable
            class="up-card small weekly-card"
            :class="{ active: weeklyNum === s.number }"
            @click="switchWeekly(s.number)"
          >
            <div class="up-face all-face wk-num">{{ s.number }}</div>
            <div class="up-name">{{ s.name.replace(/^2026/, '') }}</div>
          </div>
        </div>
      </div>

      <!-- 三级：排行榜分区横排（全部 + 20 分区） -->
      <div v-if="hotSub === 'rank'" class="menu-row">
        <div class="menu-scroll">
          <div
            v-for="c in rankCats"
            :key="c.name"
            v-focusable
            class="menu-pill"
            :class="{ active: rankCat === c.name, dim: c.rid === null }"
            @click="loadRank(c.name)"
          >
            {{ c.name }}
          </div>
        </div>
      </div>
    </div>

    <!-- 内容区 -->
    <StateBlock v-if="state === 'loading'" state="loading" />
    <StateBlock v-else-if="state === 'error'" state="error" :message="errMsg" @retry="retry" />
    <StateBlock v-else-if="state === 'empty' || (!list.length && !subLoading)" state="empty" />
    <div v-else class="card-grid">
      <VideoCard v-for="item in list" :key="item.bvid" :item="item" />
    </div>
  </div>
</template>

<style scoped>
/* 菜单与 UP 卡基础样式已提升到 global.css（P9.20 首页/热门共用） */

/* 每周必看期数卡（圆形期号） */
.weekly-card .wk-num {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  font-size: 24px;
  font-weight: 700;
}
</style>
