<script setup>
/**
 * 搜索页（P9.13 D35 改版）：
 * - 输入改用原生 <input>（v-focusable），遥控器 OK 唤起系统 IME（支持中文），Enter 搜索
 * - 未输入关键词时右侧显示「bilibili热搜」面板（/x/web-interface/search/square，匿名可用），
 *   点击热搜项 = 填入关键词立即搜索；有结果时隐藏热搜、全宽结果网格
 * - 结果懒加载（P9.0 D23）：焦点触底自动翻页（searchAll page 参数），上限 settings.maxCards
 */
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { searchAll, getHotSearch } from '../api/bilibili'
import { settings } from '../stores/app'
import { loadCache, saveCache } from '../stores/cardCache'
import VideoCard from '../components/VideoCard.vue'
import StateBlock from '../components/StateBlock.vue'
import { toastError } from '../utils/toast'

const keyword = ref('')
const results = ref([])
const state = ref('idle') // idle | loading | ok | error | empty
const errMsg = ref('')
const searched = ref(false)
const page = ref(1)
const hasMore = ref(false)
const loadingMore = ref(false)
const inputEl = ref(null)

/* ---------------- bilibili 热搜（D35） ---------------- */
/** 热搜列表（30 分钟缓存） */
const hotList = ref([])
const hotLoading = ref(false)
/** 热搜面板显隐：未搜索过且无结果时显示（输入关键词后隐藏） */
const showHot = computed(() => !searched.value && state.value !== 'ok')

const HOT_CACHE_KEY = 'hotsearch'
const HOT_TTL = 30 * 60 * 1000

async function loadHotSearch() {
  const cache = loadCache(HOT_CACHE_KEY)
  if (cache && cache.list.length && Date.now() - (cache.savedAt || 0) < HOT_TTL) {
    hotList.value = cache.list
    return
  }
  hotLoading.value = true
  try {
    hotList.value = await getHotSearch()
    saveCache(HOT_CACHE_KEY, { list: hotList.value })
  } catch (err) {
    // 热搜失败不阻断搜索主功能
    if (!hotList.value.length) console.warn('[BiliTV] 热搜加载失败:', err.message)
  } finally {
    hotLoading.value = false
  }
}

/** 点击热搜项：填入关键词并搜索 */
function searchHot(item) {
  keyword.value = item.keyword || item.showName
  doSearch()
}

/** 当前关键词展示（上限 40 字符） */
const display = computed(() => keyword.value.slice(0, 40))

/** 输入框 OK/点击 → 聚焦唤起系统键盘 */
function focusInput() {
  if (inputEl.value) {
    inputEl.value.focus()
  }
}

/** 执行搜索（Enter 或搜索按钮） */
async function doSearch() {
  const kw = keyword.value.trim()
  if (!kw) return
  state.value = 'loading'
  searched.value = true
  try {
    const res = await searchAll(kw, 1)
    page.value = 1
    results.value = res.list
    hasMore.value = res.hasMore && results.value.length < settings.maxCards
    state.value = results.value.length ? 'ok' : 'empty'
    await nextTick()
  } catch (err) {
    state.value = 'error'
    errMsg.value = err.message
    toastError(err)
  }
}

/** 焦点接近结果尾部 → 翻页（上限 maxCards） */
function onFocusChange(e) {
  if (loadingMore.value || !hasMore.value || state.value !== 'ok') return
  const el = e.detail
  if (!el.classList || !el.classList.contains('video-card')) return
  const cards = Array.from(document.querySelectorAll('.results .video-card'))
  const idx = cards.indexOf(el)
  if (idx >= cards.length - 6) loadMore()
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  if (results.value.length >= settings.maxCards) {
    hasMore.value = false
    return
  }
  loadingMore.value = true
  try {
    const res = await searchAll(keyword.value.trim(), page.value + 1)
    page.value += 1
    const seen = new Set(results.value.map((v) => v.bvid))
    const add = res.list.filter((v) => !seen.has(v.bvid))
    results.value = results.value.concat(add)
    hasMore.value = res.hasMore && results.value.length < settings.maxCards
  } catch (err) {
    toastError(err)
  } finally {
    loadingMore.value = false
  }
}

onMounted(() => {
  window.addEventListener('tvfocuschange', onFocusChange)
  loadHotSearch()
})
onUnmounted(() => {
  window.removeEventListener('tvfocuschange', onFocusChange)
  // P9.30 D46：离页收起系统键盘（input 聚焦状态下切页，IME 会滞留）
  if (inputEl.value) inputEl.value.blur()
})
</script>

