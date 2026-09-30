/** P9.1 验证：等级/硬币/会员字段修复 + 两处显示 */
const PAGE_ID = '2E20D67E48040DFF6E76E30487DA2A38'
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
    console.log('EVAL-ERR:', JSON.stringify(r.result.exceptionDetails).slice(0, 200))
    return null
  }
  return r.result && r.result.result ? r.result.result.value : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await new Promise((r) => (ws.onopen = r))
  // 等 nav 校验完成（main.js 启动即拉）
  await sleep(5000)

  console.log('== auth 缓存与实时值 ==')
  const authState = await evalJS(`(() => {
    const u = JSON.parse(localStorage.getItem('bilitv.auth.user') || '{}')
    return { cached: u, level: u.level, coins: u.coins, vipStatus: u.vipStatus }
  })()`)
  console.log(JSON.stringify(authState, null, 1))
  console.log(
    authState && authState.level === 6
      ? '✓ 等级已修复为 Lv6（nav 真实值）'
      : `✗ 等级仍异常: ${authState && authState.level}`
  )

  console.log('== 设置页账号行 ==')
  await evalJS(`location.hash = '#/settings'; 'OK'`)
  await sleep(1200)
  const row = await evalJS(`(() => {
    const r = [...document.querySelectorAll('.setting-row')].find((x) => x.textContent.includes('账号'))
    return r ? r.textContent.trim().replace(/\\s+/g, ' ') : 'NO_ROW'
  })()`)
  console.log('账号行:', row)

  console.log('== 我的页账号卡 ==')
  await evalJS(`location.hash = '#/mine'; 'OK'`)
  await sleep(1500)
  const meta = await evalJS(`(() => {
    const m = document.querySelector('.user-meta')
    return m ? m.textContent.trim().replace(/\\s+/g, ' ') : 'NO_META'
  })()`)
  console.log('我的页 meta:', meta)

  ws.close()
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
