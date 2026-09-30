/**
 * P8 探针 2：DASH baseUrl 的 Range / CORS / 备用源可用性
 * （主 baseUrl 落在 PCDN mcdn host，须确认逐字节 Range 206 与备用 URL 兜底）
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

/** 探测单个 URL 的 Range 行为 */
async function probeUrl(tag, url) {
  const t0 = Date.now()
  try {
    const r = await fetch(url, {
      headers: { Range: 'bytes=0-4095' },
      signal: AbortSignal.timeout(8000)
    })
    const ms = Date.now() - t0
    console.log(
      `[${tag}] HTTP ${r.status} | ${(ms)}ms | ` +
      `content-range=${r.headers.get('content-range')} | ` +
      `len=${r.headers.get('content-length')} | ` +
      `acao=${r.headers.get('access-control-allow-origin')} | ` +
      `type=${r.headers.get('content-type')}`
    )
    // 读头部字节验证 ftyp 魔数
    const buf = new Uint8Array(await r.arrayBuffer())
    const magic = String.fromCharCode(...buf.slice(4, 8))
    console.log(`[${tag}] 首 8 字节 box 魔数: ${magic}（期望 ftyp）`)
  } catch (e) {
    console.log(`[${tag}] 失败: ${e.name} ${e.message}`)
  }
}

async function main() {
  const pop = await (await fetch(`${API}/x/web-interface/popular?pn=1&ps=5`)).json()
  const bvid = pop.data.list[0].bvid
  const view = await (await fetch(`${API}/x/web-interface/view?bvid=${bvid}`)).json()
  const cid = view.data.cid

  const qs = await signedQuery({ bvid, cid, qn: 64, fnval: 16, fnver: 0 })
  const j = await (await fetch(`${API}/x/player/wbi/playurl?${qs}`)).json()
  const d = j.data && j.data.dash
  if (!d) { console.log('无 dash:', JSON.stringify(j).slice(0, 300)); return }

  // 只取 avc1 变体
  const vids = (d.video || []).filter((v) => String(v.codecs || '').startsWith('avc1'))
  console.log(`视频 avc1 档位：${vids.map((v) => v.id).join(',')} | 字段键名: ${Object.keys(vids[0]).join(',')}`)

  const v0 = vids[0]
  const urls = [v0.baseUrl || v0.base_url, ...((v0.backupUrl || v0.backup_url || []))].filter(Boolean)
  console.log(`候选 URL 共 ${urls.length} 条：`)
  urls.forEach((u, i) => console.log(`  [${i}] ${new URL(u).host}${new URL(u).pathname.slice(0, 30)}...`))

  for (let i = 0; i < urls.length; i++) {
    await probeUrl(`v#${i}`, urls[i])
  }
  // 音频流第一条
  const a0 = (d.audio || [])[0]
  if (a0) {
    const aurls = [a0.baseUrl || a0.base_url, ...((a0.backupUrl || a0.backup_url || []))].filter(Boolean)
    await probeUrl('a#0', aurls[0])
  }
}

main().catch((e) => { console.error('探针异常：', e); process.exit(1) })
