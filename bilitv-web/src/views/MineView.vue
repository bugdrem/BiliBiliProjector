<script setup>
/**
 * 我的：账号区 + 收藏 / 历史（登录态分流，见 docs/03-登录与云端功能设计.md D5/D6/D7）
 * - 未登录：本地数据（localStorage）+ 扫码登录入口
 * - 已登录：云端默认收藏夹 / 云端历史（登录态变化自动清缓存重载）
 * - Enter 卡片 → 操作面板（播放 / 取消收藏 / 删除记录）
 * - 云端历史播放前把进度落到本地历史，播放器沿用本地续播链路
 */
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { favorites, history, histRemove, histClear, toggleFav, histAdd } from '../stores/app'
import { auth, logout as authLogout } from '../stores/auth'
import { getFavMedia, getDefaultFolderId, favDeal, getCloudHistory } from '../api/cloud'
import { focusEngine } from '../core/focus'
import { navigate, playPath } from '../router'
import { fmtDur, fmtAgo } from '../utils/format'
import { toast, toastError } from '../utils/toast'
import StateBlock from '../components/StateBlock.vue'
import QrLogin from '../components/QrLogin.vue'

const TABS = [
  { key: 'fav', label: '收藏' },
  { key: 'hist', label: '历史' }
]

const activeTab = ref('fav')
/** 操作面板目标卡片（null 关闭） */
const actionCard = ref(null)
/** 扫码登录弹窗开关 */
const showQr = ref(false)
/** 退出登录确认面板 */
const confirmLogout = ref(false)

/* ---------------- 云端数据 ---------------- */

const cloudFav = ref([]) // 云端收藏条目（默认收藏夹第一页）
const cloudHist = ref([]) // 云端历史条目（第一页）
const cloudFavFolderId = ref(0) // 默认收藏夹 id（云端取消收藏的 del_id）
const cloudFavTotal = ref(0) // 收藏夹总数（count 徽标）
const cloudLoading = ref(false)
const cloudError = ref('')

/** 云端收藏首拉：默认夹 id → 夹内容 */
async function loadCloudFav() {
  cloudFavFolderId.value = await getDefaultFolderId()
  const r = await getFavMedia(cloudFavFolderId.value, 1, 20)
  cloudFav.value = r.list
  cloudFavTotal.value = r.total
}

/** 云端历史首拉（cursor 首页） */
async function loadCloudHist() {
  const r = await getCloudHistory(null)
  cloudHist.value = r.list
}

/** 按当前 tab 拉取云端列表（幂等；登录态/tab 切换时调用） */
async function loadList() {
  if (!auth.loggedIn) {
    cloudError.value = ''
    cloudLoading.value = false
    return
  }
  cloudLoading.value = true
  cloudError.value = ''
  try {
    if (activeTab.value === 'fav') await loadCloudFav()
    else await loadCloudHist()
  } catch (err) {
    cloudError.value = (err && err.message) || '云端数据加载失败'
  } finally {
    cloudLoading.value = false
  }
}

// 登录态变化（扫码成功 / 退出登录 / 凭据失效回落）：清云端缓存并重载
watch(
  () => auth.loggedIn,
  () => {
    cloudFav.value = []
    cloudHist.value = []
    cloudFavFolderId.value = 0
    cloudFavTotal.value = 0
    nextTick(() => loadList())
  }
)

// tab 切换：云端模式下拉取对应列表
watch(activeTab, () => {
  if (auth.loggedIn) nextTick(() => loadList())
})

/** tab 徽标数字（云端/本地取各自来源） */
function tabCount(key) {
  if (auth.loggedIn) return key === 'fav' ? cloudFavTotal.value : cloudHist.value.length
  return key === 'fav' ? favorites.list.length : history.list.length
}

const list = computed(() => {
  if (auth.loggedIn) return activeTab.value === 'fav' ? cloudFav.value : cloudHist.value
  return activeTab.value === 'fav' ? favorites.list : history.list
})

function switchTab(t) {
  activeTab.value = t
  nextTick(() => focusEngine.focusZone('content'))
}

/* ---------------- 操作面板 ---------------- */

/** 卡片确认 → 打开操作面板 */
function openAction(item) {
  actionCard.value = item
  nextTick(() => focusEngine.pushLayer('panel', null, () => { actionCard.value = null }))
}

function closeAction() {
  actionCard.value = null
  focusEngine.popLayer()
}

