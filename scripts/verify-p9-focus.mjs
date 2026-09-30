/** P9.4 验证：焦点出口修复（模拟 ArrowLeft 到达 sidebar）+ 按键兼容映射 + 内核设置 */
const PAGE_ID = '60D60B76D3F311A01C4F891ABEC4DC3C'
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)) } }, 20000)
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

async function main() {
  await new Promise((r) => (ws.onopen = r))
  await sleep(4000)

  console.log('== 1. 内容区按左键 → sidebar（出口修复验证）==')
  // 先聚焦内容区第一张卡（模拟浏览中状态）
  await evalJS(`(() => { const c = document.querySelector('.video-card'); if (c) c.dispatchEvent(new MouseEvent('click', { bubbles: true })) })()`)
  // 用 CDP 派发真实 keydown（ArrowLeft）——内容第一列按左应切到 sidebar
  const fired = await evalJS(`(() => {
    const ev = new KeyboardEvent('keydown', { key: 'ArrowLeft', keyCode: 37, which: 37, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    return 'FIRED'
  })()`)
  await sleep(600)
  const zone1 = await evalJS(`(() => {
    const el = document.querySelector('.tv-focused')
    let z = null
    let e = el
    while (e && e !== document.body) {
      if (e.getAttribute && e.getAttribute('data-focus-zone')) { z = e.getAttribute('data-focus-zone'); break }
      e = e.parentElement
    }
    return { zone: z, key: el ? (el.getAttribute('data-focus-key') || el.textContent.trim().slice(0, 10)) : 'null' }
  })()`)
  console.log(fired, JSON.stringify(zone1))
  console.log(zone1 && zone1.zone === 'sidebar' ? '✓ 左键成功切入侧边栏（出口修复生效）' : '✗ 焦点仍在 ' + (zone1 && zone1.zone))

  console.log('== 2. sidebar 按右键 → 回内容区 ==')
  await evalJS(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true })); return 'OK' })()`)
  await sleep(600)
  const zone2 = await evalJS(`(() => {
    const el = document.querySelector('.tv-focused')
    let z = null
    let e = el
    while (e && e !== document.body) {
      if (e.getAttribute && e.getAttribute('data-focus-zone')) { z = e.getAttribute('data-focus-zone'); break }
      e = e.parentElement
    }
    return z
  })()`)
  console.log(zone2 === 'content' ? '✓ 右键回到内容区' : '✗ 焦点在 ' + zone2)

  console.log('== 3. 非标准按键映射（极米遥控器模拟）==')
  await evalJS(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Select', keyCode: 13, bubbles: true, cancelable: true })); return 'OK' })()`)
  await sleep(800)
  // Select 应触发 Enter（点击当前卡片 → 进播放页）
  const after = await evalJS(`location.hash`)
  console.log('Select 键后路由:', after, after.includes('play') ? '✓ Select 映射 Enter 生效' : '（未进播放页——视当前焦点而定）')

  // keyCode-only 兜底（伪遥控器：key='Unidentified' keyCode=39）
  await evalJS(`(() => {
    if (!location.hash.includes('home')) location.hash = '#/home'
    return 'OK'
  })()`)
  await sleep(1500)
  await evalJS(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 39, bubbles: true, cancelable: true }))
    return 'OK'
  })()`)
  await sleep(500)
  const moved = await evalJS(`(() => { const el = document.querySelector('.tv-focused'); return el ? 'FOCUSED:' + (el.getAttribute('data-focus-key') || el.textContent.trim().slice(0, 8)) : 'NONE' })()`)
  console.log('keyCode=39 兜底后:', moved)

  console.log('== 4. 播放内核设置项 ==')
  await evalJS(`location.hash = '#/settings'; 'OK'`)
  await sleep(1200)
  const row = await evalJS(`(() => {
    const r = [...document.querySelectorAll('.setting-row')].find((x) => x.textContent.includes('播放内核'))
    return r ? r.textContent.trim().replace(/\\s+/g, ' ') : 'NO_ROW'
  })()`)
  console.log('播放内核行:', row)

  ws.close()
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
