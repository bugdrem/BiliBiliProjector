/**
 * P8 诊断：parseSidx 索引时间累加 bug 复现
 * 同一解析代码（与 src/player/msePlayer.js 的 parseSidx 逐字一致）跑真实 sidx，
 * 打印 frags[0..30] 的 start/dur/byteStart，定位 t 累加断点。
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

/** === 与 msePlayer.js parseSidx 完全一致的解析 === */
export function parseSidx(bytes, offset, sidxAnchor) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = offset
  const size = dv.getUint32(p)
  const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])
  if (type !== 'sidx') throw new Error(`期望 sidx 实得 ${type}`)
  const version = bytes[p + 8]
  const timescale = dv.getUint32(p + 16) || 1
  let ept, firstOffset, refCount, refBase
  if (version === 0) {
    ept = dv.getUint32(p + 20)
    firstOffset = dv.getUint32(p + 24)
    refCount = dv.getUint16(p + 30)
    refBase = p + 32
  } else {
    ept = Number(dv.getBigUint64(p + 20))
    firstOffset = Number(dv.getBigUint64(p + 28))
    refCount = dv.getUint16(p + 38)
    refBase = p + 40
  }
  console.log(`sidx: version=${version} timescale=${timescale} ept=${ept} firstOffset=${firstOffset} refCount=${refCount} size=${size}`)
  const frags = []
  let t = ept / timescale
  let byte = sidxAnchor + firstOffset
  for (let i = 0; i < refCount; i++) {
    const q = refBase + i * 12
    const referencedSize = dv.getUint32(q) & 0x7fffffff
    const dur = dv.getUint32(q + 4) / timescale
    if (referencedSize > 0) {
      frags.push({ start: t, dur, byteStart: byte, byteEnd: byte + referencedSize - 1 })
    }
    t += dur
    byte += referencedSize
  }
  return { timescale, frags }
}

async function main() {
  // 与 V1 验证同一视频（页面在播的）
  const bvid = 'BV19naF66Ezb'
  const view = await (await fetch(`${API}/x/web-interface/view?bvid=${bvid}`)).json()
  const cid = view.data.cid
  console.log(`视频 ${bvid} cid=${cid} duration=${view.data.duration}s`)

  const qs = await signedQuery({ bvid, cid, qn: 80, fnval: 16, fnver: 0 })
  const j = await (await fetch(`${API}/x/player/wbi/playurl?${qs}`)).json()
  const d = j.data.dash
  const v0raw = (d.video || []).filter((v) => String(v.codecs || '').startsWith('avc1')).sort((a, b) => b.id - a.id)[0]
  const sb = v0raw.SegmentBase || v0raw.segment_base
  const parseRange = (s) => { const m = String(s || '').match(/^(\d+)-(\d+)$/); return m ? { start: +m[1], end: +m[2] } : null }
  const init = parseRange(sb.Initialization || sb.initialization)
  const idx = parseRange(sb.indexRange || sb.IndexRange)
  console.log('video 档:', v0raw.id, v0raw.codecs, '| init=', JSON.stringify(init), 'idx=', JSON.stringify(idx))

  const head = new Uint8Array(await (await fetch(v0raw.baseUrl, { headers: { Range: `bytes=0-${idx.end}` } })).arrayBuffer())
  console.log('head 拉取:', head.length, 'bytes')

  try {
    const { frags } = parseSidx(head, idx.start, idx.end + 1)
    console.log(`解析 ${frags.length} 片`)
    for (let i = 0; i < Math.min(31, frags.length); i++) {
      const f = frags[i]
      console.log(
        `  [${i}] start=${f.start.toFixed(2)} dur=${f.dur.toFixed(2)} bytes=${f.byteStart}-${f.byteEnd}`
      )
    }
  } catch (e) {
    console.log('解析失败:', e.message)
    // 头部 hex 转储（sidx 起点前后 64B）
    const p = idx.start
    for (let row = 0; row < 4; row++) {
      const off = p + row * 16
      const hex = Array.from(head.slice(off, off + 16)).map((b) => b.toString(16).padStart(2, '0')).join(' ')
      console.log(`  +${off}: ${hex}`)
    }
  }
}

main().catch((e) => { console.error('诊断异常：', e); process.exit(1) })
