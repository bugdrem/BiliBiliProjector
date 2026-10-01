<script setup>
/**
 * 视频卡片（bbll 布局，P9.0 D24 + P9.2/P9.3/P9.20 修订）：
 *   封面（右下角时长角标 + 左下角统计浮层，同一行叠加在图内）
 *   → 标题 → UP 主 · 发布时间
 * 统计浮层用 bilibili web 同款小图标（播放 ▶ / 弹幕对话框），P9.20 起不再用文字。
 * 点击进入播放页；data-focus-key 供焦点记忆。
 */
import { computed } from 'vue'
import { navigate, playPath } from '../router'
import { fmtCount, fmtDur, fmtAgo } from '../utils/format'

const props = defineProps({
  /** 卡片数据（api/bilibili.js 的 toCard 整形结果） */
  item: { type: Object, required: true },
  /** 焦点记忆键（默认 bvid） */
  focusKey: { type: String, default: '' },
  /**
   * P9.53：播放页内的卡片（相关推荐 / 「接下来播放」）用 replace 跳转——
   * 播放页里换视频不该在返回栈里堆一条记录，否则连播 3 个后要按 3 次返回
   * 才回到菜单，中途每一次都卡在同一个播放页上。列表页（首页/热门/搜索）保持 push。
   */
  replace: { type: Boolean, default: false }
})

/** 时长展示：秒数格式化；search 接口的 "mm:ss" 字符串直接透出 */
const durText = computed(() => {
  if (props.item.duration === undefined || props.item.duration === null || props.item.duration === '') return ''
  return fmtDur(props.item.duration)
})

/** UP 主名（收藏/历史条目可能无 owner） */
const upName = computed(() => (props.item.owner && props.item.owner.name) || '')

/** 发布时间：秒级 ts → 相对时间（7 天内「3 天前」，更早 YYYY-MM-DD）；无则空 */
const dateText = computed(() => {
  const ts = Number(props.item.pubdate) || 0
  return ts > 0 ? fmtAgo(ts * 1000) : ''
})

/** 是否有可显示的统计（播放/弹幕都可能为 0/缺失） */
const hasStats = computed(() => {
  const s = props.item.stat || {}
  return s.view !== undefined || !!s.danmaku
})

function open() {
  navigate(playPath(props.item.bvid), { replace: props.replace })
}
</script>

<template>
  <div v-focusable class="video-card" :data-focus-key="focusKey || item.bvid" @click="open">
    <div class="cover">
      <img :src="item.pic" :alt="item.title" loading="lazy" decoding="async" />
      <!-- 统计浮层：bilibili web 同款小图标 + 数字（左下），与时长角标（右下）同行 -->
      <span v-if="hasStats" class="cover-stats">
        <span v-if="item.stat && item.stat.view !== undefined" class="stat">
          <!-- 播放：圆角实心三角（bilibili web 同形） -->
          <svg class="stat-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8.2 5.86a1.2 1.2 0 0 1 1.84-1.01l10.1 6.14a1.2 1.2 0 0 1 0 2.02l-10.1 6.14A1.2 1.2 0 0 1 8.2 18.14z" />
          </svg>
          {{ fmtCount(item.stat.view) }}
        </span>
        <span v-if="item.stat && item.stat.danmaku" class="stat">
          <!-- 弹幕：圆角对话框 + 弹幕线（bilibili web 同形） -->
          <svg class="stat-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4.6 4.5h14.8A2.6 2.6 0 0 1 22 7.1v8.3a2.6 2.6 0 0 1-2.6 2.6h-6.5l-3.6 2.9a.9.9 0 0 1-1.46-.7v-2.2H4.6A2.6 2.6 0 0 1 2 15.4V7.1a2.6 2.6 0 0 1 2.6-2.6z" />
            <path class="dm-line" d="M7 9h10M7 12.5h6" />
          </svg>
          {{ fmtCount(item.stat.danmaku) }}
        </span>
      </span>
      <span v-if="durText" class="dur">{{ durText }}</span>
    </div>
    <div class="card-title">{{ item.title }}</div>
    <!-- 标题下一排：UP 主 · 发布时间 -->
    <div v-if="upName || dateText" class="card-up">
      <span v-if="upName" class="up">{{ upName }}</span>
      <span v-if="upName && dateText" class="dot">·</span>
      <span v-if="dateText">{{ dateText }}</span>
    </div>
  </div>
</template>
