/**
 * 应用入口：
 *  - 注册 v-focusable 指令（标记遥控器可聚焦元素）
 *  - 初始化 FocusEngine 与返回键桥接
 *  - 挂载根组件
 */
import { createApp } from 'vue'
import { Capacitor } from '@capacitor/core'
import App from './App.vue'
import { focusEngine } from './core/focus'
import { routeBack } from './router'
import { refreshAuth } from './stores/auth'
import { detectCrashAndHeal, markCleanExit, applyDeviceProfile } from './stores/app'
import './styles/global.css'

// 崩溃自愈（P9.19 D39）：上次播放中异常退出 → 本次会话强制原生内核（老投影 WebView 媒体栈崩溃）
if (detectCrashAndHeal()) {
  console.warn('[BiliTV] 检测到上次播放异常退出，本次会话强制原生播放内核')
}

// 设备画像（P9.26 D42）：模拟器环境（MuMu/AVD）视频解码常绿屏 → 自动切换原生软解。
// 在崩溃自愈之后异步执行，模拟器判定优先级最高（覆写自愈的 'hw' 为 'sw'）
applyDeviceProfile()

// 正常退出/切后台标记（异常退出判定基准）
window.addEventListener('pagehide', markCleanExit)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') markCleanExit()
})

const app = createApp(App)

// 启动校验登录态：缓存秒开 + nav 异步核实（SESSDATA 失效自动回落未登录）
refreshAuth().catch(() => {})

/**
 * v-focusable：标记元素可被焦点引擎聚焦
 * 用法：<div v-focusable @click="...">…</div>
 * 配套可选属性：data-focus-key="唯一键"（供焦点记忆）、data-autofocus（分区初始焦点）
 */
app.directive('focusable', {
  mounted(el) {
    el.setAttribute('data-focusable', '')
  },
  unmounted(el) {
    el.removeAttribute('data-focusable')
    // 元素卸载时若正持有焦点，清除引用避免引擎操作已移除节点
    if (focusEngine.current === el) {
      focusEngine.current = null
    }
  }
})

// 初始化焦点引擎（浏览器键盘监听）
focusEngine.init()

// 返回键裁决：焦点引擎先处理弹层栈，栈空则路由回退
focusEngine.onBack = () => {
  routeBack()
  return true
}

// Android 端：Capacitor backButton 事件桥接到引擎 back()（Web 下不触发，无副作用）
if (Capacitor.isNativePlatform()) {
  import('@capacitor/app')
    .then(({ App }) => {
      App.addListener('backButton', () => {
        focusEngine.back()
      })
    })
    .catch(() => {
      /* 桥接失败不影响 Web 调试 */
    })
}

app.mount('#app')
