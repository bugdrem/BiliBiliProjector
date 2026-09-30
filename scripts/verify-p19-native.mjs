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

async function main() {
  await new Promise((r) => (ws.onopen = r))
  await sleep(2500)

  // ===== 1. 设置解码器=hw 并进播放页 =====
  await evalJS("localStorage.setItem('bilitv.set.decoder', JSON.stringify('hw')); 'OK'")
  await evalJS("location.hash = '#/play/BV14Qah6DEBL'; 'OK'")
  await sleep(13000)
  const st1 = await evalJS('(() => ({ nativeBox: !!document.querySelector(".native-video-box"), videoEl: !!document.querySelector(".video-el"), card: (document.querySelector(".card-title") || {}).textContent || "" }))()')
  console.log('1 原生模式渲染:', JSON.stringify(st1), st1.nativeBox && !st1.videoEl ? 'PASS' : 'FAIL')

  // 2. 播放推进（原生轮询驱动 curTime）
  const a = await evalJS('(() => { const h = document.querySelector(".osd-time"); return h ? h.textContent : "NO_OSD" })()')
  await sleep(3500)
  const b = await evalJS('(() => { const h = document.querySelector(".osd-time"); return h ? h.textContent : "NO_OSD" })()')
  console.log('2 播放推进: t0=', a, '→ 3.5s后=', b, a !== b ? 'PASS' : 'FAIL')

  // 3. seek 路由（原生）
  await evalJS("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true })); 'OK'")
  await sleep(300)
  await evalJS("window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', keyCode: 39, bubbles: true })); 'OK'")
  await sleep(1500)
  const c = await evalJS('(() => { const h = document.querySelector(".osd-time"); return h ? h.textContent : "NO" })()')
  console.log('3 短按→ +10s:', a, '→', c, c !== a ? 'PASS' : 'FAIL')

  // 4. 清晰度面板 + 切换（原生重载）
  await evalJS("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', keyCode: 38, bubbles: true, cancelable: true })); 'OK'")
  await sleep(600)
  const qbtn = await evalJS('(() => { const btns = [...document.querySelectorAll(".osd-btn")]; const b = btns.find((x) => /720|360|清晰度/.test(x.textContent)); if (!b) return "NO_BTN: " + btns.map((x) => x.textContent.trim()).join("|"); b.click(); return "CLICKED" })()')
  await sleep(800)
  const items = await evalJS('[...document.querySelectorAll(".rate-item")].map((e) => e.textContent.trim())')
  console.log('4 durl 档位面板:', qbtn, JSON.stringify(items))
  if (Array.isArray(items) && items.length > 1) {
    await evalJS("(() => { const its = [...document.querySelectorAll('.rate-item')]; its[its.length - 1].click(); return 'OK' })()")
    await sleep(7000)
    const afterQ = await evalJS('(() => ({ box: !!document.querySelector(".native-video-box"), t: (() => { const h = document.querySelector(".osd-time"); return h ? h.textContent : "" })() }))()')
    console.log('  切档后:', JSON.stringify(afterQ), afterQ.box ? 'PASS（原生模式保持）' : 'FAIL')
  }

  // 5. 崩溃自愈标记模拟：写 live 面包屑（不写 clean）→ 用户重启 app 后应强制原生
  await evalJS("localStorage.setItem('bilitv.runtime.live', JSON.stringify({ ts: Date.now(), route: '/play/BV14Qah6DEBL' })); localStorage.removeItem('bilitv.runtime.clean'); 'OK'")
  const live = await evalJS("JSON.parse(localStorage.getItem('bilitv.runtime.live') || 'null')")
  console.log('5 崩溃面包屑已写入:', JSON.stringify(live), '（重启后 detectCrashAndHeal 应触发）')

  // 6. 解码器设置行显示
  await evalJS("location.hash = '#/settings'; 'OK'")
  await sleep(2500)
  const decRow = await evalJS('(() => { const r = [...document.querySelectorAll(".setting-row")].find((x) => x.textContent.includes("解码器")); return r ? r.textContent.trim() : "NO_ROW" })()')
  console.log('6 设置行:', decRow)
  ws.close()
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
