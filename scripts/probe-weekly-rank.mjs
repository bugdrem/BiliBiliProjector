/**
 * P9.2 探针：每周必看接口 + 排行榜分区 rid 验证
 *  1. /x/web-interface/popular/series/list —— 期数列表结构
 *  2. /x/web-interface/popular/series/one?number=392 —— 单期内容
 *  3. ranking/v2 各分区 rid（用户 20 个子菜单）逐个验证 code
 */
const API = 'https://api.bilibili.com'

const RID_MAP = {
  番剧: 13, 国创: 167, 纪录片: 177, 电影: 23, 电视剧: 11, 综艺: 71,
  动画: 1, 游戏: 2, 鬼畜: 3, 音乐: 28, 舞蹈: 153, 影视: 181, 娱乐: 5,
  知识: 36, 科技数码: 188, 美食: 211, 汽车: 223, 时尚美妆: 155,
  体育运动: 234, 动物: 217
}

async function main() {
  // 1. 期数列表
  const sl = await (await fetch(`${API}/x/web-interface/popular/series/list`)).json()
  console.log('series/list code=', sl.code)
  if (sl.code === 0) {
    const list = sl.data && sl.data.list
    console.log(`期数 ${list.length} 项，前 3 项:`, JSON.stringify(list.slice(0, 3)))
  } else {
    console.log('msg:', sl.message)
  }

  // 2. 单期内容
  const one = await (await fetch(`${API}/x/web-interface/popular/series/one?number=392`)).json()
  console.log('\nseries/one(392) code=', one.code)
  if (one.code === 0) {
    const items = (one.data && one.data.list) || []
    console.log(`本期 ${items.length} 个视频，首条:`, JSON.stringify(items[0] && {
      bvid: items[0].bvid, title: (items[0].title || '').slice(0, 20),
      owner: items[0].owner && items[0].owner.name, pubdate: items[0].pubdate,
      stat: items[0].stat && { view: items[0].stat.view, danmaku: items[0].stat.danmaku }
    }))
  } else {
    console.log('msg:', one.message)
  }

  // 3. 排行榜各分区 rid
  console.log('\nranking/v2 rid 验证：')
  for (const [name, rid] of Object.entries(RID_MAP)) {
    const r = await (await fetch(`${API}/x/web-interface/ranking/v2?rid=${rid}&type=all`)).json()
    const n = r.code === 0 ? ((r.data && r.data.list) || []).length : -1
    console.log(`  ${name}(${rid}): code=${r.code} ${n >= 0 ? n + ' 条' : r.message}`)
    await new Promise((res) => setTimeout(res, 150)) // 限频
  }
}
main().catch((e) => { console.error('探针异常：', e); process.exit(1) })
