/**
 * 卡片本地缓存 + 增量合并（P9.0 D25，见 docs/03 第 11 节）
 *
 * 目标：二次进入模块零等待出内容（先渲染缓存，后台拉新数据增量合并），
 * 减少重复网络请求；分页游标随缓存保存，续拉不重头。
 *
 * 存储：localStorage `bilitv.cache.<module>`，结构：
 *   { list: Card[], cursor: string, page: number, savedAt: number }
 * TTL 7 天，超期整条丢弃重新拉取。
 */

/** 缓存有效期（7 天） */
const TTL = 7 * 24 * 3600 * 1000

/** 键版本前缀（P9.5：卡片 URL 加缩略参数后旧缓存图片是原图，换前缀自然失效重建） */
const KEY_PREFIX = 'bilitv.cache.v2.'

/** localStorage 兜底（Node 冒烟环境） */
const ls =
  typeof localStorage !== 'undefined'
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }

/**
 * 读取模块缓存（过期返回 null）
 * @param {string} module 模块键：hot / rcmd / rank / followAll / follow-<mid>
 * @returns {{list:Array, cursor:string, page:number, savedAt:number}|null}
 */
export function loadCache(module) {
  try {
    const raw = JSON.parse(ls.getItem(KEY_PREFIX + module) || 'null')
    if (!raw || !Array.isArray(raw.list)) return null
    if (Date.now() - (raw.savedAt || 0) > TTL) {
      ls.removeItem(KEY_PREFIX + module)
      return null
    }
    return raw
  } catch (_) {
    return null
  }
}

/**
 * 写入模块缓存（静默失败：localStorage 满不影响主流程）
 * @param {string} module 模块键
 * @param {{list:Array, cursor?:string, page?:number}} data
 */
export function saveCache(module, { list, cursor = '', page = 1 }) {
  try {
    ls.setItem(
      KEY_PREFIX + module,
      JSON.stringify({ list, cursor, page, savedAt: Date.now() })
    )
  } catch (_) {
    /* 存储满：缓存失败不影响功能 */
  }
}

/** 清除模块缓存（下拉强制刷新类操作可调） */
export function clearCache(module) {
  try {
    ls.removeItem(KEY_PREFIX + module)
  } catch (_) {
    /* 忽略 */
  }
}

/**
 * 增量合并：新数据在前、按 bvid 去重（老列表中与新增重复的条目丢弃，
 * 保留新数据的位置与字段新鲜度）
 * @param {Array} fresh 新拉取的列表
 * @param {Array} cached 缓存的旧列表
 * @returns {Array} 合并结果（去重后）
 */
export function mergeCards(fresh, cached) {
  const seen = new Set()
  const out = []
  for (const card of [...fresh, ...cached]) {
    if (!card || !card.bvid || seen.has(card.bvid)) continue
    seen.add(card.bvid)
    out.push(card)
  }
  return out
}
