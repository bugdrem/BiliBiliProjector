/** P9.0 补充：设置页 maxCards 行 + searchAll page=2 接口分页 */
const API = 'https://api.bilibili.com'
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
]
import { createHash } from 'node:crypto'
const md5 = (s) => createHash('md5').update(s).digest('hex')
async function signedQuery(params) {
  const nav = await (await fetch(`${API}/x/web-interface/nav`)).json()
  const img = nav.data.wbi_img
  const keyFromUrl = (u) => (String(u).split('/').pop() || '').replace(/\.[a-zA-Z]+$/, '')
  const raw = keyFromUrl(img.img_url) + keyFromUrl(img.sub_url)
  let mixin = ''
  for (const i of MIXIN_KEY_ENC_TAB) if (raw[i]) mixin += raw[i]
  mixin = mixin.slice(0, 32)
  const wts = Math.floor(Date.now() / 1000)
  const all = { ...params, wts }
  const qs = Object.keys(all).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  return `${qs}&w_rid=${md5(qs + mixin)}`
}

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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)) } }, 20000)
  })
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result && r.result.result ? r.result.result.value : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await new Promise((r) => (ws.onopen = r))

  // 设置页 maxCards 行（App 侧导航：用路由 hash 直达设置页）
  await evalJS(`location.hash = '#/settings'; 'OK'`)
  await sleep(1500)
  const row = await evalJS(`(() => {
    const rows = [...document.querySelectorAll('.setting-row')]
    const t = rows.find((r) => r.textContent.includes('卡片上限'))
    return t ? t.textContent.trim().replace(/\\s+/g, ' ') : 'NO_ROW: ' + rows.map((r) => r.textContent.trim()).join(' | ')
  })()`)
  console.log('设置行:', row)

  // 搜索接口 page=2 分页（Node 侧直调验证翻页有效）
  const kw = '美食'
  const p1 = await (await fetch(`${API}/x/web-interface/wbi/search/all/v2?${await signedQuery({ keyword: kw, page: 1 })}`)).json()
  const p2 = await (await fetch(`${API}/x/web-interface/wbi/search/all/v2?${await signedQuery({ keyword: kw, page: 2 })}`)).json()
  const vids = (j) => {
    const g = (j.data && j.data.result || []).find((x) => x.result_type === 'video')
    return g ? g.data.map((v) => v.bvid) : []
  }
  const v1 = vids(p1)
  const v2 = vids(p2)
  const overlap = v1.filter((b) => v2.includes(b)).length
  console.log(`搜索分页: page1=${v1.length} 条, page2=${v2.length} 条, 重复=${overlap}`)
  console.log(overlap < v1.length && v2.length > 0 ? '✓ 翻页返回不同内容' : '✗ 翻页异常')

  ws.close()
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
