/**
 * 探针：页面内直调 nav（带登录凭据），dump 用户信息相关字段真实结构
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)) } }, 20000)
  })
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) {
    console.log('EVAL-ERR:', JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return null
  }
  return r.result && r.result.result ? r.result.result.value : undefined
}

async function main() {
  await new Promise((r) => (ws.onopen = r))
  const nav = await evalJS(`(async () => {
    const ck = JSON.parse(localStorage.getItem('bilitv.auth.cookies') || '{}')
    if (!ck.SESSDATA) return { err: 'NO_COOKIE' }
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { Cookie: 'SESSDATA=' + ck.SESSDATA + '; bili_jct=' + (ck.bili_jct || '') },
      referrerPolicy: 'no-referrer'
    })
    const j = await res.json()
    const d = j.data || {}
    return {
      code: j.code,
      isLogin: d.isLogin,
      uname: d.uname,
      mid: d.mid,
      level: d.level,
      level_info: d.level_info,
      vipStatus: d.vipStatus,
      vipType: d.vipType,
      vip_label: d.vipLabel ? d.vipLabel.text : d.vip_label,
      vipDueDate: d.vipDueDate || d.vip_due_date,
      money: d.money,
      coins: d.coins,
      email_status: d.email_status,
      official: d.official ? d.official.role : undefined,
      userCacheLS: JSON.parse(localStorage.getItem('bilitv.auth.user') || 'null')
    }
  })()`)
  console.log(JSON.stringify(nav, null, 1))
  ws.close()
}
main().catch((e) => { console.error('探针异常：', e.message); process.exit(1) })