function playItem() {
  const item = actionCard.value
  if (!item) return
  actionCard.value = null
  focusEngine.popLayer()
  // 云端历史：先把云端进度写入本地历史，播放器 load() 用 histGet 读到续播点
  if (auth.loggedIn && activeTab.value === 'hist' && item.cid) {
    histAdd(item, item.cid, item.page || 1, item.progress > 0 ? item.progress : 0)
  }
  navigate(playPath(item.bvid))
}

/** 云端取消收藏（deal 接口，del_id = 默认收藏夹） */
async function removeCloudFav() {
  const item = actionCard.value
  if (!item) return
  try {
    const folderId = cloudFavFolderId.value || (await getDefaultFolderId())
    await favDeal(item.aid, null, folderId)
    cloudFav.value = cloudFav.value.filter((x) => x.bvid !== item.bvid)
    cloudFavTotal.value = Math.max(0, cloudFavTotal.value - 1)
    toast('已取消收藏')
  } catch (err) {
    toastError(err)
  }
  closeAction()
}

/** 删除：收藏 Tab 取消收藏（云端/本地分流）/ 历史 Tab 删除本地记录 */
function removeItem() {
  const item = actionCard.value
  if (!item) return
  if (activeTab.value === 'fav') {
    if (auth.loggedIn) {
      removeCloudFav()
      return
    }
    toggleFav(item)
    toast('已取消收藏')
  } else {
    if (auth.loggedIn) {
      // 云端历史 v1 不做删除，仅提供播放
      closeAction()
      return
    }
    histRemove(item.bvid)
    toast('已删除记录')
  }
  closeAction()
}

function clearHist() {
  histClear()
  toast('历史已清空')
  closeAction()
}

/* ---------------- 账号操作 ---------------- */

function askLogout() {
  confirmLogout.value = true
  nextTick(() => focusEngine.pushLayer('panel', null, () => { confirmLogout.value = false }))
}

async function doLogout() {
  confirmLogout.value = false
  focusEngine.popLayer()
  await authLogout()
  toast('已退出登录')
}

function cancelLogout() {
  confirmLogout.value = false
  focusEngine.popLayer()
}

onMounted(() => {
  // 缓存恢复的登录态直接拉云端；未登录则用本地数据
  if (auth.loggedIn) loadList()
})
</script>

