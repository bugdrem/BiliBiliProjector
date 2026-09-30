/**
 * P8 探针：验证 /x/player/wbi/playurl fnval=16 的 DASH 返回结构（匿名态）
 *
 * 验证点：
 *  1. fnval=16 是否返回 dash（video/audio 分离流）而非 durl
 *  2. dash.video 数组的清晰度档位（匿名上限）、codecs、baseUrl 形态
 *  3. accept_quality / accept_description 列表
 *  4. 对照组：现状 durl 模式（platform=html5）的 quality 上限
 *
 * 运行：node scripts/probe-dash.mjs
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

/** 与 wbi.js 同算法：nav 取 key → 混淆重排 → 签名 query */
async function signedQuery(params) {
  const navRes = await fetch(`${API}/x/web-interface/nav`)
  const nav = await navRes.json()
  const img = nav.data && nav.data.wbi_img
  if (!img) throw new Error('nav 无 wbi_img: ' + JSON.stringify(nav).slice(0, 200))
  const keyFromUrl = (u) => (String(u).split('/').pop() || '').replace(/\.[a-zA-Z]+$/, '')
  const raw = keyFromUrl(img.img_url) + keyFromUrl(img.sub_url)
  let mixin = ''
  for (const i of MIXIN_KEY_ENC_TAB) if (raw[i]) mixin += raw[i]
  mixin = mixin.slice(0, 32)

  const wts = Math.floor(Date.now() / 1000)
  const all = { ...params, wts }
  const qs = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  return `${qs}&w_rid=${md5(qs + mixin)}`
}

/** 打印 DASH 结构摘要 */
async function dumpDash(data, tag) {
  console.log(`\n===== ${tag} =====`)
  console.log('quality:', data.quality, '| accept_quality:', JSON.stringify(data.accept_quality))
  console.log('accept_description:', JSON.stringify(data.accept_description))
  console.log('support_formats:', (data.support_formats || []).map((f) => `${f.quality}:${f.new_description}`).join(' / '))
  if (data.durl) {
    console.log('durl 模式：', (data.durl || []).length, '段，size=', data.durl[0] && data.durl[0].size)
  }
  if (data.dash) {
    const d = data.dash
    console.log('dash.duration:', d.duration, 's | minBufferTime:', d.min_buffer_time)
    console.log('dash.video 档位：')
    for (const v of d.video || []) {
      console.log(
        `  id=${v.id} codecs=${v.codecs} bw=${(v.bandwidth / 1e6).toFixed(2)}Mbps ` +
        `${v.width}x${v.height}@${v.frame_rate} size=${(v.size / 1e6).toFixed(1)}MB`
      )
      console.log(`    baseUrl host: ${new URL(v.base_url).host} | backup: ${(v.backup_url || []).length} 条`)
    }
    console.log('dash.audio 档位：')
    for (const a of d.audio || []) {
      console.log(`  id=${a.id} codecs=${a.codecs} bw=${(a.bandwidth / 1e3).toFixed(0)}kbps size=${(a.size / 1e6).toFixed(1)}MB`)
    }
    // Range 支持探测：对最高档视频 baseUrl 发 HEAD/Range 请求
    const top = (d.video || [])[0]
    if (top && top.base_url) {
      const probe = async () => {
        try {
          const r = await fetch(top.base_url, { headers: { Range: 'bytes=0-1023' } })
          const cr = r.headers.get('content-range')
          console.log(`Range 探测：HTTP ${r.status} content-range=${cr} type=${r.headers.get('content-type')}`)
        } catch (e) {
          console.log('Range 探测失败：', e.message)
        }
      }
      await probe()
    }
  }
}

async function main() {
  // 1. 取一个热门视频（bvid + cid）
  const pop = await (await fetch(`${API}/x/web-interface/popular?pn=1&ps=5`)).json()
  const item = pop.data && pop.data.list && pop.data.list[0]
  if (!item) throw new Error('popular 拉取失败: ' + JSON.stringify(pop).slice(0, 200))
  const bvid = item.bvid
  const view = await (await fetch(`${API}/x/web-interface/view?bvid=${bvid}`)).json()
  const cid = view.data && view.data.cid
  console.log(`测试视频：${bvid}（${view.data.title}）cid=${cid}`)

  // 2. DASH 模式（fnval=16，wbi 签名，匿名）
  try {
    const qs = await signedQuery({ bvid, cid, qn: 80, fnval: 16, fnver: 0, fourk: 0 })
    const res = await fetch(`${API}/x/player/wbi/playurl?${qs}`)
    const j = await res.json()
    console.log('\nwbi/playurl fnval=16 code=', j.code, j.code !== 0 ? j.message : '')
    if (j.code === 0) dumpDash(j.data, 'DASH 匿名')
  } catch (e) {
    console.log('DASH 请求异常：', e.message)
  }

  // 3. 对照：现状 durl 模式（/x/player/playurl + platform=html5）
  try {
    const u = `${API}/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&platform=html5&high_quality=1`
    const j = await (await fetch(u)).json()
    console.log('\nplayer/playurl html5 code=', j.code)
    if (j.code === 0) dumpDash(j.data, 'durl 对照（现状）')
  } catch (e) {
    console.log('durl 对照异常：', e.message)
  }
}

main().catch((e) => {
  console.error('探针异常：', e)
  process.exit(1)
})
