/**
 * MSE 播放内核（P8 D18，设计见 docs/03-登录与云端功能设计.md 第 10 节）
 *
 * 目标：B 站 DASH（fnval=16）音视频分离 fMP4 流的 WebView 合流播放，
 * 突破 durl 模式 720P 上限（登录态 1080P）。
 *
 * 工作原理（探针 scripts/probe-dash*.mjs 实测支撑）：
 *  1. playurl 返回的每条流（video/audio）自带 SegmentBase 索引描述：
 *     Initialization（moov 初始化段）与 indexRange（sidx 分片索引表）
 *  2. 一次小 Range 请求拉 [0..indexRange.end]（约几 KB～百 KB），解析 sidx 得到
 *     全部 fragment 的（媒体时间区间 ↔ 字节区间）映射表
 *  3. MediaSource 挂双 SourceBuffer（video/audio），调度器按 currentTime 向前
 *     补 AHEAD 窗口：逐 fragment Range 拉取 → appendBuffer
 *  4. seek = 清空 buffered + 二分索引表定位目标 fragment 重拉；append 前滚动
 *     清理 currentTime-30s 之前的旧数据防内存膨胀
 *
 * 降级链：拉流失败自动轮询备源 → 全部失败/MSE 不支持 → onFatal 回调，
 * 由 PlayerView 回退 durl 模式。
 *
 * 传输层：native 走 CapacitorHttp（arraybuffer base64 通道，弹幕已验证二进制
 * 安全）；web 开发走 fetch（upos 主源带 acao:* 无 CORS 问题）。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core'

/** 调试探针（沿用 __dmDebug 套路）：循环缓冲 120 条，CDP 直接读 window.__mseDebug */
function dbg(msg) {
  try {
    if (!Array.isArray(window.__mseDebug)) window.__mseDebug = []
    window.__mseDebug.push(`${Math.floor(performance.now() % 100000)} ${msg}`)
    if (window.__mseDebug.length > 120) window.__mseDebug.shift()
  } catch (_) {
    /* 探针失败不影响主流程 */
  }
}

/** 向前补流缓冲窗口（秒）：播放位置之后保持这么多秒的已 append 数据 */
const AHEAD_SEC = 20
/** 滚动清理阈值（秒）：buffered 起点早于 currentTime-30s 的旧段清除 */
const KEEP_BEHIND_SEC = 30
/** 调度节拍（毫秒）：interval 轮询 feed，TV 环境简单可靠 */
const FEED_TICK = 600
/** 拉取整体超时（毫秒） */
const PULL_TIMEOUT = 15000

/** 拉流请求头（P9.7 D29 修复）：B 站 CDN（upos-sz/bilivideo 对象存储集群）对
 * CapacitorHttp 默认 UA 的请求 403——显式浏览器 UA + Referer 后通过 */
const PULL_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 11; BiliTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Accept: '*/*'
}

/**
 * 单次 Range 拉取（字节闭区间 [start,end]）→ Uint8Array
 * native：CapacitorHttp arraybuffer（base64 透传）；web：fetch + Range 头
 * 可靠性校验（P8 修：PCDN 对 Range 响应曾出现内容错位 → 播放卡死）：
 *  - 206 响应必须带 content-range 且起点 === start（起点不符 = 数据错位，立即换源）
 *  - 200 全量且 start>0 = Range 被忽略，换源
 */
