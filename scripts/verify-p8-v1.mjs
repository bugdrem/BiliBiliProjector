/**
 * P8 CDP 验证 V1：登录态 / 新 bundle / 进播放页 / MSE 内核状态
 * Node 22 原生 WebSocket（ESM 不走 NODE_PATH）
 */
const PAGE_ID = 'A7AA801E992E949FD11F25E9FA23AC69'
const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${PAGE_ID}`)
let msgId = 0
const pending = new Map()

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`${method} 超时`))
      }
    }, 20000)
  })
}

/** Runtime.evaluate（returnByValue + awaitPromise） */
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result && r.result.exceptionDetails) {
    console.log('EVAL-ERR:', JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return null
  }
  return r.result && r.result.result ? r.result.result.value : undefined
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await new Promise((r) => (ws.onopen = r))
  console.log('CDP 已连接')

  // 1. 登录态与新 bundle
  const cookies = await evalJS(`localStorage.getItem('bilitv.auth.cookies')`)
  const hasSess = cookies && cookies.includes('SESSDATA')
  console.log('登录凭据 SESSDATA:', hasSess ? '存在 ✓' : '缺失 ✗')
  const bundle = await evalJS(
    `performance.getEntriesByType('resource').map(r=>r.name).filter(n=>n.includes('index-')&&n.endsWith('.js')).pop() || ''`
  )
  console.log('bundle:', bundle)

  // 2. 当前路由
  console.log('当前 URL:', await evalJS('location.href'))

  // 3. 点击首页第一张视频卡进播放页
  const clicked = await evalJS(`(() => {
    const card = document.querySelector('.video-card')
    if (!card) return 'NO_CARD'
    card.click()
    return 'CLICKED'
  })()`)
  console.log('进播放页:', clicked)
  await sleep(6000)

  // 4. MSE 内核状态
  const status = await evalJS(`(() => {
    const v = document.querySelector('.video-el')
    const q = document.querySelector('.osd-quality')
    const infoQ = document.querySelector('.info-meta')
    return {
      url: location.href,
      videoSrc: v ? (v.src || '').slice(0, 60) : 'NO_VIDEO',
      currentTime: v ? v.currentTime : -1,
      duration: v && v.duration ? Math.round(v.duration) : -1,
      readyState: v ? v.readyState : -1,
      paused: v ? v.paused : null,
      videoWidth: v ? v.videoWidth : 0,
      videoHeight: v ? v.videoHeight : 0,
      mseDebug: window.__mseDebug || [],
      dmDebugTail: (window.__dmDebug || []).slice(-5),
      rateLS: localStorage.getItem('bilitv.set.rate')
    }
  })()`)
  console.log(JSON.stringify(status, null, 1))

  await sleep(3000)
  const status2 = await evalJS(`(() => {
    const v = document.querySelector('.video-el')
    return { t2: v ? v.currentTime : -1, paused: v ? v.paused : null, err: v && v.error ? v.error.code : null }
  })()`)
  console.log('3s 后推进:', JSON.stringify(status2))

  ws.close()
}

main().catch((e) => {
  console.error('验证脚本异常：', e.message)
  process.exit(1)
})
