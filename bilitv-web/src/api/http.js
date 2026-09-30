import { Capacitor, CapacitorHttp } from '@capacitor/core'

/**
 * 统一 HTTP 请求封装
 *
 * 双环境传输策略（核心，见 docs/01-开发文档.md 第二、四章）：
 *  - 开发期：API_BASE = '/bapi'，由 Vite dev server 代理转发到 api.bilibili.com，
 *    Node 侧转发不携带浏览器 Origin 头 → 绕开 B 站 WAF 的 Origin 白名单。
 *  - APK 生产：API_BASE = 'https://api.bilibili.com'。
 *
 * P9.43 风控加固（"全局走 bilibili web 端形态"）：
 *  设备侧 fetch 已被 CapacitorHttp patch 接管，但 shim 构造 Request 时 Referer/UA
 *  属 forbidden headers，会被引擎静默剥离 → 请求失去 web 端特征，成为风控面上的"异常
 *  客户端"（P0 实测：-352 / -412 均由此而来）。因此**所有** API 请求在原生环境下统一
 *  走 CapacitorHttp 直调（headers 全透传），并按接口注入对应 web 页面 Referer + 桌面 UA，
 *  尽量贴近真实浏览器访问画像；web/开发期仍走 Vite 代理（服务端同样可带 Referer）。
 *
 * 通用约定：
 *  - 业务码 code!==0 抛 ApiError；-412 / -352 识别为风控拦截（文案特殊化）
 *  - 网络/5xx 错误自动重试 1 次；业务错误不重试
 *  - 同 host 请求间隔 ≥ 300ms（串行队列），降低触发风控的概率；
 *    原生直调同样纳入该限频闸门（此前 nativeGet 绕过限频，是风控隐患）
 */

/** API 基地址：开发走代理，生产直连（CapacitorHttp 原生执行） */
export const API_BASE =
  typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV
    ? '/bapi'
    : 'https://api.bilibili.com'

