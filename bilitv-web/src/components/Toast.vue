<script setup>
/**
 * 全局 toast 渲染层（数据来自 utils/toast.js 的响应式队列）
 */
import { toasts } from '../utils/toast'
</script>

<template>
  <transition-group name="toast" tag="div" class="toast-wrap">
    <div v-for="t in toasts.list" :key="t.id" class="toast-item" :class="t.type">
      {{ t.text }}
    </div>
  </transition-group>
</template>

<style scoped>
.toast-wrap {
  position: fixed;
  top: 36px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  z-index: 300;
  pointer-events: none;
}

.toast-item {
  background: rgba(28, 28, 38, 0.95);
  border: 2px solid var(--line);
  color: var(--text);
  font-size: 21px;
  padding: 14px 30px;
  border-radius: 12px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
}

.toast-item.error {
  border-color: var(--accent-pink);
  color: #ffd7e2;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 220ms ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-14px);
}
</style>
