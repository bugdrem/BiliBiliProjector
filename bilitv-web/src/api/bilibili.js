/**
 * Bilibili Web 公开接口封装
 *
 * 所有接口均为匿名可用的 Web 端点（P0 实测，见 docs/01-开发文档.md 1.3 节）。
 * 数据在此层整形为视图层友好的 Card / Video 结构，字段全部容错取值。
 */

import { inflate, inflateRaw } from 'pako'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { apiGet, ApiError, ensureSession, getCookieHeader, API_BASE } from './http.js'
import { signedQuery } from './wbi.js'
import { auth } from '../stores/auth.js'

/** 清晰度 qn → 文案（playurl.quality 用） */
export const QN_LABEL = {
  16: '360P',
  32: '480P',
  64: '720P',
  74: '720P60',
  80: '1080P',
  112: '1080P 高码率',
  116: '1080P60',
  120: '4K',
  125: 'HDR',
  126: '杜比视界',
  127: '8K'
}

/**
 * http → https（页面为 https，混合内容会被 WebView 拦截）+ 图床缩略参数
 * （P9.5 性能：封面/头像原图 100-300KB×百张卡在弱设备上是最大卡顿源；
 *  hdslb 图床原生支持 @ 尺寸后缀，webp 格式 Chromium 32+ 全兼容）
 */
const httpsPic = (url, thumb = '') => {
  const u = String(url || '').replace(/^http:\/\//, 'https://')
  if (!u || !thumb || !/hdslb\.com/.test(u)) return u
  return u + thumb
}

/** 卡片封面缩略：显示宽约 288px，拉 480w 足够（2x 密度余量） */
const PIC_THUMB = '@480w_270h_1c.webp'
/** 头像缩略：显示 64-84px */
const FACE_THUMB = '@96w_96h_1c.webp'

/** 弹幕服务基地址：dev 走 Vite 代理（/bdm），生产经 CapacitorHttp 直连 */
const DM_BASE =
  typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV
    ? '/bdm'
    : 'https://comment.bilibili.com'

/**
 * 入站必刷（P9.10 D32，热门频道子菜单）：历史经典 98 条，一次返回无分页
 * 接口：/x/web-interface/popular/precious?vapp=1
 */
export async function getPrecious() {
  const data = await apiGet('/x/web-interface/popular/precious', { vapp: 1 })
  return ((data && data.list) || []).map(toCard).filter(Boolean)
}

/** 从接口原始条目整形出统一的视频卡片结构 */
function toCard(raw) {
  if (!raw) return null
  return {
    bvid: raw.bvid || '',
    aid: raw.aid,
    title: raw.title || '',
    pic: httpsPic(raw.pic, PIC_THUMB),
    // search 接口的 duration 是 "mm:ss" 字符串，其余接口是秒数
    duration: raw.duration,
    owner: {
      name: (raw.owner && raw.owner.name) || raw.author || ''
    },
    stat: {
      view: (raw.stat && raw.stat.view) || raw.play || 0,
      danmaku: (raw.stat && raw.stat.danmaku) || raw.video_review || 0
    },
    pubdate: raw.pubdate
  }
}

/** 去掉搜索标题中的高亮 <em> 标签 */
const stripEm = (s) => String(s || '').replace(/<\/?em[^>]*>/g, '')

/**
 * 首页推荐流（分页）
 * @param {number} pn 页码，从 1 开始
 * @param {number} ps 每页条数
 */
export async function getPopular(pn = 1, ps = 24) {
  const data = await apiGet('/x/web-interface/popular', { pn, ps })
  return {
    list: (data.list || []).map(toCard).filter(Boolean),
    hasMore: (data.list || []).length >= ps
  }
}

/**
 * 全站排行榜（wbi 签名不需要；rid=0 全站）
 * P9.2 D26 实测：rid 支持 1/3/4/5/11/23/36/129/155/177/181/188/211/217/223/234，
 * 番剧13/国创167/综艺71 为 PGC 体系 -400 不支持
 * @param {number} rid 分区 id（0 = 全站）
 */
export async function getRanking(rid = 0) {
  // P9.35 D51：对齐 web 排行榜页请求（桌面 UA + 排行榜页 Referer，CapacitorHttp 直调
  // 防 fetch shim 剥离 forbidden headers）；web 开发环境走 apiGet（Vite 代理）
  if (Capacitor.isNativePlatform()) {
    const data = await nativeGet(`/x/web-interface/ranking/v2?rid=${Number(rid) || 0}&type=all`, RANK_HEADERS)
    return (data.list || []).map(toCard).filter(Boolean)
  }
  const data = await apiGet('/x/web-interface/ranking/v2', { rid, type: 'all' }, { headers: RANK_HEADERS })
  return (data.list || []).map(toCard).filter(Boolean)
}

/**
 * 排行榜分区子菜单（P9.2 D26，rid 探针实测矩阵）：
 * rid=null 为 ranking/v2 不支持的分区（番剧/国创/综艺 = PGC 体系，鬼畜无独立榜）
 */
export const RANK_CATEGORIES = [
  { name: '番剧', rid: null },
  { name: '国创', rid: null },
  { name: '纪录片', rid: 177 },
  { name: '电影', rid: 23 },
  { name: '电视剧', rid: 11 },
  { name: '综艺', rid: null },
  { name: '动画', rid: 1 },
  { name: '游戏', rid: 4 },
  { name: '鬼畜', rid: null },
  { name: '音乐', rid: 3 },
  { name: '舞蹈', rid: 129 },
  { name: '影视', rid: 181 },
  { name: '娱乐', rid: 5 },
  { name: '知识', rid: 36 },
  { name: '科技数码', rid: 188 },
  { name: '美食', rid: 211 },
  { name: '汽车', rid: 223 },
  { name: '时尚美妆', rid: 155 },
  { name: '体育运动', rid: 234 },
  { name: '动物', rid: 217 }
]

/**
 * 每周必看风控要求（P9.2 D26 探针过程）：
 *  1. 无 Referer → -352；2. fetch shim 加 Referer/UA → 仍 -352（shim 构造 Request 时
 *     forbidden headers 被引擎剥离）；3. **原生 CapacitorHttp 直调（headers 全透传）→ code 0**
 *  therefore native 平台直调 CapacitorHttp，web 开发回退 apiGet（Vite 代理带 Referer）
 */
const WEEKLY_UA =
  'Mozilla/5.0 (Linux; Android 11; BiliTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const WEEKLY_HEADERS = {
  Referer: 'https://www.bilibili.com/v/popular/weekly',
  'User-Agent': WEEKLY_UA
}

