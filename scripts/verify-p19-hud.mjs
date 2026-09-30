const PAGE_ID = process.argv[2]
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/' + PAGE_ID)
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时')) } }, 25000)
  })
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result && r.result.result ? r.result.result.value : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 短按 seek（返回 HUD 目标时间）
async function shortSeek(key) {
  await evalJS("window.dispatchEvent(new KeyboardEvent('keydown', { key: '" + key + "', keyCode: " + (key === 'ArrowRight' ? 39 : 37) + ", bubbles: true, cancelable: true })); 'OK'")
  await sleep(250)
  const hud = await evalJS('(() => { const h = document.querySelector(".seek-hud"); return h ? h.textContent.replace(/\\s+/g, " ").trim() : "NO_HUD" })()')
  await evalJS("window.dispatchEvent(new KeyboardEvent('keyup', { key: '" + key + "', keyCode: " + (key === 'ArrowRight' ? 39 : 37) + ", bubbles: true })); 'OK'")
  await sleep(1400) // 等 HUD 淡出
  return hud
}
function parseT(hud) {
  const m = /(\d+):(\d{2})/.exec(hud || '')
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null
}
async function main() {
  await new Promise((r) => (ws.onopen = r))
  // 1. 短按 → +10s：HUD t1 应比 t0 大 10
  const hud0 = await shortSeek('ArrowRight')
  const t0 = parseT(hud0)
  const hud1 = await shortSeek('ArrowRight')
  const t1 = parseT(hud1)
  console.log('1 短按→: HUD0=', hud0, ' HUD1=', hud1, t1 - t0 === 10 ? 'PASS' : 'FAIL(diff=' + (t1 - t0) + ')')

  // 2. 长按 → 1.6s：连进，HUD 步长增大
  await evalJS("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true })); 'OK'")
  await sleep(1600)
  const hudLong = await evalJS('(() => { const h = document.querySelector(".seek-hud"); return h ? h.textContent.replace(/\\s+/g, " ").trim() : "NO_HUD" })()')
  const tLong = parseT(hudLong)
  await evalJS("window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', keyCode: 39, bubbles: true })); 'OK'")
  await sleep(1400)
  console.log('2 长按→ HUD:', hudLong, tLong !== null && tLong - t1 > 30 ? 'PASS' : 'FAIL')

  // 3. 短按 ← 快退
  const hudBack = await shortSeek('ArrowLeft')
  const tBack = parseT(hudBack)
  console.log('3 短按← HUD:', hudBack, hudBack.indexOf('«') >= 0 ? 'PASS' : 'FAIL')

  // 4. 崩溃面包屑
  await evalJS("localStorage.setItem('bilitv.runtime.live', JSON.stringify({ ts: Date.now(), route: '/play/BV14Qah6DEBL' })); localStorage.removeItem('bilitv.runtime.clean'); 'OK'")
  console.log('4 崩溃面包屑已写入')
  ws.close()
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
