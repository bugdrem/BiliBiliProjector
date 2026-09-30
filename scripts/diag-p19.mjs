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
  const st = await evalJS(`(() => ({
    hash: location.hash,
    decLS: JSON.parse(localStorage.getItem('bilitv.set.decoder') || 'null'),
    nativeBox: !!document.querySelector('.native-video-box'),
    videoEl: !!document.querySelector('.video-el'),
    osdTime: (document.querySelector('.osd-time') || {}).textContent || 'no-osd',
    mseTail: (window.__mseDebug || []).slice(-2)
  }))()`)
  console.log(JSON.stringify(st, null, 1))
  // 设置页读解码器行当前显示
  await evalJS("location.hash = '#/settings'; 'OK'")
  await sleep(2000)
  const row = await evalJS("(() => { const r = [...document.querySelectorAll('.setting-row')].find((x) => x.textContent.includes('解码器')); return r ? r.textContent.trim() : 'NO_ROW' })()")
  console.log('设置行显示:', row)
  ws.close()
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