/** 桌面 Chrome UA（P9.35 D51）：排行榜等风控敏感接口对齐 web 页请求 */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const RANK_HEADERS = {
  Referer: 'https://www.bilibili.com/v/popular/rank/all/',
  'User-Agent': DESKTOP_UA
}

/** 原生通道直调（CapacitorHttp headers 无 forbidden 剥离，Cookie 显式下发）。
 *  P9.35 D51：泛化自 weeklyGet，排行榜等接口复用 */
async function nativeGet(pathWithQuery, extraHeaders = {}) {
  await ensureSession()
  const cookie = getCookieHeader()
  const headers = { ...extraHeaders }
  if (cookie) headers.Cookie = cookie
  const res = await CapacitorHttp.get({
    url: `${API_BASE}${pathWithQuery}`,
    headers,
    connectTimeout: 10000,
    readTimeout: 10000
  })
  let json = res.data
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json)
    } catch (_) {
      throw new ApiError(-1, `HTTP ${res.status} 响应解析失败`)
    }
  }
  if (json.code !== 0) {
    throw new ApiError(json.code, json.code === -352 || json.code === -412 ? '请求被风控拦截，请稍后再试' : json.message || '接口返回异常')
  }
  return json.data
}

function weeklyGet(pathWithQuery) {
  return nativeGet(pathWithQuery, WEEKLY_HEADERS)
}

/**
 * B 站热搜榜（P9.13 D35，搜索页右侧面板）
 * 实测匿名可用（code 0）：data.trending.list[] = {keyword, show_name, icon, heat_score}
 */