<template>
  <div class="search-page" data-focus-zone="content">
    <!-- P9.30 D46：分区提到页面根——热搜/结果列表原本在 content 区外，遥控器永远到不了 -->
    <!-- 搜索框（系统键盘输入） -->
    <div class="search-bar">
      <input
        ref="inputEl"
        v-focusable
        v-model="keyword"
        class="search-input"
        type="text"
        maxlength="40"
        enterkeyhint="search"
        placeholder="按 OK 键输入关键词（支持中文）"
        data-focus-key="search-input"
        data-autofocus
        @keydown.enter.prevent="doSearch"
        @click="focusInput"
      />
      <div v-focusable class="search-go" data-focus-key="search-go" @click="doSearch">🔍 搜索</div>
    </div>

    <!-- 未输入：右侧 bilibili 热搜面板 -->
    <div v-if="showHot" class="search-idle">
      <div class="idle-hint">
        <div class="hint-title">搜索视频</div>
        <div class="hint-line">1. 遥控器选中搜索框，按 OK 唤起键盘</div>
        <div class="hint-line">2. 输入关键词（支持中文 / 拼音 / 英文）</div>
        <div class="hint-line">3. 按 Enter 或点「搜索」开始</div>
      </div>

      <div class="hot-panel">
        <div class="hot-title">
          <span class="hot-flame">🔥</span>
          bilibili热搜
          <button v-focusable class="hot-refresh" data-focus-key="hot-refresh" title="刷新热搜" @click="loadHotSearch">↻</button>
        </div>
        <StateBlock v-if="hotLoading && !hotList.length" state="loading" />
        <template v-else>
          <div
            v-for="(item, i) in hotList"
            :key="item.keyword"
            v-focusable
            class="hot-item"
            :data-focus-key="'hot-' + i"
            @click="searchHot(item)"
          >
            <span class="hot-rank" :class="{ top: i < 3 }">{{ i + 1 }}</span>
            <img v-if="item.icon" class="hot-icon" :src="item.icon" alt="" loading="lazy" />
            <span class="hot-keyword">{{ item.showName }}</span>
            <span v-if="item.heat" class="hot-heat">{{ (item.heat / 10000).toFixed(0) }}万</span>
          </div>
        </template>
      </div>
    </div>

    <!-- 结果区（有关键词后隐藏热搜） -->
    <div class="results">
      <StateBlock v-if="state === 'loading'" state="loading" />
      <StateBlock v-else-if="state === 'error'" state="error" :message="errMsg" @retry="doSearch" />
      <StateBlock v-else-if="state === 'empty' && searched" state="empty" />
      <template v-else-if="state === 'ok'">
        <div class="card-grid">
          <VideoCard v-for="item in results" :key="item.bvid" :item="item" />
        </div>
        <!-- 翻页加载提示 -->
        <div v-if="loadingMore || hasMore" class="more-hint">
          {{ loadingMore ? '加载中…' : '向下浏览自动加载更多' }}
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 搜索框（参考 web 首页搜索框） */
.search-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 26px;
}

.search-input {
  flex: 1;
  height: 68px;
  background: var(--bg-card);
  border: 3px solid transparent;
  border-radius: 36px;
  padding: 0 28px;
  font-size: 24px;
  color: var(--text);
  outline: none;
}

.search-input::placeholder {
  color: var(--text-dim);
}

.search-go {
  height: 68px;
  padding: 0 30px;
  border-radius: 36px;
  background: var(--accent);
  color: #fff;
  font-size: 24px;
  display: flex;
  align-items: center;
}

/* 未输入态：左提示 + 右热搜 */
.search-idle {
  display: flex;
  align-items: flex-start;
  gap: 30px;
}

.idle-hint {
  flex: 1;
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 30px;
  min-height: 420px;
}

.hint-title {
  font-size: 26px;
  color: var(--text);
  margin-bottom: 20px;
}

.hint-line {
  font-size: 20px;
  color: var(--text-dim);
  line-height: 2;
}

/* 热搜面板（web 首页搜索框同款结构） */
.hot-panel {
  width: 520px;
  flex-shrink: 0;
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 20px 22px;
}

.hot-title {
  font-size: 22px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.hot-flame {
  font-size: 22px;
}

.hot-refresh {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: 22px;
  cursor: pointer;
}

.hot-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  border-radius: 10px;
  font-size: 20px;
  color: var(--text);
}

.hot-rank {
  width: 30px;
  text-align: center;
  font-weight: 700;
  font-style: italic;
  color: var(--text-dim);
}

.hot-rank.top {
  color: #fb7299; /* B 站粉，前三名 */
}

.hot-icon {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.hot-keyword {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hot-heat {
  font-size: 16px;
  color: var(--text-dim);
}

/* 翻页提示 */
.more-hint {
  margin: 26px 0 10px;
  text-align: center;
  color: var(--text-dim);
  font-size: 18px;
}
</style>