<template>
  <div class="mine-page" data-focus-zone="content">
    <div class="page-title">我的</div>

    <!-- 账号卡片 -->
    <div class="user-card">
      <template v-if="auth.loggedIn">
        <img v-if="auth.face" class="user-avatar" :src="auth.face" :alt="auth.uname" />
        <div v-else class="user-avatar ph">{{ (auth.uname || '用')[0] }}</div>
        <div class="user-info">
          <div class="user-name">{{ auth.uname }}</div>
          <div class="user-meta">
            <span>Lv{{ auth.level }}</span>
            <span>· 硬币 {{ auth.coins }}</span>
            <span v-if="auth.vipStatus">· 大会员</span>
            <span>· 收藏与历史已同步云端</span>
          </div>
        </div>
        <div class="spacer"></div>
        <button v-focusable class="tab-item danger" data-focus-key="logout" @click="askLogout">退出登录</button>
      </template>
      <template v-else>
        <div class="user-avatar ph">B</div>
        <div class="user-info">
          <div class="user-name">未登录</div>
          <div class="user-meta">登录后同步云端收藏与历史 · 解锁 1080P</div>
        </div>
        <div class="spacer"></div>
        <button
          v-focusable
          class="tab-item primary"
          data-focus-key="login"
          :data-autofocus="auth.loggedIn ? undefined : ''"
          @click="showQr = true"
        >
          扫码登录
        </button>
      </template>
    </div>

    <div class="tab-row">
      <div
        v-for="t in TABS"
        :key="t.key"
        v-focusable
        class="tab-item"
        :class="{ active: activeTab === t.key }"
        :data-autofocus="activeTab === t.key && auth.loggedIn ? '' : undefined"
        @click="switchTab(t.key)"
      >
        {{ t.label }}
        <span v-if="auth.loggedIn" class="src-tag">云</span>
        <span class="count">{{ tabCount(t.key) }}</span>
      </div>
      <div class="spacer"></div>
      <div
        v-if="activeTab === 'hist' && !auth.loggedIn && history.list.length"
        v-focusable
        class="tab-item danger"
        @click="clearHist"
      >
        清空历史
      </div>
    </div>

    <!-- 列表：云端加载/错误态优先，其次空态，最后列表 -->
    <StateBlock v-if="auth.loggedIn && cloudLoading" state="loading" />
    <StateBlock v-else-if="auth.loggedIn && cloudError" state="error" :message="cloudError" @retry="loadList" />
    <StateBlock v-else-if="!list.length" state="empty" />

    <div v-else class="hist-list">
      <div
        v-for="item in list"
        :key="item.bvid"
        v-focusable
        class="hist-row"
        :data-focus-key="activeTab + '-' + item.bvid"
        @click="openAction(item)"
      >
        <img class="hist-cover" :src="item.pic" :alt="item.title" loading="lazy" />
        <div class="hist-body">
          <div class="hist-title">{{ item.title }}</div>
          <div class="hist-meta">
            <span>{{ item.owner && item.owner.name }}</span>
            <span v-if="activeTab === 'hist'">
              {{ item.progress >= 0 ? '看到 ' + fmtDur(item.progress) : '已看完' }}
            </span>
            <span v-if="activeTab === 'hist' && item.viewAt">{{ fmtAgo(item.viewAt) }}</span>
            <span v-if="activeTab === 'fav' && auth.loggedIn && item.favAt">收藏于 {{ fmtAgo(item.favAt) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 操作面板（模态层） -->
    <div v-if="actionCard" class="modal-mask">
      <div class="modal-panel" data-focus-zone="panel">
        <div class="modal-title">{{ actionCard.title }}</div>
        <div class="action-list">
          <button v-focusable class="tab-item primary" data-autofocus @click="playItem">▶ 播放</button>
          <button v-focusable class="tab-item danger" @click="removeItem">取消收藏</button>
          <button
            v-if="activeTab === 'hist' && !auth.loggedIn"
            v-focusable
            class="tab-item danger"
            @click="removeItem"
          >
            删除记录
          </button>
          <button v-focusable class="tab-item" @click="closeAction">取消</button>
        </div>
      </div>
    </div>

    <!-- 退出登录确认（模态层） -->
    <div v-if="confirmLogout" class="modal-mask">
      <div class="modal-panel" data-focus-zone="panel">
        <div class="modal-title">退出登录？云端数据保留在服务端</div>
        <div class="confirm-row">
          <button v-focusable class="tab-item danger" @click="doLogout">退出登录</button>
          <button v-focusable class="tab-item" data-autofocus @click="cancelLogout">取消</button>
        </div>
      </div>
    </div>

    <!-- 扫码登录弹窗 -->
    <QrLogin v-if="showQr" @close="showQr = false" />
  </div>
</template>

<style scoped>
.count {
  margin-left: 10px;
  color: var(--text-dim);
  font-size: 19px;
}

.src-tag {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(251, 114, 153, 0.16);
  color: var(--accent-pink);
  font-size: 15px;
}

.spacer {
  flex: 1;
}

.tab-item.danger {
  color: #ff8bab;
}

.tab-item.primary {
  background: var(--accent);
  color: #fff;
  justify-content: center;
}

/* ---------- 账号卡片 ---------- */

.user-card {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 20px 24px;
  background: var(--bg-card);
  border-radius: var(--radius);
  margin-bottom: 22px;
}

.user-avatar {
  width: 76px;
  height: 76px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.user-avatar.ph {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(251, 114, 153, 0.18);
  color: var(--accent-pink);
  font-size: 34px;
  font-weight: 700;
}

.user-info {
  min-width: 0;
}

.user-name {
  font-size: 25px;
  font-weight: 700;
}

.user-meta {
  margin-top: 8px;
  color: var(--text-dim);
  font-size: 18px;
}

/* ---------- 列表 ---------- */

.hist-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hist-row {
  display: flex;
  gap: 20px;
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 14px;
  align-items: center;
}

.hist-cover {
  width: 216px;
  /* P9.51：Android 9 无 aspect-ratio → 显式给 16:9 高度（216×121）作兜底 */
  height: 121px;
  object-fit: cover;
  border-radius: 8px;
  flex-shrink: 0;
}

.hist-body {
  min-width: 0;
}

.hist-title {
  font-size: 22px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hist-meta {
  margin-top: 10px;
  display: flex;
  gap: 20px;
  color: var(--text-dim);
  font-size: 18px;
}

.action-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 300px;
}

.confirm-row {
  display: flex;
  gap: 16px;
}
</style>