export async function getHotSearch() {
  const data = await apiGet('/x/web-interface/search/square', { limit: 10 })
  const list = (data && data.trending && data.trending.list) || []
  return list.map((s) => ({
    keyword: s.keyword || '',
    showName: s.show_name || s.keyword || '',
    icon: httpsPic(s.icon || ''),
    heat: s.heat_score || 0
  }))
}

/**
 * 每周必看：期数列表（最新在前，周更）
 * 实测返回 391 项：{number, name: "2026第392期 09.18 - 09.24", subject}
 */
export async function getWeeklySeriesList() {
  const data = Capacitor.isNativePlatform()
    ? await weeklyGet('/x/web-interface/popular/series/list')
    : await apiGet('/x/web-interface/popular/series/list', {}, { headers: WEEKLY_HEADERS })
  return ((data && data.list) || []).map((s) => ({
    number: s.number,
    name: s.name || `第 ${s.number} 期`,
    subject: s.subject || ''
  }))
}

/**
 * 每周必看：单期视频
 * @param {number} number 期数
 */
export async function getWeeklyOne(number) {
  const data = Capacitor.isNativePlatform()
    ? await weeklyGet(`/x/web-interface/popular/series/one?number=${number}`)
    : await apiGet('/x/web-interface/popular/series/one', { number }, { headers: WEEKLY_HEADERS })
  return (data.list || []).map(toCard).filter(Boolean)
}

/**
 * 个性化推荐流（wbi 签名；匿名可用，登录后更精准）
 * @param {string} continueKey 上一页返回的分页游标（首页传空）
 * @returns {Promise<{list:Array, continueKey:string}>} continueKey 为空表示没有更多
 */
export async function getFeedRcmd(continueKey = '') {
  const params = { ps: 24 }
  if (continueKey) params.continue_key = continueKey
  const qs = await signedQuery(params)
  const data = await apiGet('/x/web-interface/wbi/index/top/feed/rcmd', qs)
  return {
    list: (data.item || []).map(toCard).filter(Boolean),
    continueKey: (data.refresh_body && data.refresh_body.continue_key) || ''
  }
}

/**
 * 我的关注 UP 主列表（需登录 + buvid 指纹，否则 -352/-101）
 * @param {number} pn 页码
 * @param {number} ps 每页条数
 */
export async function getFollowings(pn = 1, ps = 30) {
  // 实测（2026-09-27）：参数名为 vmid——传 mid 一律 -400 请求错误（与 wbi 签名无关，
  // 带正确签名仍 -400）；vmid 形态无签名直接成功，故不引入 signedQuery
  const data = await apiGet('/x/relation/followings', { vmid: auth.mid, pn, ps })
  return {
    total: (data && data.total) || 0,
    list: ((data && data.list) || []).map((u) => ({
      mid: u.mid,
      name: u.uname || '',
      face: httpsPic(u.face, FACE_THUMB),
      sign: u.sign || ''
    }))
  }
}

/**
 * 聚合搜索（需 wbi 签名），取其中的视频结果
 * @param {string} keyword
 * @param {number} page 页码（1 起，P9.0 D23 搜索懒加载用；每页约 20 条）
 */
export async function searchAll(keyword, page = 1) {
  const qs = await signedQuery({ keyword, page })
  const data = await apiGet('/x/web-interface/wbi/search/all/v2', qs)
  const groups = data.result || []
  const videoGroup = groups.find((g) => g.result_type === 'video')
  const items = (videoGroup && videoGroup.data ? videoGroup.data : []).map((raw) =>
    toCard({ ...raw, title: stripEm(raw.title) })
  ).filter(Boolean)
  // numResults：全部视频结果数（判定是否还有下一页）
  return {
    list: items,
    total: (videoGroup && videoGroup.numResults) || items.length,
    hasMore: page * 20 < ((videoGroup && videoGroup.numResults) || 0)
  }
}

/**
 * UP 主投稿列表（P9.36 D52，未登录可用）：wbi 签名 space arc search
 * @param {number} mid UP 主 uid
 * @param {number} page 页码（每页 30）
 */
function lengthToSec(len) {
  if (!len) return 0
  const parts = String(len).split(':').map((x) => parseInt(x) || 0)
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
}

