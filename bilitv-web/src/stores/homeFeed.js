/**
 * 首页会话状态（P9.53）
 *
 * 背景：App.vue 用 `<component :is :key="route.name + '-' + route.param" />` 驱动页面，
 * 离开首页（进播放页、点侧边栏）后 HomeView 会被整体卸载，回来时重新挂载。
 * 列表/游标原本是组件内 state，回到首页必然重跑 onMounted → 重新请求推荐流，
 * 表现为「从播放页返回要等一圈、列表滚回第一页、风控请求翻倍」。
 *
 * 方案：把首页的**可视状态**提到模块级响应式对象，组件重建后按原样渲染——
 * 零请求、零闪烁、滚动位置与二级菜单选中态都还在；只有用户显式再按一次
 * 「推荐 / 关注 / 首页」导航项时才 force 重新拉流（见 router.requestRefresh）。
 *
 * 跨会话（App 重启）由 cardCache 的 localStorage 兜底，模块级状态不持久化。
 */
import { reactive } from 'vue'

export const homeFeed = reactive({
  /** 二级菜单：rcmd（推荐）| follow（关注） */
  sub: 'rcmd',
  /** 当前列表（推荐流 / 关注动态流共用） */
  list: [],
  /** 首屏状态：loading | ok | error | empty */
  state: 'loading',
  /** 错误文案 */
  errMsg: '',

  /* ---- 推荐流 ---- */
  /** 推荐流游标（空 = 没有更多） */
  rcmdKey: '',
  /** 是否仍可翻页 */
  hasMore: false,

  /* ---- 关注 ---- */
  /** UP 主列表 */
  ups: [],
  /** 主视图 / 展开网格 */
  followView: 'main',
  /** 'all' | UP 对象 | { mid }（UP 直连，D48） */
  followMode: 'all',
  /** 动态流 offset（非响应式游标用普通字段即可） */
  followOffset: '',
  /** 动态流是否还有更多 */
  followHasMore: false,
  /** 关注加载中（覆盖层） */
  followLoading: false,
  /** UP 直连模式下跳出的 UP（D48） */
  upDirect: null,

  /* ---- 加载标记：组件重建后据此跳过重复请求 ---- */
  /** 本会话是否进入过首页（true = 下一次挂载是"路由切回"，直接渲染快照） */
  visited: false,
  /** 推荐流累计拉取次数（探针，logcat 取证"返回首页是否重拉"） */
  fetches: 0,
  /** 推荐首屏是否已发起过 */
  rcmdBooted: false,
  /** 关注首屏（UP 列表 + 动态流）是否已发起过 */
  followBooted: false,
  /** UP 列表是否已拉取过 */
  upsBooted: false
})

/** 重置为初始态（显式刷新 / 直连 UP 页进入时使用） */
export function resetHomeFeed() {
  homeFeed.list = []
  homeFeed.state = 'loading'
  homeFeed.errMsg = ''
  homeFeed.rcmdKey = ''
  homeFeed.hasMore = false
  homeFeed.followOffset = ''
  homeFeed.followHasMore = false
  homeFeed.followLoading = false
  homeFeed.upDirect = null
}
