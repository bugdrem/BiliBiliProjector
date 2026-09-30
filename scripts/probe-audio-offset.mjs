/**
 * P8 诊断：audio 流 sidx 索引与真实内容的时间错位验证
 * video 索引准（vBuf 起点=索引 start），audio 拉到的内容比索引晚一片
 * —— 用 audio 流真实数据验证：拉 A#N.byteStart 处的 moof，解析 tfdt
 *   （baseMediaDecodeTime）对照索引 start。
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

/** 顺序扫描 box：返回 [{type, start, size}]（定位 moof 内的 tfdt） */
function scanBoxes(bytes, offset, end) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes = []
  let p = offset
  while (p < end - 8) {
    let size = dv.getUint32(p)
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])
    if (size === 1) {
      // largesize
      const big = dv.getBigUint64(p + 8)
      size = Number(big)
      boxes.push({ type, start: p, size, hdr: 16 })
      p += size
      if (size < 8) break
      continue
    }
    if (size === 0 || size < 8) break
    boxes.push({ type, start: p, size, hdr: 8 })
    p += size
  }
  return boxes
}

/** 暴力搜 'tfdt' box 并解析 baseMediaDecodeTime（box 布局 size(4)+'tfdt'(4)+version(1)） */
function findTfdt(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < bytes.length - 12; i++) {
    if (bytes[i] === 0x74 && bytes[i + 1] === 0x66 && bytes[i + 2] === 0x64 && bytes[i + 3] === 0x74) {
      const version = bytes[i + 4] // i 是 size 字段，'tfdt'@i，version@i+4
      return version === 0 ? dv.getUint32(i + 8) : Number(dv.getBigUint64(i + 8))
    }
  }
  return null
}

