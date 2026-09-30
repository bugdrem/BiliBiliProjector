/**
 * 真实接口冒烟脚本（Node 运行，验证网络层 + Wbi 签名 + 全部端点）
 * 用法：npm run smoke
 */
import { getPopular, getRanking, searchAll, getView, getRelated, getPlayUrl, getDanmakuXml } from '../src/api/bilibili.js'

const results = []
async function step(name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push(`✅ ${name} (${Date.now() - t0}ms)${detail ? ' → ' + detail : ''}`)
  } catch (err) {
    results.push(`❌ ${name} (${Date.now() - t0}ms) → ${err.code || ''} ${err.message}`)
    process.exitCode = 1
  }
}

// 1. 推荐流
let firstBvid = ''
let firstCid = 0
await step('popular 推荐流', async () => {
  const res = await getPopular(1, 5)
  firstBvid = res.list[0] && res.list[0].bvid
  if (!firstBvid) throw new Error('空列表')
  return `${res.list.length} 条, 首条 ${firstBvid}`
})

// 2. 排行榜
await step('ranking 排行榜', async () => {
  const list = await getRanking(0)
  return `${list.length} 条`
})

// 3. 视频详情（拿 cid）
await step('view 视频详情', async () => {
  const v = await getView(firstBvid)
  firstCid = v.cid
  return `「${v.title.slice(0, 18)}」 cid=${firstCid} 分P=${v.pages.length}`
})

// 4. 相关推荐
await step('related 相关推荐', async () => {
  const list = await getRelated(firstBvid)
  return `${list.length} 条`
})

// 5. 播放地址（匿名 MP4）
let mp4 = ''
await step('playurl 播放地址', async () => {
  const p = await getPlayUrl(firstBvid, firstCid)
  mp4 = p.url
  if (!mp4) throw new Error('未返回 url')
  return mp4.slice(0, 60) + '…'
})

// 6. MP4 直链连通性（Range 请求，验证免 Referer 可播）
await step('MP4 直链 Range 探测', async () => {
  const res = await fetch(mp4, { headers: { Range: 'bytes=0-1023' } })
  if (res.status !== 206 && res.status !== 200) throw new Error('HTTP ' + res.status)
  const buf = await res.arrayBuffer()
  return `HTTP ${res.status}, ${buf.byteLength} bytes`
})

// 7. 弹幕池
await step('danmaku 弹幕池', async () => {
  const xml = await getDanmakuXml(firstCid)
  const count = (xml.match(/<d /g) || []).length
  return `${xml.length} 字节, ${count} 条弹幕`
})

// 8. 搜索（wbi 签名，重点验证）
await step('search 搜索（wbi 签名）', async () => {
  const list = await searchAll('相声')
  return `${list.length} 条结果`
})

console.log('\n===== BiliTV 接口冒烟 =====')
for (const line of results) console.log(line)
console.log('============================\n')