export async function getUpArchives(mid, page = 1) {
  const qs = await signedQuery({ mid, pn: page, ps: 30, order: 'pubdate' })
  // P9.36 D52 补：设备上走 CapacitorHttp 直调 + space 页请求头（同排行榜风控对策）
  const headers = {
    Referer: `https://space.bilibili.com/${mid}/video`,
    'User-Agent': DESKTOP_UA
  }
  const data = Capacitor.isNativePlatform()
    ? await nativeGet(`/x/space/wbi/arc/search?${qs}`, headers)
    : await apiGet('/x/space/wbi/arc/search', qs, { headers })
  const vlist = (data.list && data.list.vlist) || []
  const list = vlist
    .map((v) =>
      toCard({
        bvid: v.bvid,
        title: v.title,
        pic: v.pic,
        owner: { name: v.author, mid: v.mid },
        duration: lengthToSec(v.length),
        stat: { view: v.play, danmaku: v.video_review },
        pubdate: v.created
      })
    )
    .filter(Boolean)
  return { list, hasMore: list.length >= 30 }
}

/**
 * 视频详情：cid、分 P、UP 主、统计
 * @param {string} bvid
 */
export async function getView(bvid) {
  const data = await apiGet('/x/web-interface/view', { bvid })
  const pages = (data.pages || []).map((p) => ({
    cid: p.cid,
    page: p.page,
    part: p.part || `P${p.page}`
  }))
  // 合集解析（P9.24 D41）：web 端选集对合集视频显示全部分集（ugc_season），
  // 单视频分 P 通常只有 1 个——合集存在时选集面板切换为合集分集模式
  let season = null
  if (data.ugc_season && Array.isArray(data.ugc_season.sections)) {
    const eps = data.ugc_season.sections.flatMap((s) => s.episodes || [])
    if (eps.length > 1) {
      season = {
        id: data.ugc_season.id,
        title: data.ugc_season.title || '合集',
        eps: eps.map((e, i) => ({
          bvid: e.bvid,
          cid: e.cid,
          title: e.title || `第 ${i + 1} 个`
        }))
      }
    }
  }
  return {
    bvid: data.bvid,
    aid: data.aid,
    title: data.title,
    desc: data.desc,
    pic: httpsPic(data.pic, PIC_THUMB),
    owner: data.owner || { name: '' },
    stat: data.stat || {},
    duration: data.duration,
    /** 当前 cid：默认 P1 */
    cid: (pages[0] && pages[0].cid) || data.cid,
    pages,
    season,
    /** 是否多 P（决定选集入口是否展示） */
    isMultiPart: pages.length > 1
  }
}

/**
 * 相关推荐（播放页右侧列表）
 * @param {string} bvid
 */
export async function getRelated(bvid) {
  // 实测（P9.23）：该接口 data 直接是数组（无 list 包裹），40 条相关视频
  const data = await apiGet('/x/web-interface/archive/related', { bvid })
  const list = Array.isArray(data) ? data : (data && data.list) || []
  return list.map(toCard).filter(Boolean)
}

/**
 * 播放地址（MP4 durl；匿名 720p 上限，登录后 qn=80 解锁 1080P，见 docs/03 D4）
 * P9.8 D30：durl 实给上限 720P（80/112 请求实给 64）；登录态 accept 实测 [112,80,64,16]
 * @param {string} bvid
 * @param {number} cid
 * @param {number} qn 期望清晰度
 * @returns {Promise<{url:string, length:number, size:number, quality:number, qualityLabel:string, qualities:Array<{id,label}>}>}
 */
export async function getPlayUrl(bvid, cid, qn = 0) {
  const data = await apiGet('/x/player/playurl', {
    bvid,
    cid,
    qn: qn || (auth.loggedIn ? 80 : 64),
    platform: 'html5',
    high_quality: 1
  })
  const durl = data.durl || []
  const first = durl[0] || {}
  const quality = data.quality || 0
  // durl 可实给档位：accept_quality 过滤 ≤720P（B 站 mp4 上限），映射 label
  const aq = data.accept_quality || []
  const ad = data.accept_description || []
  const labels = {}
  aq.forEach((q, i) => (labels[q] = ad[i] || QN_LABEL[q] || String(q)))
  const qualities = aq
    .filter((q) => q <= 64)
    .sort((a, b) => b - a)
    .map((q) => ({ id: q, label: labels[q] }))
  return {
    url: first.url || '',
    /** 片长（毫秒） */
    length: first.length || 0,
    size: first.size || 0,
    quality,
    qualityLabel: labels[quality] || QN_LABEL[quality] || '',
    qualities
  }
}

