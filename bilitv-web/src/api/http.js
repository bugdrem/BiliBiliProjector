/**
 * 统一 HTTP 请求封装
 *
 * 双环境传输策略（核心，见 docs/01-开发文档.md 第二、四章）：
 *  - 开发期：API_BASE = '/bapi'，由 Vite dev server 代理转发到 api.bilibili.com，
 *    Node 侧转发不携带浏览器 Origin 头 → 绕开 B 站 WAF 的 Origin 白名单。
 *  - APK 生产：API_BASE = 'https://api.bilibili.com'，window.fetch 已被
 *    CapacitorHttp 接管为原生 HTTP（无 Origin、无 CORS 限制）。
 *
 * 通用约定：
 *  - 业务码 code!==0 抛 ApiError；-412 / -352 识别为风控拦截（文案特殊化）
 *  - 网络/5xx 错误自动重试 1 次；业务错误不重试
 *  - 同 host 请求间隔 ≥ 300ms（串行队列），降低触发风控的概率
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
export async function apiGet(path, params = {}, opts = {}) {
  const { timeout = 10000, headers: extraHeaders = {} } = opts
  const qs = typeof params === 'string' ? params : buildQuery(params)
  const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`

  // 请求前确保设备指纹就绪（风控接口需要 buvid3）
  await ensureSession()
  const headers = { Accept: 'application/json, text/plain, */*', ...extraHeaders }
  const cookie = cookieHeader()
  if (cookie) headers.Cookie = cookie // 浏览器环境自动忽略；原生/代理环境生效

  let lastErr
  // 最多两次尝试：首次失败（网络/5xx）后重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await gate()
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      let res
      try {
        res = await fetch(url, {
          signal: ctrl.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers
        })
      } finally {
        clearTimeout(timer)
      }

      if (res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()

      if (json.code !== 0) {
        if (RISK_CODES.has(json.code)) {
          throw new ApiError(json.code, '请求被风控拦截，请稍后再试')
        }
        throw new ApiError(json.code, json.message || '接口返回异常')
      }
      return json.data
    } catch (err) {
      // 业务错误（含风控）不重试，直接上抛
      if (err instanceof ApiError) throw err
      lastErr = err
      if (attempt === 1) break
      await sleep(600) // 退避后重试
    }
  }
const reason = lastErr && lastErr.name === 'AbortError' ? '请求超时' : '网络异常，请检查设备联网'
  throw new ApiError(-1, reason)
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
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded'
  }
  const cookie = cookieHeader()
  if (cookie) headers.Cookie = cookie

  const body = buildQuery(params)
  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await gate()
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10000)
      let res
      try {
        res = await fetch(url, { method: 'POST', body, headers, signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (json.code !== 0) {
        if (RISK_CODES.has(json.code)) {
          throw new ApiError(json.code, '请求被风控拦截，请稍后再试')
        }
        throw new ApiError(json.code, json.message || '接口返回异常')
      }
      return json.data
    } catch (err) {
      if (err instanceof ApiError) throw err
      lastErr = err
      if (attempt === 1) break
      await sleep(600)
    }
  }
  const reason = lastErr && lastErr.name === 'AbortError' ? '请求超时' : '网络异常，请检查设备联网'
  throw new ApiError(-1, reason)
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
  await gate()
  const res = await fetch(`${API_BASE}${pathWithQuery}`, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer'
  })
  if (!res.ok) throw new ApiError(-1, `HTTP ${res.status}`)
  return res.text()
}
