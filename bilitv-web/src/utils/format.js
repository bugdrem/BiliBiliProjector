/**
 * 格式化工具：播放量 / 时长 / 相对时间
 */

/** 数量格式化：12345 → 1.2万 */
export function fmtCount(n) {
  const num = Number(n) || 0
  if (num >= 100000000) return (num / 100000000).toFixed(1).replace(/\.0$/, '') + '亿'
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  return String(num)
}

/**
 * 时长格式化
 * @param {number|string} v 秒数或 "mm:ss" 字符串（search 接口）
 * @returns {string} "mm:ss" / "h:mm:ss"
 */
export function fmtDur(v) {
  if (typeof v === 'string' && v.includes(':')) return v
  let sec = Math.floor(Number(v) || 0)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  sec = sec % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 进度条用：秒 → "mm:ss / hh:mm:ss" 同款输出 */
export function fmtClock(sec) {
  return fmtDur(Math.floor(sec))
}

/** 相对时间：时间戳 → "3 天前" */
export function fmtAgo(ts) {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  const date = new Date(ts)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
