/**
 * 轻量 toast：全局响应式消息队列（错误提示 / 操作反馈）
 */
import { reactive } from 'vue'

export const toasts = reactive({
  list: []
})

let seq = 0

/**
 * 弹出一条 toast
 * @param {string} text 文案
 * @param {{type?: 'info'|'error', duration?: number}} [opts]
 */
export function toast(text, opts = {}) {
  const id = ++seq
  toasts.list.push({ id, text, type: opts.type || 'info' })
  setTimeout(() => {
    const idx = toasts.list.findIndex((t) => t.id === id)
    if (idx >= 0) toasts.list.splice(idx, 1)
  }, opts.duration || 2400)
}

/** 错误快捷方法 */
export function toastError(err) {
  toast((err && err.message) || '出错了', { type: 'error', duration: 3000 })
}