/* ---------------- DASH（P8 D18，见 docs/03 第 10 节） ---------------- */

/** 解析 "0-914" 形态的字节区间串 */
function parseByteRange(str) {
  const m = String(str || '').match(/^(\d+)-(\d+)$/)
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null
}

/** 取 baseUrl 驼峰/下划线双形态字段值 */
const pickUrl = (o) => o.baseUrl || o.base_url || ''
const pickBackups = (o) => o.backupUrl || o.backup_url || []

/**
 * 编码族匹配（D36）：HEVC 有 hev1/hvc1 双前缀（服务端两种都发过）
 */
function codecFamily(codecs) {
  const fam = String(codecs || '').split('.')[0]
  if (fam === 'hev1' || fam === 'hvc1') return 'hev1'
  return fam || 'avc1'
}

/** 编码选项（对齐 web 清晰度面板：默认/AV1/HEVC/H.264） */
export const CODEC_OPTIONS = [
  { key: 'default', label: '跟随默认' },
  { key: 'avc1', label: 'H.264 (AVC)' },
  { key: 'hev1', label: 'H.265 (HEVC)' },
  { key: 'av01', label: 'AV1' }
]

/**
 * 按偏好筛选视频流变体（D36 实测：服务端全变体下发，客户端筛选）
 * 回退链：请求族 → avc1 → 任意可用（AV1 多数视频无转码，必须可回退）
 */
function pickCodecVariant(items, prefer) {
  if (!items.length) return null
  const byFamily = items.map((v) => ({ raw: v, fam: codecFamily(v.codecs) }))
  const hit =
    (prefer && prefer !== 'default' && byFamily.find((x) => x.fam === prefer)) ||
    byFamily.find((x) => x.fam === 'avc1') ||
    byFamily[0]
  return hit.raw
}

/**
 * DASH 播放数据（wbi 签名 + fnval=16 纯 DASH，见 docs/03 D18 探针结论）：
 *  - 编码筛选按 codec 偏好（D36）；未登录调用方应继续用 getPlayUrl
 * @param {string} bvid
 * @param {number} cid
 * @param {number} qn 期望清晰度（B 站按账号权益下发，实际档位以返回 dash.video 为准）
 * @param {string} codec 编码偏好：default(avc1 优先)/avc1/hev1/av01
 */
export async function getDashPlayUrl(bvid, cid, qn = 80, codec = 'default') {
  const qs = await signedQuery({ bvid, cid, qn, fnval: 16, fnver: 0, fourk: 0 })
  const data = await apiGet('/x/player/wbi/playurl', qs)
  const dash = data.dash
  if (!dash || !Array.isArray(dash.video) || !dash.video.length) {
    throw new ApiError(-1, '未返回 DASH 流')
  }

  /** 组装单条流的拉取描述（主源 + 备源列表 + init/sidx 区间） */
  const toStream = (raw) => {
    const sb = raw.SegmentBase || raw.segment_base || {}
    const init = parseByteRange(sb.Initialization || sb.initialization) || { start: 0, end: 0 }
    const idx = parseByteRange(sb.indexRange || sb.IndexRange) || null
    return {
      urls: [pickUrl(raw), ...pickBackups(raw)].filter(Boolean),
      codecs: raw.codecs || '',
      mimeType: raw.mimeType || raw.mime_type || 'video/mp4',
      bandwidth: raw.bandwidth || 0,
      seg: { init, idx }
    }
  }

  // 视频档位：同清晰度多编码变体按偏好取一条；按清晰度 id 降序（id 越大越清晰）
  const families = [...new Set(dash.video.map((v) => codecFamily(v.codecs)))]
  const byQn = new Map()
  dash.video.forEach((v) => {
    const arr = byQn.get(v.id) || []
    arr.push(v)
    byQn.set(v.id, arr)
  })
  const videos = [...byQn.keys()]
    .sort((a, b) => b - a)
    .map((id) => pickCodecVariant(byQn.get(id), codec))
    .filter(Boolean)
  if (!videos.length) throw new ApiError(-1, 'DASH 流无可用编码档位')

  // 音频：取码率最高的一条（30280=320K 通常最后但带宽最大，按 bandwidth 取避免依赖顺序）
  const audios = (dash.audio || []).slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
  if (!audios.length) throw new ApiError(-1, 'DASH 流无音频轨')

  const vLabels = {}
  const aq = data.accept_quality || []
  const ad = data.accept_description || []
  aq.forEach((q, i) => (vLabels[q] = ad[i] || QN_LABEL[q] || String(q)))

  return {
    quality: data.quality || videos[0].id,
    qualityLabel: vLabels[data.quality] || QN_LABEL[data.quality] || '',
    /** 可切档位（accept_quality ∩ 实发档位），id 降序 */
    qualities: videos.map((v) => ({ id: v.id, label: vLabels[v.id] || QN_LABEL[v.id] || String(v.id) })),
    /** 全档位流字典：清晰度切换免二次请求（同次 playurl 已带全部可看档） */
    videoStreams: videos.reduce((m, v) => ((m[v.id] = toStream(v)), m), {}),
    audio: toStream(audios[0]),
    duration: dash.duration || 0,
    /** 当前编码族 + 服务端实际下发的编码族列表（播放页编码面板用） */
    codec: codecFamily(videos[0].codecs),
    codecFamilies: families
  }
}