async function pullRange(url, start, end) {
  const range = `bytes=${start}-${end}`
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      headers: { Range: range, ...PULL_HEADERS },
      responseType: 'arraybuffer',
      connectTimeout: 10000,
      readTimeout: PULL_TIMEOUT
    })
    const status = res.status || 0
    if (status >= 300) throw new Error(`HTTP ${status} @${new URL(url).host}`)
    const b64 = String(res.data || '')
    if (!b64) throw new Error(`空响应(status=${status})`)
    // content-range 起点校验："bytes 0-11258/85134671" → 提取起始字节比对
    const cr = String((res.headers && (res.headers['content-range'] || res.headers['Content-Range'])) || '')
    const crStart = Number((cr.match(/bytes\s+(\d+)-/) || [])[1])
    if (cr && !Number.isNaN(crStart) && crStart !== start) {
      throw new Error(`content-range 起点 ${crStart} ≠ 请求 ${start}`)
    }
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    if (status === 200 && start > 0) throw new Error('Range 被忽略(200 全量)')
    return bytes
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PULL_TIMEOUT)
  try {
    const res = await fetch(url, {
      headers: { Range: range, ...PULL_HEADERS },
      referrerPolicy: 'no-referrer',
      signal: ctrl.signal
    })
    if (res.status >= 300) throw new Error(`HTTP ${res.status} @${new URL(url).host}`)
    if (res.status === 200 && start > 0) throw new Error('Range 被忽略(200 全量)')
    return new Uint8Array(await res.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析 sidx（Segment Index Box）→ fragment 索引表
 *
 * box 布局（version 0，B 站实测均为 v0）：
 *   +0 size(u32) +4 'sidx' +8 version(u8)+flags(u24)
 *   +12 reference_ID(u32) +16 timescale(u32)
 *   +20 earliest_presentation_time(u32) +24 first_offset(u32)
 *   +28 reserved(u16) + reference_count(u16)
 *   +30 每条 reference 12B：[type1bit+size31bit][duration32][sap32]
 *
 * @param {Uint8Array} bytes 含 sidx 的缓冲（init 段 + sidx 一次拉回）
 * @param {number} offset sidx box 在 bytes 内的起始偏移
 * @param {number} sidxAnchor sidx box 结束后在整个流中的字节位置（fragment 寻址锚点
 *        = indexRange.end + 1；bytes 前缀长度必须与流内偏移一致才可直算）
 * @returns {{timescale:number, frags:Array<{start:number,dur:number,byteStart:number,byteEnd:number}>}}
 */
export function parseSidx(bytes, offset, sidxAnchor) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = offset
  const size = dv.getUint32(p)
  const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])
  if (type !== 'sidx') throw new Error(`期望 sidx 实得 ${type}`)
  const version = bytes[p + 8]
  const timescale = dv.getUint32(p + 16) || 1
  let ept
  let firstOffset
  let refCount
  let refBase
  if (version === 0) {
    ept = dv.getUint32(p + 20)
    firstOffset = dv.getUint32(p + 24)
    refCount = dv.getUint16(p + 30)
    refBase = p + 32
  } else {
    // version 1：时间字段 64bit（大文件防溢出；B 站罕见，做兼容读取）
    ept = Number(dv.getBigUint64(p + 20))
    firstOffset = Number(dv.getBigUint64(p + 28))
    refCount = dv.getUint16(p + 38)
    refBase = p + 40
  }

  const frags = []
  let t = ept / timescale
  let byte = sidxAnchor + firstOffset
  for (let i = 0; i < refCount; i++) {
    const q = refBase + i * 12
    const referencedSize = dv.getUint32(q) & 0x7fffffff // 最高位是 reference_type（0=媒体流）
    const dur = dv.getUint32(q + 4) / timescale
    if (referencedSize > 0) {
      frags.push({ start: t, dur, byteStart: byte, byteEnd: byte + referencedSize - 1 })
    }
    t += dur
    byte += referencedSize
  }
  return { timescale, frags }
}

/**
 * 二分定位：frags 中 start <= t 的最后一个下标（t 早于首段返回 0）
 */
