/**
 * P8 探针 3：UA 校验假设验证 + SegmentBase 索引结构
 * backupUrl（bilivideo.com）对 Node 默认 UA 403 —— 若带浏览器 UA 通过，
 * 则 WebView 内 fetch（Chrome UA）天然可用，PCDN 主源 + 备源双通道可行。
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

const UA_TV = 'Mozilla/5.0 (Linux; Android 11; BiliTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

async function probe(tag, url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    console.log(`[${tag}] HTTP ${r.status} | content-range=${r.headers.get('content-range')} | acao=${r.headers.get('access-control-allow-origin')}`)
    return r.status
  } catch (e) {
    console.log(`[${tag}] 失败: ${e.message}`)
    return 0
  }
}

async function main() {
  const pop = await (await fetch(`${API}/x/web-interface/popular?pn=1&ps=5`)).json()
  const bvid = pop.data.list[0].bvid
  const view = await (await fetch(`${API}/x/web-interface/view?bvid=${bvid}`)).json()
  const cid = view.data.cid

  const qs = await signedQuery({ bvid, cid, qn: 64, fnval: 16, fnver: 0 })
  const j = await (await fetch(`${API}/x/player/wbi/playurl?${qs}`)).json()
  const d = j.data.dash
  const v0 = (d.video || []).filter((v) => String(v.codecs || '').startsWith('avc1'))[0]
  const sb = v0.SegmentBase || v0.segment_base
  console.log('SegmentBase:', JSON.stringify(sb))
  console.log('mimeType:', v0.mimeType || v0.mime_type, '| codecs:', v0.codecs, '| sar:', v0.sar, '| startWithSap:', v0.startWithSap || v0.start_with_sap)

  const urls = [v0.baseUrl || v0.base_url, ...(v0.backupUrl || v0.backup_url || [])].filter(Boolean)

  // 1. bilivideo.com 备源 + 浏览器 UA
  await probe('备源+UA ', urls[2], { Range: 'bytes=0-1023', 'User-Agent': UA_TV })
  // 2. bilivideo.com 备源 + UA + Referer
  await probe('备源+UA+Ref', urls[2], { Range: 'bytes=0-1023', 'User-Agent': UA_TV, Referer: 'https://www.bilibili.com/' })
  // 3. PCDN 主源 + 浏览器 UA（应仍 206）
  await probe('主源+UA  ', urls[0], { Range: 'bytes=0-1023', 'User-Agent': UA_TV })
  // 4. mountaintoys 备源 + UA
  await probe('备源1+UA ', urls[1], { Range: 'bytes=0-1023', 'User-Agent': UA_TV })
}

main().catch((e) => { console.error('探针异常：', e); process.exit(1) })