/**
 * 拉取弹幕池并解码（XML 文本）
 *
 * 端点实测（P0 冒烟）：
 *  - api.bilibili.com/x/v1/dm/list.so 已失效（HTTP 400）
 *  - comment.bilibili.com/{cid}.xml 可用，响应头 Content-Encoding: deflate
 *
 * 不同传输层对 deflate 的处理不一致（浏览器自动解压 / CapacitorHttp 可能不解压），
 * 这里做三级自适应：明文魔数 → zlib inflate → raw inflate。
 * @param {number} cid
 * @returns {Promise<string>} XML 文本
 */
export async function getDanmakuXml(cid) {
  const url = `${DM_BASE}/${cid}.xml`
  const dbg = (window.__dmDebug = window.__dmDebug || [])
  dbg.push(`start cid=${cid} url=${url}`)
  let bytes
  try {
    if (Capacitor.isNativePlatform()) {
      // 原生：fetch shim 会把 deflate 二进制按文本解码（bytes 损坏、解压必败），
      // 必须走 CapacitorHttp arraybuffer（base64 透传）
      const res = await CapacitorHttp.get({
        url,
        responseType: 'arraybuffer',
        headers: { Accept: '*/*' },
        connectTimeout: 10000,
        readTimeout: 10000
      })
      const b64 = String(res.data || '')
      const bin = atob(b64)
      bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      dbg.push(`native b64=${b64.length} bytes=${bytes.length} head=${Array.from(bytes.slice(0, 3)).join(',')}`)
    } else {
      const res = await fetch(url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      })
      if (!res.ok) throw new ApiError(-1, `弹幕拉取失败 HTTP ${res.status}`)
      bytes = new Uint8Array(await res.arrayBuffer())
      dbg.push(`web bytes=${bytes.length}`)
    }
  } catch (err) {
    dbg.push(`fetch-err ${err && err.message}`)
    throw err
  }

  // 已是明文（浏览器/undici 自动解压过）
  if (bytes[0] === 0x3c) {
    const xml = new TextDecoder('utf-8').decode(bytes)
    dbg.push(`plain xml=${xml.length}`)
    return xml
  }
  // pako 只产出字节，UTF-8 解码统一交给 TextDecoder
  //（pako to:'string' 的逐字节映射会把中文变乱码，正则/DOMParser 全部失配）
  try {
    const xml = new TextDecoder('utf-8').decode(inflate(bytes))
    dbg.push(`zlib xml=${xml.length} head=${xml.slice(0, 60)}`)
    return xml
  } catch (_) {
    const xml = new TextDecoder('utf-8').decode(inflateRaw(bytes))
    dbg.push(`raw xml=${xml.length} head=${xml.slice(0, 60)}`)
    return xml
  }
}
