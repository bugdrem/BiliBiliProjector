/**
 * Wbi 签名模块
 *
 * B 站自 2023 年起对部分 Web 接口（如搜索 all/v2）要求 wbi 签名：
 * 请求需追加 wts（秒级时间戳）与 w_rid（md5 签名）两个参数。
 *
 * 签名流程（bilibili-API-collect 公开算法）：
 *  1. GET /x/web-interface/nav 取 wbi_img.img_url / sub_url，
 *     取 URL 文件名（去扩展名）得 img_key、sub_key（匿名可用，实测 code:-101 但字段照常返回）
 *  2. img_key + sub_key 拼接后按固定混淆表 mixinKeyEncTab 重排，取前 32 位得 mixin_key
 *  3. 参数追加 wts → 按 key 字典序排序 → value 过滤字符 !'()* → RFC3986 编码拼接
 *  4. w_rid = md5(排序后 query + mixin_key)
 *
 * 密钥缓存 24 小时（localStorage），减少 nav 请求次数。
 */
import md5 from 'js-md5'
import { rawGet } from './http.js'

/** 固定混淆表（64 元素），来自 bilibili-API-collect */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
]

/** localStorage 兜底（Node 冒烟环境下无 localStorage） */
const ls =
  typeof localStorage !== 'undefined'
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const CACHE_KEY = 'bilitv.wbi.mixin'
const CACHE_TTL = 24 * 3600 * 1000

/** 内存缓存，避免同进程重复解析 */
let memMixinKey = null

/** 从 URL 提取文件名（去扩展名）作为 key */
function keyFromUrl(url) {
  const file = String(url).split('/').pop() || ''
  return file.replace(/\.[a-zA-Z]+$/, '')
}

/**
 * 获取 mixin_key（带 24h 缓存）
 * @returns {Promise<string>}
 */
export async function getMixinKey() {
  if (memMixinKey) return memMixinKey

  try {
    const cached = JSON.parse(ls.getItem(CACHE_KEY) || 'null')
    if (cached && cached.key && Date.now() - cached.at < CACHE_TTL) {
      memMixinKey = cached.key
      return memMixinKey
    }
  } catch (_) {
    /* 缓存损坏则忽略 */
  }

  const body = await rawGet('/x/web-interface/nav')
  // 注意：rawGet 返回完整信封 {code, message, data}，wbi_img 位于 data 下
  const img = body && body.data && body.data.wbi_img
  if (!img || !img.img_url || !img.sub_url) {
    throw new Error('获取 wbi 密钥失败')
  }
  const raw = keyFromUrl(img.img_url) + keyFromUrl(img.sub_url)
  let mixin = ''
  for (const i of MIXIN_KEY_ENC_TAB) {
    if (raw[i]) mixin += raw[i]
  }
  mixin = mixin.slice(0, 32)

  memMixinKey = mixin
  ls.setItem(CACHE_KEY, JSON.stringify({ key: mixin, at: Date.now() }))
  return mixin
}

/**
 * 对参数做 wbi 签名，返回可直接拼接的 query 串（含 wts 与 w_rid）
 * @param {Record<string, string|number>} params 业务参数
 * @returns {Promise<string>} 已排序编码并签名的 query 字符串
 */
export async function signedQuery(params) {
  const mixinKey = await getMixinKey()
  const wts = Math.floor(Date.now() / 1000)
  const all = { ...params, wts }

  // 按 key 字典序排序；value 过滤 !'()*；RFC3986 风格编码
  const qs = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')

  const w_rid = md5(qs + mixinKey)
  return `${qs}&w_rid=${w_rid}`
}
