import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Vite 配置
 *
 * 核心设计（见 docs/01-开发文档.md 第 1.1、4.1 节）：
 * - B 站 WAF 按 Origin 白名单拦截（仅 *.bilibili.com 放行），WebView/浏览器内
 *   直接 fetch 必然 403。开发期把请求经 Vite dev server（Node 服务端）转发，
 *   转发请求不携带浏览器 Origin 头，天然绕开 WAF。
 * - ranking 等接口对无 Cookie 请求返回 -352：服务端启动时先调
 *   /x/frontend/finger/spi 获取设备指纹 buvid3/buvid4，之后由 proxyReq
 *   事件为每个代理请求注入 Cookie 头（生产环境由 CapacitorHttp 原生携带）。
 */
const BILI_UA =
  'Mozilla/5.0 (Linux; Android 10; ATV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Safari/537.36'

/** 模块级会话状态：插件与代理共享 */
const biliSession = { cookie: '' }

/** 服务端获取设备指纹（启动时一次，失败静默——部分接口不需要） */
async function fetchBuvid() {
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': BILI_UA }
    })
    const json = await res.json()
    if (json.code === 0 && json.data && json.data.b_3) {
      biliSession.cookie = `buvid3=${json.data.b_3}; buvid4=${json.data.b_4 || ''}`
      console.log('[bapi-proxy] buvid3 注入就绪')
    }
  } catch (err) {
    console.warn('[bapi-proxy] buvid3 获取失败（部分接口可能 -352）:', err.message)
  }
}

/** 为代理请求注入会话 Cookie */
function attachCookie(proxy) {
  proxy.on('proxyReq', (proxyReq) => {
    if (biliSession.cookie) {
      proxyReq.setHeader('Cookie', biliSession.cookie)
    }
  })
}

/** API 代理公共配置 */
function biliProxy(target) {
  return {
    target,
    changeOrigin: true,
    headers: { 'User-Agent': BILI_UA },
    configure: attachCookie
  }
}

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'bilibili-buvid-bootstrap',
      configureServer() {
        fetchBuvid()
      }
    }
  ],
  base: './',
  build: {
    target: 'es2018',
    // P9.51 关键修复：CSS 压缩目标也必须锚定老 WebView！
    // 不设 cssTarget 时 esbuild 按 esnext 压缩 CSS，会把 top/right/bottom/left
    // 合并成 inset、生成新语法——Android 9（Chromium 69）全不认识，导致
    // 全屏层（弹窗遮罩/OSD/弹幕层/扫码登录）全部定位失效（跑位/只有半个画面）。
    // 之前手工替换 inset 的兼容修复全被构建器悄悄还原，就是这个原因。
    cssTarget: 'chrome69',
    chunkSizeWarningLimit: 1024
  },
  server: {
    proxy: {
      // JSON API
      '/bapi': {
        ...biliProxy('https://api.bilibili.com'),
        rewrite: (path) => path.replace(/^\/bapi/, '')
      },
      // 弹幕服务（comment.bilibili.com/{cid}.xml，raw deflate 压缩体由前端解压）
      '/bdm': {
        ...biliProxy('https://comment.bilibili.com'),
        rewrite: (path) => path.replace(/^\/bdm/, '')
      },
      // 登录通行证（passport.bilibili.com，扫码登录 generate/poll/exit；
      // dev 代理仅能看到二维码与轮询状态，Set-Cookie 闭环在 APK 原生通道验证）
      '/bpass': {
        ...biliProxy('https://passport.bilibili.com'),
        rewrite: (path) => path.replace(/^\/bpass/, '')
      }
    }
  }
})
