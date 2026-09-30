/**
 * P8 CDP 验证 V5：完整链路终验
 * 续播定位推进 / 清晰度切换续播 / seek / heartbeat 真实上报 / 倍速
 */
const PAGE_ID = '7D66A97C5CE6AFD2BE56326F796F1204'
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
    console.log('EVAL-ERR:', JSON.stringify(r.result.exceptionDetails).slice(0, 250))
    return null
  }
  return r.result && r.result.result ? r.result.result.value : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function state(tag) {
  const s = await evalJS(`(() => {
    const v = document.querySelector('.video-el')
    return {
      t: v ? +v.currentTime.toFixed(1) : -1,
      rs: v ? v.readyState : -1,
      paused: v ? v.paused : null,
      w: v ? v.videoWidth : 0, h: v ? v.videoHeight : 0,
      q: document.querySelector('.osd-quality') ? document.querySelector('.osd-quality').textContent : ''
    }
  })()`)
  console.log(`[${tag}] ${JSON.stringify(s)}`)
  return s
}

async function main() {
  await new Promise((r) => (ws.onopen = r))

  console.log('== 1. 进播放页（续播）==')
  await evalJS(`(() => { const c = document.querySelector('.video-card'); if (c) c.click(); return 'OK' })()`)
  await sleep(15000)
  const s1 = await state('15s')
  await sleep(5000)
  const s2 = await state('20s')
  const advancing = s2.t > s1.t
  console.log(advancing ? `✓ 续播推进 ${s1.t} → ${s2.t}` : `✗ 未推进`)

  console.log('== 2. 清晰度切换（续播校验）==')
  const at = s2.t
  await evalJS(`(() => { document.querySelector('.video-wrap').dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'OK' })()`)
  await sleep(600)
  await evalJS(`(() => { const b = [...document.querySelectorAll('.osd-btn')].find((x) => /1080|720|清晰/.test(x.textContent)); if (b) b.click(); return 'OK' })()`)
  await sleep(500)
  const items = await evalJS(`[...document.querySelectorAll('.rate-item')].map((e) => e.textContent.trim())`)
  console.log('档位:', JSON.stringify(items))
  // 选第 2 档（720P）
  await evalJS(`(() => { const items = [...document.querySelectorAll('.rate-item')]; if (items[1]) items[1].click(); return 'OK' })()`)
  await sleep(12000)
  const s3 = await state('切换后12s')
  const resumedOk = s3.t > at - 3 && s3.t < at + 15 && s3.rs >= 2
  console.log(resumedOk ? `✓ 切换续播：${at} → ${s3.t}（${s3.w}×${s3.h}）` : `✗ 续播异常：${at} → ${s3.t}`)

  console.log('== 3. seek ==')
  await evalJS(`(() => { const v = document.querySelector('.video-el'); v.currentTime = v.currentTime + 120; return 'OK' })()`)
  await sleep(6000)
  const s4 = await state('seek+120 后6s')
  console.log(s4.rs >= 2 || (s4.t > 0 && !s4.paused) ? `✓ seek 恢复播放 t=${s4.t}` : `⚠ seek 后 rs=${s4.rs}`)

  console.log('== 4. heartbeat 真实上报 ==')
  const hb = await evalJS(`(window.__hbDebug || []).slice(-6)`)
  console.log(Array.isArray(hb) && hb.length ? hb.join('\n') : '（15s 间隔未到或未登录——稍后复查）')
  const hbLater = await evalJS(`(window.__hbDebug || []).slice(-6)`)
  console.log('hbTail:', JSON.stringify(hbLater))

  console.log('== 5. mseDebug 尾部 ==')
  const dbg = await evalJS(`(window.__mseDebug || []).slice(-18)`)
  console.log(Array.isArray(dbg) ? dbg.join('\n') : '无')

  ws.close()
}

main().catch((e) => { console.error('V5 异常：', e.message); process.exit(1) })