/** B 站业务错误：携带 code 便于上层识别风控码 */
export class ApiError extends Error {
  /**
   * @param {number} code 业务错误码
   * @param {string} message 展示文案
   */
  constructor(code, message) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/** 风控拦截码：-412 请求被拦截 / -352 风控校验失败 */
const RISK_CODES = new Set([-412, -352])

/* ---------------- web 端请求画像（P9.43） ----------------
 * 设备侧的原生请求必须"长得像浏览器"，否则 B 站按未知客户端处理风控。
 * UA 固定为桌面 Chrome（与 ranking/weekly 已验证通过的那支一致）。
 */
export const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * 接口 → 对应 web 页面 Referer：B 站部分端点会校验 Referer 站点
 * （ranking 无 Referer 直接 -352，P0 实测）。按最长前缀匹配，未命中给首页兜底。
 */
const REFERER_RULES = [
  // P9.45：动态流属于「动态站」域（t.bilibili.com），Referer 落在 www 会被 WAF 拒
  // （表现为登录态下首页-关注一直「网络异常」，其余走 www 域的接口全部正常）
  [/^\/x\/polymer\//, 'https://t.bilibili.com/'],
  [/^\/x\/web-interface\/ranking/, 'https://www.bilibili.com/v/popular/rank/all/'],
  [/^\/x\/web-interface\/popular\/series/, 'https://www.bilibili.com/v/popular/weekly'],
  [/^\/x\/web-interface\/popular\/precious/, 'https://www.bilibili.com/v/popular/history'],
  [/^\/x\/web-interface\/wbi\/search|^\/x\/web-interface\/search/, 'https://search.bilibili.com/'],
  [/^\/x\/space\//, 'https://space.bilibili.com/'],
  [/^\/x\/web-interface\/view|^\/x\/player\//, 'https://www.bilibili.com/video/'],
  [/^\/x\/v1\/dm\/|^\/x\/v2\/dm\//, 'https://www.bilibili.com/video/'],
  [/^\/x\/web-interface\/archive\/related/, 'https://www.bilibili.com/video/'],
  [/^\/x\/click-interface\//, 'https://www.bilibili.com/video/'],
  [/^\/x\/relation\/|^\/x\/v2\/fav\//, 'https://space.bilibili.com/']
]

/** 取接口对应的 web 页面 Referer（未命中回落到 bilibili 首页） */
export function refererFor(path = '') {
  for (const [re, ref] of REFERER_RULES) {
    if (re.test(path)) return ref
  }
  return 'https://www.bilibili.com/'
}

/**
 * 组装 web 端标准请求头（UA + Referer + Accept + Cookie）
 * @param {string} path 接口路径（用于推导 Referer）
 * @param {Record<string,string>} extra 覆盖项（显式传的优先）
 */
export function webHeaders(path = '', extra = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: refererFor(path),
    'User-Agent': WEB_UA,
    ...extra
  }
  const cookie = cookieHeader()
  if (cookie) headers.Cookie = cookie
  return headers
}

/**
 * 单次传输：原生环境走 CapacitorHttp 直调（headers 全透传），否则 fetch（dev 代理）
 * 注：不同传输各自的异常都收敛为 Error，由上层统一重试/翻译
 * @returns {Promise<{status:number, data:any}>}
 */
async function transmit(url, method, headers, body, timeout, responseType = 'json') {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.request({
      url,
      method,
      headers,
      ...(body ? { data: body } : {}),
      responseType,
      connectTimeout: 10000,
      // P9.45：readTimeout 下限 20s——动态 feed 等接口响应体可达数 MB，Z7X 一般网络
      // 10s 读不完会被 OkHttp 掐断，表现同样是"网络异常"
      readTimeout: Math.max(20000, timeout)
    })
    const status = res.status || 0
    if (status >= 500) throw new Error(`HTTP ${status}`)
    if (status >= 400) throw new Error(`HTTP ${status}`)
    // P9.45：WAF 拦截返回的是 HTML 风控页而非 JSON，CapacitorHttp 在 responseType=json
    // 下会解析失败并只抛一个泛化错误，前端只能显示"网络异常"。
    // 这里显式给出状态码与响应片段，便于定位（此前关注动态流就栽在这里）。
    if (responseType === 'json' && res.data == null) {
      throw new Error(`HTTP ${status} 响应非 JSON`)
    }
    return { status, data: res.data }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, {
      method,
      headers,
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      ...(body ? { body } : {})
    })
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`)
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`) // 与原生分支对称：WAF 拦截页不是 JSON
    return { status: res.status, data: responseType === 'text' ? await res.text() : await res.json() }
  } finally {
    clearTimeout(timer)
  }
}

/** 统一的业务码翻译（命中风控码时文案特殊化） */
function assertOk(json) {
  if (!json || json.code !== 0) {
    const code = json ? json.code : -1
    if (RISK_CODES.has(code)) throw new ApiError(code, '请求被风控拦截，请稍后再试')
    throw new ApiError(code, (json && json.message) || '接口返回异常')
  }
  return json.data
}

/** 上一次请求完成时间戳（毫秒），用于最小间隔限频 */
let lastRequestAt = 0
/** 请求最小间隔 */
const MIN_INTERVAL = 300

/* ---------------- 会话引导（buvid3/buvid4） ----------------
 * ranking 等接口对无 Cookie 的陌生请求返回 -352 风控（P0 冒烟实测）。
 * 通过 /x/frontend/finger/spi 获取设备指纹 buvid3/buvid4，
 * 后续请求附加 Cookie 头：
 *  - APK（CapacitorHttp 原生）：Cookie 头原生生效
 *  - 浏览器 fetch：Cookie 为禁止头被静默忽略（无副作用），
 *    开发期由 Vite 代理在服务端注入（见 vite.config.js）
 */
const session = { buvid3: '', buvid4: '', ready: false, inflight: null }

const sessionLs =
  typeof localStorage !== 'undefined'
    ? localStorage
    : { getItem: () => null, setItem: () => {} }

const SESSION_KEY = 'bilitv.session'

/** 从缓存读会话 */
try {
  const saved = JSON.parse(sessionLs.getItem(SESSION_KEY) || 'null')
  if (saved && saved.buvid3) {
    session.buvid3 = saved.buvid3
    session.buvid4 = saved.buvid4 || ''
    session.ready = true
  }
} catch (_) {
  /* 忽略缓存损坏 */
}

/** 获取设备指纹（幂等，并发只发一次） */
export function ensureSession() {
  if (session.ready) return Promise.resolve(session)
  if (session.inflight) return session.inflight
  session.inflight = rawGet('/x/frontend/finger/spi')
    .then((body) => {
      const d = body && body.data
      if (d && d.b_3) {
        session.buvid3 = d.b_3
        session.buvid4 = d.b_4 || ''
        session.ready = true
        try {
          sessionLs.setItem(SESSION_KEY, JSON.stringify({ buvid3: session.buvid3, buvid4: session.buvid4 }))
        } catch (_) { /* 忽略 */ }
      }
      return session
    })
    .catch(() => session)
    .finally(() => (session.inflight = null))
  return session.inflight
}

/* ---------------- 登录 Cookie（扫码登录写入，见 docs/03-登录与云端功能设计.md D2） ----------------
 * Capacitor 7 原生 HTTP 不做 WebView CookieManager 同步（源码结论），
 * 登录凭据由 JS 从 poll 响应头解析后存这里，随手工 Cookie 头下发。
 */
const LOGIN_KEY = 'bilitv.auth.cookies'
/** 允许下发的登录凭据键（白名单，防止注入任意 cookie） */
const LOGIN_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']
const loginCookies = {}

try {
  const saved = JSON.parse(sessionLs.getItem(LOGIN_KEY) || '{}')
  for (const k of LOGIN_KEYS) if (saved[k]) loginCookies[k] = saved[k]
} catch (_) {
  /* 忽略缓存损坏 */
}

/** 写入/更新登录凭据（passport poll 成功后调用），值为原始 cookie 值（不含属性） */
export function setLoginCookies(map) {
  for (const k of LOGIN_KEYS) {
    if (map[k]) loginCookies[k] = map[k]
  }
  try {
    sessionLs.setItem(LOGIN_KEY, JSON.stringify(loginCookies))
  } catch (_) { /* 忽略 */ }
}

/** 清空登录凭据（退出登录调用） */
export function clearLoginCookies() {
  for (const k of Object.keys(loginCookies)) delete loginCookies[k]
  try {
    sessionLs.removeItem(LOGIN_KEY)
  } catch (_) { /* 忽略 */ }
}

/** 是否已持有登录凭据 */
export function hasLoginCookies() {
  return !!loginCookies.SESSDATA
}

/** 组装 Cookie 头（buvid 会话 + 登录凭据；无任何 cookie 返回 null） */
function cookieHeader() {
  const parts = []
  if (session.ready) {
    parts.push(`buvid3=${session.buvid3}`)
    if (session.buvid4) parts.push(`buvid4=${session.buvid4}`)
  }
  for (const k of LOGIN_KEYS) {
    if (loginCookies[k]) parts.push(`${k}=${loginCookies[k]}`)
  }
  return parts.length ? parts.join('; ') : null
}

/**
 * 导出 Cookie 头（P9.2：每周必看接口需绕过 fetch shim 直调 CapacitorHttp——
 * shim 构造 Request 时 Referer/UA 属 forbidden headers 被引擎剥离）
 */
export function getCookieHeader() {
  return cookieHeader()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 限频闸门：保证相邻请求间隔 */
async function gate() {
  const wait = MIN_INTERVAL - (Date.now() - lastRequestAt)
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

/**
 * 把参数对象编码为 query 串（标准 URL 编码，参数顺序保持传入序）
 * @param {Record<string, string|number>} params
 * @returns {string}
 */
export function buildQuery(params) {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.append(k, String(v))
  }
  return sp.toString()
}

/**
 * GET 请求（JSON），带超时 / 重试 / 限频 / 业务码翻译
 * @param {string} path 接口路径，如 /x/web-interface/popular
 * @param {Record<string, any>|string} params 参数对象，或已签名的 query 串
 * @param {{wbi?: boolean, timeout?: number}} [opts] wbi=true 时由 wbi.js 预签名后传入字符串参数
 * @returns {Promise<any>} B 站响应中的 data 字段
 */
/**
 * 带限频 + 一次重试 + 业务码翻译的请求执行器
 * @param {() => Promise<{status:number, data:any}>} send 单次传输闭包
 */
async function requestWithRetry(send) {
  let lastErr
  // 最多两次尝试：首次失败（网络/5xx）后重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await gate()
      const { data } = await send()
      return assertOk(data)
    } catch (err) {
      // 业务错误（含风控）不重试，直接上抛
      if (err instanceof ApiError) throw err
      lastErr = err
      if (attempt === 1) break
      await sleep(600) // 退避后重试
    }
  }
  const reason =
    lastErr && lastErr.name === 'AbortError' ? '请求超时' : '网络异常，请检查设备联网'
  throw new ApiError(-1, reason)
}

export async function apiGet(path, params = {}, opts = {}) {
  const { timeout = 10000, headers: extraHeaders = {} } = opts
  const qs = typeof params === 'string' ? params : buildQuery(params)
  const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`

  // 请求前确保设备指纹就绪（风控接口需要 buvid3）
  await ensureSession()
  const headers = webHeaders(path, extraHeaders)
  return requestWithRetry(() => transmit(url, 'GET', headers, null, timeout, 'json'))
}

/**
 * 原生通道 GET（供对 Referer/UA 敏感、必须直调的接口使用，见 bilibili.js）。
 * 与 apiGet 的区别仅在于允许完整覆盖请求头；同样受限频、重试、风控翻译保护。
 * @param {string} pathWithQuery 带 query 的接口路径
 * @param {Record<string,string>} extraHeaders 覆盖项（通常含专属 Referer）
 */
export async function nativeGetJson(pathWithQuery, extraHeaders = {}) {
  const path = String(pathWithQuery).split('?')[0]
  await ensureSession()
  const headers = webHeaders(path, extraHeaders)
  const url = `${API_BASE}${pathWithQuery}`
  return requestWithRetry(() => transmit(url, 'GET', headers, null, 10000, 'json'))
}

/**
 * POST 请求（表单编码，写接口专用：收藏 deal / 历史上报 / 退出登录）
 * 错误处理与 apiGet 一致；调用方需在参数中带 csrf=bili_jct。
 * @param {string} path 接口路径
 * @param {Record<string, any>} params 表单参数
 * @returns {Promise<any>} B 站响应中的 data 字段
 */
export async function apiPost(path, params = {}) {
  const url = `${API_BASE}${path}`
  await ensureSession()
  const headers = webHeaders(path, {
    'Content-Type': 'application/x-www-form-urlencoded'
  })
  const body = buildQuery(params)
  return requestWithRetry(() => transmit(url, 'POST', headers, body, 10000, 'json'))
}

/**
 * 原始 GET（供 wbi.js 获取签名密钥用，避免循环依赖，不做 wbi / 限频）
 * @param {string} path
 * @param {Record<string, any>} params
 */
export async function rawGet(path, params = {}) {
  const qs = buildQuery(params)
  const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  return res.json()
}

/**
 * 通用文本 GET（弹幕 XML 用，响应非 JSON）
 * @param {string} pathWithQuery 完整路径与 query
 * @returns {Promise<string>}
 */
export async function getText(pathWithQuery) {
  await ensureSession()
  const headers = webHeaders(pathWithQuery, { Accept: '*/*' })
  await gate()
  const { data } = await transmit(`${API_BASE}${pathWithQuery}`, 'GET', headers, null, 10000, 'text')
  return data
}
