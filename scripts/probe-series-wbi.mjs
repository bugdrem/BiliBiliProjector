/** P9.2 探针：series/one wbi 签名验证（页面取 cookie → Node 签名请求） */
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)) } }, 15000)
  })
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result && r.result.result ? r.result.result.value : undefined
}

const UA = 'Mozilla/5.0 (Linux; Android 11; BiliTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

async function main() {
  await new Promise((r) => (ws.onopen = r))
  const cookie = await evalJS(`(() => {
    const ck = JSON.parse(localStorage.getItem('bilitv.auth.cookies') || '{}')
    const session = JSON.parse(localStorage.getItem('bilitv.session') || '{}')
    return [
      ck.SESSDATA ? 'SESSDATA=' + ck.SESSDATA : '',
      ck.bili_jct ? 'bili_jct=' + ck.bili_jct : '',
      session.buvid3 ? 'buvid3=' + session.buvid3 : '',
      session.buvid4 ? 'buvid4=' + session.buvid4 : ''
    ].filter(Boolean).join('; ')
  })()`)
  ws.close()
  if (!cookie) { console.log('NO_COOKIE'); return }

  // wbi 签名的 series/one
  const qs = await signedQuery({ number: 392 })
  const r1 = await fetch(`${API}/x/web-interface/popular/series/one?${qs}`, {
    headers: { Cookie: cookie, Referer: 'https://www.bilibili.com/v/popular/weekly', 'User-Agent': UA }
  })
  const j1 = await r1.json()
  console.log('wbi series/one code=', j1.code, j1.code !== 0 ? j1.message : '')
  if (j1.code === 0) {
    const items = (j1.data && j1.data.list) || []
    console.log(`本期 ${items.length} 条，首条:`, JSON.stringify(items[0] && {
      bvid: items[0].bvid, title: (items[0].title || '').slice(0, 16), up: items[0].owner && items[0].owner.name
    }))
  }

  // 无 wbi 仅 UA+cookie 对照
  const r2 = await fetch(`${API}/x/web-interface/popular/series/one?number=392`, {
    headers: { Cookie: cookie, Referer: 'https://www.bilibili.com/v/popular/weekly', 'User-Agent': UA }
  })
  const j2 = await r2.json()
  console.log('裸 series/one code=', j2.code, j2.code !== 0 ? j2.message : '')
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
