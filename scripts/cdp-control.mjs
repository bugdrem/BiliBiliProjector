/**
 * BiliTV 调试控制：通过 WebView DevTools 协议（CDP）在模拟器/真机上操控页面。
 *
 * 触发场景：Capacitor 页面禁止 location.reload()（会打断原生桥），而模拟器只在
 * 单条 adb 命令生命周期内存活，因此把「启动 → 安装 → 拉起 → 导航 → 截图」串成
 * 一条命令时，需要一套能被调用一次的 CDP 小工具。
 *
 * 用法：
 *   node scripts/cdp-control.mjs list                 // 列出 CDP 目标
 *   node scripts/cdp-control.mjs hash '#/player/BV1xx411c7mD'  // hash 导航（不 reload）
 *   node scripts/cdp-control.mjs js 'document.title'  // 执行表达式并回显结果
 *   node scripts/cdp-control.mjs shot out.png         // 页面截图（写文件）
 */
import { writeFileSync } from 'node:fs'

const [, , mode, arg] = process.argv
const PORT = Number(process.env.CDP_PORT || 9222)
const base = `http://127.0.0.1:${PORT}`

/** 等待 CDP 端口就绪（WebView 拉起后才监听） */
async function waitForTarget(ms = 20000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/json/list`)
      if (r.ok) {
        const list = await r.json()
        if (list.some((t) => t.type === 'page')) return list
      }
    } catch {
      /* 端口还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`CDP 端口 ${PORT} 无 page 目标（应用是否已在前台？）`)
}

const list = await waitForTarget()
const target = list.find((t) => t.type === 'page')
if (!target) throw new Error('无 page 目标: ' + JSON.stringify(list.map((t) => t.type)))

if (mode === 'list') {
  console.log(JSON.stringify(list.map((t) => ({ type: t.type, url: t.url, title: t.title })), null, 2))
  process.exit(0)
}

if (!target.webSocketDebuggerUrl) throw new Error('目标无 WebSocket 地址: ' + target.id)

const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
ws.onerror = (e) => console.error('ws error', e.message || e)

await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        resolve({ error: 'timeout ' + method })
      }
    }, 30000)
  })

await send('Runtime.enable')
await send('Page.enable')

if (mode === 'hash') {
  const r = await send('Runtime.evaluate', {
    expression: `location.hash = '${arg}'`,
    returnByValue: true,
    awaitPromise: false
  })
  console.log('navigate ->', JSON.stringify(r.result?.result || r))
} else if (mode === 'js') {
  const r = await send('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true })
  const v = r.result?.result?.value
  console.log(typeof v === 'object' ? JSON.stringify(v) : String(v))
} else if (mode === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const data = r.result?.result?.data
  if (!data) throw new Error('截图失败: ' + JSON.stringify(r))
  writeFileSync(arg, Buffer.from(data, 'base64'))
  console.log('shot saved', arg)
} else {
  throw new Error('未知模式: ' + mode)
}

ws.close()
setTimeout(() => process.exit(0), 300)