function findFragIdx(frags, t) {
  let lo = 0
  let hi = frags.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (frags[mid].start <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * 单流喂送器：一条流（video 或 audio）的拉取/append/清理闭环
 * appendBuffer 必须串行（sb.updating 期间再次调用抛错）→ busy 标志 + 队列语义
 */
class StreamFeeder {
  /**
   * @param {SourceBuffer} sb 目标 SourceBuffer
   * @param {{urls:string[], seg:{init:{start,end}, idx:{start,end}|null}}} stream 拉流描述
   * @param {Array} frags sidx 解析出的 fragment 索引表
   * @param {Uint8Array} initData 初始化段（moov）字节
   * @param {string} tag 日志标签（V/A）
   */
  constructor(sb, stream, frags, initData, tag) {
    this.sb = sb
    this.urls = stream.urls
    this.frags = frags
    this.initData = initData
    this.tag = tag
    this.urlIdx = 0 // 当前使用的源（主源失败后轮询备源）
    this.nextIdx = 0 // 下一个待 append 的 fragment 下标
    this.done = false // 全部 fragment append 完毕
    this.busy = false // feed 循环重入保护
    this.epoch = 0 // 代际计数：resetTo 递增，在途 feed 循环检测到变化即作废退出
  }

  /** 当前源 URL（失败换下一候选） */
  get url() {
    return this.urls[Math.min(this.urlIdx, this.urls.length - 1)]
  }

  /**
   * 原地重绑流数据源（P9.9 D31 对齐 web 端切档）：换 urls/frags/initData 但
   * 复用 SourceBuffer 与调度状态——切清晰度时 audio 流不动、video SB 不销毁
   */
  rebind(stream, frags, initData) {
    this.epoch++ // 作废在途 feed 循环
    this.urls = stream.urls
    this.frags = frags
    this.initData = initData
    this.urlIdx = 0
    this.nextIdx = 0
    this.done = false
  }

  /** 已缓冲末端时间（无缓冲返回 -1） */
  bufferedEnd() {
    try {
      return this.sb.buffered.length ? this.sb.buffered.end(this.sb.buffered.length - 1) : -1
    } catch (_) {
      return -1
    }
  }

  /** 等待 SourceBuffer 空闲（updateend 事件驱动） */
  waitIdle() {
    if (!this.sb.updating) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const on = () => {
        this.sb.removeEventListener('updateend', on)
        this.sb.removeEventListener('error', err)
        resolve()
      }
      const err = () => {
        this.sb.removeEventListener('updateend', on)
        this.sb.removeEventListener('error', err)
        reject(new Error(`${this.tag} append/remove 失败`))
      }
      this.sb.addEventListener('updateend', on)
      this.sb.addEventListener('error', err)
    })
  }

  /** append 一段字节（Promise 包装） */
  async append(bytes) {
    this.sb.appendBuffer(bytes)
    await this.waitIdle()
  }

  /** remove [0,end) 区间（Promise 包装） */
  async removeTo(end) {
    if (this.sb.buffered.length && this.sb.buffered.start(0) < end) {
      this.sb.remove(0, end)
      await this.waitIdle()
    }
  }

  /**
   * 调度循环：从 nextIdx 顺序 append，直到补满 AHEAD 窗口或流结束。
   * 单次失败自动换源重试当前 fragment；换尽全部候选源仍失败则上抛（触发降级）。
   */
  async feed(currentTime) {
    if (this.busy || this.done) return
    this.busy = true
    const myEpoch = this.epoch
    try {
      // 滚动清理：起点落后播放位置太多时丢弃旧段（防长视频内存膨胀）
      await this.removeTo(currentTime - KEEP_BEHIND_SEC)

      while (this.nextIdx < this.frags.length) {
        // resetTo 已发生（索引被重置）：本次循环基于旧 nextIdx 继续 append 会错位，作废退出
        if (this.epoch !== myEpoch) {
          dbg(`${this.tag} feed 循环作废（epoch 变更）`)
          break
        }
        const f = this.frags[this.nextIdx]
        // 已补满窗口：fragment 起点在缓冲目标之外即停
        if (f.start > currentTime + AHEAD_SEC) break
        try {
          const bytes = await pullRange(this.url, f.byteStart, f.byteEnd)
          await this.append(bytes)
          // epoch 检查必须在 nextIdx++ 之前：resetTo 已重写 nextIdx 时，
          // 本次 append 的位置推进会把索引再次错开（P8 V4 实测：audio 跳过
          // 目标片段重拉 → buffer 缺 currentTime 处数据 → seeking 永不完成）
          if (this.epoch !== myEpoch) {
            dbg(`${this.tag} feed 循环作废（epoch 变更，不推进）`)
            break
          }
          this.nextIdx++
          dbg(`${this.tag} frag#${this.nextIdx}/${this.frags.length} t=${f.start.toFixed(1)}s ${bytes.length}B`)
        } catch (err) {
          // 换源重试：候选耗尽则上抛
          if (this.urlIdx < this.urls.length - 1) {
            this.urlIdx++
            dbg(`${this.tag} 换源#${this.urlIdx} after ${err.message}`)
            continue
          }
          throw err
        }
      }
      if (this.nextIdx >= this.frags.length) this.done = true
    } finally {
      this.busy = false
    }
  }

  /**
   * seek 重置：清空全部缓冲，nextIdx 指到目标时间所在 fragment
   * remove 完成前若有在途 append 会先被 waitIdle 串行化
   */
  async resetTo(t) {
    this.epoch++ // 作废所有在途 feed 循环（防 append 错位竞争）
    // 等 in-flight append 结束再动 sb
    if (this.sb.updating) await this.waitIdle()
    const end = this.bufferedEnd()
    if (end > 0) {
      try {
        this.sb.abort()
      } catch (_) {
        /* abort 非必需，失败忽略 */
      }
      await this.removeTo(end + 0.5)
    }
    this.nextIdx = findFragIdx(this.frags, t)
    this.done = false
    dbg(`${this.tag} resetTo t=${t.toFixed(1)}s frag#${this.nextIdx} start=${this.frags[this.nextIdx].start.toFixed(1)}s`)
  }
}

