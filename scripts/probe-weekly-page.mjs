/** P9.2 页面内探针：带凭据实测 series/one + ranking 全 rid 矩阵 */
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
    console.log('EVAL-ERR:', JSON.stringify(r.result.exceptionDetails).slice(0, 250))
    return null
  }
  return r.result && r.result.result ? r.result.result.value : undefined
}

async function main() {
  await new Promise((r) => (ws.onopen = r))
  const out = await evalJS(`(async () => {
    const ck = JSON.parse(localStorage.getItem('bilitv.auth.cookies') || '{}')
    const session = JSON.parse(localStorage.getItem('bilitv.session') || '{}')
    const cookie = [
      ck.SESSDATA ? 'SESSDATA=' + ck.SESSDATA : '',
      ck.bili_jct ? 'bili_jct=' + ck.bili_jct : '',
      session.buvid3 ? 'buvid3=' + session.buvid3 : '',
      session.buvid4 ? 'buvid4=' + session.buvid4 : ''
    ].filter(Boolean).join('; ')
    const H = { headers: { Cookie: cookie }, referrerPolicy: 'no-referrer' }

    // 1. series/one 最新期
    let weekly = null
    const sl = await (await fetch('https://api.bilibili.com/x/web-interface/popular/series/list', { headers: { Cookie: cookie, Referer: 'https://www.bilibili.com/v/popular/weekly' }, referrerPolicy: 'no-referrer' })).json()
    const num = sl.code === 0 && sl.data.list.length ? sl.data.list[0].number : 392
    const one = await (await fetch('https://api.bilibili.com/x/web-interface/popular/series/one?number=' + num, { headers: { Cookie: cookie, Referer: 'https://www.bilibili.com/v/popular/weekly' }, referrerPolicy: 'no-referrer' })).json()
    weekly = {
      listCode: sl.code, num,
      oneCode: one.code,
      count: one.code === 0 ? (one.data.list || []).length : (one.message || '')
    }

    // 2. ranking rid 矩阵（候选：标准分区 + 老接口映射）
    const cands = [
      ['番剧',13],['国创',167],['纪录片',177],['电影',23],['电视剧',11],['综艺',71],
      ['动画',1],['游戏',4],['鬼畜',3],['音乐',3],['舞蹈',129],['影视',181],['娱乐',5],
      ['知识',36],['科技数码',188],['美食',211],['汽车',223],['时尚美妆',155],
      ['体育运动',234],['动物',217],['游戏-2',2],['音乐-28',28],['舞蹈-153',153],['知识-178',178]
    ]
    const ridOut = []
    for (const [name, rid] of cands) {
      const r = await (await fetch('https://api.bilibili.com/x/web-interface/ranking/v2?rid=' + rid + '&type=all', H)).json()
      const n = r.code === 0 ? ((r.data && r.data.list) || []).length : 0
      ridOut.push(name + ':' + rid + ':' + r.code + ':' + n)
      await new Promise((res) => setTimeout(res, 120))
    }
    return { weekly, ridOut }
  })()`)
  console.log('每周必看:', JSON.stringify(out && out.weekly))
  console.log('ranking 矩阵（名称:rid:code:条数）:')
  ;(out && out.ridOut || []).forEach((l) => console.log('  ' + l))
  ws.close()
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
