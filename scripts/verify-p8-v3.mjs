/**
 * P8 CDP 验证 V3：MSE 播放推进 / seek / 清晰度切换 / 倍速记忆 / heartbeat
 */
const PAGE_ID = '6A5CA2BC4CC9BD1579E2097FF5442E03'
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

async function videoState(tag) {
  const s = await evalJS(`(() => {
    const v = document.querySelector('.video-el')
    const q = document.querySelector('.osd-quality')
    const bs = []
    if (v) for (let i = 0; i < v.buffered.length; i++) bs.push([Math.round(v.buffered.start(i)), Math.round(v.buffered.end(i))])
    return {
      src: v ? (v.src || '').slice(0, 30) : 'NO_VIDEO',
      t: v ? Math.round(v.currentTime * 10) / 10 : -1,
      paused: v ? v.paused : null,
      rs: v ? v.readyState : -1,
      w: v ? v.videoWidth : 0, h: v ? v.videoHeight : 0,
      buffered: bs,
      quality: q ? q.textContent : '',
      rate: v ? v.playbackRate : 0
    }
  })()`)
  console.log(`[${tag}]`, JSON.stringify(s))
  return s
}

async function main() {
  await new Promise((r) => (ws.onopen = r))
  console.log('== 1. 登录态 ==')
  const cookies = await evalJS(`localStorage.getItem('bilitv.auth.cookies') || ''`)
  console.log('SESSDATA:', cookies.includes('SESSDATA') ? '✓' : '✗')

  console.log('== 2. 进播放页 ==')
  console.log('click:', await evalJS(`(() => { const c = document.querySelector('.video-card'); if (!c) return 'NO_CARD'; c.click(); return 'OK' })()`))
  await sleep(8000)
  await videoState('首载8s')

  console.log('== 3. 播放推进确认 ==')
  const s1 = await videoState('t0')
  await sleep(4000)
  const s2 = await videoState('t0+4s')
  console.log(s2.t > s1.t ? `✓ 推进 ${s1.t} → ${s2.t}` : `✗ 未推进 (${s1.t} → ${s2.t})`)

  console.log('== 4. seek 测试 ==')
  await evalJS(`(() => { const v = document.querySelector('.video-el'); v.currentTime = v.currentTime + 90; return 'OK' })()`)
  await sleep(3500)
  const s3 = await videoState('seek+90 后')
  const covered = s3.buffered.some(([a, b]) => s3.t >= a && s3.t <= b)
  console.log(covered && s3.rs >= 2 ? `✓ seek 后缓冲覆盖且 readyState=${s3.rs}` : `✗ seek 异常 buffered=${JSON.stringify(s3.buffered)}`)

  console.log('== 5. 清晰度切换 ==')
  // 唤 OSD → 点清晰度按钮 → 面板选第二档
  await evalJS(`(() => { document.querySelector('.video-wrap').dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'OK' })()`)
  await sleep(700)
  const qBtn = await evalJS(`(() => {
    const btns = [...document.querySelectorAll('.osd-btn')]
    const q = btns.find((b) => /清晰度|1080|720|480/.test(b.textContent))
    if (!q) return 'NO_QBTN:' + btns.map((b) => b.textContent.trim()).join('|')
    q.click(); return 'OK'
  })()`)
  console.log('清晰度按钮:', qBtn)
  await sleep(600)
  const qList = await evalJS(`[...document.querySelectorAll('.rate-item')].map((e) => e.textContent.trim())`)
  console.log('档位列表:', JSON.stringify(qList))
  if (Array.isArray(qList) && qList.length > 1) {
    await evalJS(`(() => { const items = [...document.querySelectorAll('.rate-item')]; items[1].click(); return 'OK' })()`)
    await sleep(6000)
    const s4 = await videoState('切换后')
    // 切换后应从切换前位置附近续播
    console.log(s4.quality ? `✓ 当前档: ${s4.quality}` : '✗ 档位标签缺失')
  }

  console.log('== 6. 倍速记忆 ==')
  await evalJS(`(() => { document.querySelector('.video-wrap').dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'OK' })()`)
  await sleep(600)
  await evalJS(`(() => { const b = [...document.querySelectorAll('.osd-btn')].find((x) => /x$/.test(x.textContent.trim())); if (b) b.click(); return 'OK' })()`)
  await sleep(500)
  await evalJS(`(() => { const items = [...document.querySelectorAll('.rate-item')]; const target = items.find((i) => i.textContent.trim() === '1.5x'); if (target) target.click(); return 'OK' })()`)
  await sleep(1200)
  const rateLS = await evalJS(`localStorage.getItem('bilitv.set.rate')`)
  const rateNow = await evalJS(`(() => { const v = document.querySelector('.video-el'); return v ? v.playbackRate : 0 })()`)
  console.log(rateLS === '1.5' && rateNow === 1.5 ? `✓ 倍速记忆 1.5x（LS=${rateLS} 实时=${rateNow}）` : `✗ LS=${rateLS} 实时=${rateNow}`)

  console.log('== 7. heartbeat 端点 ==')
  const hb = await evalJS(`(async () => {
    const auth = JSON.parse(localStorage.getItem('bilitv.auth.cookies') || '{}')
    const v = document.querySelector('.video-el')
    const body = new URLSearchParams({
      aid: '0', cid: '0', type: '3', sub_type: '1', dt: '2',
      play_type: '1', etime: '15', played_time: Math.round(v ? v.currentTime : 0),
      started_at: '0', csrf: auth.bili_jct || ''
    })
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
    if (auth.SESSDATA) headers.Cookie = 'SESSDATA=' + auth.SESSDATA + '; bili_jct=' + (auth.bili_jct || '')
    const r = await fetch('https://api.bilibili.com/x/click-interface/web/heartbeat', { method: 'POST', headers, body: body.toString() })
    const j = await r.json()
    return { code: j.code, msg: j.message }
  })()`)
  console.log('heartbeat:', JSON.stringify(hb), hb && hb.code === 0 ? '✓' : '（上行为辅助验证，实际心跳由播放器定时发）')

  console.log('== 8. mseDebug 尾部 ==')
  const dbgTail = await evalJS(`(window.__mseDebug || []).slice(-16)`)
  console.log(Array.isArray(dbgTail) ? dbgTail.join('\n') : '无')

  ws.close()
}

main().catch((e) => { console.error('V3 异常：', e.message); process.exit(1) })