/**
 * MSE 播放器编排：MediaSource 生命周期 + 双 Feeder + seek + 降级回调
 */
export class MsePlayer {
  /**
   * 能力预检：WebView 是否支持给定 codecs 的 MSE 播放
   * D27b 老设备防御：UA 解析 Chrome 主版本，< 70 的老 WebView（极米等投影内置）
   * 即使 isTypeSupported 返回 true 也可能在解码器层 native crash（JS 无法拦截），
   * 直接判不支持走 durl 兼容路径
   * @param {string} vCodecs 如 avc1.64001F
   * @param {string} aCodecs 如 mp4a.40.2
   */
  static supported(vCodecs, aCodecs) {
    if (typeof window === 'undefined' || !window.MediaSource) return false
    // 老 WebView 版本门槛（Chromium 70 ≈ 2018，含 MSE + fMP4 稳定支持）
    const m = /Chrome\/(\d+)/.exec(navigator.userAgent || '')
    if (m && Number(m[1]) < 70) return false
    try {
      return (
        MediaSource.isTypeSupported(`video/mp4; codecs="${vCodecs}"`) &&
        MediaSource.isTypeSupported(`audio/mp4; codecs="${aCodecs}"`)
      )
    } catch (_) {
      return false
    }
  }

  /**
   * @param {HTMLVideoElement} videoEl
   * @param {object} dash getDashPlayUrl 返回结构（videoStreams/audio/duration）
   * @param {number} qualityId 初始清晰度档 id
   * @param {{onFatal?:Function, onReady?:Function, startAt?:number}} opts
   *        startAt：续播起点（秒）。不能由调用方在 readyState<1 时直接设
   *        el.currentTime——HAVE_NOTHING 阶段只会写入 default playback start
   *        position，seeking 事件不派发（P8 实测卡死根因）；由内核在
   *        readyState≥1 时主动补一次真实 seek。
   */
  constructor(videoEl, dash, qualityId, opts = {}) {
    this.el = videoEl
    this.dash = dash
    this.qualityId = qualityId
    this.onFatal = opts.onFatal || null
    this.onReady = opts.onReady || null
    this.startAt = opts.startAt || 0
    this.initialSeekDone = this.startAt <= 0 // 无续播需求时视为已完成
    this.ms = null
    this.feeders = {}
    this.timer = 0
    this.destroyed = false
    this.fatal = false
    this.objectUrl = ''
    this.failCount = 0 // feed 连续失败计数（累计 4 次换源无效则降级）
  }

  /** 当前视频流描述 */
  get videoStream() {
    return this.dash.videoStreams[this.qualityId]
  }

