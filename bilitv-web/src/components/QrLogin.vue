<script setup>
/**
 * 扫码登录弹窗（模态层，见 docs/03-登录与云端功能设计.md D3 状态机）
 *
 * 状态流：loading → waiting（86101）→ scanned（86090）→ 成功（0）
 *                              ↘ expired（86038，OK 刷新）↘ error（可重试）
 * - 二维码离线渲染（qrcode 库 canvas）；2s 轮询；onUnmounted 清理定时器
 * - 关闭路径统一走 focusEngine.popLayer 的 onClose 回调（键盘 Esc / 硬件返回键一致）
 */
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import QRCode from 'qrcode'
import { qrGenerate, qrPoll, parseLoginCookies, parseLoginUrl } from '../api/passport'
import { onLoginSuccess } from '../stores/auth'
import { focusEngine } from '../core/focus'
import { toast } from '../utils/toast'

const emit = defineEmits(['close'])

/** loading | waiting | scanned | expired | error */
const phase = ref('loading')
const errMsg = ref('')
const qrCanvas = ref(null)

let timer = 0
let qrcodeKey = ''
let stopped = false
/** cleanup 幂等标志（emit('close') 只发一次） */
let closed = false

/** 生成二维码并启动轮询 */
async function start() {
  stopped = false
  phase.value = 'loading'
  try {
    const { url, qrcodeKey: key } = await qrGenerate()
    qrcodeKey = key
    await nextTick()
    await QRCode.toCanvas(qrCanvas.value, url, {
      width: 380,
      margin: 2,
      color: { dark: '#15171c', light: '#ffffff' }
    })
    phase.value = 'waiting'
    clearInterval(timer)
    timer = setInterval(pollOnce, 2000)
  } catch (err) {
    phase.value = 'error'
    errMsg.value = (err && err.message) || '二维码生成失败'
  }
}

/** 单次轮询：按业务码推进状态机 */
async function pollOnce() {
  if (stopped) return
  try {
    const r = await qrPoll(qrcodeKey)
    if (r.code === 0) {
      stopped = true
      clearInterval(timer)
      // 双来源合并：Set-Cookie 解析 + crossDomain URL 参数（URL 参数更完整，覆盖后者）
      const cookies = { ...parseLoginCookies(r.headers), ...parseLoginUrl(r.url) }
      if (!cookies.SESSDATA || !cookies.bili_jct) {
        phase.value = 'error'
        errMsg.value = '登录凭据不完整（缺少 SESSDATA/bili_jct），请重试'
        return
      }
      await onLoginSuccess(cookies)
      toast('登录成功')
      // 触发 onClose → 关闭弹窗（focus 归还触发元素）
      focusEngine.popLayer()
    } else if (r.code === 86090) {
      phase.value = 'scanned'
    } else if (r.code === 86038) {
      clearInterval(timer)
      phase.value = 'expired'
    }
    // 86101 待扫：保持 waiting
  } catch (_) {
    /* 单次轮询网络抖动忽略，下一轮继续 */
  }
}

/** popLayer 的 onClose 回调：清理 + 通知父组件收起 v-if。
 *  注意不可用 stopped 做 guard——登录成功路径先置 stopped=true 再 popLayer，
 *  短路会导致 emit('close') 不执行、弹窗冻结在「已扫码」。 */
function cleanup() {
  if (closed) return
  closed = true
  stopped = true
  clearInterval(timer)
  emit('close')
}

/** 过期/错误态重试 */
function retry() {
  start()
}

onMounted(() => {
  focusEngine.pushLayer('panel', null, cleanup)
  start()
})

onUnmounted(() => {
  stopped = true
  clearInterval(timer)
})
</script>

<template>
  <div class="modal-mask">
    <div class="qr-panel" data-focus-zone="panel">
      <div class="qr-title">扫码登录</div>

      <!-- 二维码区 -->
      <div class="qr-box">
        <canvas v-show="phase === 'waiting' || phase === 'scanned'" ref="qrCanvas" class="qr-canvas"></canvas>
        <div v-if="phase === 'loading'" class="qr-hint">正在生成二维码…</div>
        <div v-if="phase === 'scanned'" class="qr-dim">
          <span>已扫码</span>
          <small>请在手机上确认</small>
        </div>
        <div v-if="phase === 'expired'" class="qr-dim">
          <button v-focusable class="qr-refresh" data-autofocus @click="retry">二维码已过期，按 OK 刷新</button>
        </div>
        <div v-if="phase === 'error'" class="qr-dim">
          <span>{{ errMsg }}</span>
          <button v-focusable class="qr-refresh" data-autofocus @click="retry">重试</button>
        </div>
      </div>

      <div class="qr-tips">打开哔哩哔哩 App → 扫一扫，登录与手机端为同一账号</div>
      <div class="qr-sub">按返回键取消</div>
    </div>
  </div>
</template>

<style scoped>
.qr-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 40px 56px;
  background: var(--bg-panel);
  border-radius: 14px;
  min-width: 480px;
}

.qr-title {
  font-size: 26px;
  font-weight: 700;
}

.qr-box {
  position: relative;
  width: 400px;
  height: 400px;
  background: #fff;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.qr-canvas {
  display: block;
}

.qr-hint {
  color: #666;
  font-size: 22px;
}

/* 扫码后/过期遮罩 */
.qr-dim {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;  /* P9.51: inset 在 Android 9 Chromium 69 无效 */
  background: rgba(255, 255, 255, 0.94);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #15171c;
  font-size: 24px;
  border-radius: 12px;
}

.qr-dim small {
  font-size: 19px;
  color: #888;
}

.qr-refresh {
  padding: 14px 28px;
  border-radius: 10px;
  background: #fb7299;
  color: #fff;
  font-size: 21px;
}

.qr-tips {
  font-size: 21px;
  color: var(--text);
  text-align: center;
  line-height: 1.5;
}

.qr-sub {
  font-size: 18px;
  color: var(--text-dim);
}
</style>
