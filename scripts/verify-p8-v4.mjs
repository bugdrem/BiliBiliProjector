/**
 * P8 CDP 验证 V4：SB 级诊断（__mseSB）+ 看门狗效果 + 全程 mseDebug
 */
const PAGE_ID = '2869DA70CE45096D00A5D12497143F9B'
const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${PAGE_ID}`)
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)) } }, 30000)
  })
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) {
    console.log('EVAL-ERR:', JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return null
  }
  return r.result && r.result.result ? r.result.result.value : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 深度状态：video + 双 SB buffered + seeking */
async function deep(tag) {
  const s = await evalJS(`(() => {
    const v = document.querySelector('.video-el')
    const sb = window.__mseSB || {}
    const rg = (b) => { const a = []; if (b) for (let i = 0; i < b.length; i++) a.push([+b.start(i).toFixed(2), +b.end(i).toFixed(2)]); return a }
    return {
      t: v ? +v.currentTime.toFixed(2) : -1,
      rs: v ? v.readyState : -1,
      paused: v ? v.paused : null,
      seeking: v ? v.seeking : null,
      vBuf: rg(sb.v ? sb.v.buffered : null),
      aBuf: rg(sb.a ? sb.a.buffered : null),
      vUpdating: sb.v ? sb.v.updating : null,
      aUpdating: sb.a ? sb.a.updating : null
    }
  })()`)
  console.log(`[${tag}]`, JSON.stringify(s))
  return s
}

async function main() {
  await new Promise((r) => (ws.onopen = r))

  // 进播放页（续播 405s）
  await evalJS(`(() => { const c = document.querySelector('.video-card'); if (c) c.click(); return 'OK' })()`)
  for (const delay of [3000, 6000, 10000, 14000]) {
    await sleep(delay === 3000 ? 3000 : delay - [3000, 6000, 10000, 14000][[3000, 6000, 10000, 14000].indexOf(delay) - 1])
    await deep(`${delay}ms`)
  }

  const dbgAll = await evalJS(`(window.__mseDebug || []).slice(-40)`)
  console.log('== mseDebug ==\n' + (Array.isArray(dbgAll) ? dbgAll.join('\n') : '无'))

  ws.close()
}

main().catch((e) => { console.error('V4 异常：', e.message); process.exit(1) })
