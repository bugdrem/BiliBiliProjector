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
  // 设置页：点解码器值一次 → webview → hw
  await evalJS("location.hash = '#/settings'; 'OK'")
  await sleep(2500)
  const clicked = await evalJS("(() => { const s = document.querySelector('[data-focus-key=set-decoder]'); if (!s) return 'NO_ROW'; s.click(); return s.textContent.trim() })()")
  console.log('切解码器 →', clicked, clicked === '原生·硬解码' ? 'PASS' : 'FAIL')

  // 回播放页 → 应走原生
  await evalJS("location.hash = '#/play/BV14Qah6DEBL'; 'OK'")
  await sleep(13000)
  const st = await evalJS('(() => ({ nativeBox: !!document.querySelector(".native-video-box"), videoEl: !!document.querySelector(".video-el"), q: (() => { const b = [...document.querySelectorAll(".osd-btn")].find((x) => /高清|流畅|1080|720/.test(x.textContent)); return b ? b.textContent.trim() : (document.querySelector(".osd") ? "OSD_ON" : "OSD_OFF") })() }))()')
  console.log('原生渲染:', JSON.stringify(st), st.nativeBox && !st.videoEl ? 'PASS' : 'FAIL')

  // 播放推进（原生轮询）
  const a = await evalJS('(() => { const h = document.querySelector(".osd-time"); return h ? h.textContent : "NO" })()')
  await sleep(3500)
  const b = await evalJS('(() => { const h = document.querySelector(".osd-time"); return h ? h.textContent : "NO" })()')
  console.log('播放推进:', a, '→', b, a !== b ? 'PASS' : 'FAIL')

  // 短按 → seek 路由
  await evalJS("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true })); 'OK'")
  await sleep(300)
  await evalJS("window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', keyCode: 39, bubbles: true })); 'OK'")
  await sleep(1600)
  const c = await evalJS('(() => { const h = document.querySelector(".osd-time"); return h ? h.textContent : "NO" })()')
  console.log('短按→: ', b, '→', c, c !== b ? 'PASS' : 'FAIL')

  // 崩溃面包屑
  await evalJS("localStorage.setItem('bilitv.runtime.live', JSON.stringify({ ts: Date.now(), route: '/play/BV14Qah6DEBL' })); localStorage.removeItem('bilitv.runtime.clean'); 'OK'")
  console.log('崩溃面包屑已写入（重启后应自愈）')
  ws.close()
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
