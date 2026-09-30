/**
 * 登录态 store（reactive + localStorage 缓存，见 docs/03-登录与云端功能设计.md D7）
 *
 * - 启动时读缓存秒开，nav 异步校验（SESSDATA 失效 → 自动回落未登录）
 * - onLoginSuccess：写入凭据 → refreshAuth 拉取用户信息
 * - logout：passport exit（best-effort）→ 清凭据 → reset
 */

import { reactive } from 'vue'
import { apiGet, setLoginCookies, clearLoginCookies, hasLoginCookies } from '../api/http.js'
import { passportExit } from '../api/passport.js'

const ls =
  typeof localStorage !== 'undefined'
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const USER_KEY = 'bilitv.auth.user'

/** 安全读取 JSON */
function loadLS(key, fallback) {
  try {
    return JSON.parse(ls.getItem(key) || 'null') || fallback
  } catch (_) {
    return fallback
  }
}

export const auth = reactive({
  /** 登录凭据是否在（Cookie 头是否携带 SESSDATA） */
  get loggedIn() {
    return hasLoginCookies()
  },
  /** nav 校验是否完成（避免首屏闪烁） */
  ready: false,
  /** nav 校验中 */
  loading: false,
  mid: 0,
  uname: '',
  face: '',
  /** 等级：nav 的 level_info.current_level（P9.0 修复——曾误取不存在的 current 恒 Lv0） */
  level: 0,
  /** 大会员状态：1 有效（vipType 1 月度 / 2 年度） */
  vipStatus: 0,
  /** 大会员到期毫秒时间戳（0 未知） */
  vipDueAt: 0,
  /** 硬币数（nav.money） */
  coins: 0,
  /** 写接口 CSRF token（bili_jct cookie 值） */
  biliJct: ''
})

// 启动恢复缓存（秒开）；loggedIn 是 getter 不在此赋值
const saved = loadLS(USER_KEY, null)
if (saved && saved.mid) {
  auth.mid = saved.mid || 0
  auth.uname = saved.uname || ''
  auth.face = saved.face || ''
  auth.level = saved.level || 0
  auth.vipStatus = saved.vipStatus || 0
  auth.vipDueAt = saved.vipDueAt || 0
  auth.coins = saved.coins || 0
}
// 恢复 csrf（凭据在才有意义）
try {
  const ck = JSON.parse(ls.getItem('bilitv.auth.cookies') || '{}')
  auth.biliJct = ck.bili_jct || ''
} catch (_) { /* 忽略 */ }

/** 未登录复位（凭据由 clearLoginCookies 清） */
function resetUser() {
  auth.mid = 0
  auth.uname = ''
  auth.face = ''
  auth.level = 0
  auth.vipStatus = 0
  auth.vipDueAt = 0
  auth.coins = 0
  auth.biliJct = ''
  ls.removeItem(USER_KEY)
}

/**
 * 拉取/校验登录态（nav 匿名也返回 code 0 + isLogin=false，无需分支）
 * 字段实测（P9.0 探针 scripts/probe-nav-fields.mjs）：
 *   level_info.current_level（顶层无 level 字段）；money=硬币；vipStatus=会员有效位
 * @returns {Promise<boolean>} 是否已登录
 */
export async function refreshAuth() {
  auth.loading = true
  try {
    const d = await apiGet('/x/web-interface/nav')
    if (d && d.isLogin && d.mid) {
      auth.mid = d.mid
      auth.uname = d.uname || `用户${d.mid}`
      auth.face = String(d.face || '').replace(/^http:\/\//, 'https://')
      // 头像缩略（hdslb 图床 @ 后缀；显示 76px，96w 足够）
      if (/hdslb\.com/.test(auth.face)) auth.face += '@96w_96h_1c.webp'
      auth.level = (d.level_info && (d.level_info.current_level ?? d.level_info.current)) || 0
      auth.vipStatus = (d.vipStatus || 0) === 1 ? 1 : 0
      auth.vipDueAt = Number(d.vipDueDate || d.vip_due_date || 0)
      auth.coins = Number(d.money) || 0
      ls.setItem(
        USER_KEY,
        JSON.stringify({
          mid: auth.mid,
          uname: auth.uname,
          face: auth.face,
          level: auth.level,
          vipStatus: auth.vipStatus,
          vipDueAt: auth.vipDueAt,
          coins: auth.coins
        })
      )
      return true
    }
    // SESSDATA 失效/不存在：本地复位（cookie 清理交给退出登录流程；匿名态本无凭据）
    resetUser()
    return false
  } catch (_) {
    // 网络异常：保留缓存现状，视为校验未完成
    return hasLoginCookies()
  } finally {
    auth.ready = true
    auth.loading = false
  }
}

/**
 * 扫码成功入口：写入凭据 → 刷新用户信息
 * @param {Record<string,string>} cookies parseLoginCookies 的产物
 */
export async function onLoginSuccess(cookies) {
  setLoginCookies(cookies)
  auth.biliJct = cookies.bili_jct || ''
  return refreshAuth()
}

/** 退出登录：服务端注销（best-effort）→ 清本地凭据与用户缓存 */
export async function logout() {
  if (auth.biliJct) {
    try {
      await passportExit(auth.biliJct)
    } catch (_) {
      /* 服务端注销失败不阻断本地退出 */
    }
  }
  clearLoginCookies()
  resetUser()
}