  /** 启动：attach MediaSource → 等 sourceopen → init+索引 → 开调度 */
  async start() {
    const v = this.videoStream
    const a = this.dash.audio
    if (!v || !MsePlayer.supported(v.codecs, a.codecs)) {
      throw new Error(`MSE 不支持当前编码 ${v && v.codecs}/${a.codecs}`)
    }

    this.ms = new MediaSource()
    this.objectUrl = URL.createObjectURL(this.ms)
    this.el.src = this.objectUrl

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sourceopen 超时')), 8000)
      this.ms.addEventListener('sourceopen', () => {
        clearTimeout(t)
        resolve()
      }, { once: true })
    })
    if (this.destroyed) return

    // 双 SourceBuffer：video 先建（append 时序优先）
    const vsb = this.ms.addSourceBuffer(`video/mp4; codecs="${v.codecs}"`)
    const asb = this.ms.addSourceBuffer(`audio/mp4; codecs="${a.codecs}"`)
    vsb.mode = 'segments'
    asb.mode = 'segments'

    // 一次拉 [0..indexRange.end]：init 段 + sidx 同回（indexRange 缺失的畸形流直接判败）
    const initAndIdx = await this.pullStreamHead(v, 'V')
    const initAndIdxA = await this.pullStreamHead(a, 'A')

    // 显式设定时长（init append 后 MSE 自身推不准总时长，进度条依赖它）
    try {
      if (this.dash.duration > 0) this.ms.duration = this.dash.duration
    } catch (_) { /* 忽略 */ }

    this.feeders.V = new StreamFeeder(vsb, v, initAndIdx.frags, initAndIdx.init, 'V')
    this.feeders.A = new StreamFeeder(asb, a, initAndIdxA.frags, initAndIdxA.init, 'A')
    // SB 调试钩子（CDP 读 audio/video 各自的 buffered，定位卡死根因）
    const mseSelf = this
    try {
      window.__mseSB = { v: vsb, a: asb, player: mseSelf }
    } catch (_) { /* 忽略 */ }

    // init 段（moov）先行 append，fragment 数据才有轨道上下文
    await this.feeders.V.append(this.feeders.V.initData)
    await this.feeders.A.append(this.feeders.A.initData)
    dbg(`init ok v=${v.codecs} a=${a.codecs} vFrags=${initAndIdx.frags.length} aFrags=${initAndIdxA.frags.length}`)

    // 续播定位：把两个 feeder 的拉取起点直接指到 startAt 所在 fragment
    // （feed 顺序拉到 405s 要 80+ 片；数据按数据内时间戳入 buffer，直接定位零浪费）
    if (this.startAt > 0) {
      this.feeders.V.nextIdx = findFragIdx(this.feeders.V.frags, this.startAt)
      this.feeders.A.nextIdx = findFragIdx(this.feeders.A.frags, this.startAt)
      dbg(`nextIdx 预定位 → V#${this.feeders.V.nextIdx} A#${this.feeders.A.nextIdx}`)
    }

    // 调度节拍 + seek 响应
    this.timer = setInterval(() => this.feedTick(), FEED_TICK)
    this.el.addEventListener('seeking', this.onSeeking = () => this.onSeek(), { passive: true })

    this.feedTick()
    if (this.onReady) this.onReady()
  }

  /**
   * 拉流头部（init + sidx）并解析出该流 fragment 索引表，附数据自校验
   * （P8 修：PCDN 曾对 head Range 返回内容错位数据 → 索引时间轴坏 → seek 定位错、
   *  播放卡死。三层校验：长度 / ftyp 魔数 / sidx 时间轴与流时长对照，任一不符换源）
   */
  async pullStreamHead(stream, tag) {
    const { init, idx } = stream.seg
    if (!idx || idx.end <= idx.start) throw new Error(`${tag} 缺 sidx indexRange`)
    // head 拉取：主源坏（数据错位/长度不符）自动轮询备源
    let head = null
    let lastErr = null
    for (const u of stream.urls) {
      try {
        head = await pullRange(u, 0, idx.end)
        break
      } catch (e) {
        lastErr = e
        dbg(`${tag} head 拉取失败: ${e.message}`)
      }
    }
    if (!head) throw lastErr || new Error(`${tag} head 拉取失败`)
    // 校验 1：严格长度（206 必须精确返回 [0..idx.end]）
    if (head.length !== idx.end + 1) {
      throw new Error(`${tag} head 长度 ${head.length} ≠ ${idx.end + 1}`)
    }
    // 校验 2：文件头魔数（box header 4B size + 'ftyp'）
    const magic = String.fromCharCode(head[4], head[5], head[6], head[7])
    if (magic !== 'ftyp') {
      throw new Error(`${tag} 头部魔数 "${magic}" ≠ ftyp（数据错位）`)
    }
    // init 段 = [init.start..init.end]（通常 0 起）
    const initData = head.slice(init.start, init.end + 1)
    // sidx 锚点 = indexRange 结束 + 1（fragment 寻址从 sidx 之后开始）
    const { frags } = parseSidx(head, idx.start, idx.end + 1)
    if (!frags.length) throw new Error(`${tag} sidx 空`)
    // 校验 3：索引时间轴健康度——尾片终点应接近流总时长（时间累加坏时这里显著偏小）
    const last = frags[frags.length - 1]
    const expectEnd = last.start + last.dur
    if (this.dash.duration > 0) {
      const dev = Math.abs(expectEnd - this.dash.duration) / this.dash.duration
      if (dev > 0.1) {
        throw new Error(
          `${tag} sidx 时间轴异常：尾片终点 ${expectEnd.toFixed(0)}s vs 时长 ${this.dash.duration}s（偏差 ${(dev * 100).toFixed(0)}%）`
        )
      }
    }
    dbg(`${tag} sidx ok frags=${frags.length} 尾片=${expectEnd.toFixed(0)}s/[0]=${frags[0].start.toFixed(1)}s`)
    return { init: initData, frags }
  }

  /** 调度 tick：首定位补发 + 双流各 feed 一步；连续失败达到阈值触发降级 */
  feedTick() {
    if (this.destroyed || this.fatal) return
    // 首定位补发：HAVE_NOTHING 时调用方设 currentTime 只进 default position（不派发
    // seeking），等 init+首片 append、readyState≥1 后这里补一次真实 seek 接管定位
    if (!this.initialSeekDone && this.el.readyState >= 1) {
      this.initialSeekDone = true
      dbg(`首定位补发 → ${this.startAt}s`)
      this.el.currentTime = this.startAt // HAVE_METADATA 下的真实 seek → seeking 事件 → onSeek
      return
    }
    const ct = this.el.currentTime > 0.5 ? this.el.currentTime : this.startAt
    // seeking 卡死兜底：seek 目标处双流数据不齐时浏览器无法完成 seek（P8 V4 实测
    // audio 片段被跳过重拉 → audio buffer 起点晚于目标）——持续 4s 后跳到双流
    // buffered 交集起点重新定位，保底恢复播放
    if (this.el.seeking) {
      this.seekStall = (this.seekStall || 0) + 1
      // 12 ticks ≈ 7.2s：1080P 首片可达 2MB+（拉取 3s+），阈值需覆盖大片段慢拉窗口，
      // 否则会在本可自然完成的 seek 上触发多余跳转（跳回交集起点重播一小段）
      if (this.seekStall > 11) {
        this.seekStall = 0
        const vb = this.feeders.V.sb.buffered
        const ab = this.feeders.A.sb.buffered
        if (vb.length && ab.length) {
          const target = Math.max(vb.start(0), ab.start(0)) + 0.1
          dbg(`seeking 卡死兜底 t=${ct.toFixed(2)} → ${target.toFixed(2)}`)
          this.el.currentTime = target
          return
        }
      }
    } else {
      this.seekStall = 0
    }
    // 卡死看门狗：readyState=1（有 metadata 无当前帧）而 buffer 覆盖播放位置且未在
    // seek 中——解码器停在无帧区（P8 实测定位后偶发），微推 0.2s 触发重定位自愈
    if (this.el.readyState === 1 && !this.el.paused && !this.el.seeking) {
      const b = this.el.buffered
      let covered = false
      for (let i = 0; i < b.length; i++) {
        if (ct >= b.start(i) - 0.01 && ct <= b.end(i)) { covered = true; break }
      }
      this.stallCount = covered ? (this.stallCount || 0) + 1 : 0
      if (this.stallCount >= 5) {
        this.stallCount = 0
        dbg(`看门狗 nudge ct=${ct.toFixed(2)} → ${ct + 0.2}`)
        this.el.currentTime = ct + 0.2
        return
      }
    } else {
      this.stallCount = 0
    }
    Promise.all([
      this.feeders.V.feed(ct),
      this.feeders.A.feed(ct)
    ]).then(() => {
      this.failCount = 0
      // 双流全部 fragment append 完毕 → endOfStream 封口（时长到位）
      if (this.feeders.V.done && this.feeders.A.done && this.ms.readyState === 'open') {
        try {
          this.ms.endOfStream()
        } catch (_) { /* 重复调用忽略 */ }
      }
    }).catch((err) => {
      this.failCount++
      dbg(`feed 失败#${this.failCount}: ${err.message}`)
      if (this.failCount >= 4 && !this.fatal) {
        this.fatal = true
        dbg('fatal → 降级回调')
        if (this.onFatal) this.onFatal(err)
      }
    })
  }

  /** seeking 事件 → 双流重定位（清 buffer + 重拉目标片段） */
  onSeek() {
    if (this.destroyed || this.fatal) return
    const t = this.el.currentTime || 0
    Promise.all([
      this.feeders.V.resetTo(t),
      this.feeders.A.resetTo(t)
    ]).then(() => this.feedTick()).catch((err) => {
      dbg(`seek reset 失败: ${err.message}`)
      this.failCount += 2
      if (this.failCount >= 4 && !this.fatal) {
        this.fatal = true
        if (this.onFatal) this.onFatal(err)
      }
    })
  }

  /** 手动 seek（与 el.currentTime 赋值等价，seeking 事件会接棒处理） */
  seekTo(t) {
    this.el.currentTime = t
  }

  /**
   * 原地切换清晰度（P9.9 D31，对齐 bilibili web 播放器）：
   * 复用 video SourceBuffer——清空 buffered → append 新档 init → feeder 重绑到
   * 新档流 → 数据拉取从当前播放位置续起；audio 轨不动、MediaSource 不重建、
   * currentTime 不跳。失败抛错由调用方走「重建内核」兜底路径。
   * @param {number} newId 目标清晰度档 id（须存在于 dash.videoStreams）
   */
  async switchQuality(newId) {
    const nv = this.dash.videoStreams[newId]
    if (!nv) throw new Error(`无档位 ${newId} 的流数据`)
    if (!MsePlayer.supported(nv.codecs, this.dash.audio.codecs)) {
      throw new Error(`新档编码不支持 ${nv.codecs}`)
    }
    const feeder = this.feeders.V
    const vsb = feeder.sb

    // 新档头部（init + sidx 索引）——失败即抛，不消耗旧状态
    const head = await this.pullStreamHead(nv, 'V')

    // 等 in-flight append 完成 → 清空旧档 buffer（换编码配置需空 buffer）
    if (vsb.updating) await feeder.waitIdle()
    const end = feeder.bufferedEnd()
    if (end > 0) {
      try {
        vsb.abort()
      } catch (_) {
        /* 非必需 */
      }
      await feeder.removeTo(end + 0.5)
    }

    // append 新档 init（moov 携带新分辨率的 SPS/PPS）
    await feeder.append(head.init)

    // feeder 重绑：新源/新索引表，拉取从当前播放位置续起
    feeder.rebind(nv, head.frags, head.init)
    this.feeders.V.nextIdx = findFragIdx(head.frags, this.el.currentTime || 0)
    this.qualityId = newId
    dbg(`原地切档 → ${newId}（${nv.codecs}），拉取续起 frag#${this.feeders.V.nextIdx}`)
  }

  /** 销毁：停调度、撤监听、释放 objectURL */
  destroy() {
    this.destroyed = true
    this.fatal = true
    clearInterval(this.timer)
    if (this.onSeeking) this.el.removeEventListener('seeking', this.onSeeking)
    try {
      if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream()
    } catch (_) { /* 忽略 */ }
    // 移除 src 触发底层资源释放；延后 revoke 避免 src 置空前 URL 失效
    try {
      this.el.removeAttribute('src')
      this.el.load()
    } catch (_) { /* 忽略 */ }
    if (this.objectUrl) {
      setTimeout(() => URL.revokeObjectURL(this.objectUrl), 100)
      this.objectUrl = ''
    }
    dbg('destroy')
  }
}
