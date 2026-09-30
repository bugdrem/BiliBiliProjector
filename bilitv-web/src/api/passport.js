/**
 * 登录通行证接口（Web 扫码登录，见 docs/03-登录与云端功能设计.md D1/D2/D3）
 *
 * 传输通道按环境分流：
 *  - APK 生产：直接调 CapacitorHttp 原生 GET（绕开 fetch shim 对 Headers 的 set-cookie
 *    访问限制，响应头以普通对象透传，才能解析登录 Set-Cookie）。
 *  - Web 开发：走 Vite 代理 /bpass → passport.bilibili.com（浏览器 fetch 无法读取
 *    set-cookie 头，登录闭环仅在 APK 上验证，dev 下仅能看到二维码与轮询状态）。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { ApiError, webHeaders, ensureSession } from './http.js'

const isDev =
  typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV

/** passport 基地址：dev 走代理，生产直连 */
const PASSPORT_BASE = isDev ? '/bpass' : 'https://passport.bilibili.com'

/**
 * 原生 GET（返回 json + 原始响应头，供 Set-Cookie 解析）
 * P9.43：带全局 web 端画像（桌面 UA + passport 登录页 Referer + buvid Cookie），
 * 与 passort 站点正常浏览器访问一致，降低扫码/轮询被判定异常的概率。
 */
async function nativeGet(pathWithQuery) {
  await ensureSession() // buvid 会话就绪后 Cookie 才会带上
  const res = await CapacitorHttp.get({
    url: `${PASSPORT_BASE}${pathWithQuery}`,
    headers: webHeaders(pathWithQuery, {
      Referer: 'https://passport.bilibili.com/login'
    }),
    connectTimeout: 10000,
    readTimeout: 10000
  })
  // CapacitorHttp 会按 content-type 自动解析 json；异常时兜底手动 parse
  let json = res.data
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json)
    } catch (_) {
      throw new ApiError(-1, `HTTP ${res.status} 响应解析失败`)
    }
  }
  return { json, headers: res.headers || {} }
}

/** 浏览器 GET（dev 通道） */
async function browserGet(pathWithQuery) {
  const res = await fetch(`${PASSPORT_BASE}${pathWithQuery}`, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer'
  })
  const json = await res.json()
  return { json, headers: {} }
}

const doGet = Capacitor.isNativePlatform() ? nativeGet : browserGet

/**
 * 生成登录二维码
 * @returns {Promise<{url:string, qrcodeKey:string}>} url 为二维码内容
 */
export async function qrGenerate() {
  const { json } = await doGet('/x/passport-login/web/qrcode/generate')
  if (json.code !== 0 || !json.data || !json.data.url) {
    throw new ApiError(json.code || -1, json.message || '二维码生成失败')
  }
  return { url: json.data.url, qrcodeKey: json.data.qrcode_key }
}

/**
 * 轮询扫码状态（不抛状态码错误：86101/86090/86038 是状态而非失败）
 *
 * B 站协议结构：外层 code 恒为 0，真实扫码状态码在 data.code
 * （86101 待扫 / 86090 已扫待确认 / 86038 过期 / 0 登录成功）。
 * Set-Cookie 仅在登录成功（data.code=0）时出现。
 * @param {string} qrcodeKey generate 返回的 key
 * @returns {Promise<{code:number, message:string, headers:Record<string,string>}>}
 */