async function main() {
  const bvid = 'BV19naF66Ezb'
  const view = await (await fetch(`${API}/x/web-interface/view?bvid=${bvid}`)).json()
  const cid = view.data.cid
  const qs = await signedQuery({ bvid, cid, qn: 80, fnval: 16, fnver: 0 })
  const j = await (await fetch(`${API}/x/player/wbi/playurl?${qs}`)).json()
  const d = j.data.dash
  const parseRange = (s) => { const m = String(s || '').match(/^(\d+)-(\d+)$/); return m ? { start: +m[1], end: +m[2] } : null }
  const pickUrl = (o) => o.baseUrl || o.base_url
  const pickBackups = (o) => o.backupUrl || o.backup_url || []

  // audio 流（码率最高）
  const audio = (d.audio || []).slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]
  const sb = audio.SegmentBase || audio.segment_base
  const init = parseRange(sb.Initialization || sb.initialization)
  const idx = parseRange(sb.indexRange || sb.IndexRange)
  console.log(`audio id=${audio.id} codecs=${audio.codecs} init=${JSON.stringify(init)} idx=${JSON.stringify(idx)} timescale hint`)

  const head = new Uint8Array(await (await fetch(pickUrl(audio), { headers: { Range: `bytes=0-${idx.end}` } })).arrayBuffer())
  console.log('head bytes:', head.length)

  // sidx 解析（与 msePlayer.js 一致）
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  let p = idx.start
  const boxType = (off) => String.fromCharCode(head[off + 4], head[off + 5], head[off + 6], head[off + 7])
  console.log(`@${p} box=${boxType(p)}`)
  const version = head[p + 8]
  const timescale = dv.getUint32(p + 16) || 1
  let ept, firstOffset, refCount, refBase
  if (version === 0) {
    ept = dv.getUint32(p + 20); firstOffset = dv.getUint32(p + 24)
    refCount = dv.getUint16(p + 30); refBase = p + 32
  } else {
    ept = Number(dv.getBigUint64(p + 20)); firstOffset = Number(dv.getBigUint64(p + 28))
    refCount = dv.getUint16(p + 38); refBase = p + 40
  }
  const sidxSize = dv.getUint32(p)
  const anchor = idx.end + 1
  console.log(`sidx v${version} timescale=${timescale} ept=${ept} firstOffset=${firstOffset} refCount=${refCount} sidxSize=${sidxSize} anchor=${anchor}`)

  // sidx box 是否在 indexRange 内结束（sidxSize 终点 vs idx.end）
  console.log(`sidx 终点=${p + sidxSize - 1} vs idx.end=${idx.end}`)

  const frags = []
  let t = ept / timescale
  let byte = anchor + firstOffset
  for (let i = 0; i < refCount; i++) {
    const q = refBase + i * 12
    const size = dv.getUint32(q) & 0x7fffffff
    const dur = dv.getUint32(q + 4) / timescale
    frags.push({ start: t, dur, byteStart: byte, byteEnd: byte + size - 1 })
    t += dur
    byte += size
  }
  // 打印头 3 片索引
  for (let i = 0; i < 3; i++) {
    const f = frags[i]
    console.log(`  索引[${i}] start=${f.start.toFixed(2)} bytes=${f.byteStart}-${f.byteEnd}`)
  }

  // 实测：拉 frags[0]/frags[1] 的真实内容，解析 moof/tfdt 的 baseMediaDecodeTime
  for (const idxN of [0, 1]) {
    const f = frags[idxN]
    const r = await fetch(pickUrl(audio), { headers: { Range: `bytes=${f.byteStart}-${f.byteStart + 4095}` } })
    const chunk = new Uint8Array(await r.arrayBuffer())
    const status = r.status
    const cr = r.headers.get('content-range')
    // 内容可能不止 moof——只扫 moof 头部
    const boxes = scanBoxes(chunk, 0, chunk.length)
    const moof = boxes.find((b) => b.type === 'moof')
    console.log(`  实测[$${idxN}] HTTP ${status} cr=${cr} boxes=${boxes.map((b) => b.type).join(',')}`)
    if (moof) {
      const bmdt = findTfdt(chunk)
      console.log(`  实测[$${idxN}] tfdt.baseMediaDecodeTime=${bmdt} → ${((bmdt || 0) / timescale).toFixed(2)}s（索引 start=${f.start.toFixed(2)}s）`)
    }
  }

  // 对照：video 流同样验证片 0
  const video = (d.video || []).filter((v) => String(v.codecs || '').startsWith('avc1')).sort((a, b) => b.id - a.id)[0]
  const vsb = video.SegmentBase || video.segment_base
  const vidx = parseRange(vsb.indexRange || vsb.IndexRange)
  const vhead = new Uint8Array(await (await fetch(pickUrl(video), { headers: { Range: `bytes=0-${vidx.end}` } })).arrayBuffer())
  const vdv = new DataView(vhead.buffer, vhead.byteOffset, vhead.byteLength)
  const vver = vhead[vidx.start + 8]
  const vts = vdv.getUint32(vidx.start + 16) || 1
  const vept = vver === 0 ? vdv.getUint32(vidx.start + 20) : Number(vdv.getBigUint64(vidx.start + 20))
  const vfo = vver === 0 ? vdv.getUint32(vidx.start + 24) : Number(vdv.getBigUint64(vidx.start + 28))
  const vrc = vver === 0 ? vdv.getUint16(vidx.start + 30) : vdv.getUint16(vidx.start + 38)
  const vrefBase = vver === 0 ? vidx.start + 32 : vidx.start + 40
  const vanchor = vidx.end + 1
  const vfrags = []
  let vt = vept / vts
  let vb = vanchor + vfo
  for (let i = 0; i < vrc; i++) {
    const q = vrefBase + i * 12
    const size = vdv.getUint32(q) & 0x7fffffff
    const dur = vdv.getUint32(q + 4) / vts
    vfrags.push({ start: vt, dur, byteStart: vb, byteEnd: vb + size - 1 })
    vt += dur
    vb += size
  }
  const f0 = vfrags[0]
  const vchunk = new Uint8Array(await (await fetch(pickUrl(video), { headers: { Range: `bytes=${f0.byteStart}-${f0.byteStart + 4095}` } })).arrayBuffer())
  const vboxes = scanBoxes(vchunk, 0, vchunk.length)
  const vmoof = vboxes.find((b) => b.type === 'moof')
  console.log(`\nvideo 对照：sidx v${vver} ts=${vts} refCount=${vrc}`)
  if (vmoof) {
    const vbmdt = findTfdt(vchunk)
    console.log(`video[0] tfdt=${vbmdt} → ${((vbmdt || 0) / vts).toFixed(2)}s（索引 start=${f0.start.toFixed(2)}s）`)
  }
}

main().catch((e) => { console.error('诊断异常：', e); process.exit(1) })
