/**
 * 探针：playurl 参数矩阵对 DASH 节点调度的影响（对齐 web 端参数）
 * wbi 签名 Node 侧实现，比较 baseUrl host 差异
 */
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function main() {
  const bvid = 'BV1GJ411x7h7'
  const view = await (await fetch(`${API}/x/web-interface/view?bvid=${bvid}`, { headers: { 'User-Agent': UA } })).json()
  const cid = view.data.cid
  console.log(`视频 ${bvid} cid=${cid}`)

  const variants = [
    { tag: '现状(无platform)', p: { bvid, cid, qn: 80, fnval: 16, fnver: 0, fourk: 0 } },
    { tag: '+platform=pc    ', p: { bvid, cid, qn: 80, fnval: 16, fnver: 0, fourk: 0, platform: 'pc' } },
    { tag: '+pc+high_quality', p: { bvid, cid, qn: 80, fnval: 16, fnver: 0, fourk: 0, platform: 'pc', high_quality: 1 } },
    { tag: 'web版(qn=0,4048) ', p: { bvid, cid, qn: 0, fnval: 4048, fnver: 0, fourk: 1, platform: 'pc', high_quality: 1 } }
  ]
  for (const v of variants) {
    const qs = await signedQuery(v.p)
    const j = await (await fetch(`${API}/x/player/wbi/playurl?${qs}`, { headers: { 'User-Agent': UA } })).json()
    if (j.code !== 0) { console.log(`${v.tag}: code=${j.code} ${j.message}`); continue }
    const vids = (j.data.dash.video || []).filter((x) => String(x.codecs || '').startsWith('avc1')).sort((a, b) => b.id - a.id)
    const top = vids[0]
    const hosts = [...new Set(vids.map((x) => new URL(x.baseUrl || x.base_url).host))]
    // 对最高档发 Range 探测
    let probe = ''
    if (top) {
      const r = await fetch(top.baseUrl || top.base_url, { headers: { Range: 'bytes=0-4095', 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } })
      probe = `探=${r.status}`
    }
    console.log(`${v.tag}: 档位[${vids.map((x) => x.id).join(',')}] 主源=${new URL(top.baseUrl || top.base_url).host} ${probe}`)
    console.log(`   全部 host: ${hosts.join(' , ')}`)
  }
}
main().catch((e) => { console.error('探针异常：', e); process.exit(1) })
