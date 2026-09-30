<script setup>
/**
 * 通用状态块：加载中 / 错误（可重试）/ 空数据
 * 通过 props 切换形态，错误态提供可聚焦的重试按钮。
 */
defineProps({
  /** loading | error | empty */
  state: { type: String, required: true },
  /** 错误文案 */
  message: { type: String, default: '' }
})

const emit = defineEmits(['retry'])
</script>

<template>
  <div class="state-block">
    <template v-if="state === 'loading'">
      <div class="spinner"></div>
      <div>加载中…</div>
    </template>

    <template v-else-if="state === 'error'">
      <div class="emoji">⚠️</div>
      <div>{{ message || '加载失败' }}</div>
      <button v-focusable class="btn" data-autofocus @click="emit('retry')">重试</button>
    </template>

    <template v-else>
      <div class="emoji">📺</div>
      <div>这里空空如也</div>
    </template>
  </div>
</template>

<style scoped>
.emoji {
  font-size: 46px;
}
</style>
