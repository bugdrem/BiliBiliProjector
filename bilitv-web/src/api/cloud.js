/**
 * 云端能力：收藏夹 / 观看历史（需登录，见 docs/03-登录与云端功能设计.md D5/D6）
 *
 * 全部经 apiGet/apiPost（手工 Cookie 头带 SESSDATA，写接口带 csrf）。
 * 数据整形为视图层 Card / 行结构，与 bilibili.js 的 toCard 风格一致。
 */

import { apiGet, apiPost } from './http.js'
import { auth } from '../stores/auth.js'

/**
 * http→https + hdslb 缩略参数（P9.5 性能：与 bilibili.js 同策略，
 * 弱设备上封面原图是最大卡顿源）
 */
const httpsPic = (url, thumb = '') => {
  const u = String(url || '').replace(/^http:\/\//, 'https://')
  if (!u || !thumb || !/hdslb\.com/.test(u)) return u
  return u + thumb
}

const PIC_THUMB = '@480w_270h_1c.webp'

/* ---------------- 云收藏 ---------------- */

/** 收藏夹条目 → 视图结构 */
function mediaToCard(raw) {
  if (!raw || !raw.bvid) return null
  return {
    bvid: raw.bvid,
    aid: raw.id,
    title: raw.title || '',
    pic: httpsPic(raw.cover, PIC_THUMB),
    duration: raw.duration,
    owner: { name: (raw.upper && raw.upper.name) || '' },
    stat: {
      view: (raw.cnt_info && raw.cnt_info.play) || 0,
      danmaku: (raw.cnt_info && raw.cnt_info.danmaku) || 0
    },
    /** 收藏时间（秒级时间戳） */
    favAt: (raw.fav_time || 0) * 1000
  }
}

/* ---------------- 关注动态流（P9.12 D35，对齐 web t.bilibili.com/?tab=video） ---------------- */

/**
 * 动态条目 → 视频卡片（同 toCard 结构；duration 用 duration_text 字符串，fmtDur 兼容）
 */
function dynToCard(item) {
  if (!item || item.type !== 'AV') return null
  const md = item.modules || {}
  const arch = md.module_dynamic && md.module_dynamic.major && md.module_dynamic.major.archive
  if (!arch || !arch.bvid) return null
  const au = md.module_author || {}
  return {
    bvid: arch.bvid,
    aid: Number(arch.aid) || 0,
    title: arch.title || '',
    pic: httpsPic(arch.pic, PIC_THUMB),
    duration: arch.duration_text || '',
    owner: { name: au.name || '' },
    stat: {
      view: (arch.stat && arch.stat.view) || 0,
      danmaku: (arch.stat && arch.stat.danmaku) || 0
    },
    pubdate: au.pub_ts || 0
  }
}

/**
 * 关注动态视频流（1 个请求替代逐 UP searchAll，真实时间序，覆盖全部关注 UP）
 * 登录态必需；无 wbi 要求；分页用响应中的 offset 透传
 * @param {number} hostMid 0=全部关注；>0=指定 UP 的动态
 * @param {string} offset 分页游标（首页传空）
 */
export async function getFollowDynFeed(hostMid = 0, offset = '') {
  const params = { type: 'video' }
  if (hostMid) params.host_mid = hostMid
  if (offset) params.offset = offset
  const d = await apiGet('/x/polymer/web-dynamic/v1/feed', params)
  const items = (d && d.items) || []
  return {
    list: items.map(dynToCard).filter(Boolean),
    hasMore: !!(d && d.has_more),
    offset: (d && d.offset) || ''
  }
}

/** 默认收藏夹 id 惰性缓存（模块级，收藏操作高频使用） */
let cachedFolderId = 0

/**
 * 拉取用户创建的收藏夹列表（首个为默认收藏夹）
 * @returns {Promise<Array<{id:number, title:string, count:number}>>}
 */
export async function getFavFolders() {
  const d = await apiGet('/x/v3/fav/folder/created/list-all', { up_mid: auth.mid, type: 2 })
  const list = (d && (d.list || d)) || []
  const folders = list
    .filter((f) => f && f.id)
    .map((f) => ({ id: f.id, title: f.title || '', count: f.media_count || 0 }))
  if (folders.length && !cachedFolderId) cachedFolderId = folders[0].id
  return folders
}

/**
 * 收藏夹内容（分页）
 * @param {number} mediaId 收藏夹 id
 * @param {number} pn 页码（从 1 起）
 */
export async function getFavMedia(mediaId, pn = 1, ps = 20) {
  const d = await apiGet('/x/v3/fav/resource/list', {
    media_id: mediaId,
    pn,
    ps,
    keyword: '',
    order: 'mtime',
    type: 0,
    tid: 0,
    platform: 'web'
  })
  return {
    total: (d && d.info && d.info.media_count) || 0,
    list: ((d && d.medias) || []).map(mediaToCard).filter(Boolean)
  }
}

/** 查询稿件是否已收藏（云端） */
export async function hasFav(aid) {
  const d = await apiGet('/x/web-interface/archive/has/fav', { aid })
  return !!(d && d.favoured)
}

/** 默认收藏夹 id（无则拉一次列表；仍无抛错由调用方提示） */
export async function getDefaultFolderId() {
  if (cachedFolderId) return cachedFolderId
  const folders = await getFavFolders()
  if (!folders.length) throw new Error('未找到可用收藏夹')
  return folders[0].id
}

/**
 * 收藏 / 取消收藏（云端 deal 接口）
 * @param {number} aid 稿件 av 号
 * @param {number|null} addId 收藏目标夹 id（null = 不加）
 * @param {number|null} delId 取消来源夹 id（null = 不删）
 * @returns {Promise<{prompt?:string}>}
 */
export async function favDeal(aid, addId, delId) {
  return apiPost('/x/v3/fav/resource/deal', {
    rid: aid,
    type: 2,
    add_media_ids: addId || '',
    del_media_ids: delId || '',
    csrf: auth.biliJct
  })
}

/* ---------------- 云历史 ---------------- */

/** 历史条目 → 行结构 */
function histToRow(raw) {
  if (!raw || !raw.history || raw.history.business !== 'archive') return null
  return {
    bvid: raw.bvid || '',
    aid: raw.history.oid,
    cid: raw.history.cid,
    title: raw.long_title || raw.title || '',
    pic: httpsPic(raw.cover, PIC_THUMB),
    duration: raw.duration || 0,
    /** 已看秒数（-1 表示看完） */
    progress: raw.progress || 0,
    /** 观看到的分 P 页码（多 P 续播定位） */
    page: raw.pages || 1,
    viewAt: (raw.view_at || 0) * 1000,
    owner: { name: raw.author_name || '' }
  }
}

/**
 * 云端历史（cursor 增量分页）
 * @param {{view_at:number, max:number, business:string}|null} cursor 上一页返回的游标（null = 首页）
 * @returns {Promise<{list:Array, cursor:object|null, hasMore:boolean}>}
 */
export async function getCloudHistory(cursor) {
  const params = { ps: 20, type: 'archive', business: '' }
  if (cursor) params.cursor = JSON.stringify(cursor)
  const d = await apiGet('/x/web-interface/history/cursor', params)
  const list = ((d && d.list) || []).map(histToRow).filter(Boolean)
  return {
    list,
    cursor: (d && d.cursor) || null,
    hasMore: !!(d && d.has_more)
  }
}

/**
 * 观历史上报（播放进度；静默失败由调用方 catch）
 * 实测（2026-09-27）：web-interface 路径已 404 下线（返回 HTML 404 页），
 * 双端上报端点为 /x/v2/history/report（bilibili-API-collect 视频观看数据上报文档）。
 * @param {number} aid 稿件 av 号
 * @param {number} cid 分 P cid
 * @param {number} progress 已播放秒数
 */
export function reportHistory(aid, cid, progress) {
  return apiPost('/x/v2/history/report', {
    aid,
    cid,
    progress: Math.max(0, Math.floor(progress)),
    type: 3,
    platform: 'android',
    csrf: auth.biliJct
  })
}

/* ---------------- 心跳上报（P8 D20） ---------------- */

/**
 * 播放心跳（15s 一次，观看时长真实化；替代「仅退出时单次 report」的粗粒度）
 * play_type：0 暂停 / 1 播放中 / 2 结束（见 docs/03 D20）
 * @param {number} aid 稿件 av 号
 * @param {number} cid 分 P cid
 * @param {number} playedTime 已播放秒数
 * @param {number} interval 本次心跳覆盖的秒数（etime）
 * @param {number} startedAt 播放开始的秒级时间戳（首次传 0 由服务端记）
 * @param {number} playType 0 暂停 / 1 播放中 / 2 结束
 */
export function heartBeat(aid, cid, playedTime, interval, startedAt, playType) {
  return apiPost('/x/click-interface/web/heartbeat', {
    aid,
    cid,
    type: 3,
    sub_type: 1,
    dt: 2,
    play_type: playType,
    etime: Math.max(1, Math.floor(interval)),
    played_time: Math.max(0, Math.floor(playedTime)),
    started_at: startedAt ? Math.floor(startedAt) : 0,
    realtime: 0,
    csrf: auth.biliJct
  })
}

/**
 * 凭据有效期检测（P8 D22 降级方案：不做完整 refresh，仅检测并提示重扫）
 * @returns {Promise<{needRefresh:boolean}>}
 */
export async function checkCookieRefresh() {
  const d = await apiGet('/x/passport-login/web/cookie/info', {})
  return { needRefresh: !!(d && d.need_refresh) }
}
