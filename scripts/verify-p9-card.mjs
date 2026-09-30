/**
 * P9.0 CDP 验证：卡片 bbll 布局 / 本地缓存增量 / maxCards 上限
 */
const PAGE_ID = 'F435294880AB0F603D315C2042C0FA4F'
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)) } }, 25000)
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

  console.log('== 1. 首页卡片 bbll 布局 ==')
  await sleep(4000)
  const card1 = await evalJS(`(() => {
    const c = document.querySelector('.video-card')
    if (!c) return 'NO_CARD'
    const stats = c.querySelector('.card-stats')
    const title = c.querySelector('.card-title')
    const up = c.querySelector('.card-up')
    return {
      stats: stats ? stats.textContent.trim() : 'MISSING',
      title: title ? title.textContent.trim().slice(0, 20) : 'MISSING',
      upLine: up ? up.textContent.trim() : 'MISSING'
    }
  })()`)
  console.log(JSON.stringify(card1, null, 1))
  console.log(
    card1 && card1.stats !== 'MISSING' && card1.upLine !== 'MISSING'
      ? '✓ 卡片新布局生效（图下统计 + UP主·日期行）'
      : '✗ 布局缺失'
  )

  console.log('== 2. 缓存写入 ==')
  const cacheHot = await evalJS(`(() => {
    const raw = localStorage.getItem('bilitv.cache.hot')
    if (!raw) return null
    const c = JSON.parse(raw)
    return { count: c.list.length, page: c.page, cursor: c.cursor ? '有' : '无', sample: c.list[0] ? { title: c.list[0].title.slice(0, 15), pubdate: c.list[0].pubdate, up: c.list[0].owner && c.list[0].owner.name } : null }
  })()`)
  console.log('hot 缓存:', JSON.stringify(cacheHot))

  console.log('== 3. 缓存增量（切推荐再切回热门）==')
  await evalJS(`(() => { const t = [...document.querySelectorAll('.tab-item')].find((x) => x.textContent.trim() === '推荐'); if (t) t.click(); return 'OK' })()`)
  await sleep(4000)
  const cacheRcmd = await evalJS(`(() => { const c = JSON.parse(localStorage.getItem('bilitv.cache.rcmd') || 'null'); return c ? c.list.length : 0 })()`)
  console.log('rcmd 缓存条数:', cacheRcmd)
  await evalJS(`(() => { const t = [...document.querySelectorAll('.tab-item')].find((x) => x.textContent.trim() === '热门'); if (t) t.click(); return 'OK' })()`)
  await sleep(500)
  // 切回瞬间（后台刷新未完成）读取——应已是缓存内容
  const instant = await evalJS(`document.querySelectorAll('.video-card').length`)
  console.log(`切回瞬间卡片数: ${instant}（缓存先行应立即 > 0）`)
  await sleep(4000)
  const afterRefresh = await evalJS(`document.querySelectorAll('.video-card').length`)
  console.log(`增量刷新后卡片数: ${afterRefresh}`)

  console.log('== 4. maxCards 设置项 ==')
  await evalJS(`(() => { const t = [...document.querySelectorAll('.tab-item')].find((x) => x.textContent.trim() === '排行榜'); if (t) t.click(); return 'OK' })()`)
  await sleep(2500)
  const rankCount = await evalJS(`document.querySelectorAll('.video-card').length`)
  const rankCache = await evalJS(`(() => { const c = JSON.parse(localStorage.getItem('bilitv.cache.rank') || 'null'); return c ? c.list.length : 0 })()`)
  console.log(`排行榜渲染 ${rankCount} 条（缓存 ${rankCache}）——默认 maxCards=100 下应 ≤100`)

  ws.close()
}

main().catch((e) => { console.error('验证异常：', e.message); process.exit(1) })
