/** P9.2 验证：Tab 重排 / 每周必看 / 排行榜分区 */
const PAGE_ID = '047BA66E5EF31531B452211593E67424'
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
  await sleep(3000)

  console.log('== 1. Tab 顺序与默认页 ==')
  const tabs = await evalJS(`[...document.querySelectorAll('.tab-item')].map((t) => t.textContent.trim().replace(/\\d+$/, ''))`)
  console.log('Tabs:', JSON.stringify(tabs))
  const active = await evalJS(`(() => { const a = document.querySelector('.tab-item.active'); return a ? a.textContent.trim() : '?' })()`)
  console.log('默认激活:', active, active.includes('推荐') ? '✓' : '✗')

  console.log('== 2. 每周必看 ==')
  await evalJS(`(() => { const t = [...document.querySelectorAll('.tab-item')].find((x) => x.textContent.includes('每周必看')); if (t) t.click(); return 'OK' })()`)
  await sleep(6000)
  const weekly = await evalJS(`(() => {
    const cards = [...document.querySelectorAll('.up-strip .up-card.small')]
    const active = document.querySelector('.up-strip .up-card.small.active')
    return {
      期数卡: cards.length,
      最新期: cards.length ? cards[0].querySelector('.up-name').textContent.trim().slice(0, 20) : '',
      当前: active ? active.querySelector('.up-name').textContent.trim().slice(0, 20) : '',
      视频数: document.querySelectorAll('.video-card').length,
      cache: (() => { const c = JSON.parse(localStorage.getItem('bilitv.cache.weeklyList') || 'null'); return c ? c.list.length : 0 })()
    }
  })()`)
  console.log(JSON.stringify(weekly, null, 1))
  console.log(weekly['视频数'] > 0 ? '✓ 每周必看内容加载' : '✗ 无内容')

  console.log('== 3. 切期数（上一期 391）==')
  await evalJS(`(() => { const cards = [...document.querySelectorAll('.up-strip .up-card.small')]; if (cards[1]) cards[1].click(); return 'OK' })()`)
  await sleep(5000)
  const wk2 = await evalJS(`(() => {
    const active = document.querySelector('.up-strip .up-card.small.active')
    return { 当前: active ? active.querySelector('.up-name').textContent.trim().slice(0, 20) : '', 视频数: document.querySelectorAll('.video-card').length }
  })()`)
  console.log('切期后:', JSON.stringify(wk2))

  console.log('== 4. 排行榜分区 ==')
  await evalJS(`(() => { const t = [...document.querySelectorAll('.tab-item')].find((x) => x.textContent.includes('排行榜')); if (t) t.click(); return 'OK' })()`)
  await sleep(4000)
  const rank = await evalJS(`(() => {
    const cats = [...document.querySelectorAll('.up-strip .up-card.small')]
    const dim = [...document.querySelectorAll('.up-strip .up-card.small.dim')].map((c) => c.textContent.trim())
    return { 分区数: cats.length, 当前: rankCur(), 置灰: dim, 视频数: document.querySelectorAll('.video-card').length }
    function rankCur() { const a = document.querySelector('.up-strip .up-card.small.active'); return a ? a.textContent.trim() : '' }
  })()`)
  console.log(JSON.stringify(rank, null, 1))
  await evalJS(`(() => { const c = [...document.querySelectorAll('.up-strip .up-card.small')].find((x) => x.textContent.trim() === '动画'); if (c) c.click(); return 'OK' })()`)
  await sleep(4500)
  const rankAnime = await evalJS(`(() => {
    const a = document.querySelector('.up-strip .up-card.small.active')
    const first = document.querySelector('.video-card .card-title')
    return { 当前: a ? a.textContent.trim() : '', 视频数: document.querySelectorAll('.video-card').length, 首条: first ? first.textContent.trim().slice(0, 18) : '' }
  })()`)
  console.log('切动画分区:', JSON.stringify(rankAnime))
  const rankCache = await evalJS(`(() => { const c = JSON.parse(localStorage.getItem('bilitv.cache.rank-1') || 'null'); return c ? c.list.length : 0 })()`)
  console.log('rank-1 缓存:', rankCache)

  console.log('== 5. mseDebug 尾部（确认无异常）==')
  ws.close()
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
