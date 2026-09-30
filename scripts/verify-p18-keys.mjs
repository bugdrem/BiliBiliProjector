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

const KEY_CODE = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Escape: 27, Enter: 13 }

function keyDown(key, repeat) {
  const code = KEY_CODE[key] || 0
  const rep = repeat ? ', repeat: true' : ''
  const expr = "window.dispatchEvent(new KeyboardEvent('keydown', { key: '" + key + "', keyCode: " + code + ", bubbles: true, cancelable: true" + rep + " })); 'OK'"
  return evalJS(expr)
}
function keyUp(key) {
  const code = KEY_CODE[key] || 0
  const expr = "window.dispatchEvent(new KeyboardEvent('keyup', { key: '" + key + "', keyCode: " + code + ", bubbles: true })); 'OK'"
  return evalJS(expr)
}
const curT = () => evalJS('(() => { const v = document.querySelector(".video-el"); return Math.round(v.currentTime * 10) / 10 })()')

async function main() {
  await new Promise((r) => (ws.onopen = r))
  await sleep(2500)
  await evalJS("location.hash = '#/play/BV14Qah6DEBL'; 'OK'")
  await sleep(13000)
  const t0 = await curT()
  console.log('起播 t=', t0)

  // 1. 短按 →：+10s 单次
  await keyDown('ArrowRight', false)
  await sleep(300)
  await keyUp('ArrowRight')
  await sleep(300)
  const t1 = await curT()
  console.log('1 短按→: t0=', t0, '→ t1=', t1, '（应 +10s 左右）', Math.abs(t1 - t0 - 10) < 3.5 ? 'PASS' : 'FAIL')

  // 2. 长按 → 1.6s：连进，keyup 停止
  const t2 = await curT()
  await keyDown('ArrowRight', false)
  await sleep(1600)
  const tMid = await curT()
  const hudMid = await evalJS('(() => { const h = document.querySelector(".seek-hud"); return h ? h.textContent.replace(/\\s+/g, " ").trim() : "NO_HUD" })()')
  await keyUp('ArrowRight')
  const tAfterKeyUp = await curT()
  await sleep(1200)
  const t3 = await curT()
  const jump = tMid - t2
  console.log('2 长按→: 按住1.6s 增量=', Math.round(jump) + 's（应≫10s）', jump > 30 ? 'PASS' : 'FAIL')
  console.log('  连进 HUD:', hudMid, hudMid.indexOf('»') >= 0 ? 'PASS' : 'FAIL')
  console.log('  keyup 停止: keyup时=', Math.round(tAfterKeyUp), '→1.2s后=', Math.round(t3), '（增量=正常播放）', t3 - tAfterKeyUp < 5 ? 'PASS' : 'FAIL')

  // 3. e.repeat 忽略：连续 repeat keydown 不叠加
  const t4 = await curT()
  for (let i = 0; i < 6; i++) { await keyDown('ArrowLeft', true); await sleep(80) }
  await keyUp('ArrowLeft')
  await sleep(400)
  const t5 = await curT()
  console.log('3 repeat 忽略: 增量=', Math.round(t5 - t4) + 's（应≈0，无-10×N跳变）', t5 - t4 > -5 ? 'PASS' : 'FAIL')

  // 4. ↓ 开选集
  await keyDown('ArrowDown', false); await keyUp('ArrowDown')
  await sleep(900)
  const ep = await evalJS('(() => { const m = document.querySelector(".modal-title"); return { panel: m ? m.textContent.trim() : null, items: document.querySelectorAll(".rate-item").length } })()')
  console.log('4 ↓ 选集面板:', JSON.stringify(ep), ep.items > 0 ? 'PASS' : 'FAIL(单P退化)')

  // 5. ↑ 唤 OSD
  await evalJS("(() => { const w = document.querySelector('.video-wrap'); if (w) w.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'OK' })()")
  await sleep(5200) // 等 OSD 自动隐藏
  const osdBefore = await evalJS('!!document.querySelector(".osd")')
  await keyDown('ArrowUp', false); await keyUp('ArrowUp')
  await sleep(600)
  const osdAfter = await evalJS('!!document.querySelector(".osd")')
  console.log('5 ↑ 唤 OSD: 隐藏=', osdBefore, '→按上=', osdAfter, !osdBefore && osdAfter ? 'PASS' : 'FAIL')
  ws.close()
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