export async function qrPoll(qrcodeKey) {
  const { json, headers } = await doGet(
    `/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`
  )
  const d = json && json.data
  // __qrDebug 探针：记录每次 poll 的原始响应（外层 code / data / 响应头键名），
  // 用于诊断「扫码确认后报凭据不完整」的协议差异（与弹幕 __dmDebug 同套路）
  try {
    if (!Array.isArray(window.__qrDebug)) window.__qrDebug = []
    window.__qrDebug.push({
      t: Date.now(),
      qrcodeKey,
      outerCode: json && json.code,
      outerMsg: json && json.message,
      dataType: d === null ? 'null' : typeof d,
      dataKeys: d && typeof d === 'object' ? Object.keys(d) : null,
      dataCode: d && typeof d === 'object' ? d.code : null,
      dataUrl: d && typeof d === 'object' ? String(d.url || '') : '',
      headerKeys: Object.keys(headers || {}),
      setCookie: (function () {
        const k = Object.keys(headers || {}).find((x) => x.toLowerCase() === 'set-cookie')
        return k ? String(headers[k]).slice(0, 800) : ''
      })()
    })
    if (window.__qrDebug.length > 30) window.__qrDebug.shift()
  } catch (_) {
    /* 探针失败不影响主流程 */
  }
  return {
    code: typeof (d && d.code) === 'number' ? d.code : (json && json.code) || 0,
    message: (d && d.message) || json.message || '',
    headers,
    /** 登录成功时的 crossDomain 跳转 URL（查询参数携带全部凭据） */
    url: (d && d.url) || ''
  }
}

/**
 * 从 crossDomain 跳转 URL 解析登录 Cookie。
 * 实测部分客户端（ATV UA）登录响应仅下发一条 Set-Cookie（SESSDATA），
 * 而 poll.data.url 的查询参数始终携带完整凭据（DedeUserID/SESSDATA/bili_jct/sid）。
 * 注意：值保持原始编码形态（SESSDATA 内 %2C 等），与浏览器存储的 cookie 形态一致，不做 decode。
 * @param {string} url poll 成功返回的 data.url
 * @returns {Record<string,string>} 白名单内的 cookie 键值
 */
export function parseLoginUrl(url) {
  const out = {}
  const whitelist = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']
  try {
    const query = String(url || '').split('?')[1] || ''
    for (const part of query.split('&')) {
      const eq = part.indexOf('=')
      if (eq < 1) continue
      const k = part.slice(0, eq)
      const v = part.slice(eq + 1)
      if (whitelist.includes(k) && v) out[k] = v
    }
  } catch (_) {
    /* 畸形 URL 忽略，返回已解析部分 */
  }
  return out
}

/**
 * 退出登录（服务端注销，best-effort）
 * @param {string} csrf bili_jct
 */
export async function passportExit(csrf) {
  const { json } = await nativeGet(`/x/passport-login/web/exit?csrf=${encodeURIComponent(csrf)}`)
  return json
}

/**
 * 从响应头解析登录 Cookie（CapacitorHttp 原生把多条 set-cookie 用 ", " 合并成一条）
 * 拆分锚点：逗号后（允许空白）紧跟「token=」才算新 cookie。
 * 实测（__qrDebug 探针 2026-09-27）：B 站下发的合并串形如
 *   "SESSDATA=...; ...; SameSite=None, bili_jct=...; ..., DedeUserID=..."
 * 即逗号与下一个 cookie 名之间有空格——旧正则 (?=[\w-]+\s*=) 因空格不匹配
 * 导致整串不切、只解析出第一段 SESSDATA（bili_jct 丢失 → 误报凭据不完整）。
 * Expires 日期内逗号（"Fri, 26 Mar 2027"）其后是 " 26 Mar"，26 后无等号不会误切；
 * SESSDATA 值内逗号是 URL 编码（%2C）不受影响。
 * @param {Record<string,string>} headers
 * @returns {Record<string,string>} 仅保留白名单键
 */
export function parseLoginCookies(headers) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === 'set-cookie')
  if (!key || !headers[key]) return {}
  const out = {}
  const whitelist = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']
  for (const part of headers[key].split(/,(?=\s*[\w-]+\s*=)/)) {
    const pair = part.split(';')[0]
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    const k = pair.slice(0, eq).trim()
    const v = pair.slice(eq + 1).trim()
    if (whitelist.includes(k) && v) out[k] = v
  }
  return out
}
